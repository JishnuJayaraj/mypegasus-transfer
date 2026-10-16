import { ManualClock, scheduledAt } from "@transfer/adapters";
import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import type { DatedFact, GuardFacts } from "@transfer/domain";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { failClosedFacts, type GuardFactsProvider } from "../participations/guard-facts";
import { createStatusService } from "../participations/status-service";
import { staffSubject } from "../participations/subjects";
import { evaluateProject } from "./evaluate-project";
import { startJobs } from "./jobs";
import { inlineDispatch, runLifecycleSweep } from "./lifecycle-sweep";
import { jobNames } from "./names";

// AC-38, AC-39, AC-40 (plan 5.9, PR 1h-2): the nightly sweep and the per-project job, with a
// manual clock on run days before database time (Q96) and a synthetic wave of Lager Süd.
const urls = testDatabaseUrls();
const db = createDb(urls.app);
const owner = createDb(urls.owner).$client;
afterAll(() => Promise.all([db.$client.end(), owner.end()]));

const { lagerSued } = seedProjectIds;
const clock = new ManualClock(scheduledAt("2025-02-03", "10:00"));
const logs: string[] = [];
// As the app's createLogger: no pid or hostname.
const logger = pino(
  { level: "info", base: undefined },
  { write: (line: string) => logs.push(line) },
);

const pl = staffSubject(seedStaffUserIds.projectLead, { [lagerSued]: ["project_lead"] });
const backOffice = staffSubject(seedStaffUserIds.backOffice, { [lagerSued]: ["back_office"] });

// Recorded long before any scheduled run: every TG entry guard passes.
const early: DatedFact = { validOn: "2025-01-20", recordedAt: new Date("2025-01-20T10:00:00Z") };
const entryFacts: GuardFacts = {
  dsvGenerated: early,
  dsvScanReceived: early,
  dsvFullyExecuted: early,
  asuRegisteredWithProof: early,
  tl407Signed: early,
  profilingDone: early,
};
/**
 * B (signed, profiled) has every TG entry fact; the others only the generated DSV their offer
 * needed. Facts are per participation, as the documents will be.
 */
const provider = (facts: GuardFacts = entryFacts): GuardFactsProvider => ({
  facts: async (tx, input) => ({
    ...(await failClosedFacts.facts(tx, input)),
    ...(input.participationId === ids.b ? facts : { dsvGenerated: early }),
  }),
  evidence: async () => undefined,
});

/** The three participations: A offered (expires), B signed and profiled (enters), C imported. */
let ids: { a: string; b: string; c: string };
let waveId: string;

beforeEach(async () => {
  await resetTestDatabase({ seed: true });
  logs.length = 0;
  clock.set(scheduledAt("2025-02-03", "10:00"));
  // Signing deadline 14 Feb, TG start 3 Mar, latest entry 14 Mar 2025: cutoff on 15 Mar.
  const { rows } = await owner.query(
    `insert into project_entry_wave (project_id, code, name, signing_deadline, default_tg_start, default_tg_end, latest_entry_date)
     values ($1, 'P1', 'P1', '2025-02-14', '2025-03-03', '2026-02-27', '2025-03-14') returning id`,
    [lagerSued],
  );
  waveId = rows[0].id;
  const service = createStatusService({ db, clock, facts: provider() });
  const create = async () =>
    (await service.createParticipation(pl, { projectId: lagerSued, entryWaveId: waveId }))
      .participationId;
  const [a, b, c] = [await create(), await create(), await create()];
  ids = { a, b, c };
  const consultant = staffSubject(
    seedStaffUserIds.consultant,
    { [lagerSued]: ["consultant"] },
    {},
    [a, b, c],
  );
  for (const id of [a, b]) {
    for (const [from, to] of [
      ["imported", "contacted"],
      ["contacted", "informed"],
    ] as const) {
      await service.changeStatus(consultant, { participationId: id, track: "main", from, to });
    }
    await service.changeStatus(backOffice, {
      participationId: id,
      track: "dsv",
      from: "not_offered",
      to: "dsv_offered",
    });
  }
  await service.changeStatus(backOffice, {
    participationId: b,
    track: "dsv",
    from: "dsv_offered",
    to: "dsv_signed",
  });
  for (const [from, to] of [
    ["not_started", "profiling_accepted"],
    ["profiling_accepted", "profiling_in_progress"],
    ["profiling_in_progress", "profiling_done"],
  ] as const) {
    await service.changeStatus(consultant, {
      participationId: b,
      track: "profiling",
      from,
      to,
      ...(to === "profiling_done" && { effectiveDate: "2025-02-03" }),
    });
  }
});

