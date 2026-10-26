import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  emptyAssessment,
  ProfilingAssessmentView,
  ProfilingView,
  UnemploymentPeriodView,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The profiling record (process-and-lifecycle.md and data-protection.md, the profiling record;
// ADR-0010) against transfer_test, on the system clock (the functions decide "today" by the
// database's): the tab's view per viewer, the profiler's writes and logged reads, the track's
// steps. Synthetic data only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant, backOffice, admin } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
/** Every response body of a test, to check where a value leaves. */
const answered: string[] = [];

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice, admin]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
  answered.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

async function request(method: string, path: string, as: string, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  const res = await app.request(`/api/v1${path}`, init);
  answered.push(await res.clone().text());
  return res;
}
const get = (path: string, as: string = consultant) => request("GET", path, as);
const put = (path: string, body: unknown, as: string = consultant) =>
  request("PUT", path, as, body);
const post = (path: string, body: unknown, as: string = consultant) =>
  request("POST", path, as, body);

/** An informed participation of Werk Nord, assigned to the consultant unless `assigned: false`. */
async function participation({ assigned = true } = {}) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  if (assigned) {
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
  }
  return id;
}

const view = async (id: string, as: string = consultant) => {
  const res = await get(`/participations/${id}/profiling`, as);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, ProfilingView);
};

const events = async (id: string, type: string) =>
  (
    await owner.$client.query(
      "select details from audit_event where participation_id = $1 and event_type = $2 order by seq",
      [id, type],
    )
  ).rows.map((row) => row.details);

describe("the tab Profiling (data-protection.md, the profiling record)", () => {
  it("shows the PL the track and the sessions, never the profiler's blocks", async () => {
    const id = await participation();
    const lead = await view(id, projectLead);
    expect(lead).toMatchObject({
      profilingStatus: "not_started",
      revision: 0,
      sessions: [],
      transitions: [
        { to: "profiling_accepted", allowed: true, refusal: null },
        { to: "profiling_declined", allowed: true, refusal: null },
      ],
      capabilities: { record: false, assessment: false, readUnemploymentPeriod: false },
    });
    expect(lead).not.toHaveProperty("declarations");
    expect(lead).not.toHaveProperty("assessment");
    expect(lead).not.toHaveProperty("unemploymentPeriodRecorded");
    const profiler = await view(id);
    expect(profiler).toMatchObject({
      declarations: { jobboerseChoice: null, baContactConsent: null, recordedAt: null },
      assessment: { revision: 0, recorded: [], writtenAt: null },
      unemploymentPeriodRecorded: false,
      capabilities: { record: true, assessment: true, readUnemploymentPeriod: true },
    });
  });

  it("is 404 for an unassigned consultant, 403 for back office and admins", async () => {
    const id = await participation({ assigned: false });
    await expectProblem(await get(`/participations/${id}/profiling`), 404, "not-found");
    for (const as of [backOffice, admin]) {
      await expectProblem(await get(`/participations/${id}/profiling`, as), 403, "forbidden");
    }
    const unknown = "00000000-0000-4000-a000-00000000ffff";
    await expectProblem(await get(`/participations/${unknown}/profiling`), 404, "not-found");
  });
});

