import { ManualClock } from "@transfer/adapters";
import {
  and,
  auditEvent,
  createDb,
  eq,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
  seedWaves,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  EntryWaveAssignmentsResult,
  matchesWorklistFilter,
  ParticipationDetail,
  ParticipationSelfService,
  ProjectDashboard,
  Worklist,
  worklistMaxRows,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countStatements,
  expectProblem,
  expectWithinBudget,
  jsonRequest,
  login,
  readJson,
  testApp,
} from "./testing";

// The work list and the dashboard (data-protection.md, the work list and the dashboard) and the
// bulk wave assignment (process-and-lifecycle.md, assigning a wave) against transfer_test. Today
// is 2091-02-05 in Berlin, ten days before W1's signing deadline. Synthetic values only.
const clock = new ManualClock(new Date("2091-02-05T10:00:00Z"));
const { app, db, logs } = testApp({ clock });
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, verwaltung, lagerSued } = seedProjectIds;
const { admin, regionalAdmin, projectLead, consultant, backOffice } = seedStaffUserIds;
const [w1, w2] = seedWaves;

type Auth = { Cookie: string };
const sessions: Record<string, Auth> = {};
const as = (staffUserId: string) => sessions[staffUserId]!;
const get = (path: string, auth: Auth) => app.request(`/api/v1${path}`, { headers: auth });
const worklist = (auth = as(projectLead), projectId: string = werkNord) =>
  get(`/projects/${projectId}/worklist`, auth);
const dashboard = (auth = as(projectLead), projectId: string = werkNord) =>
  get(`/projects/${projectId}/dashboard`, auth);
const assignWave = (body: unknown, auth = as(projectLead), projectId: string = werkNord) =>
  app.request(
    `/api/v1/projects/${projectId}/entry-wave-assignments`,
    jsonRequest("POST", body, auth),
  );
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));

/** Synthetic person values that must never appear in a work list or dashboard response. */
const secrets = ["Geheimweg 7", "geheim.privat@example.org", "0301239876", "1961-07-13"];

/** A participation with person data, written directly as the owner (a fixture). */
async function person(
  projectId: string = werkNord,
  values: Partial<typeof participation.$inferInsert> = {},
) {
  const id = randomUUID();
  await owner.insert(participation).values({
    id,
    projectId,
    status: "informed",
    profilingStatus: "not_started",
    dsvStatus: "not_offered",
    ...values,
  });
  await owner.insert(participantIdentity).values({
    participationId: id,
    projectId,
    personnelNumber: `SYN-${id.slice(-6)}`,
    firstName: "Jürgen",
    lastName: "Größer",
    birthDate: "1961-07-13",
  });
  await owner.insert(participantDetails).values({
    participationId: id,
    projectId,
    addressStreet: "Geheimweg 7",
    addressPostalCode: "10115",
    addressCity: "Berlin",
    addressCountry: "DE",
    phone: "0301239876",
    privateEmail: "geheim.privat@example.org",
  });
  return id;
}

const assign = (participationIds: string[]) =>
  app.request(
    `/api/v1/projects/${werkNord}/assignments`,
    jsonRequest("POST", { staffUserId: consultant, participationIds }, as(projectLead)),
  );

/**
 * `count` more participations with identities in Werk Nord, each booked once on one of four past
 * info events of 500 seats, every other one recorded absent: each row has an appointment item
 * (process-and-lifecycle.md, appointments). Synthetic values only.
 */
