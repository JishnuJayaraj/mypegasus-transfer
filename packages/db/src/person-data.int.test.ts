import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { auditContext, call, pl, resetTestDatabase, testDatabaseUrls, textDates } from "./testing";

// Slice 2 plan 5.3 and 5.10 (PR 2f; AC-22): the person-data tables are written only through
// write_participant_data, which keeps stored values for null arguments, never changes the
// Personalnummer and audits the changed fields as keys, never values. Synthetic values only (D8).
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner, types: textDates });
const app = new Client({ connectionString: urls.app, types: textDates });

beforeAll(() => Promise.all([owner.connect(), app.connect()]));
afterAll(() => Promise.all([owner.end(), app.end()]));

let participationId: string;
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  participationId = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
  });
});

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const identity = { personnelNumber: "BSP-0001", lastName: "Mustermann", firstName: "Erika" };
const address = {
  addressStreet: "Musterstraße 1",
  addressPostalCode: "99999",
  addressCity: "Beispielstadt",
  addressCountry: "DE",
};
const write = (args: Record<string, unknown>, id = participationId) =>
  call<string | null>(app, "write_participant_data", { participationId: id, context: pl, ...args });

const events = async () =>
  (
    await owner.query(
      `select event_type, participation_id, actor_staff_user_id, details from audit_event
       where event_type = 'participant_data_changed' order by seq`,
    )
  ).rows;
const stored = async () => ({
  identity: (
    await owner.query(
      `select project_id, personnel_number, last_name, first_name, birth_date
       from participant_identity where participation_id = $1`,
      [participationId],
    )
  ).rows[0],
  details: (
    await owner.query(
      `select address_street, address_postal_code, address_city, address_country, phone, mobile,
         private_email, work_email, old_employment_end_date
       from participant_details where participation_id = $1`,
      [participationId],
    )
  ).rows[0],
});

