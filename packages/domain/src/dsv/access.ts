import {
  staffPermission,
  type Actor,
  type Permission,
  type PermissionTarget,
} from "../access/permissions";

// Who works with the DSV (data-protection.md, access matrix: `employment_contract`; Slice 7 D1,
// D2; Q60). Normal mode only: assisted mode and break-glass grant none of it. The database
// functions check the same roles again.

const denied = { ok: false, because: "actor_not_allowed" } as const satisfies Permission;

/**
 * The tab "DSV" and the generation of one participation's DSV: the PL and back office, who read
 * the employment contract (`employment_contract`); a consultant never.
 */
export function mayWorkDsv(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => ["project_lead", "back_office"].includes(role));
}

/** The project's DSV template version (ADR-0009, the DSV template): the PL. */
export function mayPinDsvTemplate(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "project_lead");
}
