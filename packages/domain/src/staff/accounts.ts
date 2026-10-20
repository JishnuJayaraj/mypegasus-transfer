import { z } from "zod";
import { OrgRole, ProjectRole } from "../enums";

/**
 * Staff accounts and org roles (Q7, Q59, Q126): only a global admin creates, changes and
 * deactivates accounts, grants org roles and sets `mayCreateProjects`. Accounts are never deleted;
 * a deactivated one can't log in. Name and email never enter the audit trail.
 */

/** An org role: `admin` is global (no region), the regional roles name one region each. */
export const OrgRoleGrant = z
  .strictObject({ role: OrgRole, regionId: z.uuid().nullable() })
  .refine((grant) => (grant.role === "admin") === (grant.regionId === null), {
    message: "admin is global; a regional role names its region",
    path: ["regionId"],
    params: { code: "region_scope" },
  })
  .meta({ id: "OrgRoleGrant" });
export type OrgRoleGrant = z.infer<typeof OrgRoleGrant>;

const grantKey = (grant: OrgRoleGrant) => `${grant.role}:${grant.regionId ?? ""}`;

/** `PUT /staff-users/{id}/org-roles`: the account's complete set of org roles. */
export const SetOrgRolesInput = z
  .strictObject({ orgRoles: z.array(OrgRoleGrant).max(20) })
  .refine(({ orgRoles }) => new Set(orgRoles.map(grantKey)).size === orgRoles.length, {
    message: "An org role is named twice",
    path: ["orgRoles"],
    params: { code: "duplicate_org_role" },
  })
  .meta({ id: "SetOrgRolesInput" });
export type SetOrgRolesInput = z.infer<typeof SetOrgRolesInput>;

/** The grants and revocations that turn `current` into `wanted`. */
export function orgRoleChanges(
  current: readonly OrgRoleGrant[],
  wanted: readonly OrgRoleGrant[],
): { grant: OrgRoleGrant[]; revoke: OrgRoleGrant[] } {
  const held = new Set(current.map(grantKey));
  const kept = new Set(wanted.map(grantKey));
  return {
    grant: wanted.filter((grant) => !held.has(grantKey(grant))),
    revoke: current.filter((grant) => !kept.has(grantKey(grant))),
  };
}

const displayName = z.string().trim().min(1).max(100);
const email = z.email().max(254);

export const StaffAccount = z
  .strictObject({
    id: z.uuid(),
    displayName: z.string(),
    email: z.string(),
    mayCreateProjects: z.boolean(),
    orgRoles: z.array(OrgRoleGrant),
    /** Whether the first OIDC login bound an identity (ADR-0007); never the identity itself. */
    identityBound: z.boolean(),
    deactivatedAt: z.iso.datetime().nullable().meta({ description: "UTC timestamp (ISO 8601)" }),
    createdAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
  })
  .meta({ id: "StaffAccount" });
export type StaffAccount = z.infer<typeof StaffAccount>;

export const StaffAccountPage = z
  .object({ items: z.array(StaffAccount), nextCursor: z.string().nullable() })
  .meta({ id: "StaffAccountPage" });

export const CreateStaffUserInput = z
  .strictObject({ displayName, email, mayCreateProjects: z.boolean().default(false) })
  .meta({ id: "CreateStaffUserInput" });
export type CreateStaffUserInput = z.infer<typeof CreateStaffUserInput>;

export const UpdateStaffUserInput = z
  .strictObject({
    displayName: displayName.optional(),
    email: email.optional(),
    mayCreateProjects: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Change at least one field",
    params: { code: "nothing_to_change" },
  })
  .meta({ id: "UpdateStaffUserInput" });
export type UpdateStaffUserInput = z.infer<typeof UpdateStaffUserInput>;

/** `GET /staff-directory`: active staff by name, for member pickers; id and name only. */
export const StaffDirectoryQuery = z.strictObject({ search: z.string().trim().min(1).max(100) });
export const StaffDirectoryEntry = z
  .strictObject({ id: z.uuid(), displayName: z.string() })
  .meta({ id: "StaffDirectoryEntry" });
export type StaffDirectoryEntry = z.infer<typeof StaffDirectoryEntry>;

/** The role a staff user is best known by (the dev switcher's "Name · Rolle"). */
export type StaffRoleLabel = OrgRole | ProjectRole;

const labelOrder: readonly StaffRoleLabel[] = [
  ...OrgRole.options,
  "project_lead",
  "consultant",
  "back_office",
];

export function staffRoleLabel(user: {
  orgRoles: readonly OrgRole[];
  mayCreateProjects: boolean;
  projectRoles: readonly ProjectRole[];
}): StaffRoleLabel | null {
  const held = new Set<StaffRoleLabel>([
    ...user.orgRoles,
    ...user.projectRoles,
    ...(user.mayCreateProjects ? (["project_lead"] as const) : []),
  ]);
  return labelOrder.find((role) => held.has(role)) ?? null;
}