describe("sessions and declarations (Q193)", () => {
  it("writes the sessions whole with the revision, refusing the rules by code", async () => {
    const id = await participation();
    const path = `/participations/${id}/profiling/sessions`;
    const first = { date: "2026-02-20", from: "09:00", to: "10:30" };
    let res = await put(path, { revision: 0, sessions: [first] });
    expect(res.status).toBe(200);
    const saved = await readJson(res, ProfilingView);
    expect(saved.revision).toBe(1);
    expect(saved.sessions).toEqual([
      { id: expect.any(String), ...first, recordedAt: expect.any(String) },
    ]);
    // The PL reads them.
    expect((await view(id, projectLead)).sessions).toHaveLength(1);

    await expectProblem(await put(path, { revision: 0, sessions: [first] }), 409, "conflict");
    const problems = [
      [
        { date: "2026-02-21", from: "10:00", to: "09:00" },
        "/sessions/0/to",
        "session_times_reversed",
      ],
      [{ date: "2999-01-01", from: "09:00", to: "10:00" }, "/sessions/0/date", "session_in_future"],
    ] as const;
    for (const [session, pointer, code] of problems) {
      const body = await expectProblem(
        await put(path, { revision: 1, sessions: [session] }),
        422,
        "domain-error",
      );
      expect(body.errors).toEqual([{ pointer, code, detail: expect.any(String) }]);
    }
    const overlap = await expectProblem(
      await put(path, {
        revision: 1,
        sessions: [first, { date: "2026-02-20", from: "10:00", to: "11:00" }],
      }),
      422,
      "domain-error",
    );
    expect(overlap.errors).toEqual([
      { pointer: "/sessions/1", code: "sessions_overlap", detail: expect.any(String) },
    ]);
    await expectProblem(
      await put(path, { revision: 1, sessions: [{ ...first, from: "9:00" }] }),
      400,
      "validation-error",
    );
  });

  it("lets only the assigned consultant write; the PL, back office and assisted mode none", async () => {
    const id = await participation();
    const sessions = {
      revision: 0,
      sessions: [{ date: "2026-02-20", from: "09:00", to: "10:00" }],
    };
    await expectProblem(
      await put(`/participations/${id}/profiling/sessions`, sessions, projectLead),
      403,
      "forbidden",
    );
    await expectProblem(
      await put(`/participations/${id}/profiling/sessions`, sessions, backOffice),
      403,
      "forbidden",
    );
    const declarations = { revision: 0, jobboerseChoice: "full", baContactConsent: true };
    await expectProblem(
      await put(`/participations/${id}/profiling/declarations`, declarations, projectLead),
      403,
      "forbidden",
    );
    // Assisted mode grants no write here: the route takes the session's user as themselves.
    expect(await events(id, "profiling_session_changed")).toEqual([]);
  });

  it("records the pending declarations by key, never the portal consent", async () => {
    const id = await participation();
    const res = await put(`/participations/${id}/profiling/declarations`, {
      revision: 0,
      jobboerseChoice: "anonymous_callme",
      baContactConsent: false,
    });
    expect(res.status).toBe(200);
    const saved = await readJson(res, ProfilingView);
    expect(saved.declarations).toEqual({
      jobboerseChoice: "anonymous_callme",
      baContactConsent: false,
      recordedAt: expect.any(String),
    });
    expect(await events(id, "profiling_declarations_recorded")).toEqual([
      { fields: ["jobboerseChoice", "baContactConsent"] },
    ]);
    const consents = await owner.$client.query(
      "select count(*)::int as n from consent_record where participation_id = $1",
      [id],
    );
    expect(consents.rows[0].n).toBe(0);
  });
});

const assessment = (overrides: Record<string, unknown> = {}) => ({
  ...emptyAssessment(),
  ...overrides,
});
const SECRET = "Synthetischer Handlungsbedarf";

describe("section C and p. 7 (Q192)", () => {
  it("writes and reads them for the assigned consultant, each field audited, no-store", async () => {
    const id = await participation();
    const path = `/participations/${id}/profiling/assessment`;
    const values = assessment({
      schoolQualification: { rating: "placement_relevant", text: SECRET },
      health: { rating: "no_need" },
    });
    let res = await put(path, { revision: 0, values });
    expect(res.status).toBe(200);
    expect((await readJson(res, ProfilingView)).assessment).toEqual({
      revision: 1,
      recorded: ["profilingAssessment.schoolQualification", "profilingHealthAssessment"],
      writtenAt: expect.any(String),
    });
    expect((await events(id, "sensitive_write")).map((d) => d.key).toSorted()).toEqual([
      "profilingAssessment.schoolQualification",
      "profilingHealthAssessment",
    ]);
    res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(res, ProfilingAssessmentView)).toEqual({
      participationId: id,
      revision: 1,
      values,
    });
    expect(await events(id, "sensitive_read")).toHaveLength(16);
    // The value left only through the assessment's own read, and never into a log.
    expect(answered.filter((body) => body.includes(SECRET))).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    await expectProblem(await put(path, { revision: 0, values }), 409, "conflict");
  });

  it("refuses a text on the health line (422) and other problems by code", async () => {
    const id = await participation();
    const path = `/participations/${id}/profiling/assessment`;
    const body = await expectProblem(
      await put(path, {
        revision: 0,
        values: assessment({ health: { rating: "no_need", text: "Rücken" } }),
      }),
      422,
      "domain-error",
    );
    expect(body.errors).toEqual([
      {
        pointer: "/values/health/text",
        code: "health_detail_not_recorded",
        detail: expect.any(String),
      },
    ]);
    const long = await expectProblem(
      await put(path, { revision: 0, values: assessment({ nextSteps: "x".repeat(2001) }) }),
      422,
      "domain-error",
    );
    expect(long.errors).toEqual([
      { pointer: "/values/nextSteps", code: "too_long", detail: expect.any(String) },
    ]);
    expect(await events(id, "sensitive_write")).toEqual([]);
    expect(answered.join()).not.toContain("Rücken");
  });

  it("is never the PL's or back office's, nor an unassigned consultant's", async () => {
    const id = await participation();
    const path = `/participations/${id}/profiling/assessment`;
    for (const as of [projectLead]) {
      await expectProblem(await get(path, as), 403, "forbidden");
      await expectProblem(
        await put(path, { revision: 0, values: assessment() }, as),
        403,
        "forbidden",
      );
    }
    await expectProblem(await get(path, backOffice), 403, "forbidden");
    const other = await participation({ assigned: false });
    await expectProblem(
      await get(`/participations/${other}/profiling/assessment`),
      404,
      "not-found",
    );
    expect(await events(id, "sensitive_read")).toEqual([]);
  });
});

