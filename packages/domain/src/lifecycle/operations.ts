import type { IsoDate } from "../iso-date";
import {
  ProfilingExceptionReason,
  type EndReason,
  type MainStatus,
  type ProfilingExceptionStatus,
} from "./enums";
import { validBy, type DatedFact } from "./guards";
import { endReasonProblem, type TransitionContext } from "./transition";

/**
 * Operations without a status change (plan 5.3). Each checks its domain rules and returns the
 * next value; the status functions (PR 1g) write it with the audit entry. Which roles may call
 * them is the access matrix (PR 1d, Q60, Q80).
 */
export type OperationContext = Pick<
  TransitionContext,
  "projectType" | "current" | "actor" | "today"
> & { now: Date };

/** The failure codes of each operation, in check order. */
export const operationFailures = {
  assignEntryWave: [
    "actor_not_allowed",
    "not_ta_tg",
    "status_not_open",
    "dsv_already_offered",
    "wave_of_other_project",
  ],
  requestProfilingException: [
    "actor_not_allowed",
    "not_ta_tg",
    "not_informed",
    "profiling_closed",
    "exception_open",
    "reason_invalid",
    "evidence_missing",
    "ba_confirmation_missing",
  ],
  decideProfilingException: [
    "actor_not_allowed",
    "not_requested",
    "four_eyes",
    "not_informed",
    "profiling_closed",
  ],
  revokeProfilingException: ["actor_not_allowed", "not_revocable", "not_informed"],
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
  if (target.wave.projectId !== target.projectId) return fail("wave_of_other_project");
  return { ok: true, next: { waveId: target.wave.id } };
}

/** A participation's profiling exception (Q74, Q80, Q81). Only `approved` counts for entry. */
export type ProfilingException = {
  status: ProfilingExceptionStatus;
  reason: ProfilingExceptionReason | null;
  requestedBy: string | null;
  decidedBy: string | null;
  /** The decision's Berlin date and instant: an approval counts only from them (round 9). */
  decidedOn: IsoDate | null;
  decidedAt: Date | null;
};

export const noProfilingException: ProfilingException = {
  status: "none",
  reason: null,
  requestedBy: null,
  decidedBy: null,
  decidedOn: null,
  decidedAt: null,
};

export type ExceptionRequest = {
  reason: ProfilingExceptionReason;
  /** Supporting evidence or a BA reference (Q81). No evidence storage until Slice 4b (D4). */
  evidence?: DatedFact;
  /** Who at the BA confirmed it, and when; only for `ba_confirmed_other`. */
  baConfirmation?: DatedFact;
};

const closedProfiling = new Set(["profiling_done", "profiling_declined"]);

/** The PL requests; while profiling is open and never after `profiling_declined` (Q74). */
export function requestProfilingException(
  ctx: OperationContext,
  exception: ProfilingException,
  request: ExceptionRequest,
): OperationResult<ProfilingException, "requestProfilingException"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  if (ctx.projectType !== "ta_tg") return fail("not_ta_tg");
  if (ctx.current.status !== "informed") return fail("not_informed");
  if (closedProfiling.has(ctx.current.profilingStatus)) return fail("profiling_closed");
  // A new request may follow a rejected or revoked one: it needs its own approval.
  if (exception.status === "requested" || exception.status === "approved") {
    return fail("exception_open");
  }
  if (!ProfilingExceptionReason.safeParse(request.reason).success) return fail("reason_invalid");
  if (!validBy(request.evidence, ctx.today)) return fail("evidence_missing");
  if (request.reason === "ba_confirmed_other" && !validBy(request.baConfirmation, ctx.today)) {
    return fail("ba_confirmation_missing");
  }
  return {
    ok: true,
    next: {
      ...noProfilingException,
      status: "requested",
      reason: request.reason,
      requestedBy: ctx.actor.staffUserId,
    },
  };
}

/** Four eyes: a different staff user decides, before entry and while profiling is open (Q80). */
export function decideProfilingException(
  ctx: OperationContext,
  exception: ProfilingException,
  decision: "approve" | "reject",
): OperationResult<ProfilingException, "decideProfilingException"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  if (exception.status !== "requested") return fail("not_requested");
  if (!exception.requestedBy || exception.requestedBy === ctx.actor.staffUserId) {
    return fail("four_eyes");
  }
  if (ctx.current.status !== "informed") return fail("not_informed");
  if (closedProfiling.has(ctx.current.profilingStatus)) return fail("profiling_closed");
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

/** Only before TG entry; after it the exception is closed by `profiling_done` (Q60). */
export function revokeProfilingException(
  ctx: OperationContext,
  exception: ProfilingException,
): OperationResult<ProfilingException, "revokeProfilingException"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  if (exception.status !== "requested" && exception.status !== "approved") {
    return fail("not_revocable");
  }
  if (ctx.current.status !== "informed") return fail("not_informed");
  return { ok: true, next: { ...exception, status: "revoked" } };
}

/** The guard fact `profilingExceptionApproved`: valid from the approval's date and instant. */
export function approvedExceptionFact(exception: ProfilingException): DatedFact | undefined {
  if (exception.status !== "approved" || !exception.decidedOn || !exception.decidedAt) {
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
 * Q72: the PL corrects the primary reason without reopening the terminal status. A
 * system-derived previous reason moves to the secondary list; every previous one stays in the
 * audit history.
 */
export function correctEndReason(
  ctx: OperationContext,
  record: EndReasonRecord,
  endReason: EndReason,
): OperationResult<EndReasonRecord, "correctEndReason"> {
  if (ctx.actor.type !== "user") return fail("actor_not_allowed");
  const { status } = ctx.current;
  if (status !== "withdrawn" && status !== "exited") return fail("no_end_reason");
  const problem = endReasonProblem(status, endReason);
  if (problem === "reason_wrong_phase" || problem === "reason_not_storable") return fail(problem);
  if (endReason === record.endReason) return fail("reason_unchanged");
  const previous = record.source === "system" ? [record.endReason] : [];
  const secondaryReasons = [...new Set([...previous, ...record.secondaryReasons])].filter(
    (r) => r !== endReason,
  );
  return { ok: true, next: { endReason, source: "user", secondaryReasons } };
}
