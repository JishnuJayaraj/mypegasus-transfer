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

// Self-service writes (data-protection.md, self-service; Q112, Q138, Q140) as transfer_app calls
// them: the purposes notice, page writes with their revision, participant-maintained contact
// fields and the import that respects them. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = () => randomBytes(32).toString("hex");
const NOTICE = "self-service-purposes:v1";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows;

/** An activated participant of Werk Nord with a live active session. */
async function activated(address = "erika@example.invalid") {
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
       address_postal_code, address_city, address_country, phone, mobile)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE', '030 1234567', '0171 3920000')`,
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
  expect(
    await call(app, "complete_activation", {
      tokenHash: activating,
      newTokenHash: tokenHash,
      noticeVersion: "art14-activation:v1",
      consentVersion: "portal-contact-consent:v1",
      language: "de",
      channelId: randomUUID(),
      consentId: randomUUID(),
      requestId: "req-3",
      oneTimeCodeHash,
    }),
  ).toBe("activated");
  const context = auditContext({ actorType: "participant", participationId, requestId: "req-4" });
  return { participationId, tokenHash, context, activating };
}

type Participant = Awaited<ReturnType<typeof activated>>;

const acknowledge = (p: Participant, args: Record<string, unknown> = {}) =>
  call<boolean>(app, "acknowledge_self_service_notice", {
    participationId: p.participationId,
    context: p.context,
    noticeVersion: NOTICE,
    language: "de",
    id: randomUUID(),
    tokenHash: p.tokenHash,
    ...args,
  });

const write = (
  p: Participant,
  page: string,
  values: Record<string, unknown>,
  revision: number,
  args: Record<string, unknown> = {},
) =>
  call<number>(app, "write_self_service_data", {
    participationId: p.participationId,
    context: p.context,
    page,
    values: JSON.stringify(values),
    revision,
    noticeVersion: NOTICE,
    tokenHash: p.tokenHash,
    ...args,
  });

const changedFields = async (participationId: string) =>
  (
    await all(
      `select actor_type, details from audit_event
       where participation_id = $1 and event_type = 'participant_data_changed' order by seq`,
      [participationId],
    )
  ).map((e) => [e.actor_type, e.details.fields]);

const contact = {
  address: { street: "Neuer Weg 2", postalCode: "20095", city: "Hamburg", country: "DE" },
  phone: "030 1234567",
  mobile: "0171 7654321",
  privateEmail: null,
};

describe("acknowledge_self_service_notice (Q138)", () => {
  it("records the version once, audited, never as a consent", async () => {
    const p = await activated();
    expect(await acknowledge(p, { language: "en" })).toBe(true);
    expect(await acknowledge(p)).toBe(false);
    expect(
      await all(
        `select notice_version, language, actor_type, actor_staff_user_id
         from self_service_notice_acknowledgement where participation_id = $1`,
        [p.participationId],
      ),
    ).toEqual([
      {
        notice_version: NOTICE,
        language: "en",
        actor_type: "participant",
        actor_staff_user_id: null,
      },
    ]);
    const events = await all(
      `select details from audit_event where participation_id = $1
       and event_type = 'self_service_notice_acknowledged'`,
      [p.participationId],
    );
    expect(events).toEqual([
      { details: { acknowledgementId: expect.any(String), noticeVersion: NOTICE, language: "en" } },
    ]);
    // No consent record of a new purpose.
    expect(
      (
        await one("select count(*)::int as n from consent_record where participation_id = $1", [
          p.participationId,
        ])
      ).n,
    ).toBe(1);
  });

  it("is immutable", async () => {
    const p = await activated();
    await acknowledge(p);
    await expect(
      owner.query("update self_service_notice_acknowledgement set language = 'en'"),
    ).rejects.toMatchObject(failsWith("notice_acknowledgement_immutable"));
    await expect(
      owner.query("delete from self_service_notice_acknowledgement"),
    ).rejects.toMatchObject(failsWith("notice_acknowledgement_immutable"));
  });

  it.each([
    ["a malformed version", { noticeVersion: "purposes" }, "invalid_argument"],
    ["no session", { tokenHash: null }, "session_invalid"],
    ["another session", { tokenHash: hex() }, "session_invalid"],
    // Staff act only on the participant's behalf in assisted mode (assisted-mode.int.test.ts).
    ["a staff context outside assisted mode", { context: pl }, "invalid_actor"],
  ])("refuses %s", async (_, args, code) => {
    const p = await activated();
    await expect(acknowledge(p, args)).rejects.toMatchObject(failsWith(code));
  });
});

