import { z } from "zod";
import { addMonths, daysBetween } from "../dates";
import { profilingExceptionDeadlineMonths } from "../eligibility/transfer-kug";
import { isoDate, type IsoDate } from "../iso-date";
import type { LifecycleFlag } from "../lifecycle/enums";
import { validBy } from "../lifecycle/guards";
import {
  cutoffFinalReminderDays,
  latestEntryCutoff,
  type ParticipationSnapshot,
  type PlannerProject,
} from "../lifecycle/planner";
import { effectiveOfferDeadline, effectiveTgStart } from "../lifecycle/waves";
import type { PrivacyNoticeState } from "../privacy/notice-state";

// The deadlines of the work list (process-and-lifecycle.md, deadline warnings): informational,
// never a guard. Each kind applies while its condition holds; a deadline further away than the
// warning horizon isn't listed.

/** In the order that breaks a tie between equally urgent deadlines. */
export const DeadlineKind = z
  .enum([
    "offer_deadline",
    "tg_start",
    "latest_entry_cutoff",
    "privacy_notice",
    "profiling_exception",
  ])
  .meta({ id: "DeadlineKind" });
export type DeadlineKind = z.infer<typeof DeadlineKind>;

export const DeadlineState = z.enum(["upcoming", "overdue"]).meta({ id: "DeadlineState" });
export type DeadlineState = z.infer<typeof DeadlineState>;

/** `final` only on `latest_entry_cutoff`: the cutoff's final reminder (Q78). */
export const Deadline = z
  .strictObject({
    kind: DeadlineKind,
    date: isoDate,
    state: DeadlineState,
    final: z.boolean().optional(),
  })
  .meta({ id: "Deadline" });
export type Deadline = z.infer<typeof Deadline>;

/** Upcoming from 14 calendar days before the date, the date included (Q78's horizon). */
export const deadlineWarningDays = 14;

/** The planner flags a deadline stands for; such a flag is never listed beside it. */
const replacedFlags: ReadonlySet<LifecycleFlag> = new Set([
  "tg_start_missed",
  "cutoff_warning",
  "cutoff_final_reminder",
  "profiling_exception_deadline_missed",
]);

export type DeadlineFacts = {
  snapshot: ParticipationSnapshot;
  project: PlannerProject;
  privacyNotice: PrivacyNoticeState;
};

/**
 * Every applicable deadline within the horizon or past, in kind order. Deadlines are inclusive
 * (Q69): overdue from the day after the date.
 */
export function deadlinesOf(facts: DeadlineFacts, today: IsoDate): Deadline[] {
  const { snapshot: s, project, privacyNotice } = facts;
  const { status, dsvStatus } = s.current;
  const dates: [DeadlineKind, IsoDate | null][] = [
    [
      "offer_deadline",
      dsvStatus === "dsv_offered" ? effectiveOfferDeadline(s.participation, s.wave) : null,
    ],
    ["tg_start", status === "informed" ? effectiveTgStart(s.participation, s.wave) : null],
    ["latest_entry_cutoff", latestEntryCutoff(s, project)],
    ["privacy_notice", privacyNotice.state === "provided" ? null : privacyNotice.dueOn],
    ["profiling_exception", profilingExceptionDeadline(s, today)],
  ];
  return dates.flatMap(([kind, date]): Deadline[] => {
    if (date === null) return [];
    const days = daysBetween(today, date);
    if (days > deadlineWarningDays) return [];
    const state: DeadlineState = days < 0 ? "overdue" : "upcoming";
    if (kind !== "latest_entry_cutoff") return [{ kind, date, state }];
    // The cutoff is the day after the latest entry date; the reminder comes 3 days before it.
    return [{ kind, date, state, final: state === "upcoming" && days < cutoffFinalReminderDays }];
  });
}

/** One month after entry under an approved exception, while profiling isn't done (Q74). */
function profilingExceptionDeadline(s: ParticipationSnapshot, today: IsoDate): IsoDate | null {
  const entry = s.participation.tgEntryDate;
  const { status, profilingStatus } = s.current;
  if (status !== "active_in_tg" || !entry) return null;
  if (profilingStatus === "profiling_done" || profilingStatus === "profiling_declined") return null;
  if (!validBy(s.facts.profilingExceptionApproved, today)) return null;
  return addMonths(entry, profilingExceptionDeadlineMonths);
}

/**
 * The deadline a row shows: the oldest overdue one, else the earliest upcoming one; a tie by kind
 * in `DeadlineKind`'s order.
 */
export function mostUrgent(deadlines: readonly Deadline[]): Deadline | null {
  const rank = (d: Deadline) =>
    [d.state === "overdue" ? 0 : 1, d.date, DeadlineKind.options.indexOf(d.kind)] as const;
  return (
    deadlines.toSorted((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2];
    })[0] ?? null
  );
}

/** The planner's flags without those a deadline represents, so a cutoff is counted once. */
export function remainingFlags(flags: readonly LifecycleFlag[]): LifecycleFlag[] {
  return flags.filter((flag) => !replacedFlags.has(flag));
}
