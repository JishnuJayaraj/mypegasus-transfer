import { randomUUID } from "node:crypto";
import { scheduledAt, type Clock } from "@transfer/adapters";
import { project, sql, type Database } from "@transfer/db";
import type { IsoDate } from "@transfer/domain";
import { evaluateProject, type EvaluateDeps } from "./evaluate-project";
import { jobNames } from "./names";
import { EvaluateProjectPayload, type EvaluateProject } from "./payloads";
import { lifecycleRunState, runDays } from "./run-window";

export type SweepDeps = { db: Database; clock: Clock; lifecycleTime: string };

export type SweepResult =
  | { outcome: "not_due" | "already_completed"; runDate: IsoDate }
  | { outcome: "completed"; runDate: IsoDate; days: number; projects: number };

/** Runs the project jobs; resolves once every one finished, rejects if any failed. */
export type Dispatch = (jobs: EvaluateProject[]) => Promise<void>;

/**
 * `lifecycle.sweep` (plan 5.9, rounds 9, 19, 20). The run date is the Clock's Berlin today; it is
 * due only once its scheduled time has passed by **database time** (Q96): a missed-run sweep
 * before the run time, a future `--today` or a fixed Clock ahead of the database stops here,
 * before any change, and writes no `job_run` row. A due run evaluates every day after the last
 * completed run up to today (the catch-up window; the first run: today), one project job per
 * project, and records today's run only after every project job finished. A completed day is
 * never evaluated again; a failed sweep writes no row, so the next one covers the gap.
 */
export async function runLifecycleSweep(
  { db, clock, lifecycleTime }: SweepDeps,
  dispatch: Dispatch,
): Promise<SweepResult> {
  const runDate = clock.today();
  const { due, last, firstDay } = await lifecycleRunState(db, runDate, lifecycleTime);
  if (!due) return { outcome: "not_due", runDate };
  if (last !== null && last >= runDate) return { outcome: "already_completed", runDate };

  const projects = await db.select({ id: project.id }).from(project).orderBy(project.id);
  await dispatch(projects.map(({ id }) => ({ projectId: id, firstDay, runDate })));
  // Only the three columns the runtime role may insert: completed_at is the database's now().
  const at = scheduledAt(runDate, lifecycleTime).toISOString();
  await db.execute(sql`
    insert into job_run (job_name, run_date, scheduled_at)
    values (${jobNames.lifecycleSweep}, ${runDate}, ${at}::timestamptz)
    on conflict do nothing`);
  const days = runDays(firstDay, runDate, lifecycleTime).length;
  return { outcome: "completed", runDate, days, projects: projects.length };
}

/**
 * Evaluates the projects one after the other in this process (`pnpm jobs:lifecycle`), through
 * the same payload schema and function as the queue's worker, so a running API's workers never
 * pick up a `--today` run.
 */
export function inlineDispatch(deps: EvaluateDeps): Dispatch {
  return async (jobs) => {
    for (const job of jobs) {
      await evaluateProject(deps, EvaluateProjectPayload.parse(job), randomUUID());
    }
  };
}
