import { z } from "zod";
import { LegalHoldReviewItem } from "../retention/holds";
import { CorrectionReviewItem } from "../corrections/model";
import { EntryClarificationReviewItem } from "../dsv/clarification";
import { ReconciliationReviewItem } from "../dsv/reconciliation";
import type { Subject } from "../access/decide";
import { isoDate, type IsoDate } from "../iso-date";
import { ProfilingExceptionReason, ProfilingExceptionStatus } from "../lifecycle/enums";
import { AgenturKey } from "../projects/agentur-settings";

// The evidence of a profiling exception (process-and-lifecycle.md, profiling exceptions;
// data-protection.md, exception evidence; Q81, Q94, Q194, round 17). One immutable evidence
// record per attempt, either the accepted `profiling_exception_evidence` document versions or a
// structured BA confirmation. Its fingerprint is computed by the database
// (`exception_evidence_fingerprint`) over the payload `canonicalEvidence` builds; a test keeps the
// two equal. The fingerprint never leaves the database: not in a response, a log or the history.

/**
 * Which source an evidence record rests on. `legacy_unverified` marks a request recorded before
 * evidence records existed (migration 0086): kept for its history, never counting as evidence.
 */
export const ExceptionEvidenceKind = z.enum(["documents", "ba_confirmation", "legacy_unverified"]);
export type ExceptionEvidenceKind = z.infer<typeof ExceptionEvidenceKind>;

/** The canonicalisation version: a later one is `v2`, never a changed `v1` (round 17). */
export const evidencePayloadPrefix = "profiling-exception-evidence:v1";

/** The longest reference after normalisation. */
export const baReferenceMaxLength = 100;

/** A structured BA confirmation as recorded (normalised). */
export type BaConfirmation = { agenturKey: string; reference: string; confirmedOn: IsoDate };

/**
 * The reference as stored and fingerprinted: NFC, inner runs of spaces as one, no leading or
 * trailing space, lower case (Unicode's default mapping, as the database's ICU `lower`), NFC
 * again. A control character (a line break, a tab) is no reference at all.
 */
export function normaliseBaReference(reference: string): string | null {
  // oxlint-disable-next-line no-control-regex
  if (/\p{Cc}/u.test(reference)) return null;
  const text = reference
    .normalize("NFC")
    .replace(/ {2,}/g, " ")
    .replace(/^ +| +$/g, "")
    .toLowerCase()
    .normalize("NFC");
  const length = [...text].length;
  return length === 0 || length > baReferenceMaxLength ? null : text;
}

export type BaConfirmationProblem = "reference_invalid" | "confirmation_in_future";

/** The confirmation normalised, or why it can't be recorded (`today`: Berlin). */
export function normaliseBaConfirmation(
  input: BaConfirmation,
  today: IsoDate,
): { ok: true; value: BaConfirmation } | { ok: false; code: BaConfirmationProblem } {
  const reference = normaliseBaReference(input.reference);
  if (reference === null) return { ok: false, code: "reference_invalid" };
  if (input.confirmedOn > today) return { ok: false, code: "confirmation_in_future" };
  return {
    ok: true,
    value: { agenturKey: input.agenturKey, reference, confirmedOn: input.confirmedOn },
  };
}

/** What a record's fingerprint covers (round 17). */
export type CanonicalEvidenceSource =
  | { kind: "documents"; contentDigests: readonly string[] }
  | { kind: "ba_confirmation"; confirmation: BaConfirmation };

/**
 * The payload the fingerprint is the SHA-256 of (round 17): the version line, the participation
 * id, then the canonical evidence: the kind and either the sorted, de-duplicated content digests
 * of the accepted versions, or the normalised confirmation's facts in key order. Identical bytes
 * under another document id or another order give the same payload; the participation id keeps
 * equal evidence of two participants apart.
 */
export function canonicalEvidence(participationId: string, source: CanonicalEvidenceSource) {
  const lines =
    source.kind === "documents"
      ? [...new Set(source.contentDigests)].toSorted()
      : [
          `agenturKey=${source.confirmation.agenturKey}`,
          `confirmedOn=${source.confirmation.confirmedOn}`,
          `reference=${source.confirmation.reference}`,
        ];
  return [evidencePayloadPrefix, participationId, source.kind, ...lines].join("\n");
}

/** `POST /participations/{id}/exception-evidence`: the accepted documents, or a BA confirmation. */
export const ExceptionEvidenceInput = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("documents"),
      documentIds: z.array(z.uuid()).min(1).max(20),
    }),
    z.strictObject({
      kind: z.literal("ba_confirmation"),
      agenturKey: AgenturKey,
      reference: z.string().min(1).max(200),
      confirmedOn: isoDate,
    }),
  ])
  .meta({ id: "ExceptionEvidenceInput" });
export type ExceptionEvidenceInput = z.infer<typeof ExceptionEvidenceInput>;

export const ExceptionEvidenceCreated = z
  .object({ evidenceRecordId: z.uuid() })
  .meta({ id: "ExceptionEvidenceCreated" });

