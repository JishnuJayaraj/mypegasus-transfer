import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { resetTestDatabase, testDatabaseUrls } from "./testing";

// AC-18 (plan 5.4): the table itself keeps actors consistent and free text out, whoever writes.
// Inserted as the owner, which bypasses the functions on purpose.
const owner = new Client({ connectionString: testDatabaseUrls().owner });

beforeAll(async () => {
  await owner.connect();
  await resetTestDatabase({ seed: true });
});
afterAll(() => owner.end());

const valid = {
  project_id: seedProjectIds.werkNord,
  participation_id: "00000000-0000-4000-a000-000000000001",
  event_type: "status_changed",
  actor_type: "system",
  system_job: "seed",
  field: "status",
  from_value: "imported",
  to_value: "contacted",
};

async function insert(values: Record<string, unknown>) {
  const columns = Object.keys(values);
  await owner.query("begin");
  try {
    await owner.query(
      `insert into audit_event (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      columns.map((c) => (c === "details" ? JSON.stringify(values[c]) : values[c])),
    );
  } finally {
    await owner.query("rollback");
  }
}

const checkViolation = (constraint: string) => ({ code: "23514", constraint });
const sentence = "Teilnehmerin ist erkrankt, siehe Telefonat";

describe("audit_event actors (AC-18)", () => {
  const staff = seedStaffUserIds.projectLead;
  const someone = "00000000-0000-4000-a000-000000000002";

  it.each([
    ["a user", { actor_type: "user", system_job: null, actor_staff_user_id: staff }],
    [
      "a user in assisted mode",
      {
        actor_type: "user",
        system_job: null,
        actor_staff_user_id: staff,
        on_behalf_of_participation_id: someone,
      },
    ],
    [
      "a participant",
      { actor_type: "participant", system_job: null, actor_participation_id: someone },
    ],
    ["the system", {}],
  ])("accepts %s", async (_label, actor) => {
    await expect(insert({ ...valid, ...actor })).resolves.toBeUndefined();
  });

  it.each([
    ["a user without a staff id", { actor_type: "user", system_job: null }],
    ["a user with a job name", { actor_type: "user", actor_staff_user_id: staff }],
    [
      "a user with a participant id",
      {
        actor_type: "user",
        system_job: null,
        actor_staff_user_id: staff,
        actor_participation_id: someone,
      },
    ],
    ["a participant without a participant id", { actor_type: "participant", system_job: null }],
    [
      "a participant with a staff id",
      {
        actor_type: "participant",
        system_job: null,
        actor_participation_id: someone,
        actor_staff_user_id: staff,
      },
    ],
    [
      "a participant on behalf of someone",
      {
        actor_type: "participant",
        system_job: null,
        actor_participation_id: someone,
        on_behalf_of_participation_id: someone,
      },
    ],
    ["the system without a job name", { system_job: null }],
    ["the system with a staff id", { actor_staff_user_id: staff }],
    ["the system on behalf of someone", { on_behalf_of_participation_id: someone }],
  ])("rejects %s", async (_label, actor) => {
    await expect(insert({ ...valid, ...actor })).rejects.toMatchObject(
      checkViolation("audit_event_actor_consistent"),
    );
  });
});

describe("no free text in audit_event (AC-18, Q66)", () => {
  it("has exactly these text columns, each held to an id or code pattern", async () => {
    const { rows } = await owner.query(
      `select column_name from information_schema.columns
       where table_name = 'audit_event' and data_type in ('text', 'character varying', 'character')
       order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "from_value",
      "job_id",
      "reason_code",
      "request_id",
      "system_job",
      "to_value",
    ]);
  });

  it.each([
    ["from_value", "audit_event_values_of_field"],
    ["to_value", "audit_event_values_of_field"],
    ["reason_code", "audit_event_reason_code_is_code"],
    ["request_id", "audit_event_request_id_is_id"],
    ["job_id", "audit_event_job_id_is_id"],
    ["system_job", "audit_event_system_job_is_name"],
  ])("rejects a sentence in %s", async (column, constraint) => {
    await expect(insert({ ...valid, [column]: sentence })).rejects.toMatchObject(
      checkViolation(constraint),
    );
  });

  it("rejects the special-category end reason as a reason code (Q66)", async () => {
    await expect(
      insert({ ...valid, reason_code: "long_term_illness_reduced_earning_capacity" }),
    ).rejects.toMatchObject(checkViolation("audit_event_reason_code_is_code"));
  });

  it("accepts ids, codes, dates, instants, numbers and booleans in details", async () => {
    const details = {
      entryKind: "scheduled_entry_catchup",
      scheduledAt: "2027-03-01T03:15:00.000Z",
      secondaryReasons: ["no_response", "not_informed"],
      waveId: "00000000-0000-4000-b000-000000000001",
      key: "custom.beispiel_zusatznachweis_nr",
      target: { kind: "field", category: "health" },
      count: 3,
      confirmed: true,
      previousWaveId: null,
    };
    await expect(insert({ ...valid, details })).resolves.toBeUndefined();
  });

  it.each([
    ["a sentence as a value", { note: sentence }],
    ["a sentence in an array", { secondaryReasons: ["no_response", sentence] }],
    ["a sentence in a nested object", { target: { kind: sentence } }],
    ["a sentence as a key", { [sentence]: true }],
    ["a sentence as a nested key", { target: { [sentence]: "x" } }],
    ["a string instead of an object", sentence],
    ["an array instead of an object", ["no_response"]],
  ])("rejects %s in details", async (_label, details) => {
    await expect(insert({ ...valid, details })).rejects.toMatchObject(
      checkViolation("audit_event_details_ids_and_codes"),
    );
  });
});

describe("audit_event shape (AC-18)", () => {
  it.each([
    ["a status change without a field", { field: null }, "audit_event_change_values"],
    ["a value of another field", { to_value: "dsv_signed" }, "audit_event_values_of_field"],
    [
      "from/to on another event type",
      { event_type: "export_created", field: null },
      "audit_event_change_values",
    ],
    [
      "a creation to another status",
      { event_type: "participation_created", from_value: null },
      "audit_event_change_values",
    ],
    [
      "a lifecycle event without its participation",
      { participation_id: null },
      "audit_event_lifecycle_has_participation",
    ],
    [
      "a manual creation without its participation",
      {
        event_type: "participation_created_manually",
        participation_id: null,
        field: null,
        from_value: null,
        to_value: null,
        details: { baseDefaultsVersion: 1 },
      },
      "audit_event_lifecycle_has_participation",
    ],
    [
      "a correction to a value that isn't an end reason",
      {
        event_type: "end_reason_corrected",
        field: null,
        from_value: "no_response",
        to_value: "contacted",
      },
      "audit_event_change_values",
    ],
  ])("rejects %s", async (_label, values, constraint) => {
    await expect(insert({ ...valid, ...values })).rejects.toMatchObject(checkViolation(constraint));
  });

  it("orders events strictly by seq and takes occurred_at from the database", async () => {
    await expect(insert({ ...valid, seq: 1 })).rejects.toMatchObject({ code: "428C9" });
    const { rows } = await owner.query(
      "select column_default from information_schema.columns where table_name = 'audit_event' and column_name = 'occurred_at'",
    );
    expect(rows[0].column_default).toBe("now()");
  });
});
