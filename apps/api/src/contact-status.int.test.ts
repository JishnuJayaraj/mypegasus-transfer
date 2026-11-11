import { createDb, seedProjectIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { ParticipationDetail } from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The manual contact statuses (process-and-lifecycle.md, the manual contact statuses; Q60, Q215)
// against transfer_test: the three edges with their audit, `before_cutoff`, who may (the PL, the
// assigned consultant/profiler), visibility (404) before permission (403) before state (409/422).
// Synthetic data only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant, backOffice, regionalOperationsManager } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const staff = {} as Record<string, { Cookie: string }>;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice, regionalOperationsManager]) {
    staff[id] = await login(app, id);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);

/** An imported participant of Werk Nord in W1, assigned to the consultant unless said otherwise. */
async function participant(options: { assigned?: boolean } = {}) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await call(owner.$client, "assign_entry_wave", { id, waveId: w1.id, context: pl });
  await sql(
    `insert into participant_identity (participation_id, project_id, personnel_number, last_name,
       first_name) values ($1, $2, $3, 'Synthetik-Kontakt', 'Erika')`,
    [id, werkNord, `SYN-${id.slice(-8)}`],
  );
  if (options.assigned !== false) {
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
  }
  return id;
}

const version = async (id: string): Promise<number> =>
  (await sql("select status_version from participation where id = $1", [id])).rows[0]
    .status_version;
const set = async (id: string, to: string, as: string = projectLead, statusVersion?: number) =>
  app.request(
    `/api/v1/participations/${id}/contact-status`,
    jsonRequest("POST", { to, statusVersion: statusVersion ?? (await version(id)) }, staff[as]!),
  );
const detail = async (id: string, as: string = projectLead) =>
  readJson(
    await app.request(`/api/v1/participations/${id}`, { headers: staff[as]! }),
    ParticipationDetail,
  );
const codesOf = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  return ((await res.json()) as { errors: { pointer: string; code: string }[] }).errors.map(
    ({ pointer, code }) => `${pointer}:${code}`,
  );
};
const statusEvents = async (id: string) =>
  (
    await sql(
      `select event_type::text as type, actor_type::text as actor, actor_staff_user_id as staff,
         field::text as field, from_value as "from", to_value as "to"
       from audit_event where participation_id = $1 and event_type = 'status_changed'
         and field = 'status' order by seq`,
      [id],
    )
  ).rows;
/** Moves W1's admission cutoff to yesterday (Berlin), so `before_cutoff` fails today. */
const pastCutoff = () =>
  sql(
    `update project_entry_wave set signing_deadline = berlin_today() - 3,
       default_tg_start = berlin_today() - 2,
       latest_entry_date = berlin_today() - 1 where id = $1`,
    [w1.id],
  );

