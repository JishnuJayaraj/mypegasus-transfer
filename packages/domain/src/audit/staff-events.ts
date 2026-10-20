import { z } from "zod";
import { StaffLoginRefusal } from "../auth/staff-login";
import { OrgRoleGrant } from "../staff/accounts";

/**
 * The staff audit trail (D6, table `staff_audit_event`): staff logins, logouts, refusals and
 * identity bindings, and the global admin's account, org-role and region changes (Q126). It has no
 * `project_id`, so it isn't `audit_event`. Ids and codes only: a refused login never records the
 * claimed email, an account event never the name or email, a region event never the name; the
 * table's `CHECK`s enforce the same.
 */
export const StaffAuditEventType = z.enum([
  "staff_login",
  "staff_logout",
  "staff_login_refused",
  "staff_identity_bound",
  "staff_account_created",
  "staff_account_changed",
  "staff_account_deactivated",
  "org_role_granted",
  "org_role_revoked",
  "region_created",
  "region_changed",
]);
export type StaffAuditEventType = z.infer<typeof StaffAuditEventType>;

/** How a staff session ended (D2). `deactivated` comes with account deactivation. */
export const StaffSessionEndReason = z.enum(["logout", "deactivated", "superseded"]);
export type StaffSessionEndReason = z.infer<typeof StaffSessionEndReason>;

/** The login mode that started a session (D1). */
export const StaffLoginMethod = z.enum(["oidc", "dev"]);
export type StaffLoginMethod = z.infer<typeof StaffLoginMethod>;

/** The claim a first login was matched by (D5). */
export const StaffLoginNameClaim = z.enum(["email", "preferred_username"]);
export type StaffLoginNameClaim = z.infer<typeof StaffLoginNameClaim>;

const requestId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
  .nullable();

/** The acting user of a login, logout or binding is its subject too. */
const ofUser = { requestId, staffUserId: z.uuid() };

const refusedWithAccount = z.strictObject({
  type: z.literal("staff_login_refused"),
  requestId,
  method: StaffLoginMethod,
  reasonCode: StaffLoginRefusal.exclude(["unknown_account"]),
  subjectStaffUserId: z.uuid(),
});

/** An administration event: the acting global admin and the account it concerns. */
const ofAccount = { requestId, actorStaffUserId: z.uuid(), subjectStaffUserId: z.uuid() };
const ofRegion = { requestId, actorStaffUserId: z.uuid(), regionId: z.uuid() };

const accountChanged = z
  .strictObject({
    type: z.literal("staff_account_changed"),
    ...ofAccount,
    fields: z.array(z.enum(["displayName", "email", "mayCreateProjects"])).min(1),
    /** The flag's new value, with its key only. */
    mayCreateProjects: z.boolean().optional(),
  })
  .refine((e) => e.fields.includes("mayCreateProjects") === (e.mayCreateProjects !== undefined), {
    params: { code: "flag_mismatch" },
  });

const count = z.int().min(0);
const hasValidOrgRoleScope = (event: OrgRoleGrant) =>
  OrgRoleGrant.safeParse({ role: event.role, regionId: event.regionId }).success;

const orgRoleGranted = z
  .strictObject({ type: z.literal("org_role_granted"), ...ofAccount, ...OrgRoleGrant.shape })
  .refine(hasValidOrgRoleScope, { params: { code: "region_scope" } });

const orgRoleRevoked = z
  .strictObject({
    type: z.literal("org_role_revoked"),
    ...ofAccount,
    ...OrgRoleGrant.shape,
    reasonCode: z.literal("account_deactivated").optional(),
  })
  .refine(hasValidOrgRoleScope, { params: { code: "region_scope" } });

export const StaffAuditEvent = z.union([
  z.strictObject({ type: z.literal("staff_login"), ...ofUser, method: StaffLoginMethod }),
  z.strictObject({ type: z.literal("staff_logout"), ...ofUser }),
  z.strictObject({
    type: z.literal("staff_login_refused"),
    requestId,
    method: StaffLoginMethod,
    reasonCode: z.literal("unknown_account"),
    subjectStaffUserId: z.null(),
  }),
  refusedWithAccount,
  z.strictObject({
    type: z.literal("staff_identity_bound"),
    ...ofUser,
    matchedBy: StaffLoginNameClaim,
  }),
  z.strictObject({
    type: z.literal("staff_account_created"),
    ...ofAccount,
    mayCreateProjects: z.boolean(),
  }),
  accountChanged,
  /** What deactivation ended or removed (data-protection.md, regions and org roles). */
  z.strictObject({
    type: z.literal("staff_account_deactivated"),
    ...ofAccount,
    endedSessions: count,
    removedMemberships: count,
    endedAssignments: count,
    removedOrgRoles: count,
  }),
  orgRoleGranted,
  orgRoleRevoked,
  z.strictObject({ type: z.literal("region_created"), ...ofRegion }),
  z.strictObject({
    type: z.literal("region_changed"),
    ...ofRegion,
    fields: z.array(z.enum(["code", "name"])).min(1),
  }),
]);
export type StaffAuditEvent = z.infer<typeof StaffAuditEvent>;
