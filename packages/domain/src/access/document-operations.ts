import { documentTypeEntry, type AccessRole, type DocumentType } from "../documents/catalog";
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
  /** Signed documents are never deleted; only the retention job removes them. */
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
  operation: DocumentOperation,
): DocumentPermission {
  const entry = documentTypeEntry(type);
  if (operation === "delete" && entry.signed) return no("immutable");
  const roles: readonly AccessRole[] | undefined =
    entry.operations === "undecided" ? undefined : entry.operations[operation];
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
  const onBehalf = mode.kind === "assisted" && mode.onBehalfOf === target.participationId;
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

/** Staff any document of the type (with a reason code); the participant their own, not accepted. */
export function mayDeleteDocument(
  subject: Subject,
  type: DocumentType,
  target: DocumentTarget,
  mode: AccessMode,
  document: { addedByParticipant: boolean; accepted: boolean },
): DocumentPermission {
  const allowed = permission(subject, type, target, mode, "delete");
  if (!allowed.ok || subject.kind === "staff") return allowed;
  if (!document.addedByParticipant) return no("added_by_staff");
  return document.accepted ? no("document_accepted") : ok;
}