async function booked(count: number) {
  await owner.$client.query(
    `with created as (
       insert into participation (project_id, status, profiling_status, dsv_status)
       select $1, 'contacted', 'not_started', 'not_offered' from generate_series(1, $2)
       returning id
     )
     insert into participant_identity (participation_id, project_id, personnel_number, first_name, last_name)
     select id, $1, 'SYN-' || ($3::int + row_number() over ()), 'Vorname', 'Nachname' from created`,
    [werkNord, count, (await owner.$count(participation)) + 1],
  );
  await owner.$client.query(
    `with events as (
       insert into appointment (id, project_id, kind, starts_at, ends_at, booking_closes_at, capacity, venue, created_by)
       select gen_random_uuid(), $1, 'info_event', '2091-01-10T09:00:00Z'::timestamptz + n * interval '1 day',
         '2091-01-10T11:00:00Z'::timestamptz + n * interval '1 day', '2091-01-09T09:00:00Z'::timestamptz,
         500, 'Raum 1', $2
       from generate_series(0, 3) n
       returning id, extract(day from starts_at at time zone 'UTC')::int - 10 as n
     ), people as (
       select id, row_number() over (order by id) - 1 as n from participation
       where project_id = $1
         and not exists (select from appointment_booking b where b.participation_id = participation.id)
     )
     insert into appointment_booking (id, project_id, participation_id, appointment_id, origin, booked_by,
       attendance, attendance_recorded_by, attendance_recorded_at)
     select gen_random_uuid(), $1, people.id, events.id, 'staff', $2,
       case when people.n % 2 = 0 then 'absent'::attendance end,
       case when people.n % 2 = 0 then $2::uuid end,
       case when people.n % 2 = 0 then now() end
     from people join events on events.n = people.n % 4`,
    [werkNord, projectLead],
  );
}

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [admin, regionalAdmin, projectLead, consultant, backOffice]) {
    sessions[id] = await login(app, id);
  }
});
beforeEach(() => resetTestDatabase({ seed: true, active: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("GET /projects/{id}/worklist", () => {
  it("answers the PL and back office the whole project, a consultant exactly theirs", async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    await person(verwaltung);
    const ids = async (auth: Auth) =>
      (await readJson(await worklist(auth), Worklist)).items.map((item) => item.id).toSorted();
    expect(await ids(as(projectLead))).toEqual([a, b, c].toSorted());
    expect(await ids(as(backOffice))).toEqual([a, b, c].toSorted());
    // Unassigned: no list scope.
    await expectProblem(await worklist(as(consultant)), 403, "forbidden");
    expect((await assign([b])).status).toBe(200);
    expect(await ids(as(consultant))).toEqual([b]);
    // The scope follows the assignment on the next request.
    await app.request(`/api/v1/participations/${b}/assignments/${consultant}`, {
      method: "DELETE",
      headers: { ...as(projectLead), Origin: "http://localhost:5173" },
    });
    await expectProblem(await worklist(as(consultant)), 403, "forbidden");
  });

  it("refuses the org roles (403) and hides another region's project (404)", async () => {
    await person();
    await expectProblem(await worklist(as(admin)), 403, "forbidden");
    await expectProblem(await worklist(as(regionalAdmin)), 403, "forbidden");
    await expectProblem(await worklist(as(regionalAdmin), lagerSued), 404, "not-found");
    await expectProblem(await dashboard(as(regionalAdmin), lagerSued), 404, "not-found");
    await expectProblem(await dashboard(as(admin)), 403, "forbidden");
  });

  it("is private and never stored, and carries no person value beyond the listed fields", async () => {
    const id = await person();
    const res = await worklist();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    for (const secret of secrets) expect(text).not.toContain(secret);
    const { items } = Worklist.parse(JSON.parse(text));
    expect(items[0]).toMatchObject({
      id,
      lastName: "Größer",
      firstName: "Jürgen",
      entryWaveId: null,
      portal: "not_reachable",
      // Received today in real time, so the notice was due long before 2091.
      deadlines: [{ kind: "privacy_notice", state: "overdue" }],
      capabilities: { assignEntryWave: true, issueActivationCode: true },
    });
    const board = await dashboard();
    expect(board.headers.get("cache-control")).toBe("private, no-store");
    const boardText = await board.text();
    for (const secret of secrets) expect(boardText).not.toContain(secret);
    for (const secret of secrets) expect(logs.join("\n")).not.toContain(secret);
  });

  it("names the participant's actions as the Selbstauskunft tab names its missing fields", async () => {
    const id = await person();
    const { items } = await readJson(await worklist(), Worklist);
    const selfService = await readJson(
      await get(`/participations/${id}/self-service`, as(projectLead)),
      ParticipationSelfService,
    );
    const missingFields = selfService.missing.filter((m) => m.kind === "field").map((m) => m.key);
    for (const action of items[0]!.actions.filter((a) => a.kind === "field")) {
      expect(missingFields).toContain(action.key);
    }
  });

  it("shows the open offer's deadline and the wave capability from the detail's rule", async () => {
    const offered = await person(werkNord, {
      entryWaveId: w1.id,
      status: "informed",
      dsvStatus: "dsv_offered",
    });
    const { items } = await readJson(await worklist(), Worklist);
    const item = items.find((i) => i.id === offered)!;
    expect(item.deadlines).toContainEqual({
      kind: "offer_deadline",
      date: w1.signingDeadline,
      state: "upcoming",
    });
    const detail = await readJson(
      await get(`/participations/${offered}`, as(projectLead)),
      ParticipationDetail,
    );
    expect(item.capabilities.assignEntryWave).toBe(detail.capabilities.assignEntryWave);
    expect(item.capabilities.assignEntryWave).toBe(false);
  });

  it("refuses a project above worklistMaxRows with 422 worklist_too_large", async () => {
    await owner.$client.query(
      `insert into participation (project_id, status, profiling_status, dsv_status)
       select $1, 'imported', 'not_started', 'not_offered' from generate_series(1, $2)`,
      [verwaltung, worklistMaxRows + 1],
    );
    expect(await codes(await worklist(as(projectLead), verwaltung))).toEqual([
      { code: "worklist_too_large", pointer: "" },
    ]);
    expect(await codes(await dashboard(as(projectLead), verwaltung))).toEqual([
      { code: "worklist_too_large", pointer: "" },
    ]);
  });

  it("runs as many SQL statements for 2,000 participations as for 10", async () => {
    // One snapshot, every per-row fact read for all rows at once and never one statement per
    // participation (ADR-0010, the bounded snapshot). A deterministic gate, unlike the timing.
    await booked(10);
    const few = await countStatements(db, () => worklist());
    expect((await readJson(few.result, Worklist)).items).toHaveLength(10);
    await booked(1990);
    const many = await countStatements(db, () => worklist());
    const { items } = await readJson(many.result, Worklist);
    expect(items).toHaveLength(2000);
    expect(items.every((item) => item.appointments.items.length === 1)).toBe(true);
    expect(few.statements).toBeGreaterThan(0);
    expect(many.statements).toBe(few.statements);
  });

  it("answers 2,000 synthetic participations with bookings within its timing budget", async ({
    annotate,
  }) => {
    await booked(2000);
    const timings: number[] = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const res = await worklist();
      expect(res.status).toBe(200);
      expect((await readJson(res, Worklist)).items).toHaveLength(2000);
      timings.push(performance.now() - started);
    }
    const reported = `worklist of 2,000: ${timings.map((t) => `${Math.round(t)} ms`).join(", ")}`;
    // oxlint-disable-next-line no-console -- the timings go into the PR
    console.info(reported);
    await annotate(reported, "performance");
    // Best of three under 1 s (architecture/overview.md, performance approach).
    expectWithinBudget("worklist of 2,000 (best of three)", Math.min(...timings), {
      budget: 1000,
      ceiling: 5000,
      causes: "a query per participation (see the statement count test), a missing index",
    });
    // Seeding and three runs: the budget and the ceiling above judge the time, not the test's
    // default 5 s timeout, which coverage's instrumentation alone exceeds.
  }, 30_000);
});

describe("GET /projects/{id}/dashboard", () => {
  it("counts exactly the snapshot's participations by the same filters", async () => {
    await person(werkNord, { entryWaveId: w1.id });
    await person(werkNord, { entryWaveId: w2.id, status: "imported" });
    await person();
    const board = await readJson(await dashboard(), ProjectDashboard);
    const { items } = await readJson(await worklist(), Worklist);
    expect(board.scope).toBe("project");
    for (const group of Object.values(board.counts)) {
      for (const { count, filter } of group) {
        expect(count).toBe(items.filter((item) => matchesWorklistFilter(item, filter)).length);
      }
    }
    const waves = Object.fromEntries(board.counts.waves.map((w) => [w.key, w.count]));
    expect(waves).toEqual({ [w1.id]: 1, [w2.id]: 1, none: 1 });
    expect(board.counts.tiles[0]).toEqual({ key: "participations", count: 3, filter: {} });
  });

  it("counts a consultant's assigned participations only", async () => {
    const [a] = [await person(), await person()];
    await assign([a]);
    const board = await readJson(await dashboard(as(consultant)), ProjectDashboard);
    expect(board.scope).toBe("assigned");
    expect(board.counts.tiles[0]!.count).toBe(1);
  });
});

const assignedEvents = async () =>
  owner
    .select({ participationId: auditEvent.participationId })
    .from(auditEvent)
    .where(eq(auditEvent.eventType, "entry_wave_assigned"));

describe("POST /projects/{id}/entry-wave-assignments", () => {
  it("assigns the wave to each, audits each, and counts those already in it", async () => {
    const [a, b, c] = [
      await person(),
      await person(),
      await person(werkNord, { entryWaveId: w2.id }),
    ];
    const result = await readJson(
      await assignWave({ waveId: w2.id, participationIds: [a, b, c] }),
      EntryWaveAssignmentsResult,
    );
    expect(result).toEqual({ assigned: 2, unchanged: 1 });
    const waves = await owner
      .select({ id: participation.id, wave: participation.entryWaveId })
      .from(participation)
      .where(eq(participation.projectId, werkNord));
    expect(waves.every((row) => row.wave === w2.id)).toBe(true);
    expect((await assignedEvents()).map((e) => e.participationId).toSorted()).toEqual(
      [a, b].toSorted(),
    );
  });

  it("assigns none when any row is refused, naming each refused index and code", async () => {
    const ok = await person();
    const offered = await person(werkNord, { entryWaveId: w1.id, dsvStatus: "dsv_offered" });
    const own = await person(werkNord, { entryWaveId: w1.id, tgStart: "2091-04-01" });
    const foreign = await person(verwaltung);
    expect(
      await codes(
        await assignWave({ waveId: w2.id, participationIds: [ok, offered, own, foreign] }),
      ),
    ).toEqual([
      { code: "dsv_already_offered", pointer: "/participationIds/1" },
      { code: "individual_dates_set", pointer: "/participationIds/2" },
      { code: "participation_not_found", pointer: "/participationIds/3" },
    ]);
    const [row] = await owner
      .select({ wave: participation.entryWaveId })
      .from(participation)
      .where(and(eq(participation.id, ok)));
    expect(row!.wave).toBeNull();
    expect(await assignedEvents()).toEqual([]);
  });

  it("is the PL's only; a ta_only project, another project's wave and duplicates are refused", async () => {
    const id = await person();
    const body = { waveId: w1.id, participationIds: [id] };
    await expectProblem(await assignWave(body, as(backOffice)), 403, "forbidden");
    await expectProblem(await assignWave(body, as(consultant)), 403, "forbidden");
    await expectProblem(await assignWave(body, as(regionalAdmin), lagerSued), 404, "not-found");
    expect(await codes(await assignWave(body, as(projectLead), verwaltung))).toEqual([
      { code: "not_ta_tg", pointer: "" },
    ]);
    expect(await codes(await assignWave({ ...body, waveId: randomUUID() }))).toEqual([
      { code: "wave_of_other_project", pointer: "/waveId" },
    ]);
    expect(
      await codes(
        await assignWave({ waveId: w1.id, participationIds: [id, id] }),
        400,
        "validation-error",
      ),
    ).toEqual([{ code: "duplicate_participation", pointer: "/participationIds" }]);
  });
});
