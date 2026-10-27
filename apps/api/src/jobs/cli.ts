import { createClock, ManualClock, scheduledAt } from "@transfer/adapters";
import type { Database } from "@transfer/db";
import { isoDate, type IsoDate } from "@transfer/domain";
import type { Logger } from "pino";
import type { Env } from "../env";
import { dbGuardFacts, type GuardFactsProvider } from "../participations/guard-facts";
import { JobError } from "./errors";
import { inlineDispatch, runLifecycleSweep, type SweepResult } from "./lifecycle-sweep";
import { jobNames } from "./names";

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