describe("write_self_service_data (Q140)", () => {
  it("needs the current notice acknowledged first", async () => {
    const p = await activated();
    await expect(write(p, "personal", { gender: "female" }, 0)).rejects.toMatchObject(
      failsWith("notice_required"),
    );
    await acknowledge(p);
    await expect(
      write(p, "personal", { gender: "female" }, 0, { noticeVersion: "self-service-purposes:v2" }),
    ).rejects.toMatchObject(failsWith("notice_required"));
  });

  it("writes a page into the real fields, bumps the revision and audits field names only", async () => {
    const p = await activated();
    await acknowledge(p);
    expect(await write(p, "personal", { gender: "female", maritalStatus: null }, 0)).toBe(1);
    const rows = [
      {
        from: "2005-09-01",
        to: null,
        institution: "Schule",
        qualification: "Abitur",
        completed: true,
      },
    ];
    expect(await write(p, "education", { educationHistory: rows }, 1)).toBe(2);
    expect(
      await write(
        p,
        "languages_mobility",
        {
          languageSkills: { german: "business_fluent", others: [] },
          drivingLicence: "none",
          vehicleAvailable: false,
        },
        2,
      ),
    ).toBe(3);
    expect(
      await write(
        p,
        "job_wish",
        {
          workingTimePreferences: {
            employmentType: "full_time",
            weeklyHours: null,
            distribution: null,
          },
          jobWishes: { desired: "Monteur", alternative: null },
          desiredWorkLocations: "Berlin",
          maxCommuteDistance: { kind: "km", km: 30 },
          earliestStartDate: "2027-04-01",
        },
        3,
      ),
    ).toBe(4);
    expect(await write(p, "further", { "custom.beispiel_nr": "A-1" }, 4)).toBe(5);
    const stored = await one(
      `select gender, marital_status, education_history, driving_licence, vehicle_available,
         desired_work_locations, earliest_start_date::text, custom_fields, revision
       from participant_profile where participation_id = $1`,
      [p.participationId],
    );
    expect(stored).toEqual({
      gender: "female",
      marital_status: null,
      education_history: rows,
      driving_licence: "{}",
      vehicle_available: false,
      desired_work_locations: "Berlin",
      earliest_start_date: "2027-04-01",
      custom_fields: { "custom.beispiel_nr": "A-1" },
      revision: 5,
    });
    expect(await changedFields(p.participationId)).toEqual([
      ["participant", ["gender"]],
      ["participant", ["educationHistory"]],
      ["participant", ["languageSkills", "drivingLicence", "vehicleAvailable"]],
      [
        "participant",
        [
          "workingTimePreferences",
          "jobWishes",
          "desiredWorkLocations",
          "maxCommuteDistance",
          "earliestStartDate",
        ],
      ],
      ["participant", ["custom.beispiel_nr"]],
    ]);
    // The values never reach the trail.
    const trail = JSON.stringify(await all("select * from audit_event", []));
    expect(trail).not.toMatch(/Monteur|Abitur|A-1|Berlin/);
  });

  it("writes nothing for an unchanged page and keeps the revision", async () => {
    const p = await activated();
    await acknowledge(p);
    await write(p, "personal", { gender: "male", maritalStatus: "single" }, 0);
    expect(await write(p, "personal", { gender: "male", maritalStatus: "single" }, 1)).toBe(1);
    expect(await changedFields(p.participationId)).toHaveLength(1);
  });

  it("refuses a stale revision", async () => {
    const p = await activated();
    await acknowledge(p);
    await write(p, "personal", { gender: "male" }, 0);
    await expect(write(p, "personal", { gender: "female" }, 0)).rejects.toMatchObject(
      failsWith("stale_revision"),
    );
    await expect(write(p, "personal", { gender: "female" }, 2)).rejects.toMatchObject(
      failsWith("stale_revision"),
    );
  });

  it("removes a custom field set to null and keeps another chain's", async () => {
    const p = await activated();
    await acknowledge(p);
    await write(p, "further", { "custom.a": 1, "custom.b": true }, 0);
    expect(await write(p, "further", { "custom.a": null }, 1)).toBe(2);
    expect(
      (
        await one("select custom_fields from participant_profile where participation_id = $1", [
          p.participationId,
        ])
      ).custom_fields,
    ).toEqual({ "custom.b": true });
  });

  it.each([
    ["an unknown page", "health", { healthRestrictions: true }],
    ["a sensitive key", "personal", { gender: "male", nationality: "DE" }],
    ["another page's key", "personal", { phone: "030 1" }],
    ["a value outside the set", "personal", { gender: "other" }],
    ["an impossible date", "job_wish", { earliestStartDate: "2027-02-30" }],
    ["a malformed date", "job_wish", { earliestStartDate: "30.01.2027" }],
    ["too many rows", "work_history", { workHistory: Array.from({ length: 21 }, () => ({})) }],
    ["a licence class outside the set", "languages_mobility", { drivingLicence: ["X"] }],
    ["a licence answer other than none", "languages_mobility", { drivingLicence: "keiner" }],
    ["a structured custom value", "further", { "custom.a": { x: 1 } }],
    ["a malformed custom key", "further", { "custom.A": 1 }],
    ["an address without a city", "contact", { address: { street: "x", postalCode: "12345" } }],
    ["a foreign address", "contact", { address: { ...contact.address, country: "AT" } }],
    ["a phone too long", "contact", { phone: "0".repeat(31) }],
  ])("refuses %s with a code, never the value", async (_, page, values) => {
    const p = await activated();
    await acknowledge(p);
    await expect(write(p, page, values, 0)).rejects.toMatchObject(failsWith("invalid_argument"));
  });

  it("refuses a closed participation, a dead or activating session and staff outside assisted mode", async () => {
    const p = await activated();
    await acknowledge(p);
    await expect(write(p, "personal", {}, 0, { tokenHash: p.activating })).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await expect(write(p, "personal", {}, 0, { context: pl })).rejects.toMatchObject(
      failsWith("invalid_actor"),
    );
    const other = await activated("other@example.invalid");
    await expect(write(p, "personal", {}, 0, { tokenHash: other.tokenHash })).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await changeStatus(app, p.participationId, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-10-21",
    });
    await expect(write(p, "personal", { gender: "male" }, 0)).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
    await expect(acknowledge(other, { participationId: p.participationId })).rejects.toMatchObject(
      failsWith("invalid_actor"),
    );
  });
});

