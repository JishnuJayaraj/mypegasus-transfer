import { assertRunTime, type Clock } from "@transfer/adapters";
import { jobsSchema, type Database } from "@transfer/db";
import { PgBoss, type Job, type Queue } from "pg-boss";
import type { Logger } from "pino";
import { errorForLog } from "../logger";
import type { GuardFactsProvider } from "../participations/guard-facts";
import { queueDispatch } from "./dispatch";
import { JobError, jobErrorCode } from "./errors";
import { evaluateProject } from "./evaluate-project";
import { runLifecycleSweep } from "./lifecycle-sweep";
import { jobNames, timeZone } from "./names";
import type { ActivationNoticeQueue } from "../context";
import {
  ActivationNoticePayload,
  EvaluateProjectPayload,
  PurgeDocumentPayload,
  SendReminderPayload,
  SweepPayload,
} from "./payloads";
import { reminderRetryLimit, sendReminder, type ReminderQueue } from "../reminders/send";
import type { Release } from "../projects/template-pins";
import type { FileStorage } from "@transfer/adapters";
import { purgeDocumentObject, type DocumentPurgeQueue } from "../documents/purge";
import { sendActivationNotice, type ActivationNoticeDeps } from "./activation-notice";

export { jobNames, timeZone } from "./names";

/**
 * Queue policies (round 19). `lifecycle.sweep` is `singleton`: one sweep active at a time, every
 * other one kept queued, because a missed occurrence (`missed: "once"`) can arrive beside the due
 * one and must not displace it; `job_run` makes a later sweep of a completed day a no-op.
 * `lifecycle.evaluate-project` is `exclusive` per `singletonKey` `<projectId>:<runDate>`: a
 * second job for the same project and day is refused while one is queued or active. pg-boss
 * deduplicates keys only on `stately` and `exclusive` queues (spike S2). Failures retry with
 * backoff (plan 5.9). `portal.activation-notice` is `exclusive` per channel id (Slice 3 plan D21):
 * the completion queues it in its own transaction, at least once. `documents.purge-object` is
 * `exclusive` per document id: the deletion queues it in its own transaction. `reminders.send` is
 * `exclusive` per reminder id (data-protection.md, reminders): the request queues it in its own
 * transaction; 5 retries with backoff, the last one's error settling `delivery_unknown`.
 * `appointments.notify` is the same per organizer's notice (data-protection.md, messages): the
 * organizer's change queues it in its own transaction.
 */
