import { z } from "zod";
import {
  staffPermission,
  type Actor,
  type Permission,
  type PermissionTarget,
} from "../access/permissions";
import { isoDate } from "../iso-date";

// Closing a BA reporting task (process-and-lifecycle.md, BA reporting; Q111, Q190, Q207): the PL or
// back office records what happened with a pending task, once. `reported` carries the actual date
// the report went to the Agentur, `not_required` one closed reason. There is no due date: a pending
// task is a work-list item, and nothing here enforces a monthly claim or a project closure, which
// the MVP doesn't have. A wrong outcome is never edited; an approved correction supersedes it
// (data-protection.md, evidence corrections).

/** What became of a task: it was sent, or it needn't be. */
export const BaReportOutcome = z.enum(["reported", "not_required"]).meta({ id: "BaReportOutcome" });
export type BaReportOutcome = z.infer<typeof BaReportOutcome>;

/**
 * Why no report is needed: the Agentur said so, no claim month is affected, or the task should
 * never have been created. Codes only, never free text.
 */
export const BaReportNotRequiredReason = z.enum([
  "agentur_confirmed_not_required",
  "no_claim_month_affected",
  "created_in_error",
]);
export type BaReportNotRequiredReason = z.infer<typeof BaReportNotRequiredReason>;

/**
 * `POST /ba-reporting-tasks/{id}/outcome`: "Gemeldet am" with the actual sent date (not in the
 * future, not before the task's day, both checked by the function in Berlin time) or "Nicht
 * erforderlich" with its reason.
 */
export const BaReportInput = z
  .discriminatedUnion("outcome", [
    z.strictObject({ outcome: z.literal("reported"), reportedOn: isoDate }),
    z.strictObject({ outcome: z.literal("not_required"), reason: BaReportNotRequiredReason }),
  ])
  .meta({ id: "BaReportInput" });
export type BaReportInput = z.infer<typeof BaReportInput>;

/**
 * Who closes a task (D28, Q111): the PL or back office of the project, never a consultant, who
 * reads the tasks with the other case data.
 */
export function mayRecordBaReport(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return { ok: false, because: "actor_not_allowed" };
  return staffPermission(
    actor,
    target,
    (role) => role === "project_lead" || role === "back_office",
  );
}
