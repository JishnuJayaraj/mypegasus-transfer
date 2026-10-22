import {
  and,
  eq,
  inArray,
  participation,
  project,
  sql,
  transactionWithClient,
  type Database,
} from "@transfer/db";
import {
  mayRemind,
  participationListScope,
  PORTAL_REMINDER_VERSION,
  terminalMainStatuses,
  type ReminderRequestInput,
  type ReminderRequestResult,
  type ReminderSkip,
  type StaffUser,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { projectAccess, projectTarget } from "../access";
import { loadSelfServiceRecords } from "../participations/self-service";
import type { Release } from "../projects/template-pins";
import { auditContext } from "../sql";
import { hasOpenActions, type ReminderQueue } from "./send";

export type ReminderRequestDeps = {
  db: Database;
  release: Release;
  /** pg-boss in this process; without it the route runs each job after the commit. */
  queue: ReminderQueue | undefined;
};

/** Why the request is refused as a whole (data-protection.md, reminders; ADR-0010's order). */
export type ReminderRefusal =
  | { kind: "not_found" }
  | { kind: "hidden"; indexes: number[] }
  | { kind: "forbidden" }
  | { kind: "project_not_active" };

export type ReminderRequestOutcome = {
  kind: "ok";
  result: ReminderRequestResult;
  /** The queued reminders, for the jobs run after the commit without pg-boss. */
  reminderIds: string[];
};

/**
 * The checks before anything is written (data-protection.md, reminders; ADR-0010's order):
 * visibility (404; a participation the viewer can't see is `participation_not_found` at its
 * index), the permission (403: only the PL and the assigned consultant), the project's state.
 */
export async function reminderRefusal(
  db: Database,
  user: StaffUser,
  projectId: string,
  participationIds: readonly string[],
): Promise<ReminderRefusal | undefined> {
  const { subject, visible, regionId } = await projectAccess(db, user, projectId);
  if (!visible) return { kind: "not_found" };
  const rows = await db
    .select({ id: participation.id })
    .from(participation)
    .where(
      and(eq(participation.projectId, projectId), inArray(participation.id, [...participationIds])),
    );
  const inProject = new Set(rows.map((row) => row.id));
  const scope = participationListScope(subject, projectId);
  const seen = (id: string) =>
    inProject.has(id) &&
    (scope.kind === "all" || (scope.kind === "assigned" && scope.participationIds.includes(id)));
  const hidden = participationIds.flatMap((id, index) => (seen(id) ? [] : [index]));
  if (hidden.length > 0) return { kind: "hidden", indexes: hidden };
  const permitted = participationIds.every(
    (id) => mayRemind(subject, projectTarget(projectId, regionId, id)).ok,
  );
  if (!permitted) return { kind: "forbidden" };
  const [found] = await db
    .select({ status: project.status })
    .from(project)
    .where(eq(project.id, projectId));
  if (found!.status !== "active") return { kind: "project_not_active" };
  return undefined;
}

/**
 * One transaction: the participant's actions are evaluated (a participation with nothing open is
 * skipped `nothing_open` without reaching the database; a closed one goes on so the database
 * names it), `request_reminders` decides the rest under the project lock, and each queued
 * reminder's job is sent on the same connection, so rows, events and jobs commit together or not
 * at all.
 */
export async function requestReminders(
  { db, release, queue }: ReminderRequestDeps,
  user: StaffUser,
  projectId: string,
  input: ReminderRequestInput,
  requestId: string,
): Promise<ReminderRequestOutcome> {
  const batchId = randomUUID();
  return transactionWithClient(db, async (tx, client) => {
    const records = await loadSelfServiceRecords(tx, release, projectId, input.participationIds);
    const statuses = await tx
      .select({ id: participation.id, status: participation.status })
      .from(participation)
      .where(inArray(participation.id, input.participationIds));
    const statusOf = new Map(statuses.map(({ id, status }) => [id, status]));
    const skipped: { participationId: string; code: ReminderSkip }[] = [];
    const asked = input.participationIds.filter((id) => {
      const status = statusOf.get(id)!;
      if (terminalMainStatuses.has(status) || hasOpenActions(records.get(id)!, status)) {
        return true;
      }
      skipped.push({ participationId: id, code: "nothing_open" });
      return false;
    });
    const queued: ReminderRequestResult["queued"] = [];
    const reminderIds: string[] = [];
    if (asked.length > 0) {
      const { rows } = await tx.execute<{
        participationId: string;
        reminderId: string | null;
        channelKind: "email" | "sms" | null;
        skip: ReminderSkip | null;
      }>(sql`select participation_id as "participationId", reminder_id as "reminderId",
          channel_kind as "channelKind", skip
        from request_reminders(p_context => ${auditContext(user.id, requestId)},
          p_project_id => ${projectId}::uuid, p_participation_ids => ${`{${asked.join(",")}}`}::uuid[],
          p_kind => ${input.kind}::reminder_kind, p_message_version => ${PORTAL_REMINDER_VERSION},
          p_batch_id => ${batchId}::uuid)`);
      for (const row of rows) {
        if (row.skip) {
          skipped.push({ participationId: row.participationId, code: row.skip });
          continue;
        }
        queued.push({ participationId: row.participationId, channel: row.channelKind! });
        reminderIds.push(row.reminderId!);
        await queue?.enqueue(row.reminderId!, {
          executeSql: (text, values) => client.query(text, values),
        });
      }
    }
    return { kind: "ok" as const, result: { batchId, queued, skipped }, reminderIds };
  });
}