export const ProfilingExceptionRequested = z
  .object({ requestId: z.uuid() })
  .meta({ id: "ProfilingExceptionRequested" });

/** `POST /participations/{id}/profiling-exception-requests`: the reason and the record it rests on. */
export const ProfilingExceptionRequestInput = z
  .strictObject({ reason: ProfilingExceptionReason, evidenceRecordId: z.uuid() })
  .meta({ id: "ProfilingExceptionRequestInput" });

/**
 * `POST /profiling-exception-requests/{id}/decision`: the decision and the evidence record the
 * approver saw in "Freigaben" (`409 source_changed` if the request rests on another one).
 */
export const ProfilingExceptionDecisionInput = z
  .strictObject({ decision: z.enum(["approve", "reject"]), evidenceRecordId: z.uuid() })
  .meta({ id: "ProfilingExceptionDecisionInput" });

/**
 * `POST /profiling-exception-requests/{id}/revocation`: the status the PL saw on the tab
 * (`409 source_changed` if it was decided meanwhile).
 */
export const ProfilingExceptionRevocationInput = z
  .strictObject({ status: z.enum(["requested", "approved"]) })
  .meta({ id: "ProfilingExceptionRevocationInput" });

/** An evidence document of the participation as the exception block shows it: no file, no name. */
export const ExceptionEvidenceDocument = z.object({
  documentId: z.uuid(),
  addedAt: z.iso.datetime(),
  reviewState: z.enum(["unreviewed", "accepted", "rejected"]),
  /** Accepted, not quarantined, invalidated or deleted: it can be part of a record. */
  usable: z.boolean(),
  quarantined: z.boolean(),
  /**
   * The safety actions without any opening (the review of PR #102), "Korrektur beantragen"
   * among them (data-protection.md, evidence corrections).
   */
  capabilities: z.object({
    delete: z.boolean(),
    quarantine: z.boolean(),
    liftQuarantine: z.boolean(),
    requestCorrection: z.boolean(),
  }),
});

/** The participation's current request on the tab "Profiling" (the PL and the consultant). */
export const ProfilingExceptionView = z
  .object({
    current: z
      .object({
        requestId: z.uuid(),
        status: ProfilingExceptionStatus.exclude(["none"]),
        reason: ProfilingExceptionReason,
        requestedOn: isoDate,
        decidedOn: isoDate.nullable(),
        evidenceRecordId: z.uuid(),
        evidenceKind: ExceptionEvidenceKind,
      })
      .nullable(),
    evidenceDocuments: z.array(ExceptionEvidenceDocument),
    capabilities: z.object({
      addEvidence: z.boolean(),
      request: z.boolean(),
      revoke: z.boolean(),
    }),
  })
  .meta({ id: "ProfilingExceptionView" });
export type ProfilingExceptionView = z.infer<typeof ProfilingExceptionView>;

/**
 * One item of the queue "Freigaben" (Q80, Q194): what the regional operations manager decides
 * from. The project, the reason code, the dates, the evidence's kind and whether it is still
 * usable; never a name, case data, a document or the confirmation's facts.
 */
export const ReviewItem = z.object({
  requestId: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  reason: ProfilingExceptionReason,
  requestedOn: isoDate,
  tgStart: isoDate.nullable(),
  evidenceRecordId: z.uuid(),
  evidenceKind: ExceptionEvidenceKind,
  evidencePresent: z.boolean(),
  capabilities: z.object({ decide: z.boolean() }),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/**
 * "Freigaben": the pending profiling exceptions, evidence corrections, escalated entry
 * clarifications, open reconciliations and active legal holds, each oldest first.
 */
export const ReviewQueue = z
  .object({
    items: z.array(ReviewItem),
    corrections: z.array(CorrectionReviewItem),
    /** The escalated entry clarifications awaiting the manager's instruction. */
    clarifications: z.array(EntryClarificationReviewItem),
    /**
     * The reconciliations of a missed TG entry still open (Q80, Q216): awaiting the review, the
     * PL's reply to a clarification, or the resolution of a reply or an escalation.
     */
    reconciliations: z.array(ReconciliationReviewItem),
    /** The active legal holds of the region's projects, for their release (Q218). */
    legalHolds: z.array(LegalHoldReviewItem),
  })
  .meta({ id: "ReviewQueue" });

/** Who has the queue "Freigaben": a regional operations manager (Q80). */
export function seesReviews(subject: Subject): boolean {
  return subject.kind === "staff" && subject.orgRoles.has("regional_operations_manager");
}

/** Whether a project's requests are in the viewer's "Freigaben": their region's (Q80, Q126). */
export function maySeeReview(subject: Subject, project: { regionId: string | null }): boolean {
  if (subject.kind !== "staff") return false;
  const scope = subject.orgRoles.get("regional_operations_manager")?.regionIds;
  return (
    scope === "all" ||
    (scope !== undefined && project.regionId !== null && scope.has(project.regionId))
  );
}