describe("POST /participations/{id}/contact-status", () => {
  it("moves imported → contacted → unreachable → contacted, each audited by the status function", async () => {
    const id = await participant();
    expect((await detail(id)).capabilities.contactStatus).toEqual(["contacted"]);
    let res = await set(id, "contacted");
    expect(res.status).toBe(200);
    let body = await readJson(res, ParticipationDetail);
    expect(body.status).toBe("contacted");
    expect(body.capabilities.contactStatus).toEqual(["unreachable"]);
    res = await set(id, "unreachable", consultant);
    expect(res.status).toBe(200);
    body = await readJson(res, ParticipationDetail);
    expect(body.status).toBe("unreachable");
    expect(body.capabilities.contactStatus).toEqual(["contacted"]);
    expect((await set(id, "contacted")).status).toBe(200);
    expect(await statusEvents(id)).toEqual([
      {
        type: "status_changed",
        actor: "user",
        staff: projectLead,
        field: "status",
        from: "imported",
        to: "contacted",
      },
      {
        type: "status_changed",
        actor: "user",
        staff: consultant,
        field: "status",
        from: "contacted",
        to: "unreachable",
      },
      {
        type: "status_changed",
        actor: "user",
        staff: projectLead,
        field: "status",
        from: "unreachable",
        to: "contacted",
      },
    ]);
    const text = JSON.stringify(logs);
    expect(text).toMatch(/participation contact status/);
    expect(text).not.toMatch(/Synthetik-Kontakt|Erika|SYN-/);
  });

  it("refuses unreachable → contacted after the cutoff (before_cutoff), allows the other steps", async () => {
    const id = await participant();
    await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
    await changeStatus(owner.$client, id, {
      field: "status",
      from: "contacted",
      to: "unreachable",
    });
    await pastCutoff();
    expect((await detail(id)).capabilities.contactStatus).toEqual([]);
    expect(await codesOf(await set(id, "contacted"), 422)).toEqual(["/to:before_cutoff"]);
    const imported = await participant();
    // imported → contacted has no cutoff guard (the lifecycle transitions table).
    expect((await set(imported, "contacted")).status).toBe(200);
    expect((await set(imported, "unreachable")).status).toBe(200);
  });

  it("refuses steps without an edge: informed → contacted, a terminal status, the same status", async () => {
    const id = await participant();
    await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
    await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
    expect((await detail(id)).capabilities.contactStatus).toEqual([]);
    expect(await codesOf(await set(id, "contacted"), 422)).toEqual(["/to:no_edge"]);
    expect(await codesOf(await set(id, "unreachable"), 422)).toEqual(["/to:no_edge"]);
    const withdrawn = await participant();
    await changeStatus(owner.$client, withdrawn, {
      field: "status",
      from: "imported",
      to: "withdrawn",
      endReason: "never_contacted",
      effectiveDate: await sql("select berlin_today()::text as d").then((r) => r.rows[0].d),
    });
    expect(await codesOf(await set(withdrawn, "contacted"), 422)).toEqual(["/to:no_edge"]);
    const imported = await participant();
    expect(await codesOf(await set(imported, "unreachable"), 422)).toEqual(["/to:no_edge"]);
    expect(await statusEvents(imported)).toEqual([]);
  });

  it("is the PL's and the assigned consultant's: back office, the regional manager and an unassigned consultant 403", async () => {
    const id = await participant({ assigned: false });
    for (const as of [backOffice, regionalOperationsManager, consultant]) {
      const res = await set(id, "contacted", as);
      expect([as, res.status]).toEqual([as, 403]);
    }
    expect((await detail(id, backOffice)).capabilities.contactStatus).toEqual([]);
    const assigned = await participant();
    expect((await detail(assigned, consultant)).capabilities.contactStatus).toEqual(["contacted"]);
    expect((await set(assigned, "contacted", consultant)).status).toBe(200);
    // The assignment ends: the consultant may no longer.
    await sql("delete from participant_assignment where participation_id = $1", [assigned]);
    await expectProblem(await set(assigned, "unreachable", consultant), 403, "forbidden");
    expect(await statusEvents(assigned)).toHaveLength(1);
  });

  it("orders 404 (hidden, membership lost) before 403 before 409/422", async () => {
    // An unknown participation and one in a project the viewer doesn't see: 404 whatever the body.
    const missing = await app.request(
      `/api/v1/participations/${randomUUID()}/contact-status`,
      jsonRequest("POST", { to: "contacted", statusVersion: 0 }, staff[projectLead]!),
    );
    await expectProblem(missing, 404, "not-found");
    const id = await participant({ assigned: false });
    // 403 before the stale version and before no_edge.
    await expectProblem(await set(id, "unreachable", backOffice, 99), 403, "forbidden");
    // 409 before the guard: a stale version.
    const res = await set(id, "contacted", projectLead, (await version(id)) + 1);
    expect(await codesOf(res, 409)).toEqual([":stale_status"]);
    expect(await statusEvents(id)).toEqual([]);
    await sql("delete from project_membership where project_id = $1 and staff_user_id = $2", [
      werkNord,
      projectLead,
    ]);
    await expectProblem(await set(id, "contacted"), 404, "not-found");
  });

  it("validates the target: only the contact statuses", async () => {
    const id = await participant();
    await expectProblem(await set(id, "informed"), 400, "validation-error");
  });
});
