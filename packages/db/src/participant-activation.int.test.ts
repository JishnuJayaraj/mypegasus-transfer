import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  createWave,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// Slice 3 plan, PR 3e (D21–D29): the activation functions, as transfer_app calls them.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = () => randomBytes(32).toString("hex");
const NOTICE = "art14-activation:v1";
const CONSENT = "portal-contact-consent:v1";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

async function participation(
  options: { birthDate?: string | null; workEmail?: string; entryWaveId?: string } = {},
) {
  const id = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
    ...(options.entryWaveId && { entryWaveId: options.entryWaveId }),
  });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', $4)`,
    [
      id,
      seedProjectIds.werkNord,
      `SYN-${id.slice(-8)}`,
      options.birthDate === undefined ? "1970-01-01" : options.birthDate,
    ],
  );
  await owner.query(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country, work_email)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE', $3)`,
    [id, seedProjectIds.werkNord, options.workEmail ?? null],
  );
  return id;
}

/** Issues a code as the PL; an in-person code is sent (`sent`) unless told otherwise. */
async function issue(
  participationId: string,
  channel: "letter" | "sheet" | "in_person" = "letter",
  options: { addressHash?: string; replace?: boolean } = {},
) {
  const id = randomUUID();
  const codeHash = hex();
  await call(app, "issue_activation_code", {
    participationId,
    codeHash,
    channel,
    language: "en",
    noticeVersion: NOTICE,
    replaceOpenCode: options.replace ?? false,
    deliveryKind: channel === "in_person" ? "email" : null,
    deliveryAddressHash: channel === "in_person" ? (options.addressHash ?? hex()) : null,
    identityChecked: channel === "in_person",
    context: pl,
    id,
  });
  if (channel === "sheet")
    await call(app, "hand_over_activation_code", { activationCodeId: id, context: pl });
  if (channel === "in_person") {
    await call(app, "record_activation_delivery", {
      activationCodeId: id,
      outcome: "sent",
      context: pl,
    });
  }
  return { id, codeHash };
}

const start = (codeHash: string, tokenHash = hex()) =>
  call<Record<string, unknown> | null>(app, "start_activation", {
    codeHash,
    tokenHash,
    requestId: "req-1",
  }).then((result) => ({ result, tokenHash }));

const birthDate = (tokenHash: string, value = "1970-01-01") =>
  call(app, "check_activation_birth_date", { tokenHash, birthDate: value, requestId: "req-2" });

const oneTimeCode = (tokenHash: string, address = "person@example.invalid", codeHash = hex()) =>
  call(app, "create_one_time_code", {
    tokenHash,
    kind: "email",
    address,
    codeHash,
    id: randomUUID(),
  }).then(() => codeHash);

function complete(
  tokenHash: string,
  verification:
    | { oneTimeCodeHash: string }
    | { deliveryAddress: string; deliveryAddressHash: string },
  newTokenHash = hex(),
) {
  return call(app, "complete_activation", {
    tokenHash,
    newTokenHash,
    noticeVersion: NOTICE,
    consentVersion: CONSENT,
    language: "en",
    channelId: randomUUID(),
    consentId: randomUUID(),
    requestId: "req-3",
    ...verification,
  });
}

/** Moves a test wave's dates into the past (cutoff passed) or back (createWave's dates). */
const cutoffPassed = (waveId: string, passed = true) =>
  owner.query(
    `update project_entry_wave set signing_deadline = $2, default_tg_start = $3,
       default_tg_end = $4, latest_entry_date = $5 where id = $1`,
    passed
      ? [waveId, "2024-12-01", "2024-12-15", "2025-12-14", "2025-01-01"]
      : [waveId, "2027-02-15", "2027-03-01", "2028-02-29", "2027-03-15"],
  );

const one = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows;
const events = (participationId: string) =>
  all(
    `select event_type, actor_type, actor_participation_id, system_job, field, from_value, to_value,
       reason_code, details from audit_event where participation_id = $1 order by seq`,
    [participationId],
  );

