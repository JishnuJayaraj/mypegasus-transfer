import type { Mailer, SmsSender } from "@transfer/adapters";
import { sql, type Database } from "@transfer/db";
import type { NoticeLanguage } from "@transfer/domain";
import type { Logger } from "pino";
import { JobError } from "./errors";
import { jobNames } from "./names";

export type ActivationNoticeDeps = {
  db: Database;
  logger: Logger;
  mailer?: Mailer | undefined;
  smsSender?: SmsSender | undefined;
  /** `PORTAL_PUBLIC_URL`: the notice links to the portal. */
  portalPublicUrl: string;
};

function noticeMessage(language: NoticeLanguage, portalUrl: string) {
  return language === "de"
    ? {
        subject: "Ihr Zugang zum Teilnehmerportal ist aktiv",
        text: `Ihr Zugang zum Teilnehmerportal ist jetzt aktiv: ${portalUrl}\n\nWenn Sie das nicht selbst waren, wenden Sie sich bitte umgehend an Ihre Transfergesellschaft.`,
      }
    : {
        subject: "Your access to the participant portal is active",
        text: `Your access to the participant portal is now active: ${portalUrl}\n\nIf this was not you, please contact your transfer company at once.`,
      };
}

/**
 * The activation notice to a newly registered channel (Slice 3 plan D21), at least once: a second
 * run finds `notice_sent_at` set, and the provider's idempotency key `activation-notice:<channelId>`
 * keeps a retry after a lost response from sending twice. A removed channel or a closed
 * participation gets none. Logs ids and the outcome only; provider errors are never logged (they
 * may echo the address) and fail the job for a retry.
 */
export async function sendActivationNotice(
  deps: ActivationNoticeDeps,
  channelId: string,
  jobId: string,
): Promise<"sent" | "skipped"> {
  const { db, logger } = deps;
  const { rows } = await db.execute<{
    kind: "email" | "sms";
    address: string;
    language: NoticeLanguage;
    due: boolean;
  }>(sql`
    select ch.kind, ch.address, a.language,
      ch.notice_sent_at is null and ch.removed_at is null and ch.suspended_at is null
        and p.status not in ('withdrawn', 'ta_completed', 'exited') as due
    from participant_channel ch
    join participant_account a on a.participation_id = ch.participation_id
    join participation p on p.id = ch.participation_id
    where ch.id = ${channelId}::uuid`);
  const channel = rows[0];
  const log = (outcome: string) =>
    logger.info({ job: jobNames.activationNotice, jobId, channelId, outcome }, "activation notice");
  if (!channel?.due) {
    log("skipped");
    return "skipped";
  }
  const message = noticeMessage(channel.language, deps.portalPublicUrl);
  const idempotencyKey = `activation-notice:${channelId}`;
  const sender = channel.kind === "email" ? deps.mailer : deps.smsSender;
  if (!sender) throw new JobError("delivery_unavailable");
  let status: "sent" | "failed";
  try {
    status = (
      channel.kind === "email"
        ? await deps.mailer!.send({ to: channel.address, ...message, idempotencyKey })
        : await deps.smsSender!.send({ to: channel.address, text: message.text, idempotencyKey })
    ).status;
  } catch {
    throw new JobError("delivery_unknown");
  }
  if (status === "failed") throw new JobError("delivery_failed");
  await db.execute(sql`select mark_activation_notice_sent(${channelId}::uuid) as result`);
  log("sent");
  return "sent";
}
