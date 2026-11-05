import { z } from "zod";
import { mayPerformOperation, type PermissionTarget } from "../access/permissions";
import type { Subject } from "../access/decide";
import type { EvidenceCorrectionTarget } from "../access/corrections";
import { DocumentType } from "../documents/catalog";
import { isoDate } from "../iso-date";
import { BaReportingKind } from "../projects/participation-dates";

// Approved append-only corrections of wrong evidence (data-protection.md, evidence corrections;
// Q183, Q186, Q190; readings Q209). The PL requests one with a reason code and a documented
// source, the regional operations manager of the project's region approves or rejects it, never
// the requester (four eyes). An approval invalidates a document (a wrong person's file is
// purged), supersedes an ASU registration with a corrected date or invalidates it, or supersedes
// a BA reporting outcome with a linked replacement task. The original stays, linked; nothing
// reverses a status, a guard, eligibility, a contractual date or a payment on its own.

/** Why the evidence is wrong, as documented (data-protection.md, evidence corrections). */
export const CorrectionReason = z
  .enum([
    "ba_legal_reference",
    "data_subject_rectification",
    "corrected_source_document",
    "documented_internal_error",
  ])
  .meta({ id: "CorrectionReason" });
export type CorrectionReason = z.infer<typeof CorrectionReason>;

/** What a correction targets in this slice. */
export const CorrectionTargetKind = z
  .enum(["document", "asu_registration", "ba_reporting_task"])
  .meta({ id: "CorrectionTargetKind" });
export type CorrectionTargetKind = z.infer<typeof CorrectionTargetKind>;

/** What an approval does to its target. */
export const CorrectionAction = z
  .enum(["invalidate", "supersede"])
  .meta({ id: "CorrectionAction" });
export type CorrectionAction = z.infer<typeof CorrectionAction>;

export const CorrectionStatus = z
  .enum(["requested", "approved", "rejected"])
  .meta({ id: "CorrectionStatus" });
export type CorrectionStatus = z.infer<typeof CorrectionStatus>;

/** The longest documented source (one line). */
export const correctionSourceMaxLength = 200;

/**
 * The documented source as stored: NFC, inner runs of white space as one space, trimmed; null for
 * a control character or nothing left. The function normalises the same way (Q209 (2)).
 */
export function normaliseCorrectionSource(source: string): string | null {
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(source.replace(/[\t ]/g, " "))) return null;
  const value = source.normalize("NFC").replace(/\s+/g, " ").trim();
  return value.length === 0 ? null : value;
}

/** Where the correction is documented: a reference, never a name or health detail. */
export const CorrectionSource = z
  .string()
  .max(correctionSourceMaxLength)
  .refine((value) => normaliseCorrectionSource(value) !== null, { message: "source_invalid" });

const base = { reason: CorrectionReason, source: CorrectionSource };

/**
 * `POST /participations/{id}/evidence-corrections`: the target the PL reviewed, by its id, what
 * the approval would do and the corrected fact where there is one. Nothing has a default: the PL
 * chooses each value (`wrongPerson` too).
 */
export const EvidenceCorrectionRequestInput = z
  .discriminatedUnion("correction", [
    z.strictObject({
      correction: z.literal("invalidate_document"),
      documentId: z.uuid(),
      /** A wrong person's file: purged once approved, the tombstone and history kept. */
      wrongPerson: z.boolean(),
      ...base,
    }),
    z.strictObject({
      correction: z.literal("invalidate_asu_registration"),
      registrationId: z.uuid(),
      ...base,
    }),
    z.strictObject({
      correction: z.literal("supersede_asu_registration"),
      registrationId: z.uuid(),
      /** The corrected actual registration date. */
      registeredOn: isoDate,
      ...base,
    }),
    z.strictObject({
      correction: z.literal("supersede_ba_report"),
      taskId: z.uuid(),
      ...base,
    }),
  ])
  .meta({ id: "EvidenceCorrectionRequestInput" });
export type EvidenceCorrectionRequestInput = z.infer<typeof EvidenceCorrectionRequestInput>;
export type EvidenceCorrectionKind = EvidenceCorrectionRequestInput["correction"];

