import { z } from "zod";
import { isoDate, type IsoDate } from "../iso-date";
import type { DsvStatus, MainStatus } from "../lifecycle/enums";
import type { DsvCountingScan } from "./packet";
import type { DsvSignatures } from "./scans";

// process-and-lifecycle.md, the cancellation of a signed DSV and the customer notice (Q46 verify,
// Q213 accepted provisionally): a cancellation counts only from one accepted, counting scan of the
// signed contract showing the three parties' signatures; no I/O here.

/** The cancellation as a dated fact: valid on its latest actual signature, recorded when it counted. */
export type DsvCancellationFact = { documentId: string; validOn: IsoDate; recordedAt: string };

/** All three parties' signatures on one cancellation scan, else the review refuses the acceptance. */
export function dsvCancellationReviewProblem(
  signatures: z.infer<typeof DsvSignatures>,
): "cancellation_signatures_missing" | null {
  const { participant, customer, transfergesellschaft } = signatures;
  return participant && customer && transfergesellschaft ? null : "cancellation_signatures_missing";
}

/**
 * `dsvCancellation`: the earliest recorded counting cancellation scan showing all three signatures;
 * valid on the latest actual date (the dates stay the signatures' after a quarantine's lift, which
 * only moves `recordedAt`). Two scans never add up.
 */
export function dsvCancellationFact(scans: readonly DsvCountingScan[]): DsvCancellationFact | null {
  const first = scans
    .filter(({ signatures }) => dsvCancellationReviewProblem(signatures) === null)
    .toSorted((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0];
  if (!first) return null;
  const { participant, customer, transfergesellschaft } = first.signatures;
  const validOn = [participant!, customer!, transfergesellschaft!].toSorted().at(-1)!;
  return { documentId: first.documentId, validOn, recordedAt: first.recordedAt };
}

/** The participation as the customer notice reads it. */
export type DsvCustomerNoticeState = {
  status: MainStatus;
  dsvStatus: DsvStatus;
  withdrawnOn: IsoDate | null;
  /** "Kunde informiert am", once recorded. */
  notifiedOn: IsoDate | null;
};

/**
 * "Kunde informieren" (Q46's customer flag): a participation withdrawn on a signed DSV (only a
 * cancellation allows that) until the PL records the day the customer was informed; dated by the
 * withdrawal. Null when nothing is due.
 */
export function dsvCustomerNoticeDue(state: DsvCustomerNoticeState): IsoDate | null {
  if (state.status !== "withdrawn" || state.dsvStatus !== "dsv_signed") return null;
  if (state.notifiedOn !== null || state.withdrawnOn === null) return null;
  return state.withdrawnOn;
}

export const DsvCustomerNoticeProblem = z.enum([
  "notice_not_due",
  "notice_recorded",
  "date_in_future",
  "notice_before_withdrawal",
]);
export type DsvCustomerNoticeProblem = z.infer<typeof DsvCustomerNoticeProblem>;

/** The notice's date: once, only while due, not in the future and not before the withdrawal. */
export function dsvCustomerNoticeProblem(
  state: DsvCustomerNoticeState,
  notifiedOn: IsoDate,
  today: IsoDate,
): DsvCustomerNoticeProblem | null {
  if (state.notifiedOn !== null) return "notice_recorded";
  const due = dsvCustomerNoticeDue(state);
  if (due === null) return "notice_not_due";
  if (notifiedOn > today) return "date_in_future";
  if (notifiedOn < due) return "notice_before_withdrawal";
  return null;
}

/** `POST /participations/{id}/dsv/customer-notice`: the day the customer was informed. */
export const DsvCustomerNoticeRequest = z
  .strictObject({ notifiedOn: isoDate })
  .meta({ id: "DsvCustomerNoticeRequest" });
export type DsvCustomerNoticeRequest = z.infer<typeof DsvCustomerNoticeRequest>;
