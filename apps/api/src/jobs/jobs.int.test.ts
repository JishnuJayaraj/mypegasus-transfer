import { scheduledAt } from "@transfer/adapters";
import { createDb, jobsSchema } from "@transfer/db";
import { testDatabaseUrls } from "@transfer/db/testing";
import { pino } from "pino";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { jobNames, lifecycleCron, startJobs, timeZone, type Jobs } from "./jobs";

// AC-37 (plan 5.9, PR 1h-1): pg-boss starts as transfer_app on the schema db:migrate installed
// (migration off), with both queues and the nightly schedule in Europe/Berlin.
const urls = testDatabaseUrls();
const owner = createDb(urls.owner).$client;
const logs: string[] = [];
const logger = pino({ level: "info" }, { write: (line: string) => logs.push(line) });
let jobs: Jobs | undefined;

const start = (lifecycleTime = "04:15") =>
  startJobs({ connectionString: urls.app, lifecycleTime, logger }).then((started) => {
    jobs = started;
    return started;
  });

afterAll(() => owner.end());
afterEach(async () => {
  await jobs?.stop();
  jobs = undefined;
  logs.length = 0;
});

describe("lifecycleCron", () => {
  it("turns a Berlin run time into a daily cron expression", () => {
    expect(lifecycleCron("04:15")).toBe("15 4 * * *");
    expect(lifecycleCron("00:05")).toBe("5 0 * * *");
    expect(lifecycleCron("23:59")).toBe("59 23 * * *");
  });

  it("refuses the DST hour", () => {
    expect(() => lifecycleCron("02:30")).toThrow(/02:00 to 02:59/);
  });
});

