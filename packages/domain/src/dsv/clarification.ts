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

/** What the PL documents as pending (D12). */
export const EntryPendingCode = z
  .enum([
    "awaiting_countersignature",
    "awaiting_asu_proof",
    "awaiting_profiling",
    "awaiting_legal_advice",
  ])
  .meta({ id: "EntryPendingCode" });
export type EntryPendingCode = z.infer<typeof EntryPendingCode>;

/** What the region's manager instructs after an escalation (D12). */
export const EntryInstructionCode = z
  .enum([
    "legal_advice_obtained",
    "dpo_instruction",
    "authority_or_court_decision",
    "parties_agreement",
  ])
  .meta({ id: "EntryInstructionCode" });
export type EntryInstructionCode = z.infer<typeof EntryInstructionCode>;

const statusVersion = z.number().int().nonnegative();

/**
 * `POST /participations/{id}/entry-clarification`: the PL's pending code with its documented
 * source (one line, Q209's rules), against the status version read (`409 stale_status_version`).
 */
export const EntryClarificationPendingRequest = z
  .strictObject({ code: EntryPendingCode, source: CorrectionSource, statusVersion })
  .meta({ id: "EntryClarificationPendingRequest" });
export type EntryClarificationPendingRequest = z.infer<typeof EntryClarificationPendingRequest>;

/** `POST /participations/{id}/entry-clarification/escalation`. */
export const EntryClarificationEscalationRequest = z
  .strictObject({ statusVersion })
  .meta({ id: "EntryClarificationEscalationRequest" });
export type EntryClarificationEscalationRequest = z.infer<
  typeof EntryClarificationEscalationRequest
>;

/** `POST /entry-clarifications/{id}/instruction`: the region's manager. */
export const EntryClarificationInstructionRequest = z
  .strictObject({ code: EntryInstructionCode, source: CorrectionSource, statusVersion })
  .meta({ id: "EntryClarificationInstructionRequest" });
export type EntryClarificationInstructionRequest = z.infer<
  typeof EntryClarificationInstructionRequest
>;

/** What the recorded clarification has so far (the row's state, no values). */
export type EntryClarificationRecord = {
  pending: boolean;
  escalated: boolean;
  instructed: boolean;
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
  /** The reconciliation (D15) is possible: every fact held on the TG start. */
  reconciliation: boolean;
  /** A new start date with its amendment: the latest entry date still allows one. */
  newStartDate: boolean;
  /** The PL documents what is pending: until the case is escalated. */
  recordPending: boolean;
  /** The PL escalates a documented case, once. */
  escalate: boolean;
  /** The region's manager records the instruction, once, after the escalation. */
  instruct: boolean;
};

/**
 * Which legitimate path is open now (D12): each only when its guard passes. The amendment and
 * the dates rules of a new start are checked by the dates operation itself; here only the latest
 * entry date and today's run bound it. The recorded case stays open after an instruction.
 */
export function entryClarificationActions(
  input: EntryClarificationInput,
): EntryClarificationActions {
  const openedOn = entryClarificationOpenedOn(input);
  if (openedOn === null || input.tgStart === null) {
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
  const { clarification: row, latestEntryDate, today } = input;
  const earliest = input.entryRunCompletedToday ? addDays(today, 1) : today;
  return {
    open: true,
    openedOn,
    reconciliation: heldOnTgStart(input.facts, input.tgStart),
    newStartDate: latestEntryDate !== null && earliest <= latestEntryDate,
    recordPending: !row?.escalated,
    escalate: row?.pending === true && !row.escalated,
    instruct: row?.escalated === true && !row.instructed,
  };
}

/** A recorded clarification as the PL and the manager read it (the source is `case_internal`). */
export const EntryClarificationView = z
  .strictObject({
    id: z.uuid(),
    openedOn: isoDate,
    pending: z
      .strictObject({ code: EntryPendingCode, source: z.string(), recordedOn: isoDate })
      .nullable(),
    escalatedOn: isoDate.nullable(),
    instruction: z
      .strictObject({ code: EntryInstructionCode, source: z.string(), recordedOn: isoDate })
      .nullable(),
  })
  .meta({ id: "EntryClarificationView" });
export type EntryClarificationView = z.infer<typeof EntryClarificationView>;

/** `GET /participations/{id}/entry-clarification`. */
export const EntryClarificationState = z
  .strictObject({
    participationId: z.uuid(),
    statusVersion,
    /** Null until the PL documents something; the case item exists without it. */
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
 * An escalated clarification in "Freigaben": the project, the dates and the code; no name and no
 * participation id (the instruction names the clarification).
 */
export const EntryClarificationReviewItem = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    projectName: z.string(),
    tgStart: isoDate,
    openedOn: isoDate,
    escalatedOn: isoDate,
    pendingCode: EntryPendingCode,
    /** The PL's documented source line (`case_internal`), shown to the manager only. */
    pendingSource: z.string(),
    /** The participation's status version the instruction is recorded against. */
    statusVersion,
    capabilities: z.strictObject({ instruct: z.boolean() }),
  })
  .meta({ id: "EntryClarificationReviewItem" });
export type EntryClarificationReviewItem = z.infer<typeof EntryClarificationReviewItem>;
