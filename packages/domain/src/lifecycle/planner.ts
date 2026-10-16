import { addDays, addMonths } from "../dates";
import { profilingExceptionDeadlineMonths } from "../eligibility/transfer-kug";
import type { IsoDate } from "../iso-date";
import type { ProjectType } from "../project";
import { canTransition, type AnyStatus, type TransitionContext } from "./transition";
import type {
  EndReason,
  LifecycleFlag,
  MainStatus,
  ProjectFlag,
  TgEntryKind,
  Track,
} from "./enums";
import { validBy, type GuardFacts } from "./guards";
import {
  effectiveOfferDeadline,
  effectiveTgStart,
  projectFinalEntryDate,
  type EntryWave,
  type ParticipationDates,
} from "./waves";

/** One run day the planner covers, with its originally scheduled run time (round 9). */
export type RunDay = { day: IsoDate; scheduledAt: Date };

/**
 * The days after the last completed run up to `today` (normally just today; after an outage
 * every missed day). A completed day is never evaluated again.
 */
export type PlanWindow = { days: readonly RunDay[]; today: IsoDate };

export type PlannerProject = { type: ProjectType; waves: readonly EntryWave[] };

export type ParticipationSnapshot = {
  current: TransitionContext["current"];
  wave: EntryWave | null;
  participation: ParticipationDates & { tgEntryDate?: IsoDate | null };
  facts: GuardFacts;
};

/** A change for the status service to apply as `system`; `effectiveDate` may lie in the past. */
export type PlannedChange = {
  track: Track;
  from: AnyStatus;
  to: AnyStatus;
  effectiveDate: IsoDate;
  entryKind?: TgEntryKind;
  scheduledAt?: Date;
  endReason?: EndReason;
  secondaryReasons?: EndReason[];
};

export type Plan = { changes: PlannedChange[]; flags: LifecycleFlag[] };

/** Q78: warning from 14 calendar days before the cutoff, final reminder from 3 days before. */
export const cutoffWarningDays = 14;
export const cutoffFinalReminderDays = 3;
const cutoffStatuses = new Set<MainStatus>(["imported", "contacted", "unreachable", "informed"]);

type CutoffOutcome =
  | { kind: "withdraw"; reasons: [EndReason, ...EndReason[]] }
  | { kind: "flag"; flag: LifecycleFlag }
  | null;

/**
 * The system transitions for one participation (plan 5.3): DSV expiry, scheduled TG entry and
 * catch-up, cutoff withdrawals; each rule sees the changes before it. Pure and idempotent: a
 * second run plans nothing. Nothing in Slice 1 is configurable here (Q78 fixes the days).
 */
export function planSystemTransitions(
  snapshot: ParticipationSnapshot,
  project: PlannerProject,
  window: PlanWindow,
): Plan {
  const changes: PlannedChange[] = [];
  let s = snapshot;
  const { today } = window;
  const ctx = (extra: Partial<TransitionContext> = {}): TransitionContext => ({
    projectType: project.type,
    current: s.current,
    actor: { type: "system" },
    today,
    wave: s.wave,
    participation: s.participation,
    facts: s.facts,
    ...extra,
  });
  const apply = (change: PlannedChange, next: Partial<ParticipationSnapshot["current"]>) => {
    changes.push(change);
    s = { ...s, current: { ...s.current, ...next } };
  };

  // 1. DSV expiry: the day after the effective offer deadline.
  const deadline = effectiveOfferDeadline(s.participation, s.wave);
  if (
    s.current.dsvStatus === "dsv_offered" &&
    deadline !== null &&
    today > deadline &&
    canTransition("dsv", "dsv_offered", "dsv_expired", ctx()).ok
  ) {
    const effectiveDate = addDays(deadline, 1);
    const change = { track: "dsv", from: "dsv_offered", to: "dsv_expired", effectiveDate } as const;
    apply(change, { dsvStatus: "dsv_expired" });
  }

  // 2. TG entry on a run day of the window, with the snapshot as of that day's run.
  const tgStart = effectiveTgStart(s.participation, s.wave);
  const run = window.days.find((d) => d.day === tgStart);
  if (s.current.status === "informed" && run) {
    const entryKind = run.day === today ? "scheduled_entry" : "scheduled_entry_catchup";
    const entry = { entryKind, scheduledAt: run.scheduledAt } as const;
    if (canTransition("main", "informed", "active_in_tg", ctx(entry)).ok) {
      const change = { track: "main", from: "informed", to: "active_in_tg" } as const;
      apply({ ...change, effectiveDate: run.day, ...entry }, { status: "active_in_tg" });
      s = { ...s, participation: { ...s.participation, tgEntryDate: run.day } };
    }
  }

  // 3. Cutoff withdrawals, effective the day after the latest entry date.
  const latest = latestEntryDateFor(s, project);
  const outcome = cutoffOutcome(s);
  if (latest !== null && today > latest && outcome?.kind === "withdraw") {
    const [endReason, ...secondaryReasons] = outcome.reasons;
    const from = s.current.status;
    // A signed DSV needs the cancellation and the PL's confirmation: never a system withdrawal.
    if (canTransition("main", from, "withdrawn", ctx({ endReason })).ok) {
      const effectiveDate = addDays(latest, 1);
      apply(
        { track: "main", from, to: "withdrawn", effectiveDate, endReason, secondaryReasons },
        { status: "withdrawn" },
      );
    }
  }

  return { changes, flags: lifecycleFlags(s, project, today) };
}

