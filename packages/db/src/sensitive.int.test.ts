import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// The encrypted self-service fields and the step-up (ADR-0002, encryption; data-protection.md,
// self-service; Q135, Q137) as transfer_app calls them. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const NOTICE = "self-service-purposes:v1";
const key = hex();
const keyId = hex(8);

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

const RV = "65170839J003";
const baDetails = {
  pensionInsuranceNumber: RV,
  nationality: { kind: "other", country: "PL" },
  entryToGermanyDate: "2015-09-05",
  residenceStatus: "settlement_permit",
  buergergeld: false,
};
const health = { healthRestrictions: true, severeDisability: false };

/** An activated participant (birth-date step) with a live active session and the notice acknowledged. */
async function activated(address: string) {
  const participationId = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
  });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', '1970-01-01')`,
    [participationId, seedProjectIds.werkNord, `SYN-${participationId.slice(-8)}`],
  );
  await owner.query(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE')`,
    [participationId, seedProjectIds.werkNord],
  );
  const codeHash = hex();
  await call(app, "issue_activation_code", {
    participationId,
    codeHash,
    channel: "letter",
    language: "de",
    noticeVersion: "art14-activation:v1",
    replaceOpenCode: false,
    deliveryKind: null,
    deliveryAddressHash: null,
    identityChecked: false,
    context: pl,
    id: randomUUID(),
    purpose: "activation",
  });
  const activating = hex();
  await call(app, "start_activation", { codeHash, tokenHash: activating, requestId: "req-1" });
  await call(app, "check_activation_birth_date", {
    tokenHash: activating,
    birthDate: "1970-01-01",
    requestId: "req-2",
  });
  const oneTimeCodeHash = hex();
  await call(app, "create_one_time_code", {
    tokenHash: activating,
    kind: "email",
    address,
    codeHash: oneTimeCodeHash,
    id: randomUUID(),
  });
  const tokenHash = hex();
  const channelId = randomUUID();
  await call(app, "complete_activation", {
    tokenHash: activating,
    newTokenHash: tokenHash,
    noticeVersion: "art14-activation:v1",
    consentVersion: "portal-contact-consent:v1",
    language: "de",
    channelId,
    consentId: randomUUID(),
    requestId: "req-3",
    oneTimeCodeHash,
  });
  const context = auditContext({ actorType: "participant", participationId, requestId: "req-4" });
  await call(app, "acknowledge_self_service_notice", {
    participationId,
    context,
    noticeVersion: NOTICE,
    language: "de",
    id: randomUUID(),
    tokenHash,
  });
  return { participationId, tokenHash, context, address, channelId };
}
type Participant = Awaited<ReturnType<typeof activated>>;

/** A new session of the participant through a login code: no step-up of its own. */
async function loggedIn(p: Participant) {
  const codeHash = hex();
  await call(app, "request_login_code", {
    kind: "email",
    address: p.address,
    codeHash,
    id: randomUUID(),
  });
  const tokenHash = hex();
  expect(
    await call(app, "start_participant_session", {
      kind: "email",
      address: p.address,
      codeHash,
      tokenHash,
      requestId: "req-login",
    }),
  ).toBe("ok");
  return { ...p, tokenHash };
}

const write = (
  p: Participant,
  group: string,
  values: Record<string, unknown>,
  revision: number,
  args: Record<string, unknown> = {},
) =>
  call<number>(app, "write_sensitive_fields", {
    participationId: p.participationId,
    context: p.context,
    group,
    values: JSON.stringify(values),
    revision,
    noticeVersion: NOTICE,
    key,
    keyId,
    tokenHash: p.tokenHash,
    ...args,
  });

const read = (p: Participant, keys: string[], args: Record<string, unknown> = {}) =>
  call<Record<string, unknown>>(app, "read_sensitive_fields", {
    participationId: p.participationId,
    context: p.context,
    keys,
    key,
    keyId,
    tokenHash: p.tokenHash,
    ...args,
  });

const events = (participationId: string, types: string[]) =>
  all(
    `select event_type, actor_type, details from audit_event
     where participation_id = $1 and event_type = any($2) order by seq`,
    [participationId, types],
  );

const staff = (staffUserId: string) =>
  auditContext({ actorType: "user", staffUserId, requestId: "req-staff" });

const session = (tokenHash: string) =>
  one(
    `select ended_at is not null as ended, end_reason, sensitive_step_up_method, step_up_failures
     from participant_session where token_hash = $1`,
    [tokenHash],
  );

const birthDate = (q: Participant, date: string) =>
  call(app, "check_step_up_birth_date", {
    tokenHash: q.tokenHash,
    birthDate: date,
    requestId: "req-step-up",
  });