/** Runs the sweep at `time` (Berlin) on `day`, evaluating the projects in this process. */
function sweep(day: string, facts = provider(), time = "04:15") {
  clock.set(scheduledAt(day, time));
  return runLifecycleSweep(
    { db, clock, lifecycleTime: "04:15" },
    inlineDispatch({ db, clock, facts, logger }),
  );
}

async function statuses() {
  const { rows } = await owner.query(
    `select id, status, dsv_status, tg_entry_date::text, withdrawn_on::text, end_reason
     from participation where project_id = $1`,
    [lagerSued],
  );
  return Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
}

async function systemEvents() {
  const { rows } = await owner.query(
    `select participation_id as id, field, from_value, to_value, reason_code, effective_date::text,
       system_job, job_id is not null as has_job_id, details->>'entryKind' as entry_kind,
       details->>'scheduledAt' as scheduled_at
     from audit_event where actor_type = 'system' order by seq`,
  );
  return rows;
}

const auditCount = async () =>
  (await owner.query("select count(*)::int as n from audit_event")).rows[0].n;
const runDates = async () =>
  (await owner.query("select job_name, run_date::text from job_run order by run_date")).rows.map(
    (r) => `${r.job_name}:${r.run_date}`,
  );

const job = "lifecycle.evaluate-project";