/**
 * The flags of one participation (derived, never stored; the PL dashboard calls it): a missed
 * TG start, cutoff warnings and the cutoff cases that need the PL, compliance escalations.
 */
export function lifecycleFlags(
  s: ParticipationSnapshot,
  project: PlannerProject,
  today: IsoDate,
): LifecycleFlag[] {
  const flags: LifecycleFlag[] = [];
  const { status, profilingStatus, dsvStatus } = s.current;
  const tgStart = effectiveTgStart(s.participation, s.wave);
  if (status === "informed" && tgStart !== null && tgStart < today) flags.push("tg_start_missed");

  const latest = latestEntryDateFor(s, project);
  if (latest !== null && today > latest) {
    const outcome = cutoffOutcome(s);
    if (outcome?.kind === "flag") flags.push(outcome.flag);
  } else if (latest !== null) {
    // Warned as it will be at the cutoff: an open offer will have expired by then, since its
    // deadline is no later than the latest entry date (Q69).
    const atCutoff = dsvStatus === "dsv_offered" ? "dsv_expired" : dsvStatus;
    const cutoff = addDays(latest, 1);
    if (cutoffOutcome({ ...s, current: { ...s.current, dsvStatus: atCutoff } })) {
      if (today >= addDays(cutoff, -cutoffWarningDays)) flags.push("cutoff_warning");
      if (today >= addDays(cutoff, -cutoffFinalReminderDays)) flags.push("cutoff_final_reminder");
    }
  }

  if (status === "active_in_tg") {
    const entry = s.participation.tgEntryDate;
    if (profilingStatus === "profiling_declined") {
      flags.push("profiling_declined_after_entry");
    } else if (
      profilingStatus !== "profiling_done" &&
      validBy(s.facts.profilingExceptionApproved, today) &&
      entry &&
      today > addMonths(entry, profilingExceptionDeadlineMonths)
    ) {
      flags.push("profiling_exception_deadline_missed");
    }
  }
  return flags;
}

/** A `ta_tg` project needs a latest entry date on every wave, and at least one wave (Q77). */
export function projectFlags(project: PlannerProject): ProjectFlag[] {
  const missing =
    project.waves.length === 0 || project.waves.some((w) => w.latestEntryDate === null);
  return project.type === "ta_tg" && missing ? ["latest_entry_date_missing"] : [];
}

/** The participation's wave cutoff, or the project's final entry date without a wave (Q84). */
function latestEntryDateFor(s: ParticipationSnapshot, project: PlannerProject): IsoDate | null {
  if (project.type !== "ta_tg") return null;
  return s.wave ? s.wave.latestEntryDate : projectFinalEntryDate(project.waves);
}

/** What the cutoff does to this state (plan 5.3, rules 3 and 5; Q56, Q70, Q84). */
function cutoffOutcome(s: ParticipationSnapshot): CutoffOutcome {
  const { status, profilingStatus: profiling, dsvStatus: dsv } = s.current;
  if (!cutoffStatuses.has(status)) return null;
  // Cases the system doesn't resolve: the PL clarifies them.
  if (dsv === "dsv_signed" && profiling === "profiling_declined") {
    return { kind: "flag", flag: "conflict_dsv_signed_profiling_declined" };
  }
  if (status === "informed" && !s.wave)
    return { kind: "flag", flag: "informed_without_wave_at_cutoff" };
  if (status === "informed" && dsv === "not_offered")
    return { kind: "flag", flag: "dsv_never_offered" };

  // By precedence; a signed DSV with a refusal was flagged above.
  const reasons: EndReason[] = [];
  if (dsv === "dsv_declined") reasons.push("declined_dsv");
  if (profiling === "profiling_declined") reasons.push("declined_profiling");
  if (dsv === "dsv_expired" || status === "unreachable") reasons.push("no_response");
  if (status === "imported") reasons.push("never_contacted");
  if (status === "contacted") reasons.push("not_informed");
  const [first, ...rest] = reasons;
  return first ? { kind: "withdraw", reasons: [first, ...rest] } : null;
}
