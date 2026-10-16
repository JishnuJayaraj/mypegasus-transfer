import type { Clock } from "@transfer/adapters";
import {
  eq,
  participation,
  profilingExceptionRequest,
  project,
  projectEntryWave,
  sql,
  type Database,
} from "@transfer/db";
import {
  assignEntryWave,
  canTransition,
  correctEndReason,
  decideProfilingException,
  edges,
  effectiveTgStart,
  mayPerformOperation,
  mayPerformTransition,
  requestProfilingException,
  revokeProfilingException,
  statusFieldOfTrack,
  type AnyStatus,
  type EndReason,
  type EntryWave,
  type GuardId,
  type IsoDate,
  type Operation,
  type OperationContext,
  type ProfilingException,
  type ProfilingExceptionReason,
  type Subject,
  TgEntryKind,
  type Track,
  type TransitionContext,
} from "@transfer/domain";
import type { SQL } from "drizzle-orm";
import { failClosedFacts, type GuardFactsProvider, type Transaction } from "./guard-facts";

/**
 * The status service (plan 5.4): the only TypeScript caller of the status functions. Each call is
 * one transaction: lock the participation → load its project, wave, current exception request and
 * dated guard facts → check the actor's permission (`mayPerformTransition` /
 * `mayPerformOperation`, round 10 §6) → the domain's lifecycle check → the function. A refusal
 * writes nothing. The functions provide integrity; this service, authority and the dated guards.
 */

/** Staff and participants are access subjects; the system acts as a named job. */
export type ServiceActor = Subject | { kind: "system"; job: string };

/** Correlation ids copied into the audit event. */
export type Correlation = { requestId?: string; jobId?: string };

export type StatusServiceErrorKind = "not_found" | "forbidden" | "stale" | "domain" | "integrity";

/** A refusal with a stable code (and the failed guards), never a value. */
export class StatusServiceError extends Error {
  override readonly name = "StatusServiceError";

  constructor(
    readonly kind: StatusServiceErrorKind,
    readonly code: string,
    readonly failedGuards: readonly GuardId[] = [],
  ) {
    super(code);
  }
}

export type StatusChange = {
  participationId: string;
  track: Track;
  from: AnyStatus;
  to: AnyStatus;
  /** Only for `informed → active_in_tg`. */
  entryKind?: TgEntryKind;
  /** The scheduled run time the automatic entry kinds take their snapshot at (round 9). */
  scheduledAt?: Date;
  /** That day's run completed: a reconciliation may follow the same day. */
  scheduledRunCompleted?: boolean;
  endReason?: EndReason;
  secondaryReasons?: EndReason[];
  /** An explicit offer deadline for `→ dsv_offered` (required for a re-offer, Q69). */
  offerDeadline?: IsoDate;
  /** The business date of the change; a TG entry's is always its effective TG start. */
  effectiveDate?: IsoDate;
  /** The PL's explicit confirmation, where a guard needs one. */
  confirmed?: boolean;
};

type Deps = { db: Database; clock: Clock; facts?: GuardFactsProvider };

const entryKinds: ReadonlySet<string> = new Set(TgEntryKind.options);
const notFound = new Set(["participation_not_found", "project_not_found", "request_not_found"]);
const stale = new Set(["stale_status", "request_not_current"]);

/** A refusal of a status function (`P0001`, the code is the message) as a service error. */
function fromDatabase(error: unknown): unknown {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code !== "P0001" || !cause.message) return error;
  const { message: code } = cause;
  const kind = notFound.has(code) ? "not_found" : stale.has(code) ? "stale" : "integrity";
  return new StatusServiceError(kind, code);
}

const fail = (kind: StatusServiceErrorKind, code: string, failedGuards?: readonly GuardId[]) => {
  throw new StatusServiceError(kind, code, failedGuards);
};

function audit(actor: ServiceActor, correlation: Correlation): SQL {
  const staffUserId = actor.kind === "staff" ? actor.staffUserId : null;
  const participantId = actor.kind === "participant" ? actor.participationId : null;
  const job = actor.kind === "system" ? actor.job : null;
  const type = actor.kind === "staff" ? "user" : actor.kind;
  return sql`row(${type}::actor_type, ${staffUserId}::uuid, ${participantId}::uuid, ${job}::text,
    null::uuid, ${correlation.requestId ?? null}::text, ${correlation.jobId ?? null}::text)::audit_context`;
}

function transitionActor(actor: ServiceActor): TransitionContext["actor"] {
  if (actor.kind === "staff") return { type: "user", staffUserId: actor.staffUserId };
  return { type: actor.kind };
}