describe("startJobs (AC-37)", () => {
  it("runs as transfer_app on the installed schema", async () => {
    const { boss } = await start();
    const { rows } = await boss.getDb().executeSql("select current_user as role");
    expect(rows).toEqual([{ role: "transfer_app" }]);
    expect(await boss.schemaVersion()).toBe(46);
    const { rows: owners } = await owner.query(
      "select r.rolname from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = $1",
      [jobsSchema],
    );
    expect(owners).toEqual([{ rolname: "transfer_owner" }]);
  });

  it("creates the sweep queue as singleton and the project queue as exclusive (round 19)", async () => {
    const { boss } = await start();
    const policies = {
      [jobNames.lifecycleSweep]: "singleton",
      [jobNames.evaluateProject]: "exclusive",
    };
    for (const [name, policy] of Object.entries(policies)) {
      expect(await boss.getQueue(name)).toMatchObject({
        name,
        policy,
        retryLimit: 3,
        retryBackoff: true,
      });
    }
  });

  it("registers the nightly sweep as a cron in Europe/Berlin", async () => {
    const { boss } = await start();
    expect(timeZone).toBe("Europe/Berlin");
    expect(await boss.getSchedule(jobNames.lifecycleSweep)).toMatchObject({
      name: jobNames.lifecycleSweep,
      cron: "15 4 * * *",
      timezone: "Europe/Berlin",
      options: { tz: "Europe/Berlin", missed: "once" },
    });
  });

  it("fires at the instants of scheduledAt, on both DST days", async () => {
    const { boss } = await start();
    const { cron, timezone } = (await boss.getSchedule(jobNames.lifecycleSweep))!;
    const from = scheduledAt("2026-10-24", "12:00");
    const fires = boss.previewSchedule(cron, { tz: timezone, from, count: 3 });
    const days = ["2026-10-25", "2026-10-26", "2026-10-27"];
    expect(fires).toEqual(days.map((day) => scheduledAt(day, "04:15")));
    const spring = scheduledAt("2027-03-27", "12:00");
    expect(boss.previewSchedule(cron, { tz: timezone, from: spring, count: 2 })).toEqual(
      ["2027-03-28", "2027-03-29"].map((day) => scheduledAt(day, "04:15")),
    );
  });

  it("updates the schedule to another run time on the next start", async () => {
    await (await start()).stop();
    const { boss } = await start("05:30");
    expect(await boss.getSchedule(jobNames.lifecycleSweep)).toMatchObject({ cron: "30 5 * * *" });
    expect(await boss.getSchedules()).toHaveLength(1);
  });

  it("logs that it started, with the schedule and no connection string", async () => {
    await start();
    const started = logs.map((line) => JSON.parse(line)).find((l) => l.msg === "jobs started");
    expect(started).toMatchObject({ cron: "15 4 * * *", tz: "Europe/Berlin" });
    expect(logs.join("\n")).not.toMatch(/transfer_app_dev|postgres:\/\//);
  });

  it("refuses a queue with another policy and stops again", async () => {
    await (await start()).stop();
    await owner.query(`update ${jobsSchema}.queue set policy = 'standard' where name = $1`, [
      jobNames.evaluateProject,
    ]);
    try {
      await expect(start()).rejects.toThrow(
        `Queue ${jobNames.evaluateProject} has policy standard, expected exclusive`,
      );
    } finally {
      await owner.query(`update ${jobsSchema}.queue set policy = 'exclusive' where name = $1`, [
        jobNames.evaluateProject,
      ]);
    }
  });

  it("refuses to start when the schema isn't installed, without migrating it", async () => {
    await owner.query(`alter schema ${jobsSchema} rename to pgboss_aside`);
    try {
      await expect(start()).rejects.toThrow("pg-boss is not installed");
      const { rows } = await owner.query("select to_regnamespace($1) as schema", [jobsSchema]);
      expect(rows).toEqual([{ schema: null }]);
    } finally {
      await owner.query(`alter schema pgboss_aside rename to ${jobsSchema}`);
    }
  });
});

/** pg-boss started with empty queues. */
async function startedEmpty() {
  const { boss } = await start();
  for (const name of Object.values(jobNames)) await boss.deleteAllJobs(name);
  return boss;
}

// Round 19: a missed occurrence can arrive beside the due one, so the sweep queue keeps every
// job and runs one at a time (job_run makes a second sweep a no-op); the project queue refuses a
// second job for the same project and day.
describe("queue policies (round 19)", () => {
  const today = "2026-10-16";
  const projectA = "00000000-0000-4000-9000-000000000001";
  const projectB = "00000000-0000-4000-9000-000000000002";

  it("keeps a second sweep queued while one is active, and runs it after", async () => {
    const boss = await startedEmpty();
    const first = await boss.send(jobNames.lifecycleSweep, {});
    const [active] = await boss.fetch(jobNames.lifecycleSweep);
    expect(active?.id).toBe(first);
    const second = await boss.send(jobNames.lifecycleSweep, {});
    const third = await boss.send(jobNames.lifecycleSweep, {});
    expect(second).toEqual(expect.any(String));
    expect(third).toEqual(expect.any(String));
    // Only one sweep is active at a time.
    expect(await boss.fetch(jobNames.lifecycleSweep)).toEqual([]);
    await boss.complete(jobNames.lifecycleSweep, active!.id);
    const [next] = await boss.fetch(jobNames.lifecycleSweep);
    expect(next?.id).toBe(second);
  });

  it("refuses a duplicate project/day job, queued or active", async () => {
    const boss = await startedEmpty();
    const send = (projectId: string, runDate = today) =>
      boss.send(
        jobNames.evaluateProject,
        { projectId, runDate },
        { singletonKey: `${projectId}:${runDate}` },
      );
    expect(await send(projectA)).toEqual(expect.any(String));
    expect(await send(projectA)).toBeNull();
    const [active] = await boss.fetch(jobNames.evaluateProject);
    expect(active?.data).toEqual({ projectId: projectA, runDate: today });
    expect(await send(projectA)).toBeNull();
  });

  it("keeps different project/day keys queueable", async () => {
    const boss = await startedEmpty();
    const send = (projectId: string, runDate: string) =>
      boss.send(
        jobNames.evaluateProject,
        { projectId, runDate },
        { singletonKey: `${projectId}:${runDate}` },
      );
    const ids = [
      await send(projectA, today),
      await send(projectB, today),
      await send(projectA, "2026-10-17"),
    ];
    expect(ids).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
    expect(new Set(ids).size).toBe(3);
  });
});