describe("the lifecycle sweep (AC-38)", () => {
  it("expires the DSV and enters on the scheduled day as system, then records the run", async () => {
    expect(await sweep("2025-03-03")).toEqual({
      outcome: "completed",
      runDate: "2025-03-03",
      days: 1,
      projects: 3,
    });
    expect(await statuses()).toMatchObject({
      [ids.a]: { status: "informed", dsv_status: "dsv_expired" },
      [ids.b]: { status: "active_in_tg", tg_entry_date: "2025-03-03" },
      [ids.c]: { status: "imported" },
    });
    expect(await systemEvents()).toEqual([
      expect.objectContaining({
        id: ids.a,
        field: "dsv_status",
        to_value: "dsv_expired",
        effective_date: "2025-02-15",
        system_job: job,
        has_job_id: true,
      }),
      expect.objectContaining({
        id: ids.b,
        field: "status",
        to_value: "active_in_tg",
        effective_date: "2025-03-03",
        system_job: job,
        has_job_id: true,
        entry_kind: "scheduled_entry",
      }),
    ]);
    expect(await runDates()).toEqual(["lifecycle.sweep:2025-03-03"]);
  });

  it("adds no status change and no audit row when run twice, or after a crash before the record", async () => {
    await sweep("2025-03-03");
    const events = await auditCount();
    expect(await sweep("2025-03-03")).toEqual({
      outcome: "already_completed",
      runDate: "2025-03-03",
    });
    // A crash after the changes but before the record: the day is evaluated again, idempotently.
    await owner.query("delete from job_run");
    expect(await sweep("2025-03-03")).toMatchObject({ outcome: "completed" });
    expect(await auditCount()).toBe(events);
  });

  it("catches up the skipped days (no job_run row) with scheduled_entry_catchup", async () => {
    await owner.query(
      "insert into job_run (job_name, run_date, scheduled_at, completed_at) values ('lifecycle.sweep', '2025-02-28', $1, $1)",
      [scheduledAt("2025-02-28", "04:15")],
    );
    expect(await sweep("2025-03-05")).toMatchObject({ outcome: "completed", days: 5 });
    expect(await systemEvents()).toContainEqual(
      expect.objectContaining({
        id: ids.b,
        to_value: "active_in_tg",
        effective_date: "2025-03-03",
        entry_kind: "scheduled_entry_catchup",
        scheduled_at: scheduledAt("2025-03-03", "04:15").toISOString(),
      }),
    );
    expect(await runDates()).toEqual(["lifecycle.sweep:2025-02-28", "lifecycle.sweep:2025-03-05"]);
  });

  it("withdraws at the cutoff as system, the day after the latest entry date", async () => {
    await sweep("2025-03-03");
    await sweep("2025-03-15");
    expect(await statuses()).toMatchObject({
      [ids.a]: { status: "withdrawn", withdrawn_on: "2025-03-15", end_reason: "no_response" },
      [ids.c]: { status: "withdrawn", withdrawn_on: "2025-03-15", end_reason: "never_contacted" },
    });
    const withdrawals = (await systemEvents()).filter((e) => e.to_value === "withdrawn");
    expect(withdrawals.map((e) => [e.id, e.reason_code, e.effective_date])).toEqual(
      expect.arrayContaining([
        [ids.a, "no_response", "2025-03-15"],
        [ids.c, "never_contacted", "2025-03-15"],
      ]),
    );
  });

  it("never enters on evidence recorded after the day's run, nor re-evaluates the completed day", async () => {
    const late = { ...early, recordedAt: new Date("2025-03-03T05:00:00Z") }; // after 04:15 Berlin
    const lateAsu = provider({ ...entryFacts, asuRegisteredWithProof: late });
    await sweep("2025-03-03", lateAsu);
    await sweep("2025-03-04", lateAsu);
    expect((await statuses())[ids.b]).toMatchObject({ status: "informed" });
    expect(await runDates()).toEqual(["lifecycle.sweep:2025-03-03", "lifecycle.sweep:2025-03-04"]);
  });

  it("treats a concurrent change as stale, not as an error", async () => {
    let raced = false;
    const racing: GuardFactsProvider = {
      ...provider(),
      facts: async (tx, input) => {
        if (input.participationId === ids.a && !raced) {
          raced = true;
          // Back office records the decline after the job planned A's expiry.
          await createStatusService({ db, clock }).changeStatus(backOffice, {
            participationId: ids.a,
            track: "dsv",
            from: "dsv_offered",
            to: "dsv_declined",
          });
        }
        return provider().facts(tx, input);
      },
    };
    expect(await sweep("2025-03-03", racing)).toMatchObject({ outcome: "completed" });
    expect((await statuses())[ids.a]).toMatchObject({ dsv_status: "dsv_declined" });
    const summary = logs.map((l) => JSON.parse(l)).find((l) => l.projectId === lagerSued);
    expect(summary).toMatchObject({ applied: 1, stale: 1, refused: 0 });
  });

  it("fails the project job on a refusal the planner didn't foresee, after the others; no record", async () => {
    // Inconsistent facts (Q97): A's DSV executed by the facts though its track expired. The
    // planner enters A; the database refuses (a TG entry needs a signed DSV).
    const inconsistent: GuardFactsProvider = {
      ...provider(),
      facts: async (tx, input) => ({
        ...(await failClosedFacts.facts(tx, input)),
        ...(input.participationId === ids.c ? {} : entryFacts),
      }),
    };
    await expect(sweep("2025-03-03", inconsistent)).rejects.toMatchObject({
      code: "changes_refused",
    });
    expect(await statuses()).toMatchObject({
      [ids.a]: { status: "informed", dsv_status: "dsv_expired" },
      [ids.b]: { status: "active_in_tg" },
    });
    expect(await runDates()).toEqual([]);
    const summary = logs.map((l) => JSON.parse(l)).find((l) => l.projectId === lagerSued);
    expect(summary).toMatchObject({ planned: 3, applied: 2, refused: 1 });
  });

  it("writes no record when a project evaluation fails; the next run completes the day", async () => {
    const failing: GuardFactsProvider = {
      ...provider(),
      facts: async () => {
        throw Object.assign(new Error("connection to participant 4711 lost"), { code: "57P01" });
      },
    };
    await expect(sweep("2025-03-03", failing)).rejects.toMatchObject({ code: "57P01" });
    expect(await runDates()).toEqual([]);
    expect(await sweep("2025-03-03")).toMatchObject({ outcome: "completed" });
    expect((await statuses())[ids.b]).toMatchObject({ status: "active_in_tg" });
  });
});

describe("database time is authoritative (Q96)", () => {
  it("stops a run that isn't due before any change, and records nothing", async () => {
    const events = await auditCount();
    expect(await sweep("2091-03-01")).toEqual({ outcome: "not_due", runDate: "2091-03-01" });
    expect(await auditCount()).toBe(events);
    expect(await runDates()).toEqual([]);
  });

  it("refuses a project job whose run date the clock has left", async () => {
    clock.set(scheduledAt("2025-03-04", "04:15"));
    const days = [{ day: "2025-03-03", scheduledAt: scheduledAt("2025-03-03", "04:15") }];
    await expect(
      evaluateProject(
        { db, clock, facts: provider(), logger },
        { projectId: lagerSued, runDate: "2025-03-03", days },
        "job-1",
      ),
    ).rejects.toMatchObject({ name: "JobError", code: "run_date_passed" });
  });
});

describe("the Slice 1 facts (AC-39)", () => {
  it("let nobody into the TG; state-based expiry still runs", async () => {
    await sweep("2025-03-03", failClosedFacts);
    expect(await statuses()).toMatchObject({
      [ids.a]: { dsv_status: "dsv_expired" },
      [ids.b]: { status: "informed" },
    });
  });
});