describe("start_activation (D22, D23)", () => {
  it("starts an activating session for an open code and tells the steps", async () => {
    const participationId = await participation();
    const { id, codeHash } = await issue(participationId);
    const { result, tokenHash } = await start(codeHash);
    expect(result).toEqual({
      channel: "letter",
      deliveryKind: null,
      language: "en",
      needsBirthDate: true,
    });
    expect(
      await one(
        "select state, activation_code_id, ended_at from participant_session where token_hash = $1",
        [tokenHash],
      ),
    ).toEqual({ state: "activating", activation_code_id: id, ended_at: null });
  });

  it("gives the one generic answer for unknown, revoked, expired, used, locked or unhanded codes and counts nothing", async () => {
    expect((await start(hex())).result).toBeNull();
    const participationId = await participation();
    const revoked = await issue(participationId);
    await issue(participationId, "letter", { replace: true });
    expect((await start(revoked.codeHash)).result).toBeNull();

    const sheet = await participation();
    const unhanded = hex();
    await call(app, "issue_activation_code", {
      participationId: sheet,
      codeHash: unhanded,
      channel: "sheet",
      language: "de",
      noticeVersion: NOTICE,
      replaceOpenCode: false,
      deliveryKind: null,
      deliveryAddressHash: null,
      identityChecked: false,
      context: pl,
      id: randomUUID(),
    });
    expect((await start(unhanded)).result).toBeNull();

    const expired = await participation();
    const old = await issue(expired);
    await owner.query(
      "update activation_code set issued_at = now() - interval '31 days', expires_at = now() - interval '1 day' where id = $1",
      [old.id],
    );
    expect((await start(old.codeHash)).result).toBeNull();
    expect(
      await all("select failed_attempts from activation_code where failed_attempts > 0", []),
    ).toEqual([]);
    expect(await all("select token_hash from participant_session", [])).toEqual([]);
  });

  it("refuses a valid code past the participation's cutoff (Q121)", async () => {
    const waveId = await createWave(owner);
    const participationId = await participation({ entryWaveId: waveId });
    const { codeHash } = await issue(participationId);
    await cutoffPassed(waveId);
    await expect(start(codeHash)).rejects.toMatchObject(failsWith("before_cutoff"));
  });

  it("supersedes an earlier session of the same code", async () => {
    const { codeHash } = await issue(await participation());
    const first = await start(codeHash);
    await start(codeHash);
    expect(
      await one("select end_reason from participant_session where token_hash = $1", [
        first.tokenHash,
      ]),
    ).toEqual({ end_reason: "superseded" });
    await expect(birthDate(first.tokenHash)).rejects.toMatchObject(failsWith("session_invalid"));
  });
});

describe("knowledge checks (D14)", () => {
  it("records a matching birth date as the session's step-up", async () => {
    const { codeHash } = await issue(await participation());
    const { tokenHash } = await start(codeHash);
    expect(await birthDate(tokenHash)).toBe("ok");
    expect(
      await one(
        "select birth_date_checked_at is not null as checked, step_up_method from participant_session where token_hash = $1",
        [tokenHash],
      ),
    ).toEqual({ checked: true, step_up_method: "birth_date" });
    await expect(birthDate(tokenHash)).rejects.toMatchObject(failsWith("step_not_allowed"));
  });

  it("counts wrong birth dates on the code and locks it atomically at the fifth", async () => {
    const participationId = await participation();
    const { id, codeHash } = await issue(participationId);
    const { tokenHash } = await start(codeHash);
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await birthDate(tokenHash, "1971-01-01")).toBe("mismatch");
    }
    expect(await birthDate(tokenHash, "1971-01-01")).toBe("locked");
    expect(
      await one(
        "select failed_attempts, locked_at is not null as locked from activation_code where id = $1",
        [id],
      ),
    ).toEqual({ failed_attempts: 5, locked: true });
    expect(
      await one("select end_reason from participant_session where token_hash = $1", [tokenHash]),
    ).toEqual({ end_reason: "code_closed" });
    expect((await events(participationId)).at(-1)).toMatchObject({
      event_type: "activation_code_locked",
      actor_type: "system",
      system_job: "portal-activation",
      details: { activationCodeId: id },
    });
    expect((await start(codeHash)).result).toBeNull();
  });

  it("checks an in-person code's delivery address by its keyed hash and counts a mismatch", async () => {
    const participationId = await participation({ birthDate: null });
    const addressHash = hex();
    const { id, codeHash } = await issue(participationId, "in_person", { addressHash });
    const { result, tokenHash } = await start(codeHash);
    expect(result).toMatchObject({
      channel: "in_person",
      deliveryKind: "email",
      needsBirthDate: false,
    });
    await expect(birthDate(tokenHash)).rejects.toMatchObject(failsWith("step_not_allowed"));
    await expect(oneTimeCode(tokenHash)).rejects.toMatchObject(failsWith("step_not_allowed"));
    const check = (hash: string) =>
      call(app, "check_activation_delivery_address", {
        tokenHash,
        addressHash: hash,
        requestId: "r",
      });
    expect(await check(hex())).toBe("mismatch");
    expect(await check(addressHash)).toBe("ok");
    expect(await one("select failed_attempts from activation_code where id = $1", [id])).toEqual({
      failed_attempts: 1,
    });
  });
});