const queues: Record<string, Omit<Queue, "name"> & { policy: "singleton" | "exclusive" }> = {
  [jobNames.lifecycleSweep]: {
    policy: "singleton",
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
  [jobNames.activationNotice]: {
    policy: "exclusive",
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
  [jobNames.purgeDocument]: {
    policy: "exclusive",
    retryLimit: 10,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
  [jobNames.sendReminder]: {
    policy: "exclusive",
    retryLimit: reminderRetryLimit,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
  [jobNames.notifyAppointment]: {
    policy: "exclusive",
    retryLimit: reminderRetryLimit,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
};

/** `HH:MM` (Berlin) as a daily cron expression; 02:00–02:59 is refused (round 9). */
export function lifecycleCron(time: string): string {
  assertRunTime(time);
  const [hour, minute] = time.split(":").map(Number);
  return `${minute} ${hour} * * *`;
}

/** What the workers need; without it pg-boss runs with the schedule but takes no jobs. */
export type WorkDeps = {
  db: Database;
  clock: Clock;
  facts: GuardFactsProvider;
  /** pg-boss's polling (default 2 s) and the sweep's wait for its project jobs (default 1 s). */
  pollingIntervalSeconds?: number;
  dispatchPollMs?: number;
  /** The senders and the portal URL of the activation notice (D21). */
  notices?: Omit<ActivationNoticeDeps, "db" | "logger">;
  /** The document store the purge job deletes from; none in production yet (Q149). */
  storage?: FileStorage | undefined;
  /** The release whose configuration the reminder job evaluates the actions with. */
  release?: Release | undefined;
};

export type JobsOptions = {
  /** The runtime role's URL (`DATABASE_URL`, transfer_app). */
  connectionString: string;
  /** `JOBS_LIFECYCLE_TIME`. */
  lifecycleTime: string;
  logger: Logger;
  work?: WorkDeps;
};

export type Jobs = { boss: PgBoss; stop: () => Promise<void> };

/**
 * Starts pg-boss in the API process (D7) as transfer_app on the schema `db:migrate` installed:
 * migration off, so a missing or outdated schema fails the start; `persistQueueStats` off and no
 * `reindex`, which would need DDL (spike S2). Creates the queues (idempotent), keeps their options
 * current and refuses one whose policy differs, then (re)registers the nightly sweep's cron in
 * Europe/Berlin. A missed occurrence (the API was down at the run time) is sent once on the next
 * start, beside the due one; the sweep's catch-up window covers the days in between. With `work`,
 * the two workers run in this process. Events are logged without their data, errors without
 * their message (CLAUDE.md rule 9).
 */
export async function startJobs({
  connectionString,
  lifecycleTime,
  logger,
  work,
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
    if (work) await startWorkers(boss, { ...work, lifecycleTime, logger });
  } catch (error) {
    await boss.stop({ graceful: false });
    throw error;
  }
  logger.info({ queues: Object.keys(queues), cron, tz: timeZone }, "jobs started");
  return { boss, stop: () => boss.stop({ graceful: true }) };
}

/**
 * Runs one job; a failure is logged with its code and stored by pg-boss as a `JobError` carrying
 * only that code, never the original message (CLAUDE.md rule 9).
 */
async function runJob(logger: Logger, job: Job<unknown>, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    const code = jobErrorCode(error);
    logger.error({ job: job.name, jobId: job.id, code, error: errorForLog(error) }, "job failed");
    throw new JobError(code);
  }
}

/**
 * The workers (plan 5.9): the sweep dispatches one project job per project through the queue and
 * waits for them; the project job evaluates its project. Both parse their payload first.
 */
async function startWorkers(
  boss: PgBoss,
  deps: WorkDeps & { lifecycleTime: string; logger: Logger },
) {
  const { db, clock, facts, lifecycleTime, logger, pollingIntervalSeconds = 2 } = deps;
  const dispatch = queueDispatch(boss, { pollMs: deps.dispatchPollMs });
  await boss.work(jobNames.evaluateProject, { pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) {
      await runJob(logger, job, async () => {
        const payload = EvaluateProjectPayload.parse(job.data);
        await evaluateProject({ db, clock, facts, logger, lifecycleTime }, payload, job.id);
      });
    }
  });
  const { notices } = deps;
  if (notices) {
    await boss.work(jobNames.activationNotice, { pollingIntervalSeconds }, async (jobs) => {
      for (const job of jobs) {
        await runJob(logger, job, async () => {
          const { channelId } = ActivationNoticePayload.parse(job.data);
          await sendActivationNotice({ db, logger, ...notices }, channelId, job.id);
        });
      }
    });
  }
  const { release } = deps;
  if (notices && release) {
    for (const name of [jobNames.sendReminder, jobNames.notifyAppointment]) {
      await boss.work(name, { pollingIntervalSeconds }, async (jobs) => {
        for (const job of jobs) {
          await runJob(logger, job, async () => {
            const { reminderId } = SendReminderPayload.parse(job.data);
            await sendReminder(
              { db, logger, release, ...notices },
              reminderId,
              job.id,
              job.retryCount >= reminderRetryLimit,
            );
          });
        }
      });
    }
  }
  const { storage } = deps;
  if (storage) {
    await boss.work(jobNames.purgeDocument, { pollingIntervalSeconds }, async (jobs) => {
      for (const job of jobs) {
        await runJob(logger, job, async () => {
          const { documentId } = PurgeDocumentPayload.parse(job.data);
          await purgeDocumentObject({ db, storage, logger }, documentId, job.id);
        });
      }
    });
  }
  await boss.work(jobNames.lifecycleSweep, { pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) {
      await runJob(logger, job, async () => {
        SweepPayload.parse(job.data);
        const result = await runLifecycleSweep({ db, clock, lifecycleTime }, dispatch);
        logger.info({ job: job.name, jobId: job.id, ...result }, "lifecycle sweep");
      });
    }
  });
}

/** Queues the activation notice in the caller's transaction (D21): `singletonKey` the channel. */
export function activationNoticeQueue(boss: PgBoss): ActivationNoticeQueue {
  return {
    async enqueue(channelId, db) {
      await boss.send(jobNames.activationNotice, { channelId }, { singletonKey: channelId, db });
    },
  };
}

/** Queues a deleted document's purge in the caller's transaction: `singletonKey` the document. */
export function documentPurgeQueue(boss: PgBoss): DocumentPurgeQueue {
  return {
    async enqueue(documentId, db) {
      await boss.send(jobNames.purgeDocument, { documentId }, { singletonKey: documentId, db });
    },
  };
}

/** Queues a message's job in the request's transaction: `singletonKey` the message. */
export function reminderQueue(boss: PgBoss): ReminderQueue {
  return {
    async enqueue(reminderId, db, job = jobNames.sendReminder) {
      await boss.send(job, { reminderId }, { singletonKey: reminderId, db });
    },
  };
}
