import type { IsoDate } from "../iso-date";
import {
  ProfilingExceptionReason,
  terminalMainStatuses,
  type EndReason,
  type MainStatus,
  type ProfilingExceptionStatus,
  type ProfilingExceptionSupersededReason,
} from "./enums";
import { validBy, type DatedFact } from "./guards";
import { endReasonProblem, type TransitionContext } from "./transition";
import { effectiveTgStart } from "./waves";

/**
 * Operations without a status change (plan 5.3). Each checks its domain rules and returns the
 * next value; the status functions (PR 1g) write it with the audit entry. Which roles may call
 * them is the access matrix (PR 1d, Q60, Q80).
 */
export type OperationContext = Pick<
  TransitionContext,
  "projectType" | "current" | "actor" | "today" | "wave" | "participation"
> & { now: Date };

/** The failure codes of each operation, in check order. */
export const operationFailures = {
  assignEntryWave: [
    "actor_not_allowed",
    "not_ta_tg",
    "status_not_open",
    "dsv_already_offered",
    "individual_dates_set",
    "wave_of_other_project",
    "wave_unchanged",
  ],
  requestProfilingException: [
    "actor_not_allowed",
    "not_ta_tg",
    "not_informed",
    "profiling_closed",
    "no_future_start",
    "exception_open",
    "reason_invalid",
    "evidence_missing",
    "evidence_unchanged",
    "ba_confirmation_missing",
  ],
  decideProfilingException: [
    "actor_not_allowed",
    "not_requested",
    "four_eyes",
    "not_informed",
    "profiling_closed",
    "no_future_start",
  ],
  revokeProfilingException: [
    "actor_not_allowed",
    "not_revocable",
    "no_longer_applicable",
    "not_informed",
  ],
  supersedeStaleException: ["not_pending", "still_applicable"],
  correctEndReason: [
    "actor_not_allowed",
    "no_end_reason",
    "reason_wrong_phase",
    "reason_not_storable",
    "reason_unchanged",
  ],
} as const;

type Failures = typeof operationFailures;
export type OperationResult<T, Op extends keyof Failures> =
  | { ok: true; next: T }
  | { ok: false; code: Failures[Op][number] };

const fail = <C extends string>(code: C) => ({ ok: false as const, code });

/** Wave (re)assignment only before the first offer (Q79; later changes aren't covered, D10). */
const waveStatuses = new Set<MainStatus>(["imported", "contacted", "unreachable", "informed"]);

export function assignEntryWave(
  ctx: OperationContext,
  target: { projectId: string; wave: { id: string; projectId: string } },
): OperationResult<{ waveId: string }, "assignEntryWave"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  if (ctx.projectType !== "ta_tg") return fail("not_ta_tg");
  if (!waveStatuses.has(ctx.current.status)) return fail("status_not_open");
  if (ctx.current.dsvStatus !== "not_offered") return fail("dsv_already_offered");
  // Individual dates keep their wave, so a wave change never silently invalidates them (R33).
  if (ctx.participation.tgStart !== null || (ctx.participation.tgEnd ?? null) !== null) {
    return fail("individual_dates_set");
  }
  if (target.wave.projectId !== target.projectId) return fail("wave_of_other_project");
  // Assigning the current wave again is a no-op, refused without a write (round 16).
  if (ctx.wave?.id === target.wave.id) return fail("wave_unchanged");
  return { ok: true, next: { waveId: target.wave.id } };
}

/**
 * One profiling exception request (Q74, Q80, Q81). Each request is its own record: a rejected,
 * revoked or superseded one is never reopened or overwritten; a new request is a new record
 * (round 10). Only `approved` counts for entry.
 */
export type ProfilingException = {
  status: Exclude<ProfilingExceptionStatus, "none">;
  reason: ProfilingExceptionReason;
  /** The immutable evidence record (Q94): its id and canonical fingerprint, never contents. */
  evidenceRecordId: string;
  evidenceFingerprint: string;
  requestedBy: string;
  decidedBy: string | null;
  /** The decision's Berlin date and instant: an approval counts only from them (round 9). */
  decidedOn: IsoDate | null;
  decidedAt: Date | null;
  supersededBecause: ProfilingExceptionSupersededReason | null;
};

/**
 * One immutable evidence record (Q81, Q94): accepted evidence document versions or a structured
 * BA confirmation, with its versioned canonical fingerprint (`EvidenceFingerprint`, Slice 4b).
 * No evidence storage until Slice 4b (D4).
 */
export type EvidenceFact = DatedFact & { recordId: string; fingerprint: string };

export type ExceptionRequest = {
  reason: ProfilingExceptionReason;
  evidence?: EvidenceFact;
  /** Who at the BA confirmed it, and when; only for `ba_confirmed_other`. */
  baConfirmation?: DatedFact;
};

const closedProfiling = new Set(["profiling_done", "profiling_declined"]);
const isOpen = (e: ProfilingException | null) =>
  e?.status === "requested" || e?.status === "approved";

/** An exception only serves a future entry: it never authorises a missed start (round 10). */
function hasFutureStart(ctx: OperationContext) {
  const tgStart = effectiveTgStart(ctx.participation, ctx.wave);
  return tgStart !== null && ctx.today < tgStart;
}

/**
 * The PL requests while `informed`, profiling open (never after `profiling_declined`, Q74) and
 * a future start applies. After a rejected or revoked request, a new one needs changed
 * evidence; it gets its own approval.
 */
