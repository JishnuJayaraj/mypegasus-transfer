import { createClock, ManualClock, scheduledAt } from "@transfer/adapters";
import type { Database } from "@transfer/db";
import { isoDate, type IsoDate } from "@transfer/domain";
import type { Logger } from "pino";
import { retentionPeriods, retentionPrerequisites } from "@transfer/db";
import type { FileStorage } from "@transfer/adapters";
import type { Env, RetentionEnv } from "../env";
import { dbGuardFacts, type GuardFactsProvider } from "../participations/guard-facts";
import { JobError } from "./errors";
import { inlineDispatch, runLifecycleSweep, type SweepResult } from "./lifecycle-sweep";
import { jobNames } from "./names";
import { runRetention, type RetentionSummary } from "./retention";

/** `[--today YYYY-MM-DD]`; anything else is `invalid_arguments`. */
export function parseLifecycleArgs(argv: readonly string[]): { today?: IsoDate } {
  const [flag, value, ...rest] = argv.length === 1 ? argv[0]!.split(/=(.*)/s) : argv;
  if (flag === undefined) return {};
  const today = isoDate.safeParse(value);
  if (flag !== "--today" || !today.success || rest.some(Boolean)) {
    throw new JobError("invalid_arguments");
  }
  return { today: today.data };
}

/**
 * `pnpm jobs:lifecycle [--today YYYY-MM-DD]` (plan 5.9): runs the lifecycle sweep once, the
 * projects evaluated in this process. `--today` stands the clock at that day's scheduled run time
 * (a `ManualClock`); without it the configured `CLOCK`. Database time decides (Q96): a run not due
 * stops before any change with `run_not_due`. Dev and CI only: refused with `NODE_ENV=production`.
 */
export async function runLifecycleCli({
  argv,
  env,
  db,
  logger,
  facts = dbGuardFacts,
}: {
  argv: readonly string[];
  env: Env;
  db: Database;
  logger: Logger;
  facts?: GuardFactsProvider;
}): Promise<SweepResult> {
  if (env.nodeEnv === "production") throw new JobError("refused_in_production");
  const { today } = parseLifecycleArgs(argv);
  const lifecycleTime = env.jobsLifecycleTime;
  const clock = today
    ? new ManualClock(scheduledAt(today, lifecycleTime))
    : createClock({ CLOCK: env.clock, NODE_ENV: env.nodeEnv });
  const result = await runLifecycleSweep(
    { db, clock, lifecycleTime },
    inlineDispatch({ db, clock, facts, logger, lifecycleTime }),
  );
  logger.info({ job: jobNames.lifecycleSweep, ...result }, "lifecycle sweep");
  if (result.outcome === "not_due") throw new JobError("run_not_due");
  return result;
}

/** `[--dry-run] [--today YYYY-MM-DD]`, in any order; anything else is `invalid_arguments`. */
export function parseRetentionArgs(argv: readonly string[]): { dryRun: boolean; today?: IsoDate } {
  const args = argv.flatMap((arg) => (arg.startsWith("--today=") ? arg.split(/=(.*)/s, 2) : [arg]));
  let dryRun = false;
  let today: IsoDate | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run" && !dryRun) dryRun = true;
    else if (args[i] === "--today" && today === undefined) {
      const parsed = isoDate.safeParse(args[++i]);
      if (!parsed.success) throw new JobError("invalid_arguments");
      today = parsed.data;
    } else throw new JobError("invalid_arguments");
  }
  return today ? { dryRun, today } : { dryRun };
}

/**
 * `pnpm jobs:retention [--dry-run] [--today YYYY-MM-DD]` (ADR-0011; data-protection.md,
 * retention as built): one run of the retention job as the retention role, with the data
 * catalog's periods and prerequisites only (nothing from the environment): while any is unmet it
 * is a dry run. `--today` stands the clock at that day and is refused with `NODE_ENV=production`.
 */
export async function runRetentionCli({
  argv,
  env,
  db,
  storage,
  logger,
}: {
  argv: readonly string[];
  env: Pick<RetentionEnv, "nodeEnv" | "clock">;
  db: Database;
  storage: FileStorage | undefined;
  logger: Logger;
}): Promise<RetentionSummary> {
  const { dryRun, today } = parseRetentionArgs(argv);
  if (today && env.nodeEnv === "production") throw new JobError("refused_in_production");
  const clock = today
    ? new ManualClock(scheduledAt(today, "12:00"))
    : createClock({ CLOCK: env.clock, NODE_ENV: env.nodeEnv });
  return runRetention(
    { db, storage, clock, logger },
    { periods: retentionPeriods, prerequisites: retentionPrerequisites, dryRun },
  );
}
