import { randomUUID } from "node:crypto";
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
  textDates,
} from "./testing";

// Closing a BA reporting task (process-and-lifecycle.md, BA reporting; D28, Q111, Q207) as
// transfer_app calls `record_ba_report`: the PL or back office, once, `reported` with the sent date
// (not in the future, not before the task's Berlin day) or `not_required` with its reason; audited
// in the `dsv` stream; never on another's behalf, never a consultant's. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const { consultant, backOffice, admin, projectLead } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const asAdmin = auditContext({ actorType: "user", staffUserId: admin });
const { werkNord } = seedProjectIds;

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const daysAgo = async (n: number) =>
  (await one(`select (berlin_today() - $1::int)::text as d`, [n])).d as string;

/** A Werk Nord participation assigned to the consultant, with a pending task created `age` days ago. */
async function pendingTask(age = 3, kind = "early_exit") {
  const id = await call(app, "create_participation", { projectId: werkNord, context: pl });
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  await call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  // A fixture as the owner: the date change or the exit creates tasks in their own tests.
  const taskId = randomUUID();
  await owner.query(
    `insert into ba_reporting_task (id, participation_id, project_id, reporting_kind, subject_date,
       created_at)
     values ($1, $2, $3, $4, berlin_today(), now() - make_interval(days => $5))`,
    [taskId, id, werkNord, kind, age],
  );
  return { id, taskId };
}

type Record = {
  taskId: string;
  outcome?: string | null;
  reportedOn?: string | null;
  reason?: string | null;
  context?: string;
};

const record = (args: Record) =>
  call(app, "record_ba_report", {
    context: args.context ?? pl,
    taskId: args.taskId,
    outcome: args.outcome === undefined ? "reported" : args.outcome,
    reportedOn: args.reportedOn === undefined ? null : args.reportedOn,
    reason: args.reason ?? null,
  });

const taskRow = (taskId: string) =>
  one(
    `select status, reported_on, not_required_reason, decided_by, decided_at is not null as decided
     from ba_reporting_task where id = $1`,
    [taskId],
  );

const events = (id: string) =>
  owner
    .query(
      `select actor_staff_user_id, details from audit_event
       where participation_id = $1 and event_type = 'ba_report_recorded' order by seq`,
      [id],
    )
    .then((r) => r.rows);

describe("record_ba_report (process-and-lifecycle.md, BA reporting; D28)", () => {
  it("records 'Gemeldet am' with the sent date, who and when, audited in the dsv stream", async () => {
    const { id, taskId } = await pendingTask(3, "later_entry");
    const reportedOn = await daysAgo(1);
    await record({ taskId, reportedOn });
    expect(await taskRow(taskId)).toEqual({
      status: "reported",
      reported_on: reportedOn,
      not_required_reason: null,
      decided_by: projectLead,
      decided: true,
    });
    expect(await events(id)).toEqual([
      {
        actor_staff_user_id: projectLead,
        details: { taskId, kind: "later_entry", outcome: "reported", reportedOn },
      },
    ]);
  });

  it("records 'Nicht erforderlich' with its reason, by back office too", async () => {
    const { id, taskId } = await pendingTask();
    await record({
      taskId,
      outcome: "not_required",
      reason: "no_claim_month_affected",
      context: asBackOffice,
    });
    expect(await taskRow(taskId)).toEqual({
      status: "not_required",
      reported_on: null,
      not_required_reason: "no_claim_month_affected",
      decided_by: backOffice,
      decided: true,
    });
    expect((await events(id))[0].details).toEqual({
      taskId,
      kind: "early_exit",
      outcome: "not_required",
      reason: "no_claim_month_affected",
    });
  });

  it("closes a task once: a second outcome is already_recorded and changes nothing", async () => {
    const { id, taskId } = await pendingTask();
    await record({ taskId, reportedOn: await daysAgo(0) });
    for (const second of [
      { reportedOn: await daysAgo(1) },
      { outcome: "not_required", reason: "created_in_error" },
    ]) {
      await expect(record({ taskId, ...second })).rejects.toMatchObject(
        failsWith("already_recorded"),
      );
    }
    expect((await taskRow(taskId)).reported_on).toBe(await daysAgo(0));
    expect(await events(id)).toHaveLength(1);
  });

  it("takes a date from the task's Berlin day to today, never in the future", async () => {
    const { taskId } = await pendingTask(3);
    await expect(record({ taskId, reportedOn: await daysAgo(-1) })).rejects.toMatchObject(
      failsWith("date_in_future"),
    );
    await expect(record({ taskId, reportedOn: await daysAgo(4) })).rejects.toMatchObject(
      failsWith("date_before_task"),
    );
    await record({ taskId, reportedOn: await daysAgo(3) });
    expect((await taskRow(taskId)).status).toBe("reported");
  });

  it("refuses a consultant (assigned), a non-member admin and an action on someone's behalf", async () => {
    const { id, taskId } = await pendingTask();
    for (const context of [asConsultant, asAdmin]) {
      await expect(record({ taskId, reportedOn: await daysAgo(0), context })).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    const onBehalf = auditContext({
      actorType: "user",
      staffUserId: projectLead,
      onBehalfOf: id,
    });
    await expect(
      record({ taskId, reportedOn: await daysAgo(0), context: onBehalf }),
    ).rejects.toMatchObject({ code: "P0001" });
    expect((await taskRow(taskId)).status).toBe("pending");
  });

  it("refuses a shape that doesn't fit its outcome and an unknown task", async () => {
    const { taskId } = await pendingTask();
    const today = await daysAgo(0);
    for (const args of [
      { outcome: "reported", reportedOn: null },
      { outcome: "reported", reportedOn: today, reason: "created_in_error" },
      { outcome: "not_required", reportedOn: null, reason: null },
      { outcome: "not_required", reportedOn: today, reason: "created_in_error" },
      { outcome: "pending", reportedOn: null },
      { outcome: null, reportedOn: today },
    ]) {
      await expect(record({ taskId, ...args })).rejects.toMatchObject(
        failsWith("invalid_argument"),
      );
    }
    await expect(record({ taskId: randomUUID(), reportedOn: today })).rejects.toMatchObject(
      failsWith("task_not_found"),
    );
    expect((await taskRow(taskId)).status).toBe("pending");
  });

  it("closes a closed participation's task too", async () => {
    const { id, taskId } = await pendingTask();
    await changeStatus(app, id, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await daysAgo(0),
    });
    await record({ taskId, outcome: "not_required", reason: "agentur_confirmed_not_required" });
    expect((await taskRow(taskId)).status).toBe("not_required");
  });

  it("is the only writer of its event: record_audit_event refuses it", async () => {
    const { id } = await pendingTask();
    await expect(
      call(app, "record_audit_event", {
        projectId: werkNord,
        participationId: id,
        eventType: "ba_report_recorded",
        context: pl,
      }),
    ).rejects.toMatchObject(failsWith("event_type_reserved"));
  });

  it("leaves the outcome as recorded: the table refuses an edit or a reset", async () => {
    const { taskId } = await pendingTask();
    await record({ taskId, reportedOn: await daysAgo(0) });
    await expect(
      owner.query(`update ba_reporting_task set reported_on = berlin_today() - 1 where id = $1`, [
        taskId,
      ]),
    ).rejects.toMatchObject(failsWith("task_immutable"));
    await expect(
      app.query(`update ba_reporting_task set status = 'pending'`),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
