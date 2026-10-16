import type { IsoDate } from "../iso-date";

/** Every guard (plan 5.3). None is overridable (Q71); there is no override parameter. */
export const guardIds = [
  "dsv_fully_executed",
  "asu_registered_with_proof",
  "profiling_done_or_approved_exception",
  "tg_start_date",
  "ta_completion",
  "withdrawal_after_dsv_signed",
  "before_cutoff",
  "entry_wave_assigned",
  "offer_deadline_valid",
  "tl407_signed",
  "dsv_generated",
  "dsv_scan_received",
] as const;
export type GuardId = (typeof guardIds)[number];

/** A fact with the date it became valid and the instant it was recorded (rounds 8–9). */
export type DatedFact = { validOn: IsoDate; recordedAt: Date };

/**
 * The dated facts guards check. An absent fact is false (D4): in Slice 1 the document facts
 * aren't recorded yet, so their guards fail closed.
 */
export type GuardFacts = {
  /** All three signatures; `validOn` is the last of them (§623 BGB, Q21). */
  dsvFullyExecuted?: DatedFact;
  /** A registration with proof, any channel (Q55). */
  asuRegisteredWithProof?: DatedFact;
  /** `validOn` is `profilingDoneOn`. */
  profilingDone?: DatedFact;
  /** Only while the exception is `approved`; `validOn` is the approval date (Q80). */
  profilingExceptionApproved?: DatedFact;
  /** Signed by participant and profiler. */
  tl407Signed?: DatedFact;
  dsvGenerated?: DatedFact;
  /** Scan stored and receiver recorded (PRD F8). */
  dsvScanReceived?: DatedFact;
  /** Cancellation signed by all three parties (verify Q46). */
  dsvCancellation?: DatedFact;
  /** Assigned required §110 activities completed or closed, evidence present (Q73, Q83). */
  taMeasuresComplete?: DatedFact;
};

/** Valid on or before `date`. A fact never counts for a day before it became valid. */
export function validBy(fact: DatedFact | undefined, date: IsoDate | null): fact is DatedFact {
  return fact !== undefined && date !== null && fact.validOn <= date;
}

export function recordedBy(fact: DatedFact, instant: Date): boolean {
  return fact.recordedAt.getTime() <= instant.getTime();
}