export const EvidenceCorrectionRequested = z
  .strictObject({ correctionId: z.uuid() })
  .meta({ id: "EvidenceCorrectionRequested" });

/**
 * `POST /evidence-corrections/{id}/decision`: the decision on the request "Freigaben" showed; one
 * decided meanwhile is `409 source_changed`, never another request of the same target.
 */
export const EvidenceCorrectionDecisionInput = z
  .strictObject({ decision: z.enum(["approve", "reject"]) })
  .meta({ id: "EvidenceCorrectionDecisionInput" });

/** The target kind and action of a requested correction. */
export function correctionShape(kind: EvidenceCorrectionKind): {
  targetKind: CorrectionTargetKind;
  action: CorrectionAction;
} {
  switch (kind) {
    case "invalidate_document":
      return { targetKind: "document", action: "invalidate" };
    case "invalidate_asu_registration":
      return { targetKind: "asu_registration", action: "invalidate" };
    case "supersede_asu_registration":
      return { targetKind: "asu_registration", action: "supersede" };
    case "supersede_ba_report":
      return { targetKind: "ba_reporting_task", action: "supersede" };
  }
}

/**
 * One correction in "Freigaben": its target's kind and category (the document type or the
 * report's kind), the action, the reason, the source and the dates; never a value the approver
 * couldn't otherwise read (no corrected date, no file, no name).
 */
export const CorrectionReviewItem = z.object({
  correctionId: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  targetKind: CorrectionTargetKind,
  action: CorrectionAction,
  documentType: DocumentType.nullable(),
  reportingKind: BaReportingKind.nullable(),
  wrongPerson: z.boolean().nullable(),
  reason: CorrectionReason,
  source: z.string(),
  requestedOn: isoDate,
  /** The Berlin day the target was recorded (accepted, registered or closed). */
  targetRecordedOn: isoDate,
  capabilities: z.object({ decide: z.boolean() }),
});
export type CorrectionReviewItem = z.infer<typeof CorrectionReviewItem>;

/** A target's correction state as its view shows it. */
export const CorrectionState = z
  .object({
    /** A request awaits its decision: no second one, and a quarantine isn't lifted. */
    pending: z.boolean(),
    /** "Korrektur beantragen": the viewer may request one now. */
    mayRequest: z.boolean(),
  })
  .meta({ id: "CorrectionState" });
export type CorrectionState = z.infer<typeof CorrectionState>;

/**
 * Whether the viewer may request a correction of the target (the authority table, separate from
 * any read right); the target's state follows (`correctionRequestable`).
 */
export function mayRequestCorrection(
  subject: Subject,
  target: EvidenceCorrectionTarget,
  permissionTarget: PermissionTarget,
): boolean {
  return mayPerformOperation(
    subject,
    { kind: "requestEvidenceCorrection", target },
    permissionTarget,
  ).ok;
}

/** Whether the viewer may decide a request: the regional operations manager, not the requester. */
export function mayDecideCorrection(
  subject: Subject,
  requestedBy: string,
  permissionTarget: PermissionTarget,
): boolean {
  return mayPerformOperation(
    subject,
    { kind: "approveEvidenceCorrection", requestedBy },
    permissionTarget,
  ).ok;
}

/**
 * Whether the target's state admits a request: an accepted document not yet invalidated, a
 * current ASU registration, a closed BA reporting task not yet superseded; none while one is
 * pending. The function checks the same under the lock.
 */
export function correctionRequestable(
  target:
    | { kind: "document"; reviewState: string; invalidated: boolean }
    | { kind: "asu_registration"; current: boolean }
    | { kind: "ba_reporting_task"; status: string; superseded: boolean },
  pending: boolean,
): boolean {
  if (pending) return false;
  switch (target.kind) {
    case "document":
      return target.reviewState === "accepted" && !target.invalidated;
    case "asu_registration":
      return target.current;
    case "ba_reporting_task":
      return target.status !== "pending" && !target.superseded;
  }
}