describe("participant-maintained contact fields (Q112)", () => {
  it("are the changed ones, with the address's time", async () => {
    const p = await activated();
    await acknowledge(p);
    expect(await write(p, "contact", contact, 0)).toBe(1);
    expect(
      await one(
        `select address_city, phone, mobile, private_email, participant_maintained,
           participant_address_written_at is not null as "addressWritten"
         from participant_details where participation_id = $1`,
        [p.participationId],
      ),
    ).toEqual({
      address_city: "Hamburg",
      phone: "030 1234567",
      mobile: "0171 7654321",
      private_email: null,
      participant_maintained: ["address", "mobile"],
      addressWritten: true,
    });
    await write(p, "contact", { ...contact, phone: null }, 1);
    expect(
      (
        await one(
          "select participant_maintained from participant_details where participation_id = $1",
          [p.participationId],
        )
      ).participant_maintained,
    ).toEqual(["address", "phone", "mobile"]);
    expect(await changedFields(p.participationId)).toEqual([
      ["participant", ["address", "mobile"]],
      ["participant", ["phone"]],
    ]);
  });

  it("are never overwritten by write_participant_data, which writes the others", async () => {
    const p = await activated();
    await acknowledge(p);
    await write(p, "contact", { ...contact, phone: "030 1234567" }, 0);
    const event = await call<string | null>(app, "write_participant_data", {
      participationId: p.participationId,
      context: pl,
      addressStreet: "Importweg 9",
      addressPostalCode: "10115",
      addressCity: "Berlin",
      addressCountry: "DE",
      mobile: "0171 0000000",
      phone: "030 9999999",
      workEmail: "erika@werk.example",
    });
    expect(event).not.toBeNull();
    expect(
      await one(
        `select address_street, mobile, phone, work_email from participant_details
         where participation_id = $1`,
        [p.participationId],
      ),
    ).toEqual({
      address_street: "Neuer Weg 2",
      mobile: "0171 7654321",
      phone: "030 9999999",
      work_email: "erika@werk.example",
    });
    expect((await changedFields(p.participationId)).at(-1)).toEqual([
      "user",
      ["phone", "workEmail"],
    ]);
    // Only maintained differences: nothing to write.
    expect(
      await call(app, "write_participant_data", {
        participationId: p.participationId,
        context: pl,
        mobile: "0171 1111111",
      }),
    ).toBeNull();
  });
});