describe("write_participant_data (5.3, AC-22)", () => {
  it("writes both rows on the first write and audits the fields set, never values", async () => {
    const event = await write({
      ...identity,
      birthDate: "1970-02-01",
      ...address,
      privateEmail: "erika@example.org",
    });
    expect(event).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stored()).toEqual({
      identity: {
        project_id: seedProjectIds.werkNord,
        personnel_number: "BSP-0001",
        last_name: "Mustermann",
        first_name: "Erika",
        birth_date: "1970-02-01",
      },
      details: {
        address_street: "Musterstraße 1",
        address_postal_code: "99999",
        address_city: "Beispielstadt",
        address_country: "DE",
        phone: null,
        mobile: null,
        private_email: "erika@example.org",
        work_email: null,
        old_employment_end_date: null,
      },
    });
    const [audit] = await events();
    expect(audit).toEqual({
      event_type: "participant_data_changed",
      participation_id: participationId,
      actor_staff_user_id: seedStaffUserIds.projectLead,
      details: {
        fields: [
          "personnelNumber",
          "lastName",
          "firstName",
          "birthDate",
          "address",
          "privateEmail",
        ],
      },
    });
    expect(JSON.stringify(await events())).not.toContain("Mustermann");
  });

  it("writes only the identity when no detail is given", async () => {
    await write(identity);
    expect((await stored()).details).toBeUndefined();
  });

  it("keeps stored values for null arguments and audits exactly the changed keys", async () => {
    await write({ ...identity, ...address, phone: "030 1234567" });
    const event = await write({
      ...identity,
      lastName: "Musterfrau",
      ...address,
      addressCity: "Musterhausen",
      mobile: "0151 2345678",
    });
    expect(event).not.toBeNull();
    const { identity: i, details: d } = await stored();
    expect([i.last_name, i.first_name, d.address_city, d.phone, d.mobile]).toEqual([
      "Musterfrau",
      "Erika",
      "Musterhausen",
      "030 1234567",
      "0151 2345678",
    ]);
    expect((await events()).map((e) => e.details.fields)).toEqual([
      ["personnelNumber", "lastName", "firstName", "address", "phone"],
      ["lastName", "address", "mobile"],
    ]);
    // A write of the stored values (or of nothing) writes nothing and returns null.
    expect(await write({ ...identity, lastName: "Musterfrau" })).toBeNull();
    expect(await write({})).toBeNull();
    expect(await events()).toHaveLength(2);
  });

  it("needs the identity first, the address whole, and never changes the Personalnummer", async () => {
    expect(await refusal(write({ lastName: "Mustermann", firstName: "Erika" }))).toBe(
      "identity_required",
    );
    expect(await refusal(write({ ...identity, ...address, addressCity: null }))).toBe(
      "address_incomplete",
    );
    await write(identity);
    expect(await refusal(write({ personnelNumber: "BSP-0002" }))).toBe(
      "personnel_number_immutable",
    );
    expect(await write({ personnelNumber: "BSP-0001", birthDate: "1970-02-01" })).not.toBeNull();
  });

  it("keeps the Personalnummer unique in the project", async () => {
    await write(identity);
    const other = await call(app, "create_participation", {
      projectId: seedProjectIds.werkNord,
      context: pl,
    });
    expect(await refusal(write(identity, other))).toBe("personnel_number_taken");
    const elsewhere = await call(app, "create_participation", {
      projectId: seedProjectIds.verwaltung,
      context: pl,
    });
    expect(await refusal(write(identity, elsewhere))).toBe("ok");
  });

  it.each([
    ["an untrimmed name", { lastName: " Mustermann" }],
    ["a control character", { firstName: "Er\u0007ika" }],
    ["a long Personalnummer", { personnelNumber: "1".repeat(51) }],
    ["a foreign country", { ...address, addressCountry: "AT" }],
    ["a lowercase country", { ...address, addressCountry: "de" }],
    ["a four-digit postal code", { ...address, addressPostalCode: "9999" }],
    ["a long phone number", { phone: "1".repeat(31) }],
  ])("refuses %s without naming the value", async (_, args) => {
    expect(await refusal(write({ ...identity, ...args }))).toBe("invalid_argument");
    expect(await stored()).toEqual({ identity: undefined, details: undefined });
  });

  it("refuses assisted mode, a participant actor and an unknown participation", async () => {
    const assisted = auditContext({
      actorType: "user",
      staffUserId: seedStaffUserIds.projectLead,
      onBehalfOf: participationId,
    });
    expect(await refusal(write({ ...identity, context: assisted }))).toBe("invalid_actor");
    const participant = auditContext({ actorType: "participant", participationId });
    expect(await refusal(write({ ...identity, context: participant }))).toBe("actor_not_allowed");
    expect(await refusal(write(identity, "00000000-0000-4000-a000-999999999999"))).toBe(
      "participation_not_found",
    );
  });

  it("is the only write path: transfer_app may only select, record_audit_event refuses the type", async () => {
    await write(identity);
    for (const statement of [
      `insert into participant_identity (participation_id, project_id, personnel_number, last_name, first_name) values ('${participationId}', '${seedProjectIds.werkNord}', 'X', 'X', 'X')`,
      `update participant_identity set last_name = 'X'`,
      `delete from participant_identity`,
      `insert into participant_details (participation_id, project_id) values ('${participationId}', '${seedProjectIds.werkNord}')`,
      `update participant_details set phone = '030 1234567'`,
      `delete from participant_details`,
    ]) {
      expect(await refusal(app.query(statement))).toBe("42501");
    }
    expect((await app.query("select count(*)::int as n from participant_identity")).rows).toEqual([
      { n: 1 },
    ]);
    const recorded = call(app, "record_audit_event", {
      projectId: seedProjectIds.werkNord,
      participationId,
      eventType: "participant_data_changed",
      context: pl,
      details: { fields: ["lastName"] },
    });
    expect(await refusal(recorded)).toBe("event_type_reserved");
  });

  it("needs a participation for the event type", async () => {
    const insert = owner.query(
      `insert into audit_event (project_id, event_type, actor_type, actor_staff_user_id, details)
       values ($1, 'participant_data_changed', 'user', $2, '{"fields": ["lastName"]}')`,
      [seedProjectIds.werkNord, seedStaffUserIds.projectLead],
    );
    expect(await refusal(insert)).toBe("23514");
  });
});