const request = (q: Participant, codeHash: string, channelId = q.channelId) =>
  call<{ kind: string; address: string }>(app, "request_step_up_code", {
    tokenHash: q.tokenHash,
    channelId,
    codeHash,
    id: randomUUID(),
  });

const verify = (q: Participant, codeHash: string) =>
  call(app, "verify_step_up_code", {
    tokenHash: q.tokenHash,
    codeHash,
    requestId: "req-code",
  });

describe("write_sensitive_fields and read_sensitive_fields", () => {
  let p: Participant;
  beforeEach(async () => {
    p = await activated("erika@example.invalid");
  });

  it("encrypt the values, store their presence and bump the wizard's revision", async () => {
    expect(await write(p, "ba_details", baDetails, 0)).toBe(1);
    expect(await read(p, Object.keys(baDetails))).toEqual(baDetails);
    expect(
      await one(
        `select pension_insurance_number_present, key_id from participant_identifier_data
         where participation_id = $1`,
        [p.participationId],
      ),
    ).toEqual({ pension_insurance_number_present: true, key_id: keyId });
    expect(
      await one(
        `select nationality_present, entry_to_germany_date_present, residence_status_present,
           buergergeld_present from participant_residence_social_data where participation_id = $1`,
        [p.participationId],
      ),
    ).toEqual({
      nationality_present: true,
      entry_to_germany_date_present: true,
      residence_status_present: true,
      buergergeld_present: true,
    });
    expect(
      await one("select revision from participant_profile where participation_id = $1", [
        p.participationId,
      ]),
    ).toEqual({ revision: 1 });
  });

  it("hold no plaintext in the ciphertext columns (read as the owner)", async () => {
    await write(p, "ba_details", baDetails, 0);
    await write(p, "health", health, 1);
    const rows = await all(
      `select encode(pension_insurance_number, 'escape') as v from participant_identifier_data
       union all select encode(c, 'escape') from participant_residence_social_data,
         unnest(array[nationality, entry_to_germany_date, residence_status, buergergeld]) c
       union all select encode(c, 'escape') from participant_health_data,
         unnest(array[health_restrictions, severe_disability]) c`,
    );
    expect(rows).toHaveLength(7);
    for (const { v } of rows) {
      for (const plain of [RV, "PL", "2015-09-05", "settlement_permit", "true", "false", "kind"]) {
        expect(v).not.toContain(plain);
      }
    }
  });

  it("refuse a ciphertext moved to another participation or field", async () => {
    const other = await activated("max@example.invalid");
    await write(p, "ba_details", baDetails, 0);
    await write(other, "ba_details", { ...baDetails, pensionInsuranceNumber: "12010180M005" }, 0);
    await owner.query(
      `update participant_identifier_data set pension_insurance_number =
         (select pension_insurance_number from participant_identifier_data where participation_id = $1)
       where participation_id = $2`,
      [p.participationId, other.participationId],
    );
    await expect(read(other, ["pensionInsuranceNumber"])).rejects.toMatchObject(
      failsWith("envelope_mismatch"),
    );
    await owner.query(
      `update participant_residence_social_data set residence_status = nationality
       where participation_id = $1`,
      [p.participationId],
    );
    await expect(read(p, ["residenceStatus"])).rejects.toMatchObject(
      failsWith("envelope_mismatch"),
    );
    // The other participation's own write path refuses too: it decrypts to compare.
    await expect(write(other, "ba_details", baDetails, 1)).rejects.toMatchObject(
      failsWith("envelope_mismatch"),
    );
  });

  it("refuse another key: a different key id, or a wrong key under the same id", async () => {
    await write(p, "ba_details", baDetails, 0);
    await expect(read(p, ["buergergeld"], { keyId: hex(8) })).rejects.toMatchObject(
      failsWith("key_unknown"),
    );
    await expect(read(p, ["buergergeld"], { key: hex() })).rejects.toMatchObject(
      failsWith("decryption_failed"),
    );
  });

  it("audit every write and read per field key, never a value", async () => {
    await write(p, "ba_details", baDetails, 0);
    // Unchanged: nothing written, nothing audited, the revision stays.
    expect(await write(p, "ba_details", baDetails, 1)).toBe(1);
    expect(await write(p, "ba_details", { ...baDetails, buergergeld: true }, 1)).toBe(2);
    await read(p, ["nationality", "buergergeld"]);
    const audited = await events(p.participationId, ["sensitive_write", "sensitive_read"]);
    expect(audited.map((e) => [e.event_type, e.actor_type, e.details])).toEqual([
      ...Object.keys(baDetails).map((k) => ["sensitive_write", "participant", { key: k }]),
      ["sensitive_write", "participant", { key: "buergergeld" }],
      ["sensitive_read", "participant", { key: "nationality" }],
      ["sensitive_read", "participant", { key: "buergergeld" }],
    ]);
    const trail = JSON.stringify(await all("select * from audit_event"));
    for (const plain of [RV, "settlement_permit", "2015-09-05", key]) {
      expect(trail).not.toContain(plain);
    }
  });

  it("empty a field with null, and take entry date and residence status only for 'other'", async () => {
    await write(p, "ba_details", baDetails, 0);
    const german = {
      ...baDetails,
      nationality: { kind: "german" },
      entryToGermanyDate: null,
      residenceStatus: null,
    };
    expect(await write(p, "ba_details", german, 1)).toBe(2);
    expect(await read(p, ["nationality", "residenceStatus"])).toEqual({
      nationality: { kind: "german" },
      residenceStatus: null,
    });
    expect(
      await one(
        "select residence_status_present from participant_residence_social_data where participation_id = $1",
        [p.participationId],
      ),
    ).toEqual({ residence_status_present: false });
    await expect(
      write(p, "ba_details", { ...german, residenceStatus: "visa" }, 2),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });

  it.each([
    ["another group's field", { ...baDetails, healthRestrictions: true }],
    ["a missing field", { pensionInsuranceNumber: RV }],
    ["a malformed RV-Nummer", { ...baDetails, pensionInsuranceNumber: "65170839j003" }],
    ["Germany as another country", { ...baDetails, nationality: { kind: "other", country: "DE" } }],
    ["an impossible entry date", { ...baDetails, entryToGermanyDate: "2015-02-30" }],
    ["an unknown residence status", { ...baDetails, residenceStatus: "asylum" }],
    ["text for yes/no", { ...baDetails, buergergeld: "ja" }],
  ])("refuse %s (invalid_argument)", async (_label, values) => {
    await expect(write(p, "ba_details", values, 0)).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
  });

  it("refuse a stale revision, a missing notice and a terminal participation", async () => {
    await expect(write(p, "ba_details", baDetails, 3)).rejects.toMatchObject(
      failsWith("stale_revision"),
    );
    await expect(
      write(p, "ba_details", baDetails, 0, { noticeVersion: "self-service-purposes:v2" }),
    ).rejects.toMatchObject(failsWith("notice_required"));
    await changeStatus(app, p.participationId, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-10-21",
    });
    await expect(write(p, "ba_details", baDetails, 0)).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });

  it("let only the participant's own live session through", async () => {
    const other = await activated("max@example.invalid");
    await expect(read(p, ["buergergeld"], { tokenHash: other.tokenHash })).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await expect(
      write(p, "ba_details", baDetails, 0, { tokenHash: other.tokenHash }),
    ).rejects.toMatchObject(failsWith("session_invalid"));
  });
});

