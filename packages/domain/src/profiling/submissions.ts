import { z } from "zod";
import { AgenturSubmissionChannel } from "../asu/batches-api";
import { addDays, daysBetween, laterIsoDate } from "../dates";
import { FormVersion } from "../forms/field-map";
import { isoDate, type IsoDate } from "../iso-date";
import { terminalMainStatuses, type MainStatus } from "../lifecycle/enums";
import { validBy } from "../lifecycle/guards";
import type { ParticipationSnapshot } from "../lifecycle/planner";
import { effectiveTgStart } from "../lifecycle/waves";
import type { ProjectType } from "../project";
import { AgenturKey, type RegionalSettings } from "../projects/agentur-settings";

// The TL 407's submission to the Agentur (process-and-lifecycle.md, TL 407 submission; Q54, Q92,
// Q188, Q189): every attempt is kept; an Agentur's rejection reopens the work until a new
// submission and never touches the signatures or the completed profiling. Pure: the database
// function checks the same rules again under the participation's lock.

/** Q54: still not submitted this many days after the TG start escalates (base defaults). */
export const tl407EscalationDaysAfterTgStart = 14;

/** A batch's registration without the Agentur's confirmation this many days later (base defaults). */
export const kug200bConfirmationFollowUpDays = 14;

/** Why the Agentur rejected a submitted TL 407 (Q189). */
export const AgenturRejectionReason = z
  .enum(["outdated_form_version", "incomplete", "other"])
  .meta({ id: "AgenturRejectionReason" });
export type AgenturRejectionReason = z.infer<typeof AgenturRejectionReason>;

/**
 * A placement Agentur's TL 407 submission settings, resolved (regional-variation.md, blockers): the
 * channel, whether the paper original is needed and the lead time; `null` while any of the four
 * settings is unset (the `agentur_submission` blocker, Q92: the app never guesses).
 */
export type Tl407SubmissionSettings = {
  channel: z.infer<typeof AgenturSubmissionChannel>;
  originalRequired: boolean;
  leadTimeDays: number;
  rejectsOutdatedFormVersions: boolean;
};

/** The resolved `agentur_submission` settings, or null while one of the four is unset. */
export function tl407SubmissionSettings(
  settings: RegionalSettings,
): Tl407SubmissionSettings | null {
  const s = settings.agentur_submission;
  if (
    s?.submissionChannel === undefined ||
    s.originalRequired === undefined ||
    s.leadTimeDays === undefined ||
    s.rejectsOutdatedFormVersions === undefined
  ) {
    return null;
  }
  return {
    channel: s.submissionChannel,
    originalRequired: s.originalRequired,
    leadTimeDays: s.leadTimeDays,
    rejectsOutdatedFormVersions: s.rejectsOutdatedFormVersions,
  };
}

/** One TL 407 attempt as recorded (`agentur_submission`), newest first where listed. */
export type Tl407Attempt = {
  submittedOn: IsoDate;
  channel: z.infer<typeof AgenturSubmissionChannel>;
  /** The resolved `originalRequired` when it was submitted. */
  originalRequired: boolean;
  originalSentOn: IsoDate | null;
  rejectedOn: IsoDate | null;
};

/** The paper original goes with a `paper_original` submission; otherwise it is sent on its own. */
export const originalOutstanding = (a: Tl407Attempt) =>
  a.originalRequired && a.channel !== "paper_original" && a.originalSentOn === null;

/** A submission stands until the Agentur rejects it. */
export const liveAttempt = (attempts: readonly Tl407Attempt[]) =>
  attempts.find((a) => a.rejectedOn === null) ?? null;

export const Tl407SubmissionProblem = z
  .enum([
    "participation_closed",
    "placement_agentur_missing",
    "submission_settings_missing",
    "scan_unusable",
    "already_submitted",
    "form_version_outdated",
    "submitted_on_in_future",
    "submitted_before_signature",
    "submitted_before_rejection",
  ])
  .meta({ id: "Tl407SubmissionProblem" });
export type Tl407SubmissionProblem = z.infer<typeof Tl407SubmissionProblem>;

export type Tl407SubmissionFacts = {
  status: MainStatus;
  placementAgenturKey: string | null;
  /** The placement Agentur's settings as resolved now; null: the blocker. */
  settings: Tl407SubmissionSettings | null;
  /**
   * The scan to submit: usable (accepted, live, neither quarantined nor invalidated) with its
   * version and later signature date; null without one.
   */
  scan: { formVersion: string; signedOn: IsoDate } | null;
  /** Whether the scan's version has expired in the registry today. */
  versionExpired: boolean;
  /** Every TL 407 attempt, newest first. */
  attempts: readonly Tl407Attempt[];
};

