import { z } from "zod";
import { addDays, addMonths } from "../dates";
import { isoDate, type IsoDate } from "../iso-date";
import { terminalMainStatuses, type DsvStatus, type MainStatus } from "../lifecycle/enums";
import { effectiveTgEnd, effectiveTgStart, type EntryWave } from "../lifecycle/waves";
import type { ProjectType } from "../project";

// Individual TG dates (Slice 2 plan 5.7; Q102 and rounds 32–34; PR 2h-3). `tgStart` and `tgEnd`
// are the contractual dates of employment under the DSV, never the Transfer-KuG period. Pure:
// `today` and whether today's entry run completed come from the caller (the Clock, `job_run`).

/** The kind of a DSV amendment (L4): a shortening is never one, it is the exit workflow (L3). */
export const DsvAmendmentKind = z.enum(["extension", "new_start"]);
export type DsvAmendmentKind = z.infer<typeof DsvAmendmentKind>;

/** Where the signed original is kept (Q110 b: this single value until the list is set). */
export const AmendmentOriginalLocation = z.enum(["paper_personnel_file"]);
export type AmendmentOriginalLocation = z.infer<typeof AmendmentOriginalLocation>;

/** What a BA reporting task reports (round 32, B3). */
export const BaReportingKind = z.enum(["later_entry", "planned_end_changed", "early_exit"]);
export type BaReportingKind = z.infer<typeof BaReportingKind>;

/** A task's status moves forward only; 2h creates `pending`, later slices record the rest. */
export const BaReportingStatus = z.enum(["pending", "reported", "not_required"]);
export type BaReportingStatus = z.infer<typeof BaReportingStatus>;

/** An external document number, never free text (L4, R41). */
const documentReference = z.string().regex(/^[A-Za-z0-9_./-]{1,40}$/);

/** `PUT /participations/{id}/dates`: both dates (null = the wave's), the version, the amendment. */
export const ParticipationDatesInput = z
  .strictObject({
    tgStart: isoDate.nullable(),
    tgEnd: isoDate.nullable(),
    /** The `statusVersion` the PL saw (compare-and-set). */
    expectedVersion: z.int().min(0),
    /** Once the DSV is signed, every change needs one (R34). */
    amendment: z
      .strictObject({
        /** The date the last required party signed. */
        fullyExecutedOn: isoDate,
        originalLocation: AmendmentOriginalLocation,
        documentReference: documentReference.optional(),
        /** The PL's confirmations (L4): all three must be true. */
        originalInspected: z.boolean(),
        allPartiesSigned: z.boolean(),
        retrievable: z.boolean(),
      })
      .optional(),
  })
  .meta({ id: "ParticipationDatesInput" });
export type ParticipationDatesInput = z.infer<typeof ParticipationDatesInput>;

export type DatesIssueCode =
  | "not_ta_tg"
  | "wave_required"
  | "latest_entry_date_missing"
  | "participation_closed"
  | "dsv_offer_open"
  | "dates_unchanged"
  | "entered"
  | "start_missing"
  | "start_in_past"
  | "start_today_after_entry_run"
  | "start_after_latest_entry"
  | "start_before_offer_deadline"
  | "old_employment_end_unknown"
  | "ba_review_required"
  | "employment_overlap"
  | "end_missing"
  | "end_in_past"
  | "end_not_extension"
  | "end_before_start"
  | "period_exceeds_twelve_months"
  | "dsv_amendment_required"
  | "amendment_not_allowed"
  | "amendment_unconfirmed"
  | "amendment_not_executed_in_time";
export type DatesIssue = {
  code: DatesIssueCode;
  field: "tgStart" | "tgEnd" | "amendment" | null;
};

export type DatesCheckInput = {
  projectType: ProjectType;
  status: MainStatus;
  dsvStatus: DsvStatus;
  wave: EntryWave | null;
  /** The participation's own dates now (null = the wave's) and a re-offer's deadline. */
  participation: { tgStart: IsoDate | null; tgEnd: IsoDate | null; offerDeadline: IsoDate | null };
  /** The end of the former employment (the import's Austrittsdatum), if recorded. */
  oldEmploymentEndDate: IsoDate | null;
  /** The requested own dates (null = back to the wave's). */
  change: { tgStart: IsoDate | null; tgEnd: IsoDate | null };
  /** The amendment's execution date and whether the PL gave all three confirmations. */
  amendment: { fullyExecutedOn: IsoDate; confirmed: boolean } | null;
  today: IsoDate;
  entryRunCompletedToday: boolean;
};

export type DatesCheck =
  | {
      ok: true;
      effective: { tgStart: IsoDate | null; tgEnd: IsoDate | null };
      startChanged: boolean;
      endChanged: boolean;
      /** Null before the DSV is signed (R34). */
      amendmentKind: DsvAmendmentKind | null;
      /** One task per changed effective date (R38). */
      reportingKinds: BaReportingKind[];
    }
  | { ok: false; issues: DatesIssue[] };

