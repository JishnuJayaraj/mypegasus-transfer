import type { Mailer, SmsSender } from "@transfer/adapters";
import { sql, transactionWithClient, type Database } from "@transfer/db";
import {
  participantActions,
  reminderMessage,
  terminalMainStatuses,
  type MainStatus,
  type NoticeLanguage,
} from "@transfer/domain";
import type { Logger } from "pino";
import { JobError } from "../jobs/errors";
import { jobNames } from "../jobs/names";
import type { SelfServiceRecord } from "../participations/self-service";
import { loadSelfServiceRecords } from "../participations/self-service";
import type { Release } from "../projects/template-pins";

/** Retries of `reminders.send` (ADR-0011): the last one's error settles `delivery_unknown`. */
export const reminderRetryLimit = 5;

/** Where the API queues the reminders' jobs inside the request's transaction (ADR-0011). */
export interface ReminderQueue {
  enqueue(
    reminderId: string,
    db: { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  ): Promise<void>;
}

export type ReminderSendDeps = {
  db: Database;
  logger: Logger;
  release: Release;
  mailer?: Mailer | undefined;
  smsSender?: SmsSender | undefined;
  /** `PORTAL_PUBLIC_URL`: the reminder's only placeholder, as given. */
  portalPublicUrl: string;
};

/**
 * Whether the participant has something open in the portal (process-and-lifecycle.md,
 * participant actions): every action of their own, whoever asks. A closed participation has none.
 */
export function hasOpenActions(record: SelfServiceRecord, status: MainStatus): boolean {
  if (terminalMainStatuses.has(status)) return false;
  const { wizard } = record;
  return (
    participantActions(
      {
        projectType: wizard.projectType,
        rules: wizard.rules,
        fields: wizard.fields,
        documents: wizard.documents,
        customFieldKeys: Object.keys(wizard.customFields),
      },
      () => true,
    ).length > 0
  );
}

type Outcome =
  | "sent"
  | "failed"
  | "delivery_unknown"
  | "cancelled"
  | "settled"
  | "retry"
  | "skipped";

/**
 * `reminders.send` (data-protection.md, reminders; ADR-0011). No sender for the queued kind: the
 * reminder is cancelled `delivery_unavailable` before any claim. Otherwise one transaction locks
 * the participation, evaluates the participant's actions and claims the dispatch, which rechecks
 * the queued channel, consent, status and requester; a refused claim ends the job. After the
 * commit the fixed text goes to the queued channel with the provider key `reminder:<id>`: `sent`
 * and a definitive `failed` are final; an error or an unknown outcome fails the job for a retry,
 * and on the last attempt (`lastAttempt`) settles `delivery_unknown`. Logs the job, its id, the
 * reminder id and the outcome only: never the address, the text or a provider error.
 */
export async function sendReminder(
  deps: ReminderSendDeps,
  reminderId: string,
  jobId: string,
  lastAttempt: boolean,
): Promise<Outcome> {
  const { db, logger } = deps;
  const log = (outcome: Outcome) => {
    logger.info({ job: jobNames.sendReminder, jobId, reminderId, outcome }, "reminder");
    return outcome;
  };
  const record = (outcome: string, cancelReason: string | null = null) =>
    db.execute(sql`select record_reminder_outcome(${reminderId}::uuid,
      ${outcome}::reminder_status, ${cancelReason}::reminder_cancel_reason, ${jobId}) as result`);
  const { rows } = await db.execute<{
    status: string;
    channelKind: "email" | "sms";
    projectId: string;
    participationId: string;
  }>(sql`select status, channel_kind as "channelKind", project_id as "projectId",
      participation_id as "participationId"
    from participant_reminder where id = ${reminderId}::uuid`);
  const reminder = rows[0];
  if (!reminder || !["queued", "dispatching"].includes(reminder.status)) return log("skipped");
  const sender = reminder.channelKind === "email" ? deps.mailer : deps.smsSender;
  if (!sender) {
    await record(
      reminder.status === "queued" ? "cancelled" : "delivery_unknown",
      reminder.status === "queued" ? "delivery_unavailable" : null,
    );
    return log(reminder.status === "queued" ? "cancelled" : "delivery_unknown");
  }

  const claimed = await transactionWithClient(db, async (tx) => {
    const { rows: locked } = await tx.execute<{ status: MainStatus }>(
      sql`select (lock_participation(${reminder.participationId}::uuid)).status as status`,
    );
    const records = await loadSelfServiceRecords(tx, deps.release, reminder.projectId, [
      reminder.participationId,
    ]);
    const open = hasOpenActions(records.get(reminder.participationId)!, locked[0]!.status);
    const { rows: claim } = await tx.execute<{ result: string }>(sql`
      select claim_reminder_dispatch(${reminderId}::uuid, ${open}, ${jobId}) as result`);
    if (claim[0]!.result !== "dispatching") return null;
    const { rows: target } = await tx.execute<{ address: string; language: NoticeLanguage }>(sql`
      select ch.address, r.language from participant_reminder r
      join participant_channel ch on ch.id = r.channel_id where r.id = ${reminderId}::uuid`);
    return target[0]!;
  });
  if (!claimed) return log("settled");

  const message = reminderMessage(claimed.language, reminder.channelKind, deps.portalPublicUrl);
  const idempotencyKey = `reminder:${reminderId}`;
  let status: "sent" | "failed";
  try {
    status = (
      reminder.channelKind === "email"
        ? await deps.mailer!.send({
            to: claimed.address,
            subject: message.subject!,
            text: message.text,
            idempotencyKey,
          })
        : await deps.smsSender!.send({ to: claimed.address, text: message.text, idempotencyKey })
    ).status;
  } catch {
    // Unknown, or a provider error that may echo the address: never logged.
    if (!lastAttempt) {
      log("retry");
      throw new JobError("delivery_unknown");
    }
    await record("delivery_unknown");
    return log("delivery_unknown");
  }
  await record(status);
  return log(status);
}
