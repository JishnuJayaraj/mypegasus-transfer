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

/** The completeness engine's state of a document; a deleted one counts nothing (null). */
export function documentState(document: {
  reviewState: DocumentReviewState;
  deletedAt: string | null;
}): DocumentState | null {
  return document.deletedAt === null ? states[document.reviewState] : null;
}
