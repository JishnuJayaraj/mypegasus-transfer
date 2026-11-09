import { z } from "zod";
import { CorrectionSource } from "../corrections/model";
import { isoDate, type IsoDate } from "../iso-date";
import { addDays } from "../dates";
import { DsvStatus, MainStatus } from "../lifecycle/enums";
import { validBy, type GuardFacts } from "../lifecycle/guards";
import type { ProjectType } from "../project";

// The entry clarification (process-and-lifecycle.md, the entry clarification; Q214, Q220 open): a
// signed DSV that has not entered after its planned TG start. Owned by the project's PL; stays
// open until the participation leaves `informed`. It offers the existing legitimate paths only.
// No edge exists for a cancellation or termination after the planned start; nothing is invented
// for the legal outcomes (Q220). No I/O, no system time.

/** What the PL documents as pending. */
export const EntryPendingCode = z
  .enum([
    "awaiting_countersignature",
    "awaiting_asu_proof",
    "awaiting_profiling",
    "awaiting_legal_advice",
  ])
  .meta({ id: "EntryPendingCode" });
export type EntryPendingCode = z.infer<typeof EntryPendingCode>;

/** What the region's manager instructs after an escalation. */
export const EntryInstructionCode = z
  .enum([
    "legal_advice_obtained",
    "dpo_instruction",
    "authority_or_court_decision",
    "parties_agreement",
  ])
  .meta({ id: "EntryInstructionCode" });
export type EntryInstructionCode = z.infer<typeof EntryInstructionCode>;

/** Why the manager asks the PL again instead of instructing. */
export const EntryRequestCode = z
  .enum(["evidence_unclear", "date_unclear", "other_documented"])
  .meta({ id: "EntryRequestCode" });
export type EntryRequestCode = z.infer<typeof EntryRequestCode>;

const statusVersion = z.number().int().nonnegative();
/**
 * The clarification's own revision the caller read: 0 while nothing is recorded, then the number of
 * steps. Every write compares it under the lock (`409 stale_clarification`), so two tabs never
 * overwrite each other's note and an escalation names exactly the note its PL saw.
 */
const revision = z.number().int().nonnegative();

/**
 * `POST /participations/{id}/entry-clarification`: the PL's pending code with its documented
 * source (one line, Q209's rules), against the status version and the clarification's revision
 * read. After the manager's request this is the PL's reply.
 */
export const EntryClarificationPendingRequest = z
  .strictObject({ code: EntryPendingCode, source: CorrectionSource, statusVersion, revision })
  .meta({ id: "EntryClarificationPendingRequest" });
export type EntryClarificationPendingRequest = z.infer<typeof EntryClarificationPendingRequest>;

/** `POST /participations/{id}/entry-clarification/escalation`: names the revision confirmed. */
export const EntryClarificationEscalationRequest = z
  .strictObject({ statusVersion, revision })
  .meta({ id: "EntryClarificationEscalationRequest" });
export type EntryClarificationEscalationRequest = z.infer<
  typeof EntryClarificationEscalationRequest
>;

/** `POST /entry-clarifications/{id}/instruction`: the region's manager. */
export const EntryClarificationInstructionRequest = z
  .strictObject({ code: EntryInstructionCode, source: CorrectionSource, statusVersion, revision })
  .meta({ id: "EntryClarificationInstructionRequest" });
export type EntryClarificationInstructionRequest = z.infer<
  typeof EntryClarificationInstructionRequest
>;

/** `POST /entry-clarifications/{id}/request`: the manager asks the PL again; no status changes. */
export const EntryClarificationRequestRequest = z
  .strictObject({ code: EntryRequestCode, source: CorrectionSource, statusVersion, revision })
  .meta({ id: "EntryClarificationRequestRequest" });
export type EntryClarificationRequestRequest = z.infer<typeof EntryClarificationRequestRequest>;

/**
 * Where a recorded clarification stands: `documented` (the PL's note, which they may replace),
 * `escalated` (with the manager), `returned` (the manager asked the PL again; the PL replies by
 * recording again, then escalates again) and `instructed` (the manager's word; nothing follows on
 * the row).
 */
export const EntryClarificationStage = z
  .enum(["documented", "escalated", "returned", "instructed"])
  .meta({ id: "EntryClarificationStage" });
export type EntryClarificationStage = z.infer<typeof EntryClarificationStage>;

/** What the recorded clarification has so far (the row's stage, no values). */
export type EntryClarificationRecord = {
  stage: EntryClarificationStage;
  /** The day after the planned start the case opened for. */
  openedOn: IsoDate;
};

export type EntryClarificationInput = {
  projectType: ProjectType;
  status: MainStatus;
  dsvStatus: DsvStatus;
  /** The effective planned TG start. */
  tgStart: IsoDate | null;
  /** The participation's wave's latest entry date. */
  latestEntryDate: IsoDate | null;
  today: IsoDate;
  /** Whether today's entry run completed (a new start is then tomorrow at the earliest). */
  entryRunCompletedToday: boolean;
  facts: GuardFacts;
  /** The unresolved case of the participation, or its latest, whatever its planned start was. */
  clarification: EntryClarificationRecord | null;
};

/**
 * The Berlin day the clarification opened (the day after the effective TG start) while it is open:
 * a `ta_tg` participation with a signed DSV still `informed`. Null otherwise. It opens on its
 * own: no row is needed for the case item.
 */
