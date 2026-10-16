import { createDb } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testEnv } from "../testing";
import { parseLifecycleArgs, runLifecycleCli } from "./cli";

// `pnpm jobs:lifecycle [--today YYYY-MM-DD]` (plan 5.9, Q96): runs the sweep once in this process.
const urls = testDatabaseUrls();
const db = createDb(urls.app);
const owner = createDb(urls.owner).$client;
afterAll(() => Promise.all([db.$client.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

const logs: string[] = [];
const logger = pino(
  { level: "info", base: undefined },
  { write: (line: string) => logs.push(line) },
);
const run = (argv: string[], env = testEnv) => runLifecycleCli({ argv, env, db, logger });
const runDates = async () =>
  (await owner.query("select run_date::text from job_run order by run_date")).rows.map(
    (r) => r.run_date,
  );

describe("parseLifecycleArgs", () => {
  it("takes nothing or one --today date", () => {
    expect(parseLifecycleArgs([])).toEqual({});
    expect(parseLifecycleArgs(["--today", "2025-03-03"])).toEqual({ today: "2025-03-03" });
    expect(parseLifecycleArgs(["--today=2025-03-03"])).toEqual({ today: "2025-03-03" });
  });

  it.each([
    [["--today"]],
    [["--today", "2025-02-30"]],
    [["--today", "03.03.2025"]],
    [["--now"]],
    [["--today", "2025-03-03", "extra"]],
  ])("refuses %j with invalid_arguments", (argv) => {
    expect(() => parseLifecycleArgs(argv)).toThrow(
      expect.objectContaining({ code: "invalid_arguments" }),
    );
  });
});

describe("runLifecycleCli", () => {
  it("runs a past day once and records it; a second run changes nothing", async () => {
    expect(await run(["--today", "2025-03-03"])).toMatchObject({
      outcome: "completed",
      runDate: "2025-03-03",
    });
    expect(await run(["--today", "2025-03-03"])).toMatchObject({ outcome: "already_completed" });
    expect(await runDates()).toEqual(["2025-03-03"]);
    const sweeps = logs.map((l) => JSON.parse(l)).filter((l) => l.msg === "lifecycle sweep");
    expect(sweeps.at(-1)).toMatchObject({ job: "lifecycle.sweep", outcome: "already_completed" });
  });

  it("stops a run not due by database time with run_not_due, before any change (Q96)", async () => {
    await expect(run(["--today", "2091-03-01"])).rejects.toMatchObject({ code: "run_not_due" });
    await expect(
      run([], { ...testEnv, clock: "fixed:2091-03-01T03:15:00Z" }),
    ).rejects.toMatchObject({ code: "run_not_due" });
    expect(await runDates()).toEqual([]);
  });

  it("refuses NODE_ENV=production", async () => {
    await expect(run([], { ...testEnv, nodeEnv: "production" })).rejects.toMatchObject({
      code: "refused_in_production",
    });
  });
});
