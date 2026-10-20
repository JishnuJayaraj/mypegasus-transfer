import { describe, expect, it } from "vitest";
import { StaffAuditEvent, StaffAuditEventType, StaffSessionEndReason } from "./staff-events";

const staffUserId = "00000000-0000-4000-8000-000000000003";
const base = { requestId: "0c4b1f4e-1111-4000-8000-000000000001" };

const ok = (input: unknown) => StaffAuditEvent.safeParse(input).success;

describe("staff audit events (D6)", () => {
  it("has the login and administration event types and session end reasons", () => {
    expect(StaffAuditEventType.options).toEqual([
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
    expect(StaffSessionEndReason.options).toEqual(["logout", "deactivated", "superseded"]);
  });

  it("accepts a login and a logout of the acting user, with the method as a code", () => {
    expect(ok({ ...base, type: "staff_login", staffUserId, method: "oidc" })).toBe(true);
    expect(ok({ ...base, type: "staff_login", staffUserId, method: "dev" })).toBe(true);
    expect(ok({ ...base, type: "staff_logout", staffUserId })).toBe(true);
    expect(ok({ ...base, type: "staff_login", staffUserId, method: "password" })).toBe(false);
  });

  it("records a refusal as a code, the account only where one was matched", () => {
    const refused = { ...base, type: "staff_login_refused", method: "oidc" };
    expect(ok({ ...refused, reasonCode: "unknown_account", subjectStaffUserId: null })).toBe(true);
    expect(
      ok({ ...refused, reasonCode: "identity_mismatch", subjectStaffUserId: staffUserId }),
    ).toBe(true);
    expect(ok({ ...refused, reasonCode: "unknown_account", subjectStaffUserId: staffUserId })).toBe(
      false,
    );
    expect(ok({ ...refused, reasonCode: "account_deactivated", subjectStaffUserId: null })).toBe(
      false,
    );
  });

  it("never carries the claimed email (strict objects)", () => {
    expect(
      ok({
        ...base,
        type: "staff_login_refused",
        method: "oidc",
        reasonCode: "unknown_account",
        subjectStaffUserId: null,
        email: "someone@example.org",
      }),
    ).toBe(false);
  });

  it("records a binding with the claim it matched", () => {
    const bound = { ...base, type: "staff_identity_bound", staffUserId };
    expect(ok({ ...bound, matchedBy: "email" })).toBe(true);
    expect(ok({ ...bound, matchedBy: "preferred_username" })).toBe(true);
    expect(ok({ ...bound, matchedBy: "upn" })).toBe(false);
  });

  it("holds request ids to the id pattern", () => {
    expect(ok({ requestId: null, type: "staff_logout", staffUserId })).toBe(true);
    expect(ok({ requestId: "not an id", type: "staff_logout", staffUserId })).toBe(false);
  });
});

describe("staff administration events (D8, D11, Q126)", () => {
  const adminId = "00000000-0000-4000-8000-000000000001";
  const regionId = "00000000-0000-4000-a000-000000000001";
  const of = { ...base, actorStaffUserId: adminId, subjectStaffUserId: staffUserId };

  it("records account events with the acting admin and the account, never name or email", () => {
    expect(ok({ ...of, type: "staff_account_created", mayCreateProjects: true })).toBe(true);
    expect(
      ok({ ...of, type: "staff_account_created", mayCreateProjects: true, email: "a@example.org" }),
    ).toBe(false);
    const changed = { ...of, type: "staff_account_changed" };
    expect(ok({ ...changed, fields: ["displayName", "email"] })).toBe(true);
    expect(ok({ ...changed, fields: ["mayCreateProjects"], mayCreateProjects: false })).toBe(true);
    expect(ok({ ...changed, fields: [] })).toBe(false);
    // The flag's new value comes with its key, and only then
    expect(ok({ ...changed, fields: ["mayCreateProjects"] })).toBe(false);
    expect(ok({ ...changed, fields: ["email"], mayCreateProjects: true })).toBe(false);
    const deactivated = {
      ...of,
      type: "staff_account_deactivated",
      endedSessions: 1,
      removedMemberships: 3,
      endedAssignments: 0,
    };
    expect(ok(deactivated)).toBe(true);
    expect(ok({ ...deactivated, endedSessions: -1 })).toBe(false);
  });

  it("records org roles with their region; admin is global", () => {
    for (const type of ["org_role_granted", "org_role_revoked"]) {
      expect(ok({ ...of, type, role: "admin", regionId: null })).toBe(true);
      expect(ok({ ...of, type, role: "regional_admin", regionId })).toBe(true);
      expect(ok({ ...of, type, role: "regional_admin", regionId: null })).toBe(false);
      expect(ok({ ...of, type, role: "admin", regionId })).toBe(false);
      expect(ok({ ...of, type, role: "project_lead", regionId })).toBe(false);
    }
  });

  it("records region events with the region's id and changed keys, never its name", () => {
    const region = { ...base, actorStaffUserId: adminId, regionId };
    expect(ok({ ...region, type: "region_created" })).toBe(true);
    expect(ok({ ...region, type: "region_changed", fields: ["code", "name"] })).toBe(true);
    expect(ok({ ...region, type: "region_changed", fields: [] })).toBe(false);
    expect(ok({ ...region, type: "region_created", name: "Nord" })).toBe(false);
  });
});
