import { decideAccess, type Subject } from "../access/decide";
import {
  staffPermission,
  type Actor,
  type Permission,
  type PermissionTarget,
} from "../access/permissions";

// Who works with the ASU record (data-protection.md, the ASU record; Q49, Q62, Q186; readings
// Q201). Normal mode only: assisted mode and break-glass grant none of it (the routes take
// neither). The functions check the same roles again.

const denied = { ok: false, because: "actor_not_allowed" } as const satisfies Permission;

/** Reading a field as the matrix decides in normal mode, in the active phase. */
function reads(subject: Subject, target: PermissionTarget, field: string): boolean {
  return (
    decideAccess(
      subject,
      {
        kind: "field",
        field,
        projectId: target.projectId,
        regionId: target.regionId,
        participationId: target.participationId,
        phase: "active",
      },
      "read",
      { kind: "normal" },
    ).effect === "allow"
  );
}

/**
 * The tab "Arbeitsuche": whoever reads the case data (`asuRegistration`, `case_internal`): the PL,
 * the assigned consultant and back office (data-protection.md, access matrix).
 */
export function mayViewAsu(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) =>
    ["project_lead", "consultant", "back_office"].includes(role),
  );
}

/** The knowledge date and the due date it gives: whoever reads the confidential case data. */
export function mayReadKnowledgeDate(subject: Subject, target: PermissionTarget): boolean {
  return reads(subject, target, "knowledgeDate");
}

/**
 * The route and a registration without the attestation (D19, D31): the PL or the assigned
 * consultant.
 */
export function mayRecordAsu(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "project_lead" || role === "consultant");
}

/** The attestation with the BA-Kundennummer, write-only (D19): the PL. */
export function mayAttestAsu(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "project_lead");
}

/**
 * Linking an accepted BA confirmation to the registration (Q201): the assigned consultant, who
 * alone opens it and so confirms that it supports the registration date.
 */
export function mayLinkAsuProof(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "consultant");
}

/** The knowledge date's audited correction (D22): the PL. */
export function maySetKnowledgeDate(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "project_lead");
}