export function requestProfilingException(
  ctx: OperationContext,
  latest: ProfilingException | null,
  request: ExceptionRequest,
): OperationResult<ProfilingException, "requestProfilingException"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  if (ctx.projectType !== "ta_tg") return fail("not_ta_tg");
  if (ctx.current.status !== "informed") return fail("not_informed");
  if (closedProfiling.has(ctx.current.profilingStatus)) return fail("profiling_closed");
  if (!hasFutureStart(ctx)) return fail("no_future_start");
  if (isOpen(latest)) return fail("exception_open");
  if (!ProfilingExceptionReason.safeParse(request.reason).success) return fail("reason_invalid");
  const { evidence } = request;
  if (!evidence || !validBy(evidence, ctx.today)) return fail("evidence_missing");
  // Changed evidence means a different fingerprint, not just another record (Q94).
  if (latest && latest.evidenceFingerprint === evidence.fingerprint) {
    return fail("evidence_unchanged");
  }
  if (request.reason === "ba_confirmed_other" && !validBy(request.baConfirmation, ctx.today)) {
    return fail("ba_confirmation_missing");
  }
  return {
    ok: true,
    next: {
      status: "requested",
      reason: request.reason,
      evidenceRecordId: evidence.recordId,
      evidenceFingerprint: evidence.fingerprint,
      requestedBy: ctx.actor.staffUserId,
      decidedBy: null,
      decidedOn: null,
      decidedAt: null,
      supersededBecause: null,
    },
  };
}

/**
 * Four eyes: a different staff user approves or rejects a documented request, before entry,
 * while profiling is open and a future start applies (Q80, round 10).
 */
export function decideProfilingException(
  ctx: OperationContext,
  exception: ProfilingException,
  decision: "approve" | "reject",
): OperationResult<ProfilingException, "decideProfilingException"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  if (exception.status !== "requested") return fail("not_requested");
  if (exception.requestedBy === ctx.actor.staffUserId) return fail("four_eyes");
  if (ctx.current.status !== "informed") return fail("not_informed");
  if (closedProfiling.has(ctx.current.profilingStatus)) return fail("profiling_closed");
  if (!hasFutureStart(ctx)) return fail("no_future_start");
  return {
    ok: true,
    next: {
      ...exception,
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: ctx.actor.staffUserId,
      decidedOn: ctx.today,
      decidedAt: ctx.now,
    },
  };
}

/** Why a request no longer applies, or `null` while it still does (round 10). */
function staleBecause(ctx: OperationContext): ProfilingExceptionSupersededReason | null {
  if (terminalMainStatuses.has(ctx.current.status)) return "participation_closed";
  if (ctx.projectType !== "ta_tg") return "project_ta_only";
  if (closedProfiling.has(ctx.current.profilingStatus)) return "profiling_closed";
  return null;
}

/**
 * The PL deliberately withdraws a still-applicable request or approval, before TG entry (Q60).
 * One that no longer applies is superseded instead.
 */
export function revokeProfilingException(
  ctx: OperationContext,
  exception: ProfilingException,
): OperationResult<ProfilingException, "revokeProfilingException"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  if (!isOpen(exception)) return fail("not_revocable");
  if (staleBecause(ctx)) return fail("no_longer_applicable");
  if (ctx.current.status !== "informed") return fail("not_informed");
  return { ok: true, next: { ...exception, status: "revoked" } };
}

/**
 * Closes a pending request automatically when profiling finishes, the participation closes or
 * the project becomes `ta_only` (round 10). The status functions (PR 1g) apply it in the
 * transaction of the change that makes it stale; audited like every closure. A passed start alone doesn't close it: it stays pending for a
 * new start date, and can't authorise the missed one.
 */
export function supersedeStaleException(
  ctx: OperationContext,
  exception: ProfilingException,
): OperationResult<ProfilingException, "supersedeStaleException"> {
  if (exception.status !== "requested") return fail("not_pending");
  const because = staleBecause(ctx);
  if (!because) return fail("still_applicable");
  return { ok: true, next: { ...exception, status: "superseded", supersededBecause: because } };
}

/** The guard fact `profilingExceptionApproved`: valid from the approval's date and instant. */
export function approvedExceptionFact(exception: ProfilingException | null): DatedFact | undefined {
  if (exception?.status !== "approved" || !exception.decidedOn || !exception.decidedAt) {
    return undefined;
  }
  return { validOn: exception.decidedOn, recordedAt: exception.decidedAt };
}

/** The primary end reason, who set it, and the other applicable reasons (Q56). */
export type EndReasonRecord = {
  endReason: EndReason;
  source: "system" | "user";
  secondaryReasons: readonly EndReason[];
};

/**
 * Q72: the PL corrects the primary reason without reopening the terminal status. Every previous
 * reason stays in the audit history. A system-derived one also moves to the secondary list as
 * factual context; a previous staff reason only when the PL confirms it still applies
 * (round 10).
 */
export function correctEndReason(
  ctx: OperationContext,
  record: EndReasonRecord,
  endReason: EndReason,
  options: { previousStillApplies?: boolean } = {},
): OperationResult<EndReasonRecord, "correctEndReason"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  const { status } = ctx.current;
  if (status !== "withdrawn" && status !== "exited") return fail("no_end_reason");
  const problem = endReasonProblem(status, endReason);
  if (problem === "reason_wrong_phase" || problem === "reason_not_storable") return fail(problem);
  if (endReason === record.endReason) return fail("reason_unchanged");
  const keep = record.source === "system" || options.previousStillApplies === true;
  const previous = keep ? [record.endReason] : [];
  const secondaryReasons = [...new Set([...previous, ...record.secondaryReasons])].filter(
    (r) => r !== endReason,
  );
  return { ok: true, next: { endReason, source: "user", secondaryReasons } };
}
