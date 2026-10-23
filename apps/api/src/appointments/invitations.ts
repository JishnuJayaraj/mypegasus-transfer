import { sql, transactionWithClient } from "@transfer/db";
import {
  mayListBookings,
  mayRemind,
  type InvitationRequestInput,
  type InvitationRequestResult,
  type ReminderSkip,
  type StaffUser,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { projectTarget } from "../access";
import type { Deps } from "../context";
import { jobNames } from "../jobs/names";
import { loadRelease } from "../projects/template-pins";
import { sendReminder } from "../reminders/send";
import { auditContext } from "../sql";
import type { AppointmentViewer } from "./service";

// Invitations to an appointment (data-protection.md, invitations; ADR-0010). The database decides
// every row again under the exclusive project lock; a skip is data, never an error.

/** Why the request is refused as a whole, before anything is written (ADR-0010's order). */
export type InvitationRefusal =
  | { kind: "hidden"; indexes: number[] }
  | { kind: "forbidden" }
  | { kind: "project_not_active" };

/**
 * Visibility (a participation the viewer can't list, or of another project, is
 * `participation_not_found` at its index), the permission (403: the PL or the assigned
 * consultant, `mayRemind`), the project's state.
 */
export async function invitationRefusal(
  deps: Pick<Deps, "db">,
  viewer: AppointmentViewer,
  participationIds: readonly string[],
): Promise<InvitationRefusal | undefined> {
  const { rows } = await deps.db.execute<{ id: string }>(
    sql`select id from participation
      where project_id = ${viewer.projectId}::uuid
        and id = any(${`{${participationIds.join(",")}}`}::uuid[])`,
  );
  const inProject = new Set(rows.map((row) => row.id));
  const hidden = participationIds.flatMap((participationId, index) =>
    inProject.has(participationId) &&
    mayListBookings(viewer.subject, { projectId: viewer.projectId, participationId })
      ? []
      : [index],
  );
  if (hidden.length > 0) return { kind: "hidden", indexes: hidden };
  const permitted = participationIds.every(
    (id) => mayRemind(viewer.subject, projectTarget(viewer.projectId, viewer.regionId, id)).ok,
  );
  if (!permitted) return { kind: "forbidden" };
  if (!viewer.projectActive) return { kind: "project_not_active" };
  return undefined;
}

/**
 * One transaction: `request_invitations` decides each row, and each invitation queued for a
 * channel gets its `reminders.send` job on the same connection, so rows, events and jobs commit
 * together. Without pg-boss (tests and e2e) each job runs once after the commit.
 */
export async function requestInvitations(
  deps: Deps,
  user: StaffUser,
  appointmentId: string,
  input: InvitationRequestInput,
  requestId: string,
): Promise<InvitationRequestResult> {
  const batchId = randomUUID();
  const { result, reminderIds } = await transactionWithClient(deps.db, async (tx, client) => {
    const { rows } = await tx.execute<{
      participationId: string;
      reminderId: string | null;
      channelKind: "email" | "sms" | null;
      notDeliverable: "no_channel" | "consent_required" | null;
      skip: ReminderSkip | null;
    }>(sql`select participation_id as "participationId", reminder_id as "reminderId",
        channel_kind as "channelKind", not_deliverable as "notDeliverable", skip
      from request_invitations(p_context => ${auditContext(user.id, requestId)},
        p_appointment_id => ${appointmentId}::uuid,
        p_participation_ids => ${`{${input.participationIds.join(",")}}`}::uuid[],
        p_batch_id => ${batchId}::uuid)`);
    const value: InvitationRequestResult = { batchId, queued: [], notDeliverable: [], skipped: [] };
    const queued: string[] = [];
    for (const row of rows) {
      const { participationId } = row;
      if (row.skip) value.skipped.push({ participationId, code: row.skip });
      else if (row.notDeliverable) {
        value.notDeliverable.push({ participationId, code: row.notDeliverable });
      } else {
        value.queued.push({ participationId, channel: row.channelKind! });
        queued.push(row.reminderId!);
        await deps.reminders?.enqueue(
          row.reminderId!,
          { executeSql: (text, values) => client.query(text, values) },
          jobNames.sendReminder,
        );
      }
    }
    return { result: value, reminderIds: queued };
  });
  if (!deps.reminders) {
    const sendDeps = {
      db: deps.db,
      logger: deps.logger,
      release: loadRelease(deps.env.configDir),
      mailer: deps.mailer,
      smsSender: deps.smsSender,
      portalPublicUrl: deps.env.portalPublicUrl ?? "",
    };
    for (const reminderId of reminderIds) {
      deps.detached!.run(jobNames.sendReminder, async () => {
        await sendReminder(sendDeps, reminderId, `detached:${reminderId}`, true);
      });
    }
  }
  return result;
}
