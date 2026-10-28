import { documentTypeEntry, type AccessRole, type DocumentType } from "../documents/catalog";
import type { DocumentDeleteReason, DocumentReviewState } from "../documents/state";
import type { AccessMode, AccessQuestion, Subject } from "./decide";
import { staffPermission, type PermissionDenial, type PermissionTarget } from "./permissions";

/**
 * Who may add, review and delete a document (data-protection.md, documents; Q146 *assumed*),
 * beside `decideAccess`, which keeps reading and opening and answers `write` with
 * `via_domain_operation`. The document functions check the same rules again. A type whose
 * operations its slice hasn't decided is `undecided` (Q65) for the roles that may open it.
 */
export type DocumentOperation = "add" | "review" | "delete";

export type DocumentPermissionDenial =
  | PermissionDenial
  /** Staff add in normal or assisted mode, review and delete in normal mode; break-glass never. */
  | "mode_not_allowed"
  /**
   * Generated documents are never deleted, signed ones not once reviewed; only the retention job
   * or an approved correction removes them.
   */
  | "immutable"
  /** A participant deletes only what they added themselves… */
  | "added_by_staff"
  /** …and only while it isn't accepted. */
  | "document_accepted";

export type DocumentPermission =
  | { ok: true }
  | { ok: false; because: DocumentPermissionDenial }
  | { ok: false; because: "undecided"; question: AccessQuestion };

export type DocumentTarget = PermissionTarget & { participationId: string };

const ok: DocumentPermission = { ok: true };
const no = (because: DocumentPermissionDenial): DocumentPermission => ({ ok: false, because });

function permission(
  subject: Subject,
  type: DocumentType,
  target: DocumentTarget,
  mode: AccessMode,
  operation: DocumentOperation | "quarantine",
): DocumentPermission {
  const entry = documentTypeEntry(type);
  const operations = entry.operations;
  const generated = operations === "generated";
  // A signed type whose operations are undecided keeps the rule it had: never deleted.
  const undecidedSigned = entry.signed && operations === "undecided";
  if (operation === "delete" && (generated || undecidedSigned)) return no("immutable");
  // Generated forms come only from their generation (data-protection.md, generated forms).
  if (generated) return no("actor_not_allowed");
  const roles: readonly AccessRole[] | undefined =
    operations === "undecided"
      ? undefined
      : operation === "quarantine"
        ? (operations.quarantine ?? operations.review)
        : operations[operation];
  if (subject.kind === "participant") {
    // Participants have no modes and reach only their own participation.
    const own = subject.participationId === target.participationId && mode.kind === "normal";
    return own && roles?.includes("participant") ? ok : no("actor_not_allowed");
  }
  if (!roles) {
    // Undecided for the roles that may open the type, in every mode; the others are refused.
    const opens = staffPermission(subject, target, (role) => {
      const right = entry.roles[role];
      return right !== undefined && right !== "metadata";
    });
    return opens.ok ? { ok: false, because: "undecided", question: "Q65" } : opens;
  }
  const allowed = staffPermission(subject, target, (role) => roles.includes(role));
  if (!allowed.ok) return allowed;
  // Signed paper is the staff's own act in normal mode (data-protection.md, signed scans).
  const onBehalf =
    mode.kind === "assisted" && mode.onBehalfOf === target.participationId && !entry.signed;
  return mode.kind === "normal" || (operation === "add" && onBehalf) ? ok : no("mode_not_allowed");
}

/** The participant in the portal; staff as themselves, or on the participant's behalf. */
export function mayAddDocument(
  subject: Subject,
  type: DocumentType,
  target: DocumentTarget,
  mode: AccessMode,
): DocumentPermission {
  return permission(subject, type, target, mode, "add");
}

/** Accept, or reject with a reason code; once and final. */
export function mayReviewDocument(
  subject: Subject,
  type: DocumentType,
  target: DocumentTarget,
  mode: AccessMode,
): DocumentPermission {
  return permission(subject, type, target, mode, "review");
}

/**
 * Staff any document of the type (with a reason code), a signed one only before its review; the
 * participant their own, not accepted.
 */
export function mayDeleteDocument(
  subject: Subject,
  type: DocumentType,
  target: DocumentTarget,
  mode: AccessMode,
  document: { addedByParticipant: boolean; reviewState: DocumentReviewState },
): DocumentPermission {
  const allowed = permission(subject, type, target, mode, "delete");
  if (!allowed.ok) return allowed;
  if (subject.kind === "staff") {
    const reviewed = document.reviewState !== "unreviewed";
    return documentTypeEntry(type).signed && reviewed ? no("immutable") : ok;
  }
  if (!document.addedByParticipant) return no("added_by_staff");
  return document.reviewState === "accepted" ? no("document_accepted") : ok;
}

/**
 * The reasons a staff deletion of the type may give: a signed scan's only `wrong_person` or
 * `wrong_file` (data-protection.md, signed scans; Q183).
 */
export function documentDeleteReasons(type: DocumentType): readonly DocumentDeleteReason[] {
  return documentTypeEntry(type).signed
    ? ["wrong_person", "wrong_file"]
    : ["wrong_person", "wrong_file", "duplicate", "participant_request"];
}

/**
 * Quarantine at once (data-protection.md, quarantine; Q183): the type's quarantine roles (its
 * review roles unless the catalog names others, as for the ASU proof, Q201), in normal mode,
 * whatever its review state.
 */
export function mayQuarantineDocument(
  subject: Subject,
  type: DocumentType,
  target: DocumentTarget,
  mode: AccessMode,
): DocumentPermission {
  return permission(subject, type, target, mode, "quarantine");
}

/** The lift: whoever quarantined it, while they may still quarantine it, or the PL. */
export function mayLiftDocumentQuarantine(
  subject: Subject,
  type: DocumentType,
  target: DocumentTarget,
  mode: AccessMode,
  quarantinedBy: string,
): DocumentPermission {
  const allowed = mayQuarantineDocument(subject, type, target, mode);
  if (!allowed.ok || subject.kind !== "staff" || subject.staffUserId === quarantinedBy) {
    return allowed;
  }
  return staffPermission(subject, target, (role) => role === "project_lead");
}
