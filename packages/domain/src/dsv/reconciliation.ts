import { z } from "zod";
import { CorrectionSource } from "../corrections/model";
import { addDays, daysBetween } from "../dates";
import { isoDate, type IsoDate } from "../iso-date";

// The reconciliation of a TG entry after its planned start (process-and-lifecycle.md, TG entry
// guard, "Entry after the planned date" case 2; Q68, Q80, Q216): the PL records the entry with the
// TG start as its effective date when every entry fact was valid on that day though recorded later,
// and the regional operations manager of the project's region reviews it after the fact. Never
// backdated on evidence valid later; never reversed automatically; no deadline. No I/O, no system
// time.

/** The evidence a reconciliation rests on, one per entry fact. */
export const ReconciliationEvidenceKind = z
  .enum(["dsv_packet", "asu_registration", "tl407", "profiling_exception"])
  .meta({ id: "ReconciliationEvidenceKind" });
export type ReconciliationEvidenceKind = z.infer<typeof ReconciliationEvidenceKind>;

/** The entry facts the evidence covers: the profiling by the TL 407 or the approved exception. */
export const ReconciliationFact = z
  .enum(["dsv_packet", "asu_registration", "profiling"])
  .meta({ id: "ReconciliationFact" });
export type ReconciliationFact = z.infer<typeof ReconciliationFact>;

/** One piece of evidence as recorded: its record, the day it is valid from, when it counted. */
export type EvidenceRecord = { id: string; validOn: IsoDate; recordedAt: Date };

/**
 * What the database holds for the entry facts now: the complete packet of the signed DSV, the
 * current ASU registration with a usable proof, the TL 407 that supports `profilingDoneOn` and the
 * approved exception (each only while its evidence counts).
 */
export type EntryEvidence = {
  packet: EvidenceRecord | null;
  asu: EvidenceRecord | null;
  tl407: EvidenceRecord | null;
  exception: EvidenceRecord | null;
};

export type ReconciliationEvidenceItem = {
  kind: ReconciliationEvidenceKind;
  id: string;
  validOn: IsoDate;
  recordedAt: Date;
};

export type ReconciliationEvidenceProblem = {
  fact: ReconciliationFact;
  /** `evidence_missing`: none counts now; `evidence_after_tg_start`: valid only after it. */
  code: "evidence_missing" | "evidence_after_tg_start";
};

export type ReconciliationEvidenceResult =
  | { ok: true; evidence: ReconciliationEvidenceItem[] }
  | {
      ok: false;
      problems: ReconciliationEvidenceProblem[];
      /** The records that exist, each with its actual day, for the dialog to show. */
      evidence: ReconciliationEvidenceItem[];
    };

/**
 * The evidence of a reconciliation (Q68 case 2): every entry fact valid on the TG start, however
 * late it was recorded. The profiling rests on the TL 407 when it was done by the start, else on the
 * approved exception. A fact valid only after the start is refused: no entry is backdated on it,
 * and no later day is invented (Q216).
 */
export function reconciliationEvidence(
  input: EntryEvidence,
  tgStart: IsoDate,
): ReconciliationEvidenceResult {
  const held = (record: EvidenceRecord | null) => record !== null && record.validOn <= tgStart;
  const profiling: [ReconciliationEvidenceKind, EvidenceRecord | null] = held(input.tl407)
    ? ["tl407", input.tl407]
    : held(input.exception)
      ? ["profiling_exception", input.exception]
      : input.tl407
        ? ["tl407", input.tl407]
        : ["profiling_exception", input.exception];
  const facts: [ReconciliationFact, ReconciliationEvidenceKind, EvidenceRecord | null][] = [
    ["dsv_packet", "dsv_packet", input.packet],
    ["asu_registration", "asu_registration", input.asu],
    ["profiling", ...profiling],
  ];
  const problems: ReconciliationEvidenceProblem[] = [];
  const evidence: ReconciliationEvidenceItem[] = [];
  for (const [fact, kind, record] of facts) {
    if (record === null) {
      problems.push({ fact, code: "evidence_missing" });
      continue;
    }
    if (!held(record)) problems.push({ fact, code: "evidence_after_tg_start" });
    evidence.push({ kind, ...record });
  }
  return problems.length > 0 ? { ok: false, problems, evidence } : { ok: true, evidence };
}

