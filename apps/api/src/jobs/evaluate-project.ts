import type { Clock } from "@transfer/adapters";
import {
  eq,
  inArray,
  participation,
  profilingExceptionRequest,
  project,
  projectEntryWave,
  type Database,
} from "@transfer/db";
import {
  planSystemTransitions,
  terminalMainStatuses,
  type EntryWave,
  type Plan,
} from "@transfer/domain";
import type { Logger } from "pino";
import type { GuardFactsProvider } from "../participations/guard-facts";
import {
  createStatusService,
  exceptionOf,
  StatusServiceError,
  type ServiceActor,
} from "../participations/status-service";
import { JobError } from "./errors";
import { jobNames } from "./names";
import type { EvaluateProject } from "./payloads";
import { lifecycleRunState, runDays } from "./run-window";

export type EvaluateDeps = {
  db: Database;
  clock: Clock;
  facts: GuardFactsProvider;
  logger: Logger;
  /** `JOBS_LIFECYCLE_TIME`: the job derives each day's scheduled instant from it. */
  lifecycleTime: string;
};

export type EvaluationCounts = {
  participations: number;
  planned: number;
  applied: number;
  stale: number;
  refused: number;
  flagged: number;
};

const system: ServiceActor = { kind: "system", job: jobNames.evaluateProject };

/**
 * `lifecycle.evaluate-project` (plan 5.9): plans the system transitions of every open
 * participation of one project for the window's days (`planSystemTransitions`, with the snapshot
 * of each day's scheduled run, round 9) and applies each change through the status service as
 * `system`, with the job id. The service locks, re-checks the guards and validates the planner's
 * effective dates (round 18).
 *
 * The job trusts its payload for nothing but the bounds (round 21): it runs only on its run date
 * (`run_date_passed`), only once that day's scheduled time has passed by database time
 * (`run_not_due`, Q96), and only for the window that starts after the last completed run
 * (`window_mismatch`: no completed day again, no missing day); it derives the days and their
 * scheduled instants from `JOBS_LIFECYCLE_TIME` itself. All checks come before any planning or
 * write.
 *
 * Idempotent: a moved participation plans nothing. Only the status service's refusals are
 * lifecycle refusals: a lost race (`stale`) is counted, not an error; any other is counted, the
 * other participations are still applied, and the job then fails (`changes_refused`), so the day
 * isn't recorded. Any other error (database, infrastructure, a bug) propagates at once.
 */
export async function evaluateProject(
  { db, clock, facts, logger, lifecycleTime }: EvaluateDeps,
  { projectId, firstDay, runDate }: EvaluateProject,
  jobId: string,
): Promise<EvaluationCounts> {
  if (clock.today() !== runDate) throw new JobError("run_date_passed");
  const state = await lifecycleRunState(db, runDate, lifecycleTime);
  if (!state.due) throw new JobError("run_not_due");
  if (firstDay !== state.firstDay) throw new JobError("window_mismatch");
  const days = runDays(firstDay, runDate, lifecycleTime);

  const plans = await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ type: project.type })
      .from(project)
      .where(eq(project.id, projectId));
    if (!found) throw new JobError("project_not_found");
    const waves: EntryWave[] = await tx
      .select({
        id: projectEntryWave.id,
        code: projectEntryWave.code,
        signingDeadline: projectEntryWave.signingDeadline,
        defaultTgStart: projectEntryWave.defaultTgStart,
        defaultTgEnd: projectEntryWave.defaultTgEnd,
        latestEntryDate: projectEntryWave.latestEntryDate,
      })
      .from(projectEntryWave)
      .where(eq(projectEntryWave.projectId, projectId));
    const open = (
      await tx.select().from(participation).where(eq(participation.projectId, projectId))
    ).filter((p) => !terminalMainStatuses.has(p.status));
    const requestIds = open.flatMap((p) => p.profilingExceptionRequestId ?? []);
    const requests = requestIds.length
      ? await tx
          .select()
          .from(profilingExceptionRequest)
          .where(inArray(profilingExceptionRequest.id, requestIds))
      : [];
    const result: [string, Plan][] = [];
    for (const p of open) {
      const request = requests.find((r) => r.id === p.profilingExceptionRequestId);
      const snapshot = {
        current: { status: p.status, profilingStatus: p.profilingStatus, dsvStatus: p.dsvStatus },
        wave: waves.find((w) => w.id === p.entryWaveId) ?? null,
        participation: {
          tgStart: p.tgStart,
          tgEnd: p.tgEnd,
          offerDeadline: p.offerDeadline,
          tgEntryDate: p.tgEntryDate,
        },
        facts: await facts.facts(tx, {
          participationId: p.id,
          currentRequest: exceptionOf(request),
        }),
      };
      result.push([
        p.id,
        planSystemTransitions(snapshot, { type: found.type, waves }, { days, today: runDate }),
      ]);
    }
    return result;
  });

  const service = createStatusService({ db, clock, facts });
  const counts: EvaluationCounts = {
    participations: plans.length,
    planned: 0,
    applied: 0,
    stale: 0,
    refused: 0,
    flagged: 0,
  };
  for (const [participationId, { changes, flags }] of plans) {
    counts.planned += changes.length;
    if (flags.length) counts.flagged += 1;
    // In order: each change starts where the previous one left the participation.
    for (const change of changes) {
      try {
        await service.changeStatus(system, { participationId, ...change }, { jobId });
        counts.applied += 1;
      } catch (error) {
        if (!(error instanceof StatusServiceError)) throw error;
        if (error.kind === "stale") counts.stale += 1;
        else counts.refused += 1;
        break;
      }
    }
  }
  logger.info({ job: jobNames.evaluateProject, jobId, projectId, ...counts }, "project evaluated");
  if (counts.refused) throw new JobError("changes_refused");
  return counts;
}