describe("one-time codes for channel verification (D20, D27)", () => {
  it("needs the birth-date step first and refuses the imported work email", async () => {
    const participationId = await participation({ workEmail: "Erika.Beispiel@Werk.Example" });
    const { tokenHash } = await start((await issue(participationId)).codeHash);
    await expect(oneTimeCode(tokenHash)).rejects.toMatchObject(failsWith("step_not_allowed"));
    await birthDate(tokenHash);
    await expect(oneTimeCode(tokenHash, "erika.beispiel@werk.example")).rejects.toMatchObject(
      failsWith("channel_invalid"),
    );
    await expect(oneTimeCode(tokenHash, "Not Normalised@x")).rejects.toMatchObject(
      failsWith("channel_invalid"),
    );
  });

  it("allows five codes per address and hour across participations, and supersedes older ones", async () => {
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const { tokenHash } = await start((await issue(await participation())).codeHash);
      await birthDate(tokenHash);
      sessions.push(tokenHash);
    }
    for (let i = 0; i < 4; i++) await oneTimeCode(sessions[0]!, "shared@example.invalid");
    await oneTimeCode(sessions[1]!, "shared@example.invalid");
    await expect(oneTimeCode(sessions[1]!, "shared@example.invalid")).rejects.toMatchObject(
      failsWith("rate_limited"),
    );
    await oneTimeCode(sessions[1]!, "other@example.invalid");
    expect(
      await all(
        `select invalidation_reason, count(*)::int as n from one_time_code_challenge
         group by invalidation_reason order by invalidation_reason`,
        [],
      ),
    ).toEqual([
      { invalidation_reason: "superseded", n: 4 },
      { invalidation_reason: null, n: 2 },
    ]);
  });

  it("records the send's outcome: a failure invalidates, unless a newer code already did", async () => {
    const { tokenHash } = await start((await issue(await participation())).codeHash);
    await birthDate(tokenHash);
    await oneTimeCode(tokenHash);
    await oneTimeCode(tokenHash);
    const [older, newer] = await all(
      "select id from one_time_code_challenge order by created_at, id",
      [],
    );
    const record = (challengeId: string, outcome: string) =>
      call(app, "record_one_time_code_delivery", { tokenHash, challengeId, outcome });
    await record(newer.id, "failed");
    await record(older.id, "failed");
    expect(
      await all(
        "select id, delivery_status, invalidation_reason from one_time_code_challenge order by created_at, id",
        [],
      ),
    ).toEqual([
      { id: older.id, delivery_status: "failed", invalidation_reason: "superseded" },
      { id: newer.id, delivery_status: "failed", invalidation_reason: "delivery_failed" },
    ]);
    await expect(record(newer.id, "sent")).rejects.toMatchObject(
      failsWith("invalid_delivery_state"),
    );
    await expect(
      call(app, "record_one_time_code_delivery", {
        tokenHash: hex(),
        challengeId: newer.id,
        outcome: "sent",
      }),
    ).rejects.toMatchObject(failsWith("challenge_not_found"));
  });
});

/** A letter's participation past the birth-date step, with a one-time code sent. */
async function ready(options: Parameters<typeof participation>[0] = {}) {
  const participationId = await participation(options);
  const code = await issue(participationId);
  const { tokenHash } = await start(code.codeHash);
  await birthDate(tokenHash);
  const otp = await oneTimeCode(tokenHash);
  return { participationId, code, tokenHash, otp };
}

const logout = (tokenHash: string) =>
  call(app, "end_participant_session", { tokenHash, requestId: "req-9" });

