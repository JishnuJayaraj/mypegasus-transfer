import { z } from "zod";
import type { DocumentState } from "../completeness/engine";

/** A document is reviewed once, and finally (process-and-lifecycle.md; Q146 *assumed*). */
export const DocumentReviewState = z.enum(["unreviewed", "accepted", "rejected"]);
export type DocumentReviewState = z.infer<typeof DocumentReviewState>;

/** Why a document was rejected; a new upload replaces a wrong one. */
export const DocumentReviewReason = z.enum(["unreadable", "wrong_document", "incomplete"]);
export type DocumentReviewReason = z.infer<typeof DocumentReviewReason>;

/** Why staff deleted a document; a participant's deletion of their own upload has none. */
export const DocumentDeleteReason = z.enum([
  "wrong_person",
  "wrong_file",
  "duplicate",
  "participant_request",
]);
export type DocumentDeleteReason = z.infer<typeof DocumentDeleteReason>;

const states: Record<DocumentReviewState, DocumentState> = {
  unreviewed: "uploaded",
  accepted: "accepted",
  rejected: "rejected",
};

/**
 * Why a document is quarantined at once (data-protection.md, quarantine; Q183): it may belong to
 * another person, or it was accepted by mistake.
 */
export const QuarantineReason = z
  .enum(["suspected_wrong_person", "suspected_wrong_acceptance"])
  .meta({ id: "QuarantineReason" });
export type QuarantineReason = z.infer<typeof QuarantineReason>;

/**
 * The completeness engine's state of a document; a deleted or quarantined one counts nothing
 * (null; data-protection.md, quarantine).
 */
export function documentState(document: {
  reviewState: DocumentReviewState;
  deletedAt: string | null;
  quarantined: boolean;
}): DocumentState | null {
  return document.deletedAt === null && !document.quarantined ? states[document.reviewState] : null;
}