type Request = typeof profilingExceptionRequest.$inferSelect;

function exceptionOf(request: Request | undefined): ProfilingException | null {
  if (!request) return null;
  return {
    status: request.status as ProfilingException["status"],
    reason: request.reasonCode,
    evidenceRecordId: request.evidenceRecordId,
    evidenceFingerprint: request.evidenceFingerprint,
    requestedBy: request.requestedBy,
    decidedBy: request.decidedBy,
    decidedOn: request.decidedOn,
    decidedAt: request.decidedAt === null ? null : new Date(request.decidedAt),
    supersededBecause: request.supersededReason,
  };
}

async function selectFirst<T>(rows: Promise<T[]>): Promise<T | undefined> {
  return (await rows)[0];
}

/** Calls a status function; it returns the new row's or event's id. */
async function call(tx: Transaction, query: SQL): Promise<string> {
  const { rows } = await tx.execute<{ result: string }>(sql`select ${query} as result`);
  return rows[0]!.result;
}

export function createStatusService({ db, clock, facts = failClosedFacts }: Deps) {
  /** One transaction; a function's refusal becomes a service error. */
  async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(work);
    } catch (error) {
      throw fromDatabase(error);
    }
  }

  /** Locks the participation (until the transaction ends) and loads what the checks need. */
  async function load(tx: Transaction, participationId: string, actor: ServiceActor) {
    await tx.execute(sql`select 1 from lock_participation(${participationId}::uuid)`);
    const p = (await selectFirst(
      tx.select().from(participation).where(eq(participation.id, participationId)),
    ))!;
    const { type: projectType } = (await selectFirst(
      tx.select({ type: project.type }).from(project).where(eq(project.id, p.projectId)),
    ))!;
    const wave: EntryWave | null = p.entryWaveId
      ? ((await selectFirst(
          tx
            .select({
              id: projectEntryWave.id,
              code: projectEntryWave.code,
              signingDeadline: projectEntryWave.signingDeadline,
              defaultTgStart: projectEntryWave.defaultTgStart,
              defaultTgEnd: projectEntryWave.defaultTgEnd,
              latestEntryDate: projectEntryWave.latestEntryDate,
            })
            .from(projectEntryWave)
            .where(eq(projectEntryWave.id, p.entryWaveId)),
        )) ?? null)
      : null;
    const request = p.profilingExceptionRequestId
      ? await selectFirst(
          tx
            .select()
            .from(profilingExceptionRequest)
            .where(eq(profilingExceptionRequest.id, p.profilingExceptionRequestId)),
        )
      : undefined;
    const context: OperationContext = {
      projectType,
      current: { status: p.status, profilingStatus: p.profilingStatus, dsvStatus: p.dsvStatus },
      actor: transitionActor(actor),
      today: clock.today(),
      now: clock.now(),
      wave,
      participation: { tgStart: p.tgStart, tgEnd: p.tgEnd, offerDeadline: p.offerDeadline },
    };
    // Projects get their region in Slice 3; until then only a global role reaches them.
    const target = { projectId: p.projectId, regionId: null, participationId };
    return { p, request, exception: exceptionOf(request), context, target };
  }

  type Loaded = Awaited<ReturnType<typeof load>>;

  function permitOperation(actor: ServiceActor, operation: Operation, loaded: Loaded) {
    const permission = mayPerformOperation(actor, operation, loaded.target);
    if (!permission.ok) fail("forbidden", permission.because);
  }

  /** Loads the participation of a request and checks the request is its current one. */
  async function loadRequest(tx: Transaction, requestId: string, actor: ServiceActor) {
    const request = await selectFirst(
      tx
        .select({ participationId: profilingExceptionRequest.participationId })
        .from(profilingExceptionRequest)
        .where(eq(profilingExceptionRequest.id, requestId)),
    );
    if (!request) return fail("not_found", "request_not_found");
    const loaded = await load(tx, request.participationId, actor);
    if (loaded.request?.id !== requestId) return fail("stale", "request_not_current");
    return { ...loaded, exception: loaded.exception! };
  }

  return {
    /** Creation along the creation edge (`imported`, by the PL, Q60). */
    async createParticipation(
      actor: ServiceActor,
      input: { projectId: string; entryWaveId?: string; id?: string },
      correlation: Correlation = {},
    ): Promise<{ participationId: string }> {
      const edge = edges.find((e) => e.from === null && e.to === "imported")!;
      const permission = mayPerformTransition(actor, edge, {
        projectId: input.projectId,
        regionId: null,
        participationId: null,
      });
      if (!permission.ok) fail("forbidden", permission.because);
      return transaction(async (tx) => ({
        participationId: await call(
          tx,
          sql`create_participation(p_project_id => ${input.projectId}::uuid,
            p_context => ${audit(actor, correlation)},
            p_entry_wave_id => ${input.entryWaveId ?? null}::uuid, p_id => ${input.id ?? null}::uuid)`,
        ),
      }));
    },

    /** One track moves one step; a pending exception request it makes stale is superseded. */
    changeStatus(
      actor: ServiceActor,
      change: StatusChange,
      correlation: Correlation = {},
    ): Promise<{ auditEventId: string }> {
      return transaction(async (tx) => {
        const loaded = await load(tx, change.participationId, actor);
        const { context, exception } = loaded;
        const { track, from, to, entryKind } = change;
        // The actor's own edge, else any edge of this step: a wrong actor type is refused by the
        // permission check. Without any edge, the lifecycle check says `no_edge`.
        const candidates = edges.filter(
          (e) =>
            e.track === track &&
            e.from === from &&
            e.to === to &&
            (entryKinds.has(e.kind) ? e.kind === entryKind : entryKind === undefined),
        );
        const edge = candidates.find((e) => e.actor === context.actor.type) ?? candidates[0];
        if (edge) {
          const permission = mayPerformTransition(actor, edge, loaded.target);
          if (!permission.ok) fail("forbidden", permission.because);
        }
        const field = { main: "status", profiling: "profilingStatus", dsv: "dsvStatus" } as const;
        if (context.current[field[track]] !== from) fail("stale", "stale_status");

        const check = canTransition(track, from, to, {
          ...context,
          entryKind,
          scheduledAt: change.scheduledAt,
          scheduledRunCompleted: change.scheduledRunCompleted,
          facts: await facts.facts(tx, {
            participationId: change.participationId,
            currentRequest: exception,
          }),
          newOfferDeadline: change.offerDeadline,
          endReason: change.endReason,
          confirmed: change.confirmed,
        });
        if (!check.ok) fail("domain", check.code, check.failedGuards);

        // A TG entry is recorded on the effective TG start, whatever its kind (plan 5.3).
        let effectiveDate = change.effectiveDate ?? null;
        if (to === "active_in_tg") {
          const tgStart = effectiveTgStart(context.participation, context.wave);
          if (effectiveDate !== null && effectiveDate !== tgStart) {
            fail("domain", "effective_date_mismatch");
          }
          effectiveDate = tgStart;
        }
        const secondary = change.secondaryReasons ?? [];
        return {
          auditEventId: await call(
            tx,
            sql`change_participation_status(p_id => ${change.participationId}::uuid,
              p_field => ${statusFieldOfTrack[track]}::status_field,
              p_expected_from => ${from}::text, p_to => ${to}::text,
              p_context => ${audit(actor, correlation)},
              p_entry_kind => ${entryKind ?? null}::tg_entry_kind,
              p_end_reason => ${change.endReason ?? null}::end_reason,
              p_secondary_reasons => ${`{${secondary.join(",")}}`}::end_reason[],
              p_offer_deadline => ${change.offerDeadline ?? null}::date,
              p_effective_date => ${effectiveDate}::date,
              p_scheduled_at => ${change.scheduledAt?.toISOString() ?? null}::timestamptz)`,
          ),
        };
      });
    },

    assignEntryWave(
      actor: ServiceActor,
      input: { participationId: string; waveId: string },
      correlation: Correlation = {},
    ): Promise<{ auditEventId: string }> {
      return transaction(async (tx) => {
        const loaded = await load(tx, input.participationId, actor);
        permitOperation(actor, { kind: "assignEntryWave" }, loaded);
        const wave = await selectFirst(
          tx
            .select({ id: projectEntryWave.id, projectId: projectEntryWave.projectId })
            .from(projectEntryWave)
            .where(eq(projectEntryWave.id, input.waveId)),
        );
        // An unknown wave is as foreign as another project's (fail safe).
        if (!wave) return fail("domain", "wave_of_other_project");
        const result = assignEntryWave(loaded.context, { projectId: loaded.p.projectId, wave });
        if (!result.ok) return fail("domain", result.code);
        return {
          auditEventId: await call(
            tx,
            sql`assign_entry_wave(p_id => ${input.participationId}::uuid,
              p_wave_id => ${input.waveId}::uuid, p_context => ${audit(actor, correlation)})`,
          ),
        };
      });
    },

    /**
     * A new request names its evidence record; the facts provider resolves and validates it
     * (none in Slice 1: `evidence_missing`). Returns the request id only, never the fingerprint.
     */
    requestProfilingException(
      actor: ServiceActor,
      input: {
        participationId: string;
        reason: ProfilingExceptionReason;
        evidenceRecordId: string;
      },
      correlation: Correlation = {},
    ): Promise<{ requestId: string }> {
      return transaction(async (tx) => {
        const loaded = await load(tx, input.participationId, actor);
        permitOperation(actor, { kind: "requestProfilingException" }, loaded);
        const resolved = await facts.evidence(tx, input);
        const result = requestProfilingException(loaded.context, loaded.exception, {
          reason: input.reason,
          ...(resolved && { evidence: resolved.evidence }),
          ...(resolved?.baConfirmation && { baConfirmation: resolved.baConfirmation }),
        });
        if (!result.ok) return fail("domain", result.code);
        const { evidenceRecordId, evidenceFingerprint } = result.next;
        return {
          requestId: await call(
            tx,
            sql`request_profiling_exception(p_id => ${input.participationId}::uuid,
              p_reason => ${input.reason}::profiling_exception_reason,
              p_requested_on => ${loaded.context.today}::date,
              p_evidence_record_id => ${evidenceRecordId}::uuid,
              p_evidence_fingerprint => ${evidenceFingerprint}::text,
              p_context => ${audit(actor, correlation)})`,
          ),
        };
      });
    },

    decideProfilingException(
      actor: ServiceActor,
      input: { requestId: string; approve: boolean },
      correlation: Correlation = {},
    ): Promise<{ auditEventId: string }> {
      return transaction(async (tx) => {
        const loaded = await loadRequest(tx, input.requestId, actor);
        const { requestedBy } = loaded.exception;
        permitOperation(actor, { kind: "decideProfilingException", requestedBy }, loaded);
        const decision = input.approve ? "approve" : "reject";
        const result = decideProfilingException(loaded.context, loaded.exception, decision);
        if (!result.ok) return fail("domain", result.code);
        return {
          auditEventId: await call(
            tx,
            sql`decide_profiling_exception(p_request_id => ${input.requestId}::uuid,
              p_approve => ${input.approve}::boolean, p_decided_on => ${loaded.context.today}::date,
              p_context => ${audit(actor, correlation)})`,
          ),
        };
      });
    },

    revokeProfilingException(
      actor: ServiceActor,
      input: { requestId: string },
      correlation: Correlation = {},
    ): Promise<{ auditEventId: string }> {
      return transaction(async (tx) => {
        const loaded = await loadRequest(tx, input.requestId, actor);
        permitOperation(actor, { kind: "revokeProfilingException" }, loaded);
        const result = revokeProfilingException(loaded.context, loaded.exception);
        if (!result.ok) return fail("domain", result.code);
        return {
          auditEventId: await call(
            tx,
            sql`revoke_profiling_exception(p_request_id => ${input.requestId}::uuid,
              p_context => ${audit(actor, correlation)})`,
          ),
        };
      });
    },

    /** Q72: the PL corrects the primary end reason without reopening the terminal status. */
    correctEndReason(
      actor: ServiceActor,
      input: { participationId: string; endReason: EndReason; previousStillApplies?: boolean },
      correlation: Correlation = {},
    ): Promise<{ auditEventId: string }> {
      return transaction(async (tx) => {
        const loaded = await load(tx, input.participationId, actor);
        permitOperation(actor, { kind: "correctEndReason" }, loaded);
        const { endReason, endReasonSource, endReasonSecondary } = loaded.p;
        if (endReason === null) return fail("domain", "no_end_reason");
        const record = {
          endReason,
          source: endReasonSource === "system" ? ("system" as const) : ("user" as const),
          secondaryReasons: endReasonSecondary,
        };
        const result = correctEndReason(loaded.context, record, input.endReason, {
          previousStillApplies: input.previousStillApplies,
        });
        if (!result.ok) return fail("domain", result.code);
        return {
          auditEventId: await call(
            tx,
            sql`correct_end_reason(p_id => ${input.participationId}::uuid,
              p_new_reason => ${input.endReason}::end_reason, p_context => ${audit(actor, correlation)},
              p_previous_still_applies => ${input.previousStillApplies ?? false}::boolean)`,
          ),
        };
      });
    },
  };
}

export type StatusService = ReturnType<typeof createStatusService>;