describe("complete_activation (D23, D25, D28, D29)", () => {
  it("activates in one transaction: code, account, consent, channel, status, audit, sessions", async () => {
    const { participationId, code, tokenHash, otp } = await ready();
    const newToken = hex();
    expect(await complete(tokenHash, { oneTimeCodeHash: otp }, newToken)).toBe("activated");

    expect(
      await one("select used_at is not null as used from activation_code where id = $1", [code.id]),
    ).toEqual({
      used: true,
    });
    expect(
      await one(
        "select identity_assurance, identity_assured_by, language, activation_code_id from participant_account where participation_id = $1",
        [participationId],
      ),
    ).toEqual({
      identity_assurance: "birth_date",
      identity_assured_by: null,
      language: "en",
      activation_code_id: code.id,
    });
    const channel = await one(
      "select id, kind, address, verified_by, consent_id from participant_channel where participation_id = $1",
      [participationId],
    );
    expect(channel).toMatchObject({
      kind: "email",
      address: "person@example.invalid",
      verified_by: "one_time_code",
    });
    expect(
      await one(
        "select purpose, channel_id, text_version, language, actor_type from consent_record where id = $1",
        [channel.consent_id],
      ),
    ).toEqual({
      purpose: "portal_contact",
      channel_id: channel.id,
      text_version: CONSENT,
      language: "en",
      actor_type: "participant",
    });
    expect(await one("select status from participation where id = $1", [participationId])).toEqual({
      status: "contacted",
    });
    const trail = (await events(participationId)).filter((e) => e.actor_type === "participant");
    expect(trail.map((e) => e.event_type)).toEqual([
      "participant_activated",
      "consent_given",
      "contact_channel_added",
      "status_changed",
    ]);
    expect(trail[0]).toMatchObject({
      actor_participation_id: participationId,
      details: {
        activationCodeId: code.id,
        identityAssurance: "birth_date",
        noticeVersion: NOTICE,
        language: "en",
      },
    });
    expect(trail[3]).toMatchObject({
      field: "status",
      from_value: "imported",
      to_value: "contacted",
    });
    expect(JSON.stringify(await events(participationId))).not.toContain("example.invalid");
    expect(
      await all(
        "select state, end_reason, step_up_method from participant_session where participation_id = $1 order by created_at, state",
        [participationId],
      ),
    ).toEqual([
      { state: "activating", end_reason: "activated", step_up_method: "birth_date" },
      { state: "active", end_reason: null, step_up_method: "birth_date" },
    ]);
    expect(
      await one("select state from participant_session where token_hash = $1", [newToken]),
    ).toEqual({ state: "active" });
  });

  it("counts a wrong one-time code without writing anything else, and the fifth ends it", async () => {
    const { participationId, tokenHash, otp } = await ready();
    for (let i = 0; i < 4; i++) {
      expect(await complete(tokenHash, { oneTimeCodeHash: hex() })).toBe("one_time_code_invalid");
    }
    expect(await complete(tokenHash, { oneTimeCodeHash: hex() })).toBe("one_time_code_exhausted");
    expect(await complete(tokenHash, { oneTimeCodeHash: otp })).toBe("one_time_code_invalid");
    expect(await all("select 1 from participant_account", [])).toEqual([]);
    expect((await events(participationId)).at(-1)).toMatchObject({
      event_type: "one_time_code_exhausted",
      actor_type: "system",
      details: { purpose: "channel_verification" },
    });
    // A new code works again.
    expect(await complete(tokenHash, { oneTimeCodeHash: await oneTimeCode(tokenHash) })).toBe(
      "activated",
    );
  });

  it("keeps contacted, informed and later statuses as they are", async () => {
    const { participationId, tokenHash, otp } = await ready();
    await changeStatus(app, participationId, {
      field: "status",
      from: "imported",
      to: "contacted",
    });
    await changeStatus(app, participationId, {
      field: "status",
      from: "contacted",
      to: "informed",
    });
    expect(await complete(tokenHash, { oneTimeCodeHash: otp })).toBe("activated");
    expect(await one("select status from participation where id = $1", [participationId])).toEqual({
      status: "informed",
    });
  });

  it("checks the cutoff again by database time and leaves nothing on any refusal", async () => {
    const waveId = await createWave(owner);
    const { participationId, tokenHash, otp } = await ready({ entryWaveId: waveId });
    await cutoffPassed(waveId);
    await expect(complete(tokenHash, { oneTimeCodeHash: otp })).rejects.toMatchObject(
      failsWith("before_cutoff"),
    );
    await cutoffPassed(waveId, false);
    // Another account took the address meanwhile: the generic collision, and still nothing.
    const other = await ready();
    await complete(other.tokenHash, { oneTimeCodeHash: other.otp });
    await expect(complete(tokenHash, { oneTimeCodeHash: otp })).rejects.toMatchObject(
      failsWith("channel_in_use"),
    );
    expect(
      await all("select 1 from participant_account where participation_id = $1", [participationId]),
    ).toEqual([]);
    expect(
      await one("select consumed_at from one_time_code_challenge where code_hash = $1", [otp]),
    ).toEqual({ consumed_at: null });
    expect(await one("select status from participation where id = $1", [participationId])).toEqual({
      status: "imported",
    });
  });

  it("activates an in-person code without a birth date by the photo ID and the retyped address (Q129)", async () => {
    const participationId = await participation({ birthDate: null });
    const addressHash = hex();
    const code = await issue(participationId, "in_person", { addressHash });
    const { tokenHash } = await start(code.codeHash);
    const address = {
      deliveryAddress: "private@example.invalid",
      deliveryAddressHash: addressHash,
    };
    await expect(complete(tokenHash, address)).rejects.toMatchObject(failsWith("step_not_allowed"));
    await call(app, "check_activation_delivery_address", {
      tokenHash,
      addressHash,
      requestId: "r",
    });
    expect(await complete(tokenHash, { ...address, deliveryAddressHash: hex() })).toBe("mismatch");
    expect(await complete(tokenHash, address)).toBe("activated");
    expect(
      await one(
        `select a.identity_assurance, a.identity_assured_by = c.identity_checked_by as by_checker,
           a.identity_assured_at = c.identity_checked_at as at_check
         from participant_account a join activation_code c on c.id = a.activation_code_id
         where a.participation_id = $1`,
        [participationId],
      ),
    ).toEqual({ identity_assurance: "photo_id", by_checker: true, at_check: true });
    expect(
      await one("select verified_by from participant_channel where participation_id = $1", [
        participationId,
      ]),
    ).toEqual({ verified_by: "activation_link" });
    expect(
      await one("select step_up_method from participant_session where state = 'active'", []),
    ).toEqual({ step_up_method: null });
  });

  it("refuses a reissue for an activated account (D17)", async () => {
    const { participationId, tokenHash, otp } = await ready();
    await complete(tokenHash, { oneTimeCodeHash: otp });
    await expect(issue(participationId, "letter", { replace: true })).rejects.toMatchObject(
      failsWith("already_activated"),
    );
  });
});