export function entryClarificationOpenedOn(
  input: Pick<
    EntryClarificationInput,
    "projectType" | "status" | "dsvStatus" | "tgStart" | "today"
  >,
): IsoDate | null {
  const { tgStart } = input;
  if (input.projectType !== "ta_tg" || input.status !== "informed") return null;
  if (input.dsvStatus !== "dsv_signed" || tgStart === null) return null;
  return input.today > tgStart ? addDays(tgStart, 1) : null;
}

/** Whether every entry fact held on the planned TG start, though it may be recorded later (Q68 case 2). */
function heldOnTgStart(facts: GuardFacts, tgStart: IsoDate): boolean {
  return (
    validBy(facts.dsvFullyExecuted, tgStart) &&
    validBy(facts.asuRegisteredWithProof, tgStart) &&
    (validBy(facts.profilingDone, tgStart) || validBy(facts.profilingExceptionApproved, tgStart))
  );
}

export type EntryClarificationActions = {
  open: boolean;
  openedOn: IsoDate | null;
  /** The reconciliation is possible: every fact held on the TG start. */
  reconciliation: boolean;
  /** A new start date with its amendment: the latest entry date still allows one. */
  newStartDate: boolean;
  /** The PL documents or replies: until the case is escalated, and after the manager's request. */
  recordPending: boolean;
  /** The PL escalates a documented case. */
  escalate: boolean;
  /** The region's manager instructs or asks the PL again, while the case is with them. */
  instruct: boolean;
};

/**
 * Which legitimate path is open now: each only when its guard passes. The amendment and the dates
 * rules of a new start are checked by the dates operation itself; here only the latest entry date
 * and today's run bound it. A case is open from the day after the planned start and stays open
 * until the participation leaves `informed`; an unresolved case also stays open, and actionable,
 * when the planned start moved on. The recorded case stays open after an instruction.
 */
export function entryClarificationActions(
  input: EntryClarificationInput,
): EntryClarificationActions {
  const { clarification: row, tgStart, latestEntryDate, today } = input;
  const derived = entryClarificationOpenedOn(input);
  const carried = row !== null && row.stage !== "instructed" && input.status === "informed";
  if (derived === null && !carried) {
    return {
      open: false,
      openedOn: null,
      reconciliation: false,
      newStartDate: false,
      recordPending: false,
      escalate: false,
      instruct: false,
    };
  }
  const earliest = input.entryRunCompletedToday ? addDays(today, 1) : today;
  return {
    open: true,
    openedOn: carried ? row.openedOn : derived,
    reconciliation: derived !== null && tgStart !== null && heldOnTgStart(input.facts, tgStart),
    newStartDate: latestEntryDate !== null && earliest <= latestEntryDate,
    recordPending: row === null || row.stage === "documented" || row.stage === "returned",
    escalate: row?.stage === "documented",
    instruct: row?.stage === "escalated",
  };
}

/** One step of a clarification, in order: what was recorded, by which code, on which Berlin day. */
export const EntryClarificationStep = z
  .strictObject({
    kind: z.enum(["recorded", "escalated", "requested", "instructed"]),
    code: z.union([EntryPendingCode, EntryRequestCode, EntryInstructionCode]),
    /** The documented source line (`case_internal`). */
    source: z.string(),
    on: isoDate,
  })
  .meta({ id: "EntryClarificationStep" });
export type EntryClarificationStep = z.infer<typeof EntryClarificationStep>;

/** A recorded clarification as the PL and the manager read it: every step is kept. */
export const EntryClarificationView = z
  .strictObject({
    id: z.uuid(),
    openedOn: isoDate,
    stage: EntryClarificationStage,
    revision,
    steps: z.array(EntryClarificationStep),
  })
  .meta({ id: "EntryClarificationView" });
export type EntryClarificationView = z.infer<typeof EntryClarificationView>;

/** `GET /participations/{id}/entry-clarification`. */
export const EntryClarificationState = z
  .strictObject({
    participationId: z.uuid(),
    statusVersion,
    /**
     * Null until the PL documents something (the case item exists without it); else the unresolved
     * case, or the latest, whatever planned start it opened for.
     */
    clarification: EntryClarificationView.nullable(),
    actions: z.strictObject({
      open: z.boolean(),
      openedOn: isoDate.nullable(),
      reconciliation: z.boolean(),
      newStartDate: z.boolean(),
      recordPending: z.boolean(),
      escalate: z.boolean(),
      instruct: z.boolean(),
    }),
    /** The viewer's own permission (the PL), beside the state's `actions`. */
    capabilities: z.strictObject({ record: z.boolean(), escalate: z.boolean() }),
  })
  .meta({ id: "EntryClarificationState" });
export type EntryClarificationState = z.infer<typeof EntryClarificationState>;

/**
 * An escalated clarification in "Freigaben": the project, the dates, the steps so far and the
 * revision to answer; no name and no participation id (the answer names the clarification).
 */
export const EntryClarificationReviewItem = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    projectName: z.string(),
    /** The planned start the case opened for. */
    tgStart: isoDate,
    openedOn: isoDate,
    escalatedOn: isoDate,
    revision,
    steps: z.array(EntryClarificationStep),
    /** The participation's status version the answer is recorded against. */
    statusVersion,
    /** Never the person who escalated; the same for an instruction and for a request. */
    capabilities: z.strictObject({ answer: z.boolean() }),
  })
  .meta({ id: "EntryClarificationReviewItem" });
export type EntryClarificationReviewItem = z.infer<typeof EntryClarificationReviewItem>;
