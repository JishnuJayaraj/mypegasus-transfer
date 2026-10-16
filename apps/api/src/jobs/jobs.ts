import { assertRunTime } from "@transfer/adapters";
import { jobsSchema } from "@transfer/db";
import { PgBoss, type Queue } from "pg-boss";
import type { Logger } from "pino";
import { errorForLog } from "../logger";

/** The background jobs (plan 5.9, ADR-0011); the handlers come with PR 1h-2. */
export const jobNames = {
  lifecycleSweep: "lifecycle.sweep",
  evaluateProject: "lifecycle.evaluate-project",
} as const;

/** The nightly run is a Berlin local time (round 9). */
export const timeZone = "Europe/Berlin";

/**
 * Both queues are `exclusive`: at most one queued or active job, per `singletonKey` where one is
 * given (the project job's `<projectId>:<runDate>`). pg-boss deduplicates keys only on `stately`
 * and `exclusive` queues (spike S2). Failures retry with backoff (plan 5.9).
 */
const queues: Record<string, Omit<Queue, "name"> & { policy: "exclusive" }> = {
  [jobNames.lifecycleSweep]: {
    policy: "exclusive",
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 60 * 60,
  },
  [jobNames.evaluateProject]: {
    policy: "exclusive",
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
  },
};

/** `HH:MM` (Berlin) as a daily cron expression; 02:00–02:59 is refused (round 9). */
export function lifecycleCron(time: string): string {
  assertRunTime(time);
  const [hour, minute] = time.split(":").map(Number);
  return `${minute} ${hour} * * *`;
}

export type JobsOptions = {
  /** The runtime role's URL (`DATABASE_URL`, transfer_app). */
  connectionString: string;
  /** `JOBS_LIFECYCLE_TIME`. */
  lifecycleTime: string;
  logger: Logger;
};

export type Jobs = { boss: PgBoss; stop: () => Promise<void> };

/**
 * Starts pg-boss in the API process (D7) as transfer_app on the schema `db:migrate` installed:
 * migration off, so a missing or outdated schema fails the start; `persistQueueStats` off and no
 * `reindex`, which would need DDL (spike S2). Creates the queues (idempotent), keeps their options
 * current and refuses one whose policy differs, then (re)registers the nightly sweep's cron in
 * Europe/Berlin. A missed occurrence (the API was down at the run time) is sent once on the next
 * start; the sweep's catch-up window covers the days in between (1h-2). Events are logged without
 * their data, errors without their message (CLAUDE.md rule 9).
 */
export async function startJobs({
  connectionString,
  lifecycleTime,
  logger,
}: JobsOptions): Promise<Jobs> {
  const cron = lifecycleCron(lifecycleTime);
  const boss = new PgBoss({
    connectionString,
    schema: jobsSchema,
    application_name: "transfer-jobs",
    migrate: false,
    createSchema: false,
    persistQueueStats: false,
    reindex: false,
  });
  boss.on("error", (error) => logger.error({ error: errorForLog(error) }, "jobs error"));
  boss.on("warning", (warning) => logger.warn({ warning: warning.message }, "jobs warning"));
  try {
    await boss.start();
    for (const [name, { policy, ...options }] of Object.entries(queues)) {
      await boss.createQueue(name, { policy, ...options });
      const queue = await boss.getQueue(name);
      if (queue?.policy !== policy) {
        throw new Error(`Queue ${name} has policy ${queue?.policy}, expected ${policy}`);
      }
      await boss.updateQueue(name, options);
    }
    await boss.schedule(jobNames.lifecycleSweep, cron, null, { tz: timeZone, missed: "once" });
  } catch (error) {
    await boss.stop({ graceful: false });
    throw error;
  }
  logger.info({ queues: Object.keys(queues), cron, tz: timeZone }, "jobs started");
  return { boss, stop: () => boss.stop({ graceful: true }) };
}