describe("the status edges (D25)", () => {
  it("never lets change_participation_status take a participant's edge", async () => {
    const participationId = await participation();
    await expect(
      changeStatus(app, participationId, {
        field: "status",
        from: "imported",
        to: "contacted",
        context: auditContext({ actorType: "participant", participationId }),
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });
});

describe("sessions (D26, D29)", () => {
  it("ends every session of a participation that becomes terminal", async () => {
    const participationId = await participation();
    const { tokenHash } = await start((await issue(participationId)).codeHash);
    await changeStatus(app, participationId, {
      field: "status",
      from: "imported",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-10-21",
    });
    expect(
      await one("select end_reason from participant_session where token_hash = $1", [tokenHash]),
    ).toEqual({ end_reason: "participation_closed" });
  });

  it("logs out: ends the session and audits an active one's logout", async () => {
    const participationId = await participation();
    const { tokenHash } = await start((await issue(participationId)).codeHash);
    await birthDate(tokenHash);
    const otp = await oneTimeCode(tokenHash);
    const active = hex();
    await complete(tokenHash, { oneTimeCodeHash: otp }, active);
    expect(await logout(active)).toBe(true);
    expect(await logout(active)).toBe(false);
    expect((await events(participationId)).at(-1)).toMatchObject({
      event_type: "participant_logout",
      actor_type: "participant",
      actor_participation_id: participationId,
    });
  });

  it("records the activation notice once (D21)", async () => {
    const participationId = await participation();
    const { tokenHash } = await start((await issue(participationId)).codeHash);
    await birthDate(tokenHash);
    await complete(tokenHash, { oneTimeCodeHash: await oneTimeCode(tokenHash) });
    const { id } = await one("select id from participant_channel where participation_id = $1", [
      participationId,
    ]);
    expect(await call(app, "mark_activation_notice_sent", { channelId: id })).toBe(true);
    expect(await call(app, "mark_activation_notice_sent", { channelId: id })).toBe(false);
  });
});