/**
 * Whether the PL may record a TL 407 submission (D26), the first problem in the database
 * function's order: an open participation, a placement Agentur with all four settings, a usable
 * scan, no standing submission, a version the Agentur doesn't reject as outdated (only where its
 * `rejectsOutdatedFormVersions` is `true`, Q188); with a date, that date from the signature (and
 * after the last rejection) to today. Without a date, the state alone (the capability).
 */
export function tl407SubmissionProblem(
  facts: Tl407SubmissionFacts,
  submittedOn: IsoDate | null,
  today: IsoDate,
): Tl407SubmissionProblem | null {
  if (terminalMainStatuses.has(facts.status)) return "participation_closed";
  if (facts.placementAgenturKey === null) return "placement_agentur_missing";
  if (facts.settings === null) return "submission_settings_missing";
  if (facts.scan === null) return "scan_unusable";
  if (liveAttempt(facts.attempts)) return "already_submitted";
  if (facts.settings.rejectsOutdatedFormVersions && facts.versionExpired) {
    return "form_version_outdated";
  }
  if (submittedOn === null) return null;
  if (submittedOn > today) return "submitted_on_in_future";
  if (submittedOn < facts.scan.signedOn) return "submitted_before_signature";
  const rejected = facts.attempts[0]?.rejectedOn;
  if (rejected && submittedOn < rejected) return "submitted_before_rejection";
  return null;
}

/** An attempt with what identifies its paper and destination. */
export type Tl407AttemptRef = Tl407Attempt & { id: string; documentId: string; agenturKey: string };

/**
 * The earlier dispatched original the same Agentur may still hold for a standing attempt
 * (Q206 (4)): of the newest earlier attempt of the same scan and Agentur that was rejected after
 * its original went out. The PL confirms it; it is never assumed. `attempts` newest first.
 */
export function retainableOriginal(
  attempt: Tl407AttemptRef,
  attempts: readonly Tl407AttemptRef[],
): { submissionId: string; originalSentOn: IsoDate } | null {
  if (attempt.rejectedOn !== null || !originalOutstanding(attempt)) return null;
  const earlier = attempts.slice(attempts.findIndex((a) => a.id === attempt.id) + 1);
  const held = earlier.find(
    (a) =>
      a.documentId === attempt.documentId &&
      a.agenturKey === attempt.agenturKey &&
      a.rejectedOn !== null &&
      a.originalSentOn !== null,
  );
  return held ? { submissionId: held.id, originalSentOn: held.originalSentOn! } : null;
}

export type FollowUpProblem =
  | "original_not_required"
  | "original_recorded"
  | "already_rejected"
  | "date_in_future"
  | "date_before_submission";

/** "Original versandt am": once, where the original is outstanding, from the submission to today. */
export function originalSentProblem(
  attempt: Tl407Attempt,
  sentOn: IsoDate,
  today: IsoDate,
): FollowUpProblem | null {
  if (!attempt.originalRequired || attempt.channel === "paper_original") {
    return "original_not_required";
  }
  if (attempt.originalSentOn !== null) return "original_recorded";
  return datesProblem(attempt, sentOn, today);
}

/** "Von der Agentur abgelehnt": once per attempt, from the submission to today. */
export function rejectionProblem(
  attempt: Tl407Attempt,
  rejectedOn: IsoDate,
  today: IsoDate,
): FollowUpProblem | null {
  if (attempt.rejectedOn !== null) return "already_rejected";
  return datesProblem(attempt, rejectedOn, today);
}

function datesProblem(attempt: Tl407Attempt, on: IsoDate, today: IsoDate): FollowUpProblem | null {
  if (on > today) return "date_in_future";
  if (on < attempt.submittedOn) return "date_before_submission";
  return null;
}

/**
 * The deadline `tl407_submission` (D27): in `ta_tg`, while `informed` or `active_in_tg` and no
 * TL 407 submission stands, the effective TG start minus the placement Agentur's `leadTimeDays`
 * (the TG start while unresolved); under an approved exception the day profiling was done, none
 * before (the exception's own deadline applies until the catch-up).
 */
