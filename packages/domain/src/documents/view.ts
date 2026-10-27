import { decideAccess, type AccessAction, type AccessMode, type Subject } from "../access/decide";
import {
  mayAddDocument,
  mayDeleteDocument,
  mayLiftDocumentQuarantine,
  mayQuarantineDocument,
  mayReviewDocument,
  type DocumentTarget,
} from "../access/document-operations";
import { uploadableDocumentTypes, type DocumentCapabilities } from "./api";
import { DocumentType } from "./catalog";
import type { DocumentReviewState } from "./state";

// What a viewer sees of a participation's documents and may do with each (data-protection.md,
// documents and access matrix; Q146 *assumed*). Pure: the API loads the rows and applies the
// result; the document functions check the same rules again.

const decision = (
  subject: Subject,
  target: DocumentTarget,
  documentType: DocumentType,
  action: AccessAction,
  mode: AccessMode,
) =>
  decideAccess(
    subject,
    { kind: "document", ...target, phase: "active", documentType },
    action,
    mode,
  );

/** The types whose documents' metadata the viewer reads in the mode. */
export function readableDocumentTypes(
  subject: Subject,
  target: DocumentTarget,
  mode: AccessMode,
): DocumentType[] {
  return DocumentType.options.filter(
    (type) => decision(subject, target, type, "read", mode).effect === "allow",
  );
}

/**
 * Whether the participation's documents are hidden from the viewer as the participation itself
 * is (ADR-0010, documents): a consultant not assigned to it, whose best decision
 * on every type is `not_assigned`. A role without document rights sees an empty list instead.
 */
export function documentsHidden(subject: Subject, target: DocumentTarget): boolean {
  return DocumentType.options.every((type) => {
    const d = decision(subject, target, type, "read", { kind: "normal" });
    return d.effect === "deny" && d.because === "not_assigned";
  });
}

/** The types the viewer may upload in the mode (only the uploadable ones). */
export function addableDocumentTypes(
  subject: Subject,
  target: DocumentTarget,
  mode: AccessMode,
): DocumentType[] {
  return uploadableDocumentTypes.filter((type) => mayAddDocument(subject, type, target, mode).ok);
}

/**
 * What the viewer may do with one live document now. A quarantined one opens for nobody and is
 * not reviewed (data-protection.md, quarantine); a deletion before review stays possible.
 */
export function documentCapabilities(
  subject: Subject,
  target: DocumentTarget,
  mode: AccessMode,
  document: {
    type: DocumentType;
    addedByParticipant: boolean;
    reviewState: DocumentReviewState;
    /** Who quarantined it, while it is; else null. */
    quarantinedBy: string | null;
  },
): DocumentCapabilities {
  const { type, addedByParticipant, reviewState, quarantinedBy } = document;
  const quarantined = quarantinedBy !== null;
  return {
    open: !quarantined && decision(subject, target, type, "open_document", mode).effect === "allow",
    review:
      !quarantined &&
      reviewState === "unreviewed" &&
      mayReviewDocument(subject, type, target, mode).ok,
    delete: mayDeleteDocument(subject, type, target, mode, { addedByParticipant, reviewState }).ok,
    quarantine: !quarantined && mayQuarantineDocument(subject, type, target, mode).ok,
    liftQuarantine:
      quarantined && mayLiftDocumentQuarantine(subject, type, target, mode, quarantinedBy).ok,
  };
}