describe("the runtime role (ADR-0002)", () => {
  it("selects the new tables and writes none of them", async () => {
    for (const table of ["participant_profile", "self_service_notice_acknowledgement"]) {
      await app.query(`select * from ${table}`);
      for (const statement of [
        `insert into ${table} (participation_id) values (gen_random_uuid())`,
        `update ${table} set project_id = project_id`,
        `delete from ${table}`,
      ]) {
        await expect(app.query(statement)).rejects.toMatchObject({ code: "42501" });
      }
    }
    await expect(
      app.query("update participant_details set participant_maintained = '{}'"),
    ).rejects.toMatchObject({ code: "42501" });
    for (const fn of ["lock_self_service_writer", "keep_notice_acknowledgement_immutable"]) {
      const { rows } = await owner.query(
        "select has_function_privilege('transfer_app', p.oid, 'execute') as can from pg_proc p where proname = $1",
        [fn],
      );
      expect(rows).toEqual([{ can: false }]);
    }
  });
});

/** A consent record written as the owner, as staff record one from a paper form. */
const insert = (
  participationId: string,
  purpose: string,
  channel: string | null,
  source = "portal",
) =>
  owner.query(
    `insert into consent_record (project_id, participation_id, purpose, source, channel_id,
       text_version, language, actor_type, actor_staff_user_id)
     values ($1, $2, $3, $4, $5, 'kug200b:v1', 'de', 'user', $6)`,
    [
      seedProjectIds.werkNord,
      participationId,
      purpose,
      source,
      channel,
      seedStaffUserIds.projectLead,
    ],
  );

describe("consent_record (Q138)", () => {
  it("takes a channel exactly for portal_contact, given in the portal", async () => {
    const p = await activated();
    const channel = await one("select channel_id from consent_record where participation_id = $1", [
      p.participationId,
    ]);
    expect(
      await one("select source from consent_record where participation_id = $1", [
        p.participationId,
      ]),
    ).toEqual({ source: "portal" });
    await insert(p.participationId, "kug200b_profile_access", null, "paper_form");
    for (const [purpose, ch, source] of [
      ["kug200b_profile_access", channel.channel_id, "paper_form"],
      ["portal_contact", null, "portal"],
      ["portal_contact", channel.channel_id, "paper_form"],
    ] as const) {
      await expect(insert(p.participationId, purpose, ch, source)).rejects.toMatchObject({
        code: "23514",
      });
    }
  });
});
