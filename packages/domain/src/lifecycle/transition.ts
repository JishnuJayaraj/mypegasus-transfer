import { valueDataClass } from "../fields/catalog";
import type { IsoDate } from "../iso-date";
import type { ProjectType } from "../project";
import { edges, type Edge } from "./edges";
import {
  TgEntryKind,
  isEndReasonForPhase,
  type DsvStatus,
  type EndReason,
  type EndReasonPhase,
  type MainStatus,
  type ProfilingStatus,
  type Track,
} from "./enums";
import { recordedBy, validBy, type DatedFact, type GuardFacts, type GuardId } from "./guards";
import { effectiveTgStart, type EntryWave, type ParticipationDates } from "./waves";

export type AnyStatus = MainStatus | ProfilingStatus | DsvStatus;

export type TransitionContext = {
  projectType: ProjectType;
  current: { status: MainStatus; profilingStatus: ProfilingStatus; dsvStatus: DsvStatus };
  actor: { type: "user"; staffUserId: string } | { type: "participant" } | { type: "system" };
  /** Only for `informed → active_in_tg`. */
  entryKind?: TgEntryKind;
  /** The Berlin date, from the Clock. */
  today: IsoDate;
  /** The originally scheduled run time of the TG start's day (system entry kinds). */
  scheduledAt?: Date;
  /** That day's run completed (and its guard failed): reconciliation may follow the same day. */
  scheduledRunCompleted?: boolean;
  wave: EntryWave | null;
  participation: ParticipationDates;
  facts: GuardFacts;
  /** An explicit deadline for `→ dsv_offered`; required for a re-offer (Q69). */
  newOfferDeadline?: IsoDate;
  /** For `→ withdrawn` and `→ exited`. */
  endReason?: EndReason;
  /** The PL's explicit confirmation, where a guard needs one. */
  confirmed?: boolean;
};

export type TransitionFailure =
  | "no_edge"
  | "track_inactive"
  | "actor_not_allowed"
  | "reason_required"
  | "reason_wrong_phase"
  | "reason_not_storable"
  | "guard_failed";

export type TransitionCheck =
  | { ok: true; flagForReview: boolean }
  | { ok: false; code: TransitionFailure; failedGuards: GuardId[] };

const statusField = { main: "status", profiling: "profilingStatus", dsv: "dsvStatus" } as const;
const reasonPhase: Partial<Record<AnyStatus, EndReasonPhase>> = {
  withdrawn: "pre_tg",
  exited: "tg",
};
const forwardProfiling = new Set([
  "not_started>profiling_accepted",
  "profiling_accepted>profiling_in_progress",
  "profiling_in_progress>profiling_done",
]);
const isEntryKind = (kind: string) => (TgEntryKind.options as string[]).includes(kind);
const fail = (code: TransitionFailure): TransitionCheck => ({ ok: false, code, failedGuards: [] });

/**
 * Whether one track may move from `from` to `to` (plan 5.3). Checked in this order: edge, track
 * activity, actor and entry kind, end reason, guards. There is no override (Q71). Pure: the
 * caller passes today's date and the dated facts; absent facts are false (D4).
 */
export function canTransition(
  track: Track,
  from: AnyStatus,
  to: AnyStatus,
  ctx: TransitionContext,
): TransitionCheck {
  if (ctx.current[statusField[track]] !== from) {
    throw new Error(`from (${from}) is not the current status`);
  }
  const candidates = edges.filter(
    (e) =>
      e.track === track &&
      e.from === from &&
      e.to === to &&
      (!e.projectTypes || e.projectTypes.includes(ctx.projectType)),
  );
  if (candidates.length === 0) return fail("no_edge");
  if (!isTrackActive(track, from, to, ctx)) return fail("track_inactive");

  const edge = candidates.find(
    (e) =>
      e.actor === ctx.actor.type &&
      (isEntryKind(e.kind) ? e.kind === ctx.entryKind : ctx.entryKind === undefined),
  );
  if (!edge) return fail("actor_not_allowed");

  const reasonProblem = endReasonProblem(to, ctx.endReason);
  if (reasonProblem) return fail(reasonProblem);

  const failedGuards = edge.guards.filter((guard) => !guardPasses(guard, edge, ctx));
  if (failedGuards.length > 0) return { ok: false, code: "guard_failed", failedGuards };
  return { ok: true, flagForReview: edge.kind === "reconciliation" };
}

