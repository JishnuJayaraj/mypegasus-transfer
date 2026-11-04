import { z } from "zod";
import { addDays, addMonths, daysBetween, laterIsoDate } from "../dates";
import { profilingExceptionDeadlineMonths } from "../eligibility/transfer-kug";
import type { IsoDate } from "../iso-date";
import {
  lifecycleFlags,
  type ParticipationSnapshot,
  type PlannerProject,
} from "../lifecycle/planner";
import { tl407EscalationDate, type Tl407Attempt } from "../profiling/submissions";

// Escalations to the regional admin (data-protection.md, the regional view; Q57): per project its
// responsible PLs and, per type, how many participations are escalated and how many days the
// oldest is overdue. Counts only: never a participant, a name or an id of one.

export const EscalationType = z
  .enum(["tl407_not_submitted", "profiling_compliance"])
  .meta({ id: "EscalationType" });
export type EscalationType = z.infer<typeof EscalationType>;

export const EscalationCount = z
  .strictObject({
    type: EscalationType,
    count: z.int().min(1),
    /** Days since the oldest escalated: 0 on the day it escalates. */
    oldestDaysOverdue: z.int().min(0),
  })
  .meta({ id: "EscalationCount" });

export const EscalationRow = z
  .strictObject({
    projectId: z.uuid(),
    projectName: z.string(),
    /** The project's active PLs, by display name. */
    leads: z.array(z.string()),
    counts: z.array(EscalationCount),
  })
  .meta({ id: "EscalationRow" });
export type EscalationRow = z.infer<typeof EscalationRow>;

export const Escalations = z
  .strictObject({
    generatedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    rows: z.array(EscalationRow),
  })
  .meta({ id: "Escalations" });
export type Escalations = z.infer<typeof Escalations>;

/** One escalated matter of a participation: its type and the day it escalated. */
export type Escalation = { type: EscalationType; since: IsoDate };

/**
 * A participation's escalations (process-and-lifecycle.md, TL 407 submission; Q189):
 * `tl407_not_submitted` from TG start + 14 while no submission stands, whatever the exception;
 * `profiling_compliance` the day it happens, with no grace period: a refusal after entry (from the
 * refusal, never before the entry) or the missed one-month deadline of an exception (the day after
 * it). `declinedOn` is the refusal's effective date, if known.
 */
export function participationEscalations(
  s: ParticipationSnapshot,
  project: PlannerProject,
  attempts: readonly Tl407Attempt[],
  declinedOn: IsoDate | null,
  today: IsoDate,
): Escalation[] {
  const escalations: Escalation[] = [];
  const tl407 = tl407EscalationDate(s, project.type, attempts, today);
  if (tl407) escalations.push({ type: "tl407_not_submitted", since: tl407 });
  const flags = lifecycleFlags(s, project, today);
  const entry = s.participation.tgEntryDate ?? null;
  if (entry !== null && flags.includes("profiling_declined_after_entry")) {
    escalations.push({
      type: "profiling_compliance",
      since: declinedOn === null ? entry : laterIsoDate(declinedOn, entry),
    });
  }
  if (entry !== null && flags.includes("profiling_exception_deadline_missed")) {
    escalations.push({
      type: "profiling_compliance",
      since: addDays(addMonths(entry, profilingExceptionDeadlineMonths), 1),
    });
  }
  return escalations;
}

/**
 * The regional view's rows: projects with at least one escalation, by name; per type the count of
 * distinct participations and the days overdue of the oldest.
 */
export function escalationRows(
  projects: readonly {
    projectId: string;
    projectName: string;
    leads: readonly string[];
    /** Each participation's escalations. */
    participations: readonly (readonly Escalation[])[];
  }[],
  today: IsoDate,
): EscalationRow[] {
  return projects
    .map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      leads: project.leads.toSorted((a, b) => a.localeCompare(b, "de")),
      counts: EscalationType.options.flatMap((type) => {
        const oldest = project.participations
          .map(
            (each) =>
              each
                .filter((e) => e.type === type)
                .map((e) => e.since)
                .toSorted()[0],
          )
          .filter((since): since is IsoDate => since !== undefined);
        if (oldest.length === 0) return [];
        const first = oldest.toSorted()[0]!;
        return [{ type, count: oldest.length, oldestDaysOverdue: daysBetween(first, today) }];
      }),
    }))
    .filter((row) => row.counts.length > 0)
    .toSorted(
      (a, b) =>
        a.projectName.localeCompare(b.projectName, "de") || a.projectId.localeCompare(b.projectId),
    );
}