describe("staff reads (normal mode)", () => {
  let p: Participant;
  beforeEach(async () => {
    p = await activated("erika@example.invalid");
    await write(p, "ba_details", baDetails, 0);
    await write(p, "health", health, 1);
  });

  it("let the assigned consultant read every field, audited as the user", async () => {
    const consultant = staff(seedStaffUserIds.consultant);
    await expect(
      read(p, ["healthRestrictions"], { context: consultant, tokenHash: null }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await owner.query(
      `insert into participant_assignment (project_id, participation_id, staff_user_id, assigned_by)
       values ($1, $2, $3, $4)`,
      [
        seedProjectIds.werkNord,
        p.participationId,
        seedStaffUserIds.consultant,
        seedStaffUserIds.projectLead,
      ],
    );
    expect(
      await read(p, ["healthRestrictions", "pensionInsuranceNumber"], {
        context: consultant,
        tokenHash: null,
      }),
    ).toEqual({ healthRestrictions: true, pensionInsuranceNumber: RV });
    const reads = await events(p.participationId, ["sensitive_read"]);
    expect(reads.map((e) => [e.actor_type, e.details.key])).toEqual([
      ["user", "healthRestrictions"],
      ["user", "pensionInsuranceNumber"],
    ]);
  });

  it("let back office read all but the health restrictions; the PL nothing", async () => {
    const backOffice = staff(seedStaffUserIds.backOffice);
    expect(
      await read(p, ["severeDisability", "nationality"], { context: backOffice, tokenHash: null }),
    ).toEqual({ severeDisability: false, nationality: baDetails.nationality });
    await expect(
      read(p, ["healthRestrictions"], { context: backOffice, tokenHash: null }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(read(p, ["buergergeld"], { context: pl, tokenHash: null })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });
});

describe("the step-up (Q137)", () => {
  let p: Participant;
  beforeEach(async () => {
    p = await activated("erika@example.invalid");
  });

  it("counts the session after an activation with the birth-date step", async () => {
    expect(await write(p, "health", health, 0)).toBe(1);
    expect(await read(p, ["severeDisability"])).toEqual({ severeDisability: false });
  });

  it("gates health and disability for a login session until the birth date", async () => {
    const q = await loggedIn(p);
    await expect(write(q, "health", health, 0)).rejects.toMatchObject(
      failsWith("step_up_required"),
    );
    await expect(read(q, ["severeDisability"])).rejects.toMatchObject(
      failsWith("step_up_required"),
    );
    // The highly confidential group needs none.
    expect(await write(q, "ba_details", baDetails, 0)).toBe(1);
    expect(await birthDate(q, "1970-01-01")).toBe("ok");
    expect(await session(q.tokenHash)).toMatchObject({ sensitive_step_up_method: "birth_date" });
    expect(await write(q, "health", health, 1)).toBe(2);
    expect((await events(p.participationId, ["step_up_completed"])).map((e) => e.details)).toEqual([
      { method: "birth_date" },
    ]);
  });

  it("ends the session at the fifth wrong birth date, audited", async () => {
    const q = await loggedIn(p);
    for (let i = 0; i < 4; i += 1) expect(await birthDate(q, "1971-01-01")).toBe("mismatch");
    expect(await session(q.tokenHash)).toMatchObject({ ended: false, step_up_failures: 4 });
    expect(await birthDate(q, "1971-01-01")).toBe("ended");
    expect(await session(q.tokenHash)).toMatchObject({
      ended: true,
      end_reason: "step_up_failed",
      step_up_failures: 5,
    });
    expect(
      (await events(p.participationId, ["step_up_failed"])).map((e) => [e.actor_type, e.details]),
    ).toEqual([["participant", { method: "birth_date" }]]);
    await expect(birthDate(q, "1970-01-01")).rejects.toMatchObject(failsWith("session_invalid"));
  });

  describe("for a photo-ID account", () => {
    beforeEach(async () => {
      // Fixture: an account assured by photo ID (a handed-over sheet or an in-person code).
      await owner.query(
        `update participant_account set identity_assurance = 'photo_id', identity_assured_by = $2,
           identity_assured_at = now() where participation_id = $1`,
        [p.participationId, seedStaffUserIds.backOffice],
      );
    });

    it("needs a step-up code: neither the activation's birth date nor the login code counts", async () => {
      await expect(write(p, "health", health, 0)).rejects.toMatchObject(
        failsWith("step_up_required"),
      );
      await expect(birthDate(p, "1970-01-01")).rejects.toMatchObject(failsWith("step_not_allowed"));
      const loginCode = hex();
      await call(app, "request_login_code", {
        kind: "email",
        address: p.address,
        codeHash: loginCode,
        id: randomUUID(),
      });
      expect(await verify(p, loginCode)).toBe("one_time_code_invalid");

      const code = hex();
      expect(await request(p, code)).toEqual({ kind: "email", address: p.address });
      expect(await verify(p, hex())).toBe("one_time_code_invalid");
      expect(await verify(p, code)).toBe("ok");
      expect(await session(p.tokenHash)).toMatchObject({
        sensitive_step_up_method: "photo_id_and_code",
      });
      expect(await write(p, "health", health, 0)).toBe(1);
      const [completed] = await events(p.participationId, ["step_up_completed"]);
      expect(completed.details).toEqual({
        method: "photo_id_and_code",
        challengeId: expect.any(String),
      });
    });

    it("gives the step-up code its own five attempts; the session goes on", async () => {
      const code = hex();
      await request(p, code);
      for (let i = 0; i < 4; i += 1) expect(await verify(p, hex())).toBe("one_time_code_invalid");
      expect(await verify(p, hex())).toBe("one_time_code_exhausted");
      expect(await verify(p, code)).toBe("one_time_code_invalid");
      expect(await session(p.tokenHash)).toMatchObject({ ended: false });
    });

    it("sends only to a live channel of the participant's own", async () => {
      await expect(request(p, hex(), randomUUID())).rejects.toMatchObject(
        failsWith("channel_not_found"),
      );
      await owner.query(
        "update participant_channel set suspended_at = now(), suspension_reason = 'lost_access' where id = $1",
        [p.channelId],
      );
      await expect(request(p, hex())).rejects.toMatchObject(failsWith("channel_not_found"));
    });
  });
});