/** The evidence as the PL saw it in the dialog: its kind, its record and the day it is valid. */
export const ReconciliationEvidenceRef = z
  .strictObject({ kind: ReconciliationEvidenceKind, id: z.uuid(), validOn: isoDate })
  .meta({ id: "ReconciliationEvidenceRef" });
export type ReconciliationEvidenceRef = z.infer<typeof ReconciliationEvidenceRef>;

/**
 * Whether the evidence read is the evidence now: the same records with the same days, nothing
 * more, nothing less (else `409 source_changed`).
 */
export function sameEvidence(
  read: readonly ReconciliationEvidenceRef[],
  current: readonly ReconciliationEvidenceRef[],
): boolean {
  const key = (e: ReconciliationEvidenceRef) => `${e.kind}|${e.id}|${e.validOn}`;
  const now = new Set(current.map(key));
  return (
    read.length === current.length &&
    new Set(read.map(key)).size === read.length &&
    read.every((e) => now.has(key(e)))
  );
}

/**
 * Where the review stands (Q216): `requested` (awaiting the manager), `no_objection` (closed),
 * `clarification_requested` (with the PL), `replied` (back with the manager), `escalated_to_dpo`
 * (open until the manager resolves it on the DPO's documented instruction) and
 * `resolved_no_objection` (closed).
 */
export const ReconciliationStage = z
  .enum([
    "requested",
    "no_objection",
    "clarification_requested",
    "replied",
    "escalated_to_dpo",
    "resolved_no_objection",
  ])
  .meta({ id: "ReconciliationStage" });
export type ReconciliationStage = z.infer<typeof ReconciliationStage>;

/** The manager's outcomes. */
export const ReconciliationOutcome = z
  .enum(["no_objection", "clarification_requested", "resolved_no_objection", "escalated_to_dpo"])
  .meta({ id: "ReconciliationOutcome" });
export type ReconciliationOutcome = z.infer<typeof ReconciliationOutcome>;

/** Why the manager asks the PL (Q209's documented-source rules apply to the line beside it). */
export const ReconciliationReasonCode = z
  .enum(["evidence_unclear", "date_unclear", "other_documented"])
  .meta({ id: "ReconciliationReasonCode" });
export type ReconciliationReasonCode = z.infer<typeof ReconciliationReasonCode>;

/** The PL's reply; supplementing evidence happens through its own operations. */
export const ReconciliationReplyCode = z
  .enum(["evidence_supplemented", "explained", "correction_requested"])
  .meta({ id: "ReconciliationReplyCode" });
export type ReconciliationReplyCode = z.infer<typeof ReconciliationReplyCode>;

/** The outcomes the manager may record in each stage that awaits them. */
const outcomesOf: Partial<Record<ReconciliationStage, readonly ReconciliationOutcome[]>> = {
  requested: ["no_objection", "clarification_requested"],
  replied: ["resolved_no_objection", "escalated_to_dpo", "clarification_requested"],
  escalated_to_dpo: ["resolved_no_objection"],
};

/** The outcomes open to the manager now; none while the PL is to reply or once it is closed. */
export function reconciliationOutcomes(stage: ReconciliationStage): ReconciliationOutcome[] {
  return [...(outcomesOf[stage] ?? [])];
}

/** Whether the review is with the manager. */
export const reconciliationAwaitsReview = (stage: ReconciliationStage): boolean =>
  reconciliationOutcomes(stage).length > 0;

/**
 * Whether a clarification is open: from the manager's first request until it is resolved; the
 * PL's case item "Rückfrage zum Eintritt" stays while it is (an escalation too).
 */
export const reconciliationClarificationOpen = (stage: ReconciliationStage): boolean =>
  stage === "clarification_requested" || stage === "replied" || stage === "escalated_to_dpo";

export type ReconciliationReviewFailure =
  | "actor_not_allowed"
  | "four_eyes"
  | "not_awaiting"
  | "outcome_not_allowed";