export function tl407SubmissionDeadline(
  s: ParticipationSnapshot,
  projectType: ProjectType,
  agentur: Tl407WorkFacts,
  today: IsoDate,
): IsoDate | null {
  const { status } = s.current;
  if (projectType !== "ta_tg" || (status !== "informed" && status !== "active_in_tg")) return null;
  if (liveAttempt(agentur.attempts)) return null;
  if (validBy(s.facts.profilingExceptionApproved, today)) {
    return s.facts.profilingDone?.validOn ?? null;
  }
  const start = effectiveTgStart(s.participation, s.wave);
  if (start === null) return null;
  return agentur.leadTimeDays === null ? start : addDays(start, -agentur.leadTimeDays);
}

/**
 * The start of the TL 407's current escalation episode, while it is escalated (Q189, Q206 (8)):
 * the trigger is TG start + 14 with no submission standing, whatever the exception; an episode
 * starts there or, when a rejection reopened the work later, on the rejection's day, so its age
 * never counts the time a submission stood. Null while not escalated.
 */
export function tl407EscalationDate(
  s: ParticipationSnapshot,
  projectType: ProjectType,
  attempts: readonly Tl407Attempt[],
  today: IsoDate,
): IsoDate | null {
  const { status } = s.current;
  if (projectType !== "ta_tg" || (status !== "informed" && status !== "active_in_tg")) return null;
  if (liveAttempt(attempts)) return null;
  const start = effectiveTgStart(s.participation, s.wave);
  if (start === null) return null;
  const trigger = addDays(start, tl407EscalationDaysAfterTgStart);
  if (daysBetween(trigger, today) < 0) return null;
  // Attempts are newest first; with none standing, the newest is the last rejected one.
  const rejectedOn = attempts[0]?.rejectedOn ?? null;
  return rejectedOn === null ? trigger : laterIsoDate(trigger, rejectedOn);
}

/** What the Agentur items read of one participation. */
export type Tl407WorkFacts = {
  /** Every TL 407 attempt, newest first. */
  attempts: readonly Tl407Attempt[];
  /** The placement Agentur's resolved `leadTimeDays`; null while unresolved. */
  leadTimeDays: number | null;
  /** A batch's ASU registration (`kug200b_submission`): its date and the Agentur's confirmation. */
  kug200bRegistration: { registeredOn: IsoDate; confirmedOn: IsoDate | null } | null;
  /**
   * The Berlin day the oldest pending BA reporting task was created (process-and-lifecycle.md, BA
   * reporting); null without one, or for a viewer who doesn't read the tasks.
   */
  baReportPendingSince: IsoDate | null;
};

export const AgenturItemKind = z
  .enum([
    "tl407_escalated",
    "tl407_resubmission_open",
    "tl407_original_missing",
    "kug200b_confirmation_missing",
    "ba_report_pending",
  ])
  .meta({ id: "AgenturItemKind" });
export type AgenturItemKind = z.infer<typeof AgenturItemKind>;

/**
 * Staff work with the Agentur (process-and-lifecycle.md, TL 407 submission), in urgency order:
 * `tl407_escalated` from its escalation date; `tl407_resubmission_open` from the rejection;
 * `tl407_original_missing` from the submission; `kug200b_confirmation_missing` with the batch's
 * sent date, from `kug200bConfirmationFollowUpDays` after it; `ba_report_pending` from the oldest
 * pending reporting task's day, with no due date (D28).
 */
export const AgenturItem = z
  .strictObject({ kind: AgenturItemKind, date: isoDate })
  .meta({ id: "AgenturItem" });
export type AgenturItem = z.infer<typeof AgenturItem>;

/**
 * A participation's Agentur items. A terminal participation keeps the follow-ups of what was sent
 * (the original, the confirmation) and its pending BA reports (an early exit's is created at the
 * exit), never the submission work.
 */
export function agenturItems(
  s: ParticipationSnapshot,
  projectType: ProjectType,
  facts: Tl407WorkFacts,
  today: IsoDate,
): AgenturItem[] {
  const items: AgenturItem[] = [];
  const closed = terminalMainStatuses.has(s.current.status);
  const escalated = tl407EscalationDate(s, projectType, facts.attempts, today);
  if (escalated) items.push({ kind: "tl407_escalated", date: escalated });
  const [latest] = facts.attempts;
  if (latest?.rejectedOn && !closed) {
    items.push({ kind: "tl407_resubmission_open", date: latest.rejectedOn });
  }
  const live = liveAttempt(facts.attempts);
  if (live && originalOutstanding(live)) {
    items.push({ kind: "tl407_original_missing", date: live.submittedOn });
  }
  const registration = facts.kug200bRegistration;
  if (
    projectType === "ta_tg" &&
    registration &&
    registration.confirmedOn === null &&
    daysBetween(registration.registeredOn, today) >= kug200bConfirmationFollowUpDays
  ) {
    items.push({ kind: "kug200b_confirmation_missing", date: registration.registeredOn });
  }
  if (facts.baReportPendingSince !== null) {
    items.push({ kind: "ba_report_pending", date: facts.baReportPendingSince });
  }
  return items;
}

