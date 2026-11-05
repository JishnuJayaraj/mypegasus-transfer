import { randomUUID } from "node:crypto";
import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  HistoryPage,
  matchesWorklistFilter,
  ParticipationDetail,
  ProjectDashboard,
  Worklist,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, origin, readJson, testApp } from "./testing";

// Closing a BA reporting task (process-and-lifecycle.md, BA reporting; D28, Q111, Q207) against
// transfer_test: "Gemeldet am" and "Nicht erforderlich" with ADR-0010's order, the overview's
// tasks and their capability, the work list's `ba_report_pending` and its counts, the history's
// `dsv` stream. Synthetic data only; the tasks are owner fixtures (the date change and the exit
// create them in their own tests).
const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant, backOffice, admin } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice, admin]) staff[id] = await login(app, id);
});
beforeEach(() => resetTestDatabase({ seed: true, active: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

function request(method: string, path: string, as: string = projectLead, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  return app.request(`/api/v1${path}`, init);
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const day = async (offset = 0) =>
  (await sql("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d as string;

/** A contacted Werk Nord participation, assigned to the consultant unless `assign` is false. */
async function participation(assign = true) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  if (assign) {
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
  }
  return id;
}

/** A pending task of the participation created `age` days ago. */
async function task(id: string, age = 3, kind = "planned_end_changed") {
  const taskId = randomUUID();
  await sql(
    `insert into ba_reporting_task (id, participation_id, project_id, reporting_kind, subject_date,
       created_at)
     values ($1, $2, $3, $4, berlin_today() + 30, now() - make_interval(days => $5))`,
    [taskId, id, werkNord, kind, age],
  );
  return taskId;
}

const outcome = (taskId: string, body: unknown, as: string = projectLead) =>
  request("POST", `/ba-reporting-tasks/${taskId}/outcome`, as, body);
const codes = async (res: Response) =>
  (await expectProblem(res, 422, "domain-error")).errors?.map((e) => [e.code, e.pointer]);
const detail = async (id: string, as: string = projectLead) =>
  readJson(await request("GET", `/participations/${id}`, as), ParticipationDetail);
const worklist = async (as: string = projectLead) =>
  readJson(await request("GET", `/projects/${werkNord}/worklist`, as), Worklist);
const row = async (id: string, as: string = projectLead) =>
  (await worklist(as)).items.find((i) => i.id === id)!;

describe("POST /ba-reporting-tasks/{id}/outcome (D28)", () => {
  it("records 'Gemeldet am': the overview shows it, the work list's item and the capability go", async () => {
    const id = await participation();
    const taskId = await task(id, 3);
    const before = (await detail(id)).baReportingTasks!;
    expect(before).toEqual([
      expect.objectContaining({
        id: taskId,
        status: "pending",
        reportedOn: null,
        notRequiredReason: null,
        decidedAt: null,
        capabilities: { recordOutcome: true },
      }),
    ]);
    expect((await row(id)).agenturItems).toEqual([
      { kind: "ba_report_pending", date: await day(-3) },
    ]);
    const res = await outcome(taskId, { outcome: "reported", reportedOn: await day(-1) });
    expect(res.status).toBe(204);
    const [after] = (await detail(id)).baReportingTasks!;
    expect(after).toMatchObject({
      status: "reported",
      reportedOn: await day(-1),
      notRequiredReason: null,
      decidedAt: expect.any(String),
      capabilities: { recordOutcome: false },
    });
    expect((await row(id)).agenturItems).toEqual([]);
    const history = await readJson(
      await request("GET", `/participations/${id}/history?stream=dsv`),
      HistoryPage,
    );
    expect(history.items.find((e) => e.type === "ba_report_recorded")?.details).toEqual({
      kind: "planned_end_changed",
      outcome: "reported",
      reportedOn: await day(-1),
    });
  });

  it("records 'Nicht erforderlich' by back office, with its reason, for a closed participation too", async () => {
    const id = await participation();
    const taskId = await task(id, 1, "early_exit");
    await changeStatus(owner.$client, id, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await day(0),
    });
    // A closed participation keeps its pending report on the work list.
    expect((await row(id)).agenturItems).toEqual([
      { kind: "ba_report_pending", date: await day(-1) },
    ]);
    expect((await detail(id, backOffice)).baReportingTasks![0]!.capabilities).toEqual({
      recordOutcome: true,
    });
    const res = await outcome(
      taskId,
      { outcome: "not_required", reason: "agentur_confirmed_not_required" },
      backOffice,
    );
    expect(res.status).toBe(204);
    expect((await detail(id)).baReportingTasks![0]).toMatchObject({
      status: "not_required",
      reportedOn: null,
      notRequiredReason: "agentur_confirmed_not_required",
    });
    expect((await row(id)).agenturItems).toEqual([]);
  });

  it("closes a task once and takes a date from the task's day to today", async () => {
    const id = await participation();
    const taskId = await task(id, 2);
    expect(
      await codes(await outcome(taskId, { outcome: "reported", reportedOn: await day(1) })),
    ).toEqual([["date_in_future", "/reportedOn"]]);
    expect(
      await codes(await outcome(taskId, { outcome: "reported", reportedOn: await day(-3) })),
    ).toEqual([["date_before_task", "/reportedOn"]]);
    expect((await outcome(taskId, { outcome: "reported", reportedOn: await day(-2) })).status).toBe(
      204,
    );
    expect(
      await codes(await outcome(taskId, { outcome: "not_required", reason: "created_in_error" })),
    ).toEqual([["already_recorded", ""]]);
    expect((await detail(id)).baReportingTasks![0]!.reportedOn).toBe(await day(-2));
  });

  it("answers visibility before permission before state", async () => {
    const id = await participation();
    const taskId = await task(id);
    const hidden = await participation(false);
    const hiddenTask = await task(hidden);
    // Closed or not, a task the viewer doesn't read is 404: the unassigned consultant, the admin.
    await outcome(hiddenTask, { outcome: "not_required", reason: "created_in_error" });
    for (const [t, as] of [
      [hiddenTask, consultant],
      [taskId, admin],
      [randomUUID(), projectLead],
    ] as const) {
      await expectProblem(
        await outcome(t, { outcome: "reported", reportedOn: await day(1) }, as),
        404,
        "not-found",
      );
    }
    // The assigned consultant reads the task but may not close it, whatever its state.
    await expectProblem(
      await outcome(taskId, { outcome: "reported", reportedOn: await day(1) }, consultant),
      403,
      "forbidden",
    );
    expect((await detail(id, consultant)).baReportingTasks![0]!.capabilities).toEqual({
      recordOutcome: false,
    });
    // The consultant sees the item on their work list, as they read the task.
    expect((await row(id, consultant)).agenturItems).toEqual([
      { kind: "ba_report_pending", date: await day(-3) },
    ]);
    for (const body of [
      { outcome: "reported" },
      { outcome: "not_required", reason: "other" },
      { outcome: "reported", reportedOn: await day(0), reason: "created_in_error" },
    ]) {
      await expectProblem(await outcome(taskId, body), 400, "validation-error");
    }
    const empty = await app.request(`/api/v1/ba-reporting-tasks/${taskId}/outcome`, {
      method: "POST",
      headers: { ...staff[projectLead]!, Origin: origin },
    });
    expect(empty.status).toBe(415);
    expect((await detail(id)).baReportingTasks![0]!.status).toBe("pending");
  });

  it("counts the pending reports in the dashboard's Agentur group as the work list filters them", async () => {
    const [first, second] = [await participation(), await participation()];
    await task(first, 5);
    await task(first, 2, "later_entry");
    await task(second, 1);
    expect((await row(first)).agenturItems).toEqual([
      { kind: "ba_report_pending", date: await day(-5) },
    ]);
    const items = (await worklist()).items;
    const { counts } = await readJson(
      await request("GET", `/projects/${werkNord}/dashboard`),
      ProjectDashboard,
    );
    for (const entry of [
      ...counts.agentur,
      ...counts.tiles.filter((t) => t.key === "agentur_open"),
    ]) {
      expect(entry.count).toBe(items.filter((i) => matchesWorklistFilter(i, entry.filter)).length);
    }
    expect(counts.agentur.find((c) => c.key === "ba_report_pending")!.count).toBe(2);
  });
});