/**
 * The manager's review (Q80, Q216): only a regional operations manager of the project's region
 * (`actor_not_allowed`), never the PL who reconciled (`four_eyes`, even holding both roles), while
 * the review awaits them (`not_awaiting`), with an outcome open in that stage. The outcome is the
 * next stage. A clarification needs its reason code, every outcome but `no_objection` a source.
 */
export function reviewReconciliation(input: {
  stage: ReconciliationStage;
  reconciledBy: string;
  reviewer: string;
  /** `mayPerformOperation(reviewReconciliation)` for the project. */
  permitted: boolean;
  outcome: ReconciliationOutcome;
}): { ok: true; next: ReconciliationStage } | { ok: false; code: ReconciliationReviewFailure } {
  if (!input.permitted) return { ok: false, code: "actor_not_allowed" };
  if (input.reviewer === input.reconciledBy) return { ok: false, code: "four_eyes" };
  const open = reconciliationOutcomes(input.stage);
  if (open.length === 0) return { ok: false, code: "not_awaiting" };
  if (!open.includes(input.outcome)) return { ok: false, code: "outcome_not_allowed" };
  return { ok: true, next: input.outcome };
}

/** The PL's reply: only while the manager's request awaits it. */
export function replyReconciliation(
  stage: ReconciliationStage,
): { ok: true; next: "replied" } | { ok: false; code: "not_awaiting" } {
  return stage === "clarification_requested"
    ? { ok: true, next: "replied" }
    : { ok: false, code: "not_awaiting" };
}

// 1970-01-05 was a Monday.
const weekday = (date: IsoDate) => (((daysBetween("1970-01-05", date) % 7) + 7) % 7) + 1;

/**
 * The day the review is due: the next business day (Monday to Friday) after the reconciliation.
 * Informational only: nothing happens when it passes (Q80, Q216).
 */
export function reconciliationReviewDueOn(reconciledOn: IsoDate): IsoDate {
  let day = addDays(reconciledOn, 1);
  while (weekday(day) > 5) day = addDays(day, 1);
  return day;
}

const statusVersion = z.number().int().nonnegative();
/** The reconciliation's own revision the caller read: the number of review steps so far. */
const revision = z.number().int().nonnegative();

/**
 * `POST /participations/{id}/tg-entry-reconciliation`: the evidence the dialog listed, the status
 * version read and the PL's confirmation that every fact held on the TG start.
 */
export const TgEntryReconciliationRequest = z
  .strictObject({
    evidence: z.array(ReconciliationEvidenceRef).length(3),
    statusVersion,
    confirmed: z.literal(true),
  })
  .meta({ id: "TgEntryReconciliationRequest" });
export type TgEntryReconciliationRequest = z.infer<typeof TgEntryReconciliationRequest>;

/** `POST /reconciliations/{id}/review`: the region's manager. */
export const ReconciliationReviewRequest = z
  .discriminatedUnion("outcome", [
    z.strictObject({ outcome: z.literal("no_objection"), revision }),
    z.strictObject({
      outcome: z.literal("clarification_requested"),
      code: ReconciliationReasonCode,
      source: CorrectionSource,
      revision,
    }),
    z.strictObject({
      outcome: z.enum(["resolved_no_objection", "escalated_to_dpo"]),
      source: CorrectionSource,
      revision,
    }),
  ])
  .meta({ id: "ReconciliationReviewRequest" });
export type ReconciliationReviewRequest = z.infer<typeof ReconciliationReviewRequest>;

/** `POST /reconciliations/{id}/reply`: the PL. */
export const ReconciliationReplyRequest = z
  .strictObject({ code: ReconciliationReplyCode, source: CorrectionSource, revision })
  .meta({ id: "ReconciliationReplyRequest" });
export type ReconciliationReplyRequest = z.infer<typeof ReconciliationReplyRequest>;

/** One step of the review, in order: its kind, code, documented source and Berlin day. */
export const ReconciliationStep = z
  .strictObject({
    kind: z.enum([
      "no_objection",
      "clarification_requested",
      "replied",
      "resolved_no_objection",
      "escalated_to_dpo",
    ]),
    code: z.union([ReconciliationReasonCode, ReconciliationReplyCode]).nullable(),
    /** The documented source line (`case_internal`); null for `no_objection`. */
    source: z.string().nullable(),
    on: isoDate,
  })
  .meta({ id: "ReconciliationStep" });