/** Why no date may change now, before any requested value is looked at (5.7, R35). */
export const DatesPrecondition = z.enum([
  "not_ta_tg",
  "wave_required",
  "latest_entry_date_missing",
  "participation_closed",
  "dsv_offer_open",
]);
export type DatesPrecondition = z.infer<typeof DatesPrecondition>;

/** The first precondition that fails, or null; the detail page's capability uses it too. */
export function datesPrecondition(
  input: Pick<DatesCheckInput, "projectType" | "status" | "dsvStatus" | "wave">,
): DatesPrecondition | null {
  if (input.projectType !== "ta_tg") return "not_ta_tg";
  if (!input.wave) return "wave_required";
  if (!input.wave.latestEntryDate) return "latest_entry_date_missing";
  if (terminalMainStatuses.has(input.status)) return "participation_closed";
  // The paper offer carries the old dates (R35).
  if (input.dsvStatus === "dsv_offered") return "dsv_offer_open";
  return null;
}

/** A refusal of the whole change (a precondition, or nothing would change). */
const stop = (code: DatesIssueCode): DatesCheck => ({
  ok: false,
  issues: [{ code, field: null }],
});

/**
 * Checks a change of a participation's contractual dates (5.7). The preconditions stop at the
 * first that fails; then every rule of the start, the end, the period and the amendment is
 * checked and each refusal listed, so the PL sees them all at once.
 */
export function checkParticipationDates(input: DatesCheckInput): DatesCheck {
  const { today } = input;
  const failed = datesPrecondition(input);
  if (failed) return stop(failed);
  const wave = input.wave as EntryWave & { latestEntryDate: IsoDate };

  const before = {
    tgStart: effectiveTgStart(input.participation, wave),
    tgEnd: effectiveTgEnd(input.participation, wave),
  };
  const after = {
    tgStart: effectiveTgStart({ ...input.participation, ...input.change }, wave),
    tgEnd: effectiveTgEnd({ ...input.participation, ...input.change }, wave),
  };
  const startChanged = after.tgStart !== before.tgStart;
  const endChanged = after.tgEnd !== before.tgEnd;
  if (!startChanged && !endChanged) return stop("dates_unchanged");

  const issues: DatesIssue[] = [];
  const refuse = (code: DatesIssueCode, field: DatesIssue["field"]) => issues.push({ code, field });
  const signed = input.dsvStatus === "dsv_signed";

  if (startChanged) {
    const start = after.tgStart;
    if (input.status === "active_in_tg") refuse("entered", "tgStart");
    else if (start === null) refuse("start_missing", "tgStart");
    else {
      if (start < today) refuse("start_in_past", "tgStart");
      else if (start === today && input.entryRunCompletedToday) {
        refuse("start_today_after_entry_run", "tgStart");
      }
      if (start > wave.latestEntryDate) refuse("start_after_latest_entry", "tgStart");
      const deadline = input.participation.offerDeadline;
      if (deadline !== null && start < deadline) refuse("start_before_offer_deadline", "tgStart");
      // A direct transition: the former employment ends exactly the day before (L6; round 33).
      const oldEnd = input.oldEmploymentEndDate;
      if (oldEnd === null) refuse("old_employment_end_unknown", "tgStart");
      else if (oldEnd < addDays(start, -1)) refuse("ba_review_required", "tgStart");
      else if (oldEnd > addDays(start, -1)) refuse("employment_overlap", "tgStart");
    }
  }

  if (endChanged) {
    const end = after.tgEnd;
    if (end === null) refuse("end_missing", "tgEnd");
    else {
      if (end < today) refuse("end_in_past", "tgEnd");
      // Once signed, a shortening is the exit workflow, never an amendment (L3, R36).
      if (signed && before.tgEnd !== null && end <= before.tgEnd) {
        refuse("end_not_extension", "tgEnd");
      }
    }
  }

  const { tgStart: start, tgEnd: end } = after;
  if (start !== null && end !== null) {
    if (end < start) refuse("end_before_start", "tgEnd");
    else if (end > addDays(addMonths(start, 12), -1)) {
      refuse("period_exceeds_twelve_months", "tgEnd");
    }
  }

  const amendment = input.amendment;
  if (signed && !amendment) refuse("dsv_amendment_required", "amendment");
  else if (!signed && amendment) refuse("amendment_not_allowed", "amendment");
  else if (amendment) {
    if (!amendment.confirmed) refuse("amendment_unconfirmed", "amendment");
    const executed = amendment.fullyExecutedOn;
    const late =
      executed > today ||
      (startChanged && start !== null && executed >= start) ||
      (endChanged && before.tgEnd !== null && executed > before.tgEnd);
    if (late) refuse("amendment_not_executed_in_time", "amendment");
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    effective: after,
    startChanged,
    endChanged,
    amendmentKind: signed ? (startChanged ? "new_start" : "extension") : null,
    reportingKinds: [
      ...(startChanged ? (["later_entry"] as const) : []),
      ...(endChanged ? (["planned_end_changed"] as const) : []),
    ],
  };
}