describe("job logs (AC-40)", () => {
  it("carry the job name, job id, project id and counts only", async () => {
    await sweep("2025-03-03");
    await sweep("2025-03-15");
    const allowed = new Set([
      "level",
      "time",
      "msg",
      "job",
      "jobId",
      "projectId",
      "participations",
      "planned",
      "applied",
      "stale",
      "refused",
      "flagged",
    ]);
    const lines = logs.map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Object.keys(line).filter((key) => !allowed.has(key))).toEqual([]);
    }
    for (const id of Object.values(ids)) expect(logs.join("\n")).not.toContain(id);
  });
});

describe("through pg-boss (AC-37, AC-38, AC-40)", () => {
  it("runs the sweep as a job, one keyed project job per project, and records the day", async () => {
    clock.set(scheduledAt("2025-03-03", "04:15"));
    const { boss, stop } = await startJobs({
      connectionString: urls.app,
      lifecycleTime: "04:15",
      logger,
      work: { db, clock, facts: provider(), pollingIntervalSeconds: 0.5, dispatchPollMs: 100 },
    });
    try {
      for (const name of Object.values(jobNames)) await boss.deleteAllJobs(name);
      const finished = async (id: string) => {
        for (let i = 0; i < 300; i += 1) {
          const [found] = await boss.findJobs(jobNames.lifecycleSweep, { id });
          if (found && ["completed", "failed"].includes(found.state)) return found.state;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return "timeout";
      };
      const first = (await boss.send(jobNames.lifecycleSweep, {}))!;
      expect(await finished(first)).toBe("completed");
      expect((await statuses())[ids.b]).toMatchObject({ status: "active_in_tg" });
      expect(await runDates()).toEqual(["lifecycle.sweep:2025-03-03"]);

      // The entry's audit row names the project job, whose payload holds ids and dates only.
      const { rows } = await owner.query(
        "select job_id from audit_event where participation_id = $1 and to_value = 'active_in_tg'",
        [ids.b],
      );
      const [projectJob] = await boss.findJobs(jobNames.evaluateProject, { id: rows[0].job_id });
      expect(projectJob).toMatchObject({ singletonKey: `${lagerSued}:2025-03-03` });
      expect(projectJob!.data).toEqual({
        projectId: lagerSued,
        runDate: "2025-03-03",
        days: [
          { day: "2025-03-03", scheduledAt: scheduledAt("2025-03-03", "04:15").toISOString() },
        ],
      });

      // A second sweep the same day (a missed occurrence beside the due one) changes nothing.
      const events = await auditCount();
      const second = (await boss.send(jobNames.lifecycleSweep, {}))!;
      expect(await finished(second)).toBe("completed");
      expect(await auditCount()).toBe(events);
      const sweeps = logs.map((l) => JSON.parse(l)).filter((l) => l.msg === "lifecycle sweep");
      expect(sweeps.map((l) => [l.jobId, l.outcome])).toEqual([
        [first, "completed"],
        [second, "already_completed"],
      ]);
      for (const id of Object.values(ids)) expect(logs.join("\n")).not.toContain(id);
    } finally {
      await stop();
    }
  });

  it("stores a failed job's code, never its message", async () => {
    clock.set(scheduledAt("2025-03-03", "04:15"));
    const { boss, stop } = await startJobs({
      connectionString: urls.app,
      lifecycleTime: "04:15",
      logger,
      work: { db, clock, facts: provider(), pollingIntervalSeconds: 0.5 },
    });
    try {
      await boss.deleteAllJobs(jobNames.evaluateProject);
      // Free text in a payload is refused before anything runs.
      const id = (await boss.send(
        jobNames.evaluateProject,
        { projectId: lagerSued, runDate: "2025-03-03", days: [], note: "participant 4711" },
        { retryLimit: 0 },
      ))!;
      let state = "";
      for (let i = 0; i < 100 && state !== "failed"; i += 1) {
        state = (await boss.findJobs(jobNames.evaluateProject, { id }))[0]!.state;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const [failed] = await boss.findJobs(jobNames.evaluateProject, { id });
      expect(failed).toMatchObject({
        state: "failed",
        output: { name: "JobError", message: "invalid_payload" },
      });
      expect(JSON.stringify(failed!.output)).not.toContain("4711");
      const line = logs.map((l) => JSON.parse(l)).find((l) => l.msg === "job failed");
      expect(line).toMatchObject({
        job: jobNames.evaluateProject,
        jobId: id,
        code: "invalid_payload",
      });
      expect(logs.join("\n")).not.toContain("4711");
    } finally {
      await stop();
    }
  });
});