export type ReconciliationStep = z.infer<typeof ReconciliationStep>;

/** Evidence as listed: its kind, the day it is valid from and the Berlin day it was recorded. */
export const ReconciliationEvidenceDays = z
  .strictObject({ kind: ReconciliationEvidenceKind, validOn: isoDate, recordedOn: isoDate })
  .meta({ id: "ReconciliationEvidenceDays" });

/** A recorded reconciliation as the PL reads it on the tab "DSV". */
export const TgEntryReconciliationView = z
  .strictObject({
    id: z.uuid(),
    effectiveDate: isoDate,
    reconciledOn: isoDate,
    reviewDueOn: isoDate,
    evidence: z.array(ReconciliationEvidenceDays),
    stage: ReconciliationStage,
    revision,
    steps: z.array(ReconciliationStep),
  })
  .meta({ id: "TgEntryReconciliationView" });
export type TgEntryReconciliationView = z.infer<typeof TgEntryReconciliationView>;

/** Why "Eintritt nachträglich erfassen" is closed now. */
export const ReconciliationRefusal = z
  .enum([
    "actor_not_allowed",
    "project_not_active",
    "not_informed",
    "tg_start_missing",
    "before_tg_start",
    "run_not_completed",
    "dsv_not_signed",
    "evidence_incomplete",
  ])
  .meta({ id: "ReconciliationRefusal" });
export type ReconciliationRefusal = z.infer<typeof ReconciliationRefusal>;

/**
 * Whether the reconciliation is open today (process-and-lifecycle.md, the guard `tg_start_date`,
 * kind `reconciliation`): after the TG start, or on it once that day's lifecycle run completed.
 */
export function reconciliationTiming(
  tgStart: IsoDate | null,
  today: IsoDate,
  runCompletedToday: boolean,
): null | "tg_start_missing" | "before_tg_start" | "run_not_completed" {
  if (tgStart === null) return "tg_start_missing";
  if (today < tgStart) return "before_tg_start";
  if (today === tgStart && !runCompletedToday) return "run_not_completed";
  return null;
}

/** `GET /participations/{id}/tg-entry-reconciliation`. */
export const TgEntryReconciliationState = z
  .strictObject({
    participationId: z.uuid(),
    statusVersion,
    /** The effective TG start: the reconciliation's effective date. */
    tgStart: isoDate.nullable(),
    /** The evidence the dialog lists, with its actual days and when it was recorded (UTC). */
    evidence: z.array(
      z.strictObject({
        kind: ReconciliationEvidenceKind,
        id: z.uuid(),
        validOn: isoDate,
        recordedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
      }),
    ),
    /** The facts that don't hold on the TG start, if any. */
    problems: z.array(z.strictObject({ fact: ReconciliationFact, code: z.string() })),
    reconciliation: TgEntryReconciliationView.nullable(),
    capabilities: z.strictObject({ reconcile: z.boolean(), reply: z.boolean() }),
    /** Why `reconcile` is closed (the missing permission first). */
    refusal: ReconciliationRefusal.nullable(),
  })
  .meta({ id: "TgEntryReconciliationState" });
export type TgEntryReconciliationState = z.infer<typeof TgEntryReconciliationState>;

/**
 * A reconciliation in "Freigaben": the project, the TG start, the evidence kinds with their valid
 * and recorded days, the review's steps and the revision to answer; never a participant's name or
 * id, nor a file (Q80).
 */
export const ReconciliationReviewItem = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    projectName: z.string(),
    tgStart: isoDate,
    reconciledOn: isoDate,
    /** The next business day (informational, never a deadline). */
    reviewDueOn: isoDate,
    evidence: z.array(ReconciliationEvidenceDays),
    stage: ReconciliationStage,
    revision,
    steps: z.array(ReconciliationStep),
    /** The outcomes the viewer may record now (none for the PL who reconciled). */
    capabilities: z.strictObject({ outcomes: z.array(ReconciliationOutcome) }),
  })
  .meta({ id: "ReconciliationReviewItem" });
export type ReconciliationReviewItem = z.infer<typeof ReconciliationReviewItem>;
