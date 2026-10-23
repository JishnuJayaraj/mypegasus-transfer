import { sql, transactionWithClient, type Database } from "@transfer/db";
import type { Deps } from "../context";
import { jobNames } from "../jobs/names";
import { loadRelease } from "../projects/template-pins";
import { sendReminder } from "../reminders/send";

// The organizer's notices (data-protection.md, messages; ADR-0011): the database function that
// cancels an appointment or a booking, or corrects a title or venue, queues them as the system in
// its own transaction; the API sends each one's `appointments.notify` job on the same connection,
// so the change, the notices and their jobs commit together or not at all.

type Tx = Parameters<Parameters<typeof transactionWithClient>[1]>[0];

/**
 * Runs `write` in one transaction and queues a job for each organizer's notice it queued (the
 * rows of the appointment queued in this transaction: `requested_at` is the transaction's time).
 * Without pg-boss (tests and e2e) each job runs once after the commit.
 */
export function createNoticeWriter(deps: Deps) {
  const { db, env, logger } = deps;
  const release = loadRelease(env.configDir);
  const sendDeps = {
    db,
    logger,
    release,
    mailer: deps.mailer,
    smsSender: deps.smsSender,
    portalPublicUrl: env.portalPublicUrl ?? "",
  };
  return async function withNotices<T>(
    appointmentId: string,
    write: (tx: Pick<Database, "execute"> & Tx) => Promise<T>,
  ): Promise<T> {
    const { value, noticeIds } = await transactionWithClient(db, async (tx, client) => {
      const result = await write(tx);
      const { rows } = await tx.execute<{ id: string }>(
        sql`select id from participant_reminder
          where appointment_id = ${appointmentId}::uuid and status = 'queued'
            and kind in ('appointment_changed', 'appointment_cancelled')
            and requested_at = now()
          order by id`,
      );
      for (const { id } of rows) {
        await deps.reminders?.enqueue(
          id,
          { executeSql: (text, values) => client.query(text, values) },
          jobNames.notifyAppointment,
        );
      }
      return { value: result, noticeIds: rows.map(({ id }) => id) };
    });
    if (!deps.reminders) {
      for (const id of noticeIds) {
        deps.detached!.run(jobNames.notifyAppointment, async () => {
          await sendReminder(sendDeps, id, `detached:${id}`, true);
        });
      }
    }
    return value;
  };
}
