import { z } from "zod";

/** Lifecycle vocabulary (plan 5.2, process-and-lifecycle.md). Values are stored as they are. */

export const MainStatus = z.enum([
  "self_registered",
  "imported",
  "contacted",
  "unreachable",
  "informed",
  "active_in_tg",
  "withdrawn",
  "rejected",
  "ta_completed",
  "exited",
]);
export type MainStatus = z.infer<typeof MainStatus>;

export const terminalMainStatuses: ReadonlySet<MainStatus> = new Set([
  "withdrawn",
  "rejected",
  "ta_completed",
  "exited",
]);

export const ProfilingStatus = z.enum([
  "not_started",
  "profiling_accepted",
  "profiling_in_progress",
  "profiling_done",
  "profiling_declined",
]);
export type ProfilingStatus = z.infer<typeof ProfilingStatus>;

/** Only in `ta_tg` projects. */
export const DsvStatus = z.enum([
  "not_offered",
  "dsv_offered",
  "dsv_signed",
  "dsv_declined",
  "dsv_expired",
]);
export type DsvStatus = z.infer<typeof DsvStatus>;

/** Columns `status`, `profiling_status`, `dsv_status`. */
export const Track = z.enum(["main", "profiling", "dsv"]);
export type Track = z.infer<typeof Track>;

/** Shared by lifecycle guards and configuration (ADR-0004); `project_checklist` is project scope. */
export const Step = z.enum([
  "asu_registration",
  "data_collection",
  "profiling",
  "agentur_submission",
  "dsv",
  "project_checklist",
]);
export type Step = z.infer<typeof Step>;

export const EndReasonPhase = z.enum(["pre_tg", "tg"]);
export type EndReasonPhase = z.infer<typeof EndReasonPhase>;

const preTgEndReasons = [
  "declined_profiling",
  "declined_dsv",
  "no_response",
  "never_contacted",
  "not_informed",
  "placed_direct",
  "self_employed",
  "retirement",
  "other_measure",
  "deceased",
  "other",
] as const;

const tgEndReasons = [
  "placed_permanent",
  "placed_fixed_term",
  "self_employed",
  "retirement",
  "apprenticeship_or_study",
  "max_duration_reached",
  "own_termination_without_job",
  "terminated_by_tg",
  // special category (health): refused by the status function until encrypted storage (Q66)
  "long_term_illness_reduced_earning_capacity",
  "deceased",
  "other",
] as const;

type EndReasonValue = (typeof preTgEndReasons)[number] | (typeof tgEndReasons)[number];

/** One enum with a phase attribute (Q34); some reasons exist in both phases. */
export const EndReason = z.enum([
  ...new Set<EndReasonValue>([...preTgEndReasons, ...tgEndReasons]),
] as [EndReasonValue, ...EndReasonValue[]]);
export type EndReason = z.infer<typeof EndReason>;

const endReasonsByPhase: Record<EndReasonPhase, readonly EndReason[]> = {
  pre_tg: preTgEndReasons,
  tg: tgEndReasons,
};

export function endReasonsForPhase(phase: EndReasonPhase): readonly EndReason[] {
  return endReasonsByPhase[phase];
}

export function isEndReasonForPhase(reason: EndReason, phase: EndReasonPhase): boolean {
  return endReasonsByPhase[phase].includes(reason);
}

/** The only reasons the system planner derives, in precedence order (Q56, Q70). */
export const plannerEndReasons: readonly EndReason[] = [
  "declined_dsv",
  "declined_profiling",
  "no_response",
  "never_contacted",
  "not_informed",
];

export const TgEntryKind = z.enum(["scheduled_entry", "scheduled_entry_catchup", "reconciliation"]);
export type TgEntryKind = z.infer<typeof TgEntryKind>;

/** Q81. No `other`: anything else needs `ba_confirmed_other`. */
export const ProfilingExceptionReason = z.enum([
  "participant_prevented_documented",
  "agentur_scheduling_unavailable",
  "force_majeure",
  "ba_confirmed_other",
]);
export type ProfilingExceptionReason = z.infer<typeof ProfilingExceptionReason>;

/** `none` is a participation without a request; each request is its own record (round 10). */
export const ProfilingExceptionStatus = z.enum([
  "none",
  "requested",
  "approved",
  "rejected",
  "revoked",
  "superseded",
]);
export type ProfilingExceptionStatus = z.infer<typeof ProfilingExceptionStatus>;

/** Why a pending request was closed automatically (round 10). */
export const ProfilingExceptionSupersededReason = z.enum([
  "participation_closed",
  "project_ta_only",
  "profiling_closed",
]);
export type ProfilingExceptionSupersededReason = z.infer<typeof ProfilingExceptionSupersededReason>;

/** Transfer-KuG eligibility per period (Q82, verify). */
export const KugOutcome = z.enum(["eligible", "excluded", "ba_review_required"]);
export type KugOutcome = z.infer<typeof KugOutcome>;

export const ActorType = z.enum(["user", "participant", "system"]);
export type ActorType = z.infer<typeof ActorType>;