describe("the unemployment period (Q85)", () => {
  it("is written by the profiler and read by the profiler and back office, never the PL", async () => {
    const id = await participation();
    const path = `/participations/${id}/profiling/unemployment`;
    const period = { from: "2025-11-01", until: null };
    const res = await put(path, { period });
    expect(res.status).toBe(200);
    expect((await readJson(res, ProfilingView)).unemploymentPeriodRecorded).toBe(true);
    for (const as of [consultant, backOffice]) {
      const read = await get(path, as);
      expect(read.headers.get("cache-control")).toBe("no-store");
      expect(await readJson(read, UnemploymentPeriodView)).toEqual({ participationId: id, period });
    }
    await expectProblem(await get(path, projectLead), 403, "forbidden");
    await expectProblem(await put(path, { period: null }, projectLead), 403, "forbidden");
    await expectProblem(await put(path, { period: null }, backOffice), 403, "forbidden");
    expect(await events(id, "sensitive_read")).toEqual([
      { key: "unemploymentPeriod" },
      { key: "unemploymentPeriod" },
    ]);
  });
});

const step = (id: string, body: unknown, as: string = consultant) =>
  post(`/participations/${id}/profiling-status`, body, as);

describe("the profiling track (process-and-lifecycle.md, profiling track; Q60)", () => {
  it("moves the track for the PL and the assigned consultant with the status version", async () => {
    const id = await participation();
    let current = await view(id);
    let res = await step(id, { to: "profiling_accepted", statusVersion: current.statusVersion });
    expect(res.status).toBe(200);
    current = await readJson(res, ProfilingView);
    expect(current.profilingStatus).toBe("profiling_accepted");
    expect(current.transitions.map((t) => t.to)).toEqual([
      "profiling_in_progress",
      "profiling_declined",
    ]);
    await expectProblem(
      await step(id, { to: "profiling_in_progress", statusVersion: current.statusVersion - 1 }),
      409,
      "conflict",
    );
    res = await step(
      id,
      { to: "profiling_in_progress", statusVersion: current.statusVersion },
      projectLead,
    );
    expect(res.status).toBe(200);
    const changes = await events(id, "status_changed");
    expect(changes).toHaveLength(4);
  });

  it("refuses profiling_done on its guard until a signed TL 407 is recorded", async () => {
    const id = await participation();
    for (const to of ["profiling_accepted", "profiling_in_progress"]) {
      const { statusVersion } = await view(id);
      expect((await step(id, { to, statusVersion })).status).toBe(200);
    }
    const current = await view(id);
    expect(current.transitions).toContainEqual({
      to: "profiling_done",
      allowed: false,
      refusal: "tl407_signed",
    });
    const body = await expectProblem(
      await step(id, {
        to: "profiling_done",
        effectiveDate: "2026-02-20",
        statusVersion: current.statusVersion,
      }),
      422,
      "domain-error",
    );
    expect(body.errors?.map((e) => e.code)).toEqual(["tl407_signed"]);
  });

  it("is refused for back office, outside the track's activity, and for an unassigned consultant", async () => {
    const id = await participation();
    const { statusVersion } = await view(id);
    await expectProblem(
      await step(id, { to: "profiling_accepted", statusVersion }, backOffice),
      403,
      "forbidden",
    );
    const contacted = await call(owner.$client, "create_participation", {
      projectId: werkNord,
      context: pl,
    });
    await changeStatus(owner.$client, contacted, {
      field: "status",
      from: "imported",
      to: "contacted",
    });
    const refused = await expectProblem(
      await step(contacted, { to: "profiling_accepted", statusVersion: 1 }, projectLead),
      422,
      "domain-error",
    );
    expect(refused.errors?.map((e) => e.code)).toEqual(["track_inactive"]);
    await expectProblem(
      await step(contacted, { to: "profiling_accepted", statusVersion: 1 }),
      404,
      "not-found",
    );
  });
});
