import { z } from "zod";
import { isoDate, type IsoDate } from "../iso-date";
import { EndReason, type DsvStatus, type MainStatus } from "./enums";
import type { DatedFact } from "./guards";

// process-and-lifecycle.md, manual withdrawal and the withdrawal after a signed DSV (Q46 verify,
// Q213 accepted provisionally): beside the guard `withdrawal_after_dsv_signed` (a counting
// cancellation valid today, the PL's confirmation, a user), the effective date and the day.

export const WithdrawalProblem = z.enum([
  "effective_date_before_cancellation",
  "after_planned_start",
  "tg_start_missing",
]);
export type WithdrawalProblem = z.infer<typeof WithdrawalProblem>;

/**
 * A withdrawal of a signed DSV: the effective date not before the cancellation's validity, and
 * only while today is on or before the effective TG start (after it the entry clarification
 * applies; Q220). Without a TG start it fails closed. Nothing applies to an unsigned DSV.
 */
export function withdrawalProblem(input: {
  dsvStatus: DsvStatus;
  cancellation: DatedFact | undefined;
  effectiveDate: IsoDate;
  today: IsoDate;
  tgStart: IsoDate | null;
}): WithdrawalProblem | null {
  if (input.dsvStatus !== "dsv_signed") return null;
  if (input.tgStart === null) return "tg_start_missing";
  if (input.today > input.tgStart) return "after_planned_start";
  if (input.cancellation && input.effectiveDate < input.cancellation.validOn) {
    return "effective_date_before_cancellation";
  }
  return null;
}

/** Why "Zurückziehen" is closed now: no permission, else the first rule that fails today. */
export const WithdrawRefusal = z.enum([
  "forbidden",
  "project_not_active",
  "status_not_withdrawable",
  "dsv_cancellation_missing",
  "after_planned_start",
  "tg_start_missing",
]);
export type WithdrawRefusal = z.infer<typeof WithdrawRefusal>;

const withdrawable: ReadonlySet<MainStatus> = new Set([
  "imported",
  "contacted",
  "unreachable",
  "informed",
]);

/**
 * The capability's refusal (C1: the prerequisite next to the button). The withdrawal's own date
 * rules follow at the request; the guard and the database decide again.
 */
export function withdrawRefusal(input: {
  permitted: boolean;
  projectActive: boolean;
  status: MainStatus;
  dsvStatus: DsvStatus;
  cancellation: DatedFact | undefined;
  today: IsoDate;
  tgStart: IsoDate | null;
}): WithdrawRefusal | null {
  if (!input.permitted) return "forbidden";
  if (!input.projectActive) return "project_not_active";
  if (!withdrawable.has(input.status)) return "status_not_withdrawable";
  if (input.dsvStatus !== "dsv_signed") return null;
  if (!input.cancellation || input.cancellation.validOn > input.today) {
    return "dsv_cancellation_missing";
  }
  if (input.tgStart === null) return "tg_start_missing";
  return input.today > input.tgStart ? "after_planned_start" : null;
}

/**
 * `POST /participations/{id}/withdrawal` (the PL): a `pre_tg` reason, the effective date (no
 * default, not in the future), the status version read, and for a signed DSV the confirmation.
 */
export const WithdrawalRequest = z
  .strictObject({
    endReason: EndReason,
    effectiveDate: isoDate,
    statusVersion: z.int().min(0),
    /** The PL's confirmation; required when the DSV is signed (a cancellation). */
    confirmed: z.boolean().optional(),
  })
  .meta({ id: "WithdrawalRequest" });
export type WithdrawalRequest = z.infer<typeof WithdrawalRequest>;

/** `PUT /participations/{id}/end-reason` (Q72): against the reason read. */
export const EndReasonCorrectionRequest = z
  .strictObject({
    endReason: EndReason,
    /** The primary reason the PL saw (`409 stale_value`). */
    expected: EndReason,
    /** The PL confirms their earlier reason still applies (it then becomes secondary). */
    previousStillApplies: z.boolean().optional(),
  })
  .meta({ id: "EndReasonCorrectionRequest" });
export type EndReasonCorrectionRequest = z.infer<typeof EndReasonCorrectionRequest>;