/** One attempt as the tab "Profiling" shows it, with what the PL may record now. */
export const Tl407SubmissionView = z
  .strictObject({
    id: z.uuid(),
    documentId: z.uuid(),
    formVersion: FormVersion,
    agenturKey: z.string(),
    channel: AgenturSubmissionChannel,
    submittedOn: isoDate,
    originalRequired: z.boolean(),
    originalSentOn: isoDate.nullable(),
    /** The earlier attempt whose original the Agentur still holds, when the PL confirmed it. */
    originalRetainedFrom: z.uuid().nullable(),
    /**
     * The earlier dispatch the PL may confirm the Agentur still holds ("Original liegt der
     * Agentur vor"; Q206 (4)); null when there is none or the viewer can't record it.
     */
    retainableOriginal: z
      .strictObject({ submissionId: z.uuid(), originalSentOn: isoDate })
      .nullable(),
    rejection: z.strictObject({ rejectedOn: isoDate, reason: AgenturRejectionReason }).nullable(),
    recordedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    capabilities: z.strictObject({ recordOriginal: z.boolean(), recordRejection: z.boolean() }),
  })
  .meta({ id: "Tl407Submission" });
export type Tl407SubmissionView = z.infer<typeof Tl407SubmissionView>;

/**
 * The TL 407's submission on the tab "Profiling" (the PL and the assigned consultant read it; the
 * PL records): the attempts newest first and, for the PL, what a new submission would record now
 * (the usable scan, the placement Agentur and its resolved channel) or why it can't.
 */
export const Tl407SubmissionState = z
  .strictObject({
    attempts: z.array(Tl407SubmissionView),
    /** The next submission as it would be recorded; null for a viewer who can't submit. */
    next: z
      .strictObject({
        documentId: z.uuid().nullable(),
        formVersion: FormVersion.nullable(),
        agenturKey: z.string().nullable(),
        channel: AgenturSubmissionChannel.nullable(),
        originalRequired: z.boolean().nullable(),
        problem: Tl407SubmissionProblem.nullable(),
      })
      .nullable(),
  })
  .meta({ id: "Tl407SubmissionState" });
export type Tl407SubmissionState = z.infer<typeof Tl407SubmissionState>;

/**
 * `POST /participations/{id}/tl407-submissions` (the PL): the scan, the destination (the placement
 * Agentur), the channel and original rule the PL saw, and the actual sent date; anything changed
 * since is `source_changed`.
 */
export const Tl407SubmissionInput = z
  .strictObject({
    documentId: z.uuid(),
    agenturKey: AgenturKey,
    channel: AgenturSubmissionChannel,
    originalRequired: z.boolean(),
    submittedOn: isoDate,
  })
  .meta({ id: "Tl407SubmissionInput" });
export type Tl407SubmissionInput = z.infer<typeof Tl407SubmissionInput>;

/** The answer to a recorded submission: the attempt's id. */
export const Tl407SubmissionCreated = z
  .strictObject({ submissionId: z.uuid() })
  .meta({ id: "Tl407SubmissionCreated" });

/** `POST /agentur-submissions/{id}/original`: "Original versandt am". */
export const OriginalSentInput = z
  .strictObject({ originalSentOn: isoDate })
  .meta({ id: "OriginalSentInput" });

/**
 * `POST /agentur-submissions/{id}/original-retained`: the earlier attempt whose dispatched original
 * the same Agentur still holds (Q206 (4)).
 */
export const OriginalRetainedInput = z
  .strictObject({ retainedFrom: z.uuid() })
  .meta({ id: "OriginalRetainedInput" });

/** `POST /agentur-submissions/{id}/rejection`: "Von der Agentur abgelehnt" with the date and reason. */
export const AgenturRejectionInput = z
  .strictObject({ rejectedOn: isoDate, reason: AgenturRejectionReason })
  .meta({ id: "AgenturRejectionInput" });
