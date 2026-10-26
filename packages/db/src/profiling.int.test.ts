import { randomBytes } from "node:crypto";
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

// The profiling record (data-protection.md, the profiling record; process-and-lifecycle.md, the
// profiling record; Q85, Q192, Q193) as transfer_app calls its functions: the sessions, the
// pending declarations, section C with p. 7 and the unemployment period. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const key = hex();
const keyId = hex(8);
const { consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { werkNord } = seedProjectIds;

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

/** An informed participation of Werk Nord, assigned to the consultant. */
async function participation() {
  const id = await call(app, "create_participation", { projectId: werkNord, context: pl });
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(app, id, { field: "status", from: "contacted", to: "informed" });
  await call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

const events = (participationId: string, type: string) =>
  all(
    `select actor_staff_user_id, details from audit_event
     where participation_id = $1 and event_type = $2 order by seq`,
    [participationId, type],
  );

const writeSessions = (
  participationId: string,
  sessions: unknown[],
  revision: number,
  context = asConsultant,
) =>
  call<number>(app, "write_profiling_sessions", {
    participationId,
    context,
    sessions: JSON.stringify(sessions),
    revision,
  });

const sessionsOf = (participationId: string) =>
  all(
    `select id, session_date::text as date, time_from, time_to from profiling_session
     where participation_id = $1 order by session_date, time_from`,
    [participationId],
  );

describe("profiling sessions (Q193)", () => {
  it("writes the sessions whole, each change audited by id and date, with the revision", async () => {
    const id = await participation();
    expect(
      await writeSessions(
        id,
        [
          { date: "2026-02-20", from: "09:00", to: "10:30" },
          { date: "2026-02-20", from: "10:30", to: "12:00" },
        ],
        0,
      ),
    ).toBe(1);
    const [first, second] = await sessionsOf(id);
    expect(first).toMatchObject({ date: "2026-02-20", time_from: "09:00", time_to: "10:30" });
    expect(
      await writeSessions(
        id,
        [
          { id: first.id, date: "2026-02-21", from: "09:00", to: "10:30" },
          { date: "2026-03-02", from: "13:00", to: "14:00" },
        ],
        1,
      ),
    ).toBe(2);
    const audited = await events(id, "profiling_session_changed");
    expect(audited.map((e) => e.details)).toEqual([
      { action: "added", sessionId: first.id, date: "2026-02-20" },
      { action: "added", sessionId: second.id, date: "2026-02-20" },
      { action: "removed", sessionId: second.id, date: "2026-02-20" },
      { action: "changed", sessionId: first.id, date: "2026-02-21" },
      { action: "added", sessionId: expect.any(String), date: "2026-03-02" },
    ]);
    expect(audited.every((e) => e.actor_staff_user_id === consultant)).toBe(true);
    const record = await one(
      "select revision from participant_profiling where participation_id = $1",
      [id],
    );
    expect(record.revision).toBe(2);
  });

  it("writes nothing for an unchanged list and refuses a stale revision", async () => {
    const id = await participation();
    await writeSessions(id, [{ date: "2026-02-20", from: "09:00", to: "10:00" }], 0);
    const [s] = await sessionsOf(id);
    const same = [{ id: s.id, date: "2026-02-20", from: "09:00", to: "10:00" }];
    expect(await writeSessions(id, same, 1)).toBe(1);
    expect(await events(id, "profiling_session_changed")).toHaveLength(1);
    await expect(writeSessions(id, same, 0)).rejects.toMatchObject(failsWith("stale_revision"));
  });

  it("refuses reversed times, a future date, overlaps, an unknown or repeated id", async () => {
    const id = await participation();
    const other = await participation();
    await writeSessions(other, [{ date: "2026-02-20", from: "09:00", to: "10:00" }], 0);
    const [foreign] = await sessionsOf(other);
    for (const [sessions, code] of [
      [[{ date: "2026-02-20", from: "10:00", to: "10:00" }], "session_times_reversed"],
      [[{ date: "2999-01-01", from: "09:00", to: "10:00" }], "session_in_future"],
      [
        [
          { date: "2026-02-20", from: "09:00", to: "11:00" },
          { date: "2026-02-20", from: "10:59", to: "12:00" },
        ],
        "sessions_overlap",
      ],
      [[{ id: foreign.id, date: "2026-02-20", from: "09:00", to: "10:00" }], "session_not_found"],
      [
        [
          { id: foreign.id, date: "2026-02-20", from: "09:00", to: "10:00" },
          { id: foreign.id, date: "2026-02-21", from: "09:00", to: "10:00" },
        ],
        "invalid_argument",
      ],
      [[{ date: "2026-02-20", from: "9:00", to: "10:00" }], "invalid_argument"],
      [[{ date: "2026-02-30", from: "09:00", to: "10:00" }], "invalid_argument"],
      [[{ date: "2026-02-20", from: "09:00", to: "10:00", room: "1" }], "invalid_argument"],
    ] as const) {
      await expect(writeSessions(id, [...sessions], 0)).rejects.toMatchObject(failsWith(code));
    }
    expect(await sessionsOf(id)).toEqual([]);
  });

  it("lets only the assigned consultant write, as themselves, while the participation is open", async () => {
    const id = await participation();
    const sessions = [{ date: "2026-02-20", from: "09:00", to: "10:00" }];
    const assisted = auditContext({ actorType: "user", staffUserId: consultant, onBehalfOf: id });
    for (const context of [pl, asBackOffice, assisted]) {
      await expect(writeSessions(id, sessions, 0, context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    await call(app, "unassign_participation", {
      participationId: id,
      staffUserId: consultant,
      context: pl,
    });
    await expect(writeSessions(id, sessions, 0)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const closed = await participation();
    await changeStatus(app, closed, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-02-01",
    });
    await expect(writeSessions(closed, sessions, 0)).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });
});

describe("the pending declarations (ba-forms.md, declarations; Q193)", () => {
  const write = (
    participationId: string,
    jobboerseChoice: string | null,
    baContactConsent: boolean | null,
    revision: number,
    context = asConsultant,
  ) =>
    call<number>(app, "write_profiling_declarations", {
      participationId,
      context,
      jobboerseChoice,
      baContactConsent,
      revision,
    });

  it("records the changed keys only, never the values, sharing the record's revision", async () => {
    const id = await participation();
    expect(await write(id, "anonymous_callme", null, 0)).toBe(1);
    expect(await write(id, "anonymous_callme", true, 1)).toBe(2);
    expect(await write(id, "anonymous_callme", true, 2)).toBe(2);
    expect((await events(id, "profiling_declarations_recorded")).map((e) => e.details)).toEqual([
      { fields: ["jobboerseChoice"] },
      { fields: ["baContactConsent"] },
    ]);
    expect(
      await one(
        `select jobboerse_choice, ba_contact_consent, declarations_recorded_by
         from participant_profiling where participation_id = $1`,
        [id],
      ),
    ).toEqual({
      jobboerse_choice: "anonymous_callme",
      ba_contact_consent: true,
      declarations_recorded_by: consultant,
    });
    // A session write after the declarations compares the same revision.
    await expect(
      writeSessions(id, [{ date: "2026-02-20", from: "09:00", to: "10:00" }], 1),
    ).rejects.toMatchObject(failsWith("stale_revision"));
    await expect(write(id, "full", true, 1)).rejects.toMatchObject(failsWith("stale_revision"));
    await expect(write(id, "full", true, 2, pl)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });
});

const line = (rating: string | null, text: string | null) => ({ rating, text });
const other = (rating: string | null, text: string | null, label: string | null) => ({
  rating,
  text,
  label,
});
const assessment = (overrides: Record<string, unknown> = {}) => ({
  schoolQualification: line(null, null),
  vocationalQualification: line(null, null),
  workExperience: line(null, null),
  languageSkills: line(null, null),
  otherQualification: other(null, null, null),
  health: { rating: null },
  intellectualCapacity: line(null, null),
  workAndSocialBehaviour: line(null, null),
  otherPerformance: other(null, null, null),
  initiative: line(null, null),
  learningReadiness: line(null, null),
  otherMotivation: other(null, null, null),
  localMobility: line(null, null),
  otherConditions: other(null, null, null),
  overallAssessment: null,
  nextSteps: null,
  ...overrides,
});

const writeAssessment = (
  participationId: string,
  values: unknown,
  revision: number,
  context = asConsultant,
  keyIdOf = keyId,
) =>
  call<number>(app, "write_profiling_assessment", {
    participationId,
    context,
    values: JSON.stringify(values),
    revision,
    key,
    keyId: keyIdOf,
  });
const readAssessment = (participationId: string, context = asConsultant) =>
  call<{ revision: number; values: Record<string, unknown> }>(app, "read_profiling_assessment", {
    participationId,
    context,
    key,
    keyId,
  });

describe("section C and p. 7 (Q192)", () => {
  it("encrypts each field, audits each write and read by key, and reads it back whole", async () => {
    const id = await participation();
    const values = assessment({
      schoolQualification: line("placement_relevant", "Abschluss nachholen"),
      otherMotivation: other("no_need", null, "Pünktlichkeit"),
      health: { rating: "placement_relevant" },
      overallAssessment: "Synthetische Einschätzung",
    });
    expect(await writeAssessment(id, values, 0)).toBe(1);
    expect((await events(id, "sensitive_write")).map((e) => e.details.key).toSorted()).toEqual([
      "overallAssessment",
      "profilingAssessment.otherMotivation",
      "profilingAssessment.schoolQualification",
      "profilingHealthAssessment",
    ]);
    const stored = await one(
      `select school_qualification, school_qualification_present, initiative_present,
         overall_assessment::text as overall from participant_profiling_assessment
       where participation_id = $1`,
      [id],
    );
    expect(stored.school_qualification_present).toBe(true);
    expect(stored.initiative_present).toBe(false);
    expect(stored.overall).not.toContain("Synthetische");
    expect(
      await one(
        "select health_rating_present from participant_profiling_health_assessment where participation_id = $1",
        [id],
      ),
    ).toEqual({ health_rating_present: true });

    expect(await readAssessment(id)).toEqual({ revision: 1, values });
    expect(await events(id, "sensitive_read")).toHaveLength(16);

    // Only the changed field is audited again; an unchanged write writes nothing.
    const next = { ...values, nextSteps: "Bewerbungstraining" };
    expect(await writeAssessment(id, next, 1)).toBe(2);
    expect(await writeAssessment(id, next, 2)).toBe(2);
    expect((await events(id, "sensitive_write")).map((e) => e.details.key)).toHaveLength(5);
    await expect(writeAssessment(id, next, 1)).rejects.toMatchObject(failsWith("stale_revision"));
  });

  it("keeps the health line's rating only: a text there is refused, never stored", async () => {
    const id = await participation();
    await expect(
      writeAssessment(id, assessment({ health: { rating: "no_need", text: "Rücken" } }), 0),
    ).rejects.toMatchObject(failsWith("health_detail_not_recorded"));
    for (const bad of [
      assessment({ schoolQualification: line("kein", null) }),
      assessment({ schoolQualification: line(null, "x".repeat(301)) }),
      assessment({ otherConditions: other(null, null, "y".repeat(101)) }),
      assessment({ nextSteps: "z".repeat(2001) }),
      assessment({ notes: "frei" }),
      assessment({ initiative: other(null, null, "a") }),
      { ...assessment(), health: undefined },
    ]) {
      await expect(writeAssessment(id, bad, 0)).rejects.toMatchObject(
        failsWith("invalid_argument"),
      );
    }
    expect(await one("select count(*)::int as n from participant_profiling_assessment")).toEqual({
      n: 0,
    });
  });

  it("is the assigned consultant's alone; another key is refused", async () => {
    const id = await participation();
    for (const context of [pl, asBackOffice]) {
      await expect(writeAssessment(id, assessment(), 0, context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
      await expect(readAssessment(id, context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    await writeAssessment(id, assessment({ nextSteps: "Coaching" }), 0);
    await expect(writeAssessment(id, assessment(), 1, asConsultant, hex(8))).rejects.toMatchObject(
      failsWith("key_unknown"),
    );
  });

  it("gives transfer_app no ciphertext column", async () => {
    await expect(
      app.query("select school_qualification from participant_profiling_assessment"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query("select health_rating from participant_profiling_health_assessment"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query("select unemployment_period from participant_residence_social_data"),
    ).rejects.toMatchObject({ code: "42501" });
    await app.query(
      "select school_qualification_present, revision from participant_profiling_assessment",
    );
    await app.query("select unemployment_period_present from participant_residence_social_data");
  });
});

describe("the unemployment period (Q85, Q192)", () => {
  const write = (participationId: string, period: unknown, context = asConsultant) =>
    call<boolean>(app, "write_unemployment_period", {
      participationId,
      context,
      period: JSON.stringify(period),
      key,
      keyId,
    });
  const read = (participationId: string, context: string) =>
    call<Record<string, unknown>>(app, "read_sensitive_fields", {
      participationId,
      context,
      keys: "{unemploymentPeriod}",
      key,
      keyId,
    });

  it("is written by the assigned consultant and read like the residence answers", async () => {
    const id = await participation();
    const period = { from: "2025-11-01", until: null };
    expect(await write(id, period)).toBe(true);
    expect(await write(id, period)).toBe(false);
    expect(await read(id, asConsultant)).toEqual({ unemploymentPeriod: period });
    expect(await read(id, asBackOffice)).toEqual({ unemploymentPeriod: period });
    await expect(read(id, pl)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    expect((await events(id, "sensitive_write")).map((e) => e.details)).toEqual([
      { key: "unemploymentPeriod" },
    ]);
    expect(await events(id, "sensitive_read")).toHaveLength(2);
    expect(await write(id, null)).toBe(true);
    expect(await read(id, asConsultant)).toEqual({ unemploymentPeriod: null });
  });

  it("refuses others, a malformed period, and leaves the participant's answers alone", async () => {
    const id = await participation();
    await expect(write(id, { from: "2025-11-01", until: null }, pl)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    for (const bad of [{ from: "2025-11-31", until: null }, { from: "2025-11-01" }, "2025-11-01"]) {
      await expect(write(id, bad)).rejects.toMatchObject(failsWith("invalid_argument"));
    }
    await write(id, { from: "2025-11-01", until: "2026-03-31" });
    const row = await one(
      `select nationality_present, buergergeld_present, unemployment_period_present
       from participant_residence_social_data where participation_id = $1`,
      [id],
    );
    expect(row).toEqual({
      nationality_present: false,
      buergergeld_present: false,
      unemployment_period_present: true,
    });
    // A participant reads no unemployment period of theirs here: it is the profiler's record.
    await expect(
      read(id, auditContext({ actorType: "participant", participationId: id })),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });
});

describe("the reserved events", () => {
  it("lets record_audit_event write neither profiling record event", async () => {
    const id = await participation();
    for (const type of ["profiling_session_changed", "profiling_declarations_recorded"]) {
      await expect(
        call(app, "record_audit_event", {
          projectId: werkNord,
          participationId: id,
          eventType: type,
          context: pl,
        }),
      ).rejects.toMatchObject(failsWith("event_type_reserved"));
    }
  });
});
