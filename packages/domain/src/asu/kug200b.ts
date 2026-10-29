import type { IsoDate } from "../iso-date";
import type { FieldMap } from "../forms/field-map";
import type { FormInput } from "../forms/input";
import { layoutForm, type FormLayout, type TextMeasure } from "../forms/layout";
import { tl407Label } from "../forms/tl407";
import { validateFormInput, type FormErrorCode, type FormIssue } from "../forms/validate";
import { terminalMainStatuses, type MainStatus } from "../lifecycle/enums";
import type { ProjectType } from "../project";
import type { AsuChannel } from "../projects/agentur-settings";

// The Kug 200b offer (process-and-lifecycle.md, Arbeitsuchendmeldung: the Kug 200b offer; Q185):
// separate from the ASU proof. Offered once a Kug 200b was generated or an external paper was
// received; its outcome `signed` (an accepted, usable scan) or `declined`; a written withdrawal of
// declaration 17 that reaches the TG opens the BA notice. Neither a decline nor a withdrawal
// touches a registration. Pure; no I/O, no system time.

export type Kug200bOfferOutcome = "signed" | "declined";

export type Kug200bOfferFacts = {
  projectType: ProjectType;
  status: MainStatus;
  channel: AsuChannel | null;
  /** The Berlin date of the first generation or of the first external paper received; null: none. */
  offeredOn: IsoDate | null;
  /** A usable accepted scan: accepted, live, not quarantined, not invalidated. */
  signed: boolean;
  declinedOn: IsoDate | null;
  /** The withdrawals received, each with its "BA informiert am" once recorded. */
  withdrawals: readonly { receivedOn: IsoDate; baNotifiedOn: IsoDate | null }[];
};

/** The offer's outcome: signed wins over an earlier decline (the participant may still sign). */
export function kug200bOfferOutcome(
  facts: Pick<Kug200bOfferFacts, "signed" | "declinedOn">,
): Kug200bOfferOutcome | null {
  if (facts.signed) return "signed";
  return facts.declinedOn === null ? null : "declined";
}

export type Kug200bItem =
  | { kind: "kug200b_offer_open"; date: IsoDate }
  | { kind: "kug200b_withdrawal_ba_notice"; date: IsoDate };

/**
 * The offer's work-list items (process-and-lifecycle.md, deadline warnings), in `ta_tg` only:
 * `kug200b_offer_open` (the offer's date) while an open participation's offer has no outcome and
 * its route isn't `kug_200b` (there the step's rule names the missing scan), never a guard; and
 * `kug200b_withdrawal_ba_notice` (the earliest withdrawal received) until "BA informiert am" is
 * recorded, also after the participation's end: the BA must still be told.
 */
export function kug200bItems(facts: Kug200bOfferFacts): Kug200bItem[] {
  if (facts.projectType !== "ta_tg") return [];
  const items: Kug200bItem[] = [];
  if (
    facts.offeredOn !== null &&
    kug200bOfferOutcome(facts) === null &&
    facts.channel !== "kug_200b" &&
    !terminalMainStatuses.has(facts.status)
  ) {
    items.push({ kind: "kug200b_offer_open", date: facts.offeredOn });
  }
  const pending = facts.withdrawals
    .filter((withdrawal) => withdrawal.baNotifiedOn === null)
    .map((withdrawal) => withdrawal.receivedOn)
    .toSorted()[0];
  if (pending !== undefined) items.push({ kind: "kug200b_withdrawal_ba_notice", date: pending });
  return items;
}

export type Kug200bDateProblem =
  | "declined_on_in_future"
  | "received_on_in_future"
  | "received_before_consent"
  | "notified_on_in_future"
  | "notified_before_receipt";

/** A decline's date: not after today. */
export function kug200bDeclineProblem(
  declinedOn: IsoDate,
  today: IsoDate,
): Kug200bDateProblem | null {
  return declinedOn > today ? "declined_on_in_future" : null;
}

/** A withdrawal's date of receipt: not after today, not before the declaration was given. */
export function kug200bWithdrawalProblem(
  receivedOn: IsoDate,
  givenOn: IsoDate,
  today: IsoDate,
): Kug200bDateProblem | null {
  if (receivedOn > today) return "received_on_in_future";
  return receivedOn < givenOn ? "received_before_consent" : null;
}

/** "BA informiert am": not after today, not before the withdrawal was received. */
export function kug200bBaNoticeProblem(
  notifiedOn: IsoDate,
  receivedOn: IsoDate,
  today: IsoDate,
): Kug200bDateProblem | null {
  if (notifiedOn > today) return "notified_on_in_future";
  return notifiedOn < receivedOn ? "notified_before_receipt" : null;
}

/**
 * The handwriting and clarification checklist (Q197 (8)): every applicable `*` field left blank
 * (`required_blank`) and every text too long for its box at the minimum size
 * (`text_not_fitting`), each by key with its label as the form prints it; nothing disappears
 * silently. The participant writes them by hand; the review checks the completed paper.
 */
export type Kug200bChecklistItem = {
  code: "required_blank" | "text_not_fitting";
  key: string;
  label: string;
};

/** The check of one Kug 200b: errors refuse it; else its layout and checklist. */
export type Kug200bCheck =
  | { ok: false; errors: FormIssue<FormErrorCode>[] }
  | { ok: true; layout: FormLayout; checklist: Kug200bChecklistItem[] };

/**
 * A Kug 200b input checked against its map (ba-forms.md, validation before rendering): an error
 * (`character_unsupported`, `identifier_too_long`, …) refuses generation; blanks and texts that
 * don't fit are left for handwriting and listed. A Kug 200b has no plausibility warnings.
 */
export function checkKug200b(
  input: FormInput,
  map: FieldMap,
  today: IsoDate,
  measure: TextMeasure,
): Kug200bCheck {
  if (map.formCode !== "kug200b") throw new RangeError("Not a Kug 200b field map");
  const validation = validateFormInput(input, map, today);
  if (validation.errors.length > 0) return { ok: false, errors: validation.errors };
  const layout = layoutForm(input, map, measure);
  const checklist = [...validation.blanks, ...layout.notFitting].map(({ code, key }) => ({
    code,
    key,
    label: tl407Label(map, key),
  }));
  return { ok: true, layout, checklist };
}
