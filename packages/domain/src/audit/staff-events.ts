import { z } from "zod";
import { StaffLoginRefusal } from "../auth/staff-login";

/**
 * The staff audit trail (D6, table `staff_audit_event`): staff logins, logouts, refusals and
 * identity bindings. It has no `project_id`, so it isn't `audit_event`. Ids and codes only: a
 * refused login never records the claimed email, and the table's `CHECK`s enforce the same.
 * Account and org-role events join with Slice 3's administration.
 */
export const StaffAuditEventType = z.enum([
  "staff_login",
  "staff_logout",
  "staff_login_refused",
  "staff_identity_bound",
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
]);
export type StaffAuditEvent = z.infer<typeof StaffAuditEvent>;