/**
 * The tracks move only while `informed`; the DSV track only in `ta_tg`. In the TG with an
 * approved profiling exception, forward profiling moves and a refusal are recorded (Q74).
 */
function isTrackActive(track: Track, from: AnyStatus, to: AnyStatus, ctx: TransitionContext) {
  const { status } = ctx.current;
  if (track === "main") return true;
  if (track === "dsv") return ctx.projectType === "ta_tg" && status === "informed";
  if (status === "informed") return true;
  return (
    status === "active_in_tg" &&
    validBy(ctx.facts.profilingExceptionApproved, ctx.today) &&
    (to === "profiling_declined" || forwardProfiling.has(`${from}>${to}`))
  );
}

/** `→ withdrawn` needs a pre-TG reason, `→ exited` a TG reason; special category isn't storable yet. */
export function endReasonProblem(
  to: AnyStatus,
  reason: EndReason | undefined,
): Extract<TransitionFailure, `reason_${string}`> | null {
  const phase = reasonPhase[to];
  if (!phase) return null;
  if (!reason) return "reason_required";
  if (!isEndReasonForPhase(reason, phase)) return "reason_wrong_phase";
  // Refused until encrypted storage exists (Q66, Slice 8).
  if (valueDataClass("endReason", reason) === "special_category") return "reason_not_storable";
  return null;
}

function guardPasses(guard: GuardId, edge: Edge, ctx: TransitionContext): boolean {
  const { facts, today, wave } = ctx;
  const tgStart = effectiveTgStart(ctx.participation, wave);
  // Automatic entry uses a snapshot as of the scheduled run (round 9).
  const byEntry = (fact: DatedFact | undefined) =>
    validBy(fact, tgStart) &&
    (edge.actor !== "system" ||
      (ctx.scheduledAt !== undefined && recordedBy(fact, ctx.scheduledAt)));

  switch (guard) {
    case "dsv_fully_executed":
      return byEntry(facts.dsvFullyExecuted);
    case "asu_registered_with_proof":
      return byEntry(facts.asuRegisteredWithProof);
    case "profiling_done_or_approved_exception":
      return byEntry(facts.profilingDone) || byEntry(facts.profilingExceptionApproved);
    case "tg_start_date":
      return tgStartDatePasses(edge.kind, tgStart, ctx);
    case "ta_completion":
      return validBy(facts.taMeasuresComplete, today) && ctx.confirmed === true;
    case "withdrawal_after_dsv_signed":
      return (
        ctx.current.dsvStatus !== "dsv_signed" ||
        (validBy(facts.dsvCancellation, today) &&
          ctx.confirmed === true &&
          ctx.actor.type === "user")
      );
    case "before_cutoff":
      return !wave?.latestEntryDate || today <= wave.latestEntryDate;
    case "entry_wave_assigned":
      return wave !== null;
    case "offer_deadline_valid":
      return offerDeadlinePasses(edge, tgStart, ctx);
    case "tl407_signed":
      return validBy(facts.tl407Signed, today);
    case "dsv_generated":
      return validBy(facts.dsvGenerated, today);
    case "dsv_scan_received":
      return validBy(facts.dsvScanReceived, today);
  }
}

/** Q68 and rounds 8–9: the entry kind decides which day the entry may be recorded on. */
function tgStartDatePasses(kind: Edge["kind"], tgStart: IsoDate | null, ctx: TransitionContext) {
  const { today, scheduledAt } = ctx;
  if (tgStart === null) return false;
  if (kind === "scheduled_entry") return tgStart === today && scheduledAt !== undefined;
  if (kind === "scheduled_entry_catchup") return tgStart < today && scheduledAt !== undefined;
  return today > tgStart || (today === tgStart && ctx.scheduledRunCompleted === true);
}

/**
 * Q69: the first offer may use the wave's signing deadline, a re-offer needs an explicit one.
 * It must lie between today and both the latest entry date and the TG start; fails closed
 * when either is missing (D10).
 */
function offerDeadlinePasses(edge: Edge, tgStart: IsoDate | null, ctx: TransitionContext) {
  const firstOffer = edge.from === "not_offered" ? ctx.wave?.signingDeadline : undefined;
  const deadline = ctx.newOfferDeadline ?? firstOffer;
  const latest = ctx.wave?.latestEntryDate;
  if (!deadline || !latest || !tgStart) return false;
  return ctx.today <= deadline && deadline <= latest && deadline <= tgStart;
}
