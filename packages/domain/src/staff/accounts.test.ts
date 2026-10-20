import { describe, expect, it } from "vitest";
import {
  CreateStaffUserInput,
  orgRoleChanges,
  OrgRoleGrant,
  SetOrgRolesInput,
  StaffDirectoryQuery,
  staffRoleLabel,
  UpdateStaffUserInput,
} from "./accounts";

const region = "00000000-0000-4000-a000-000000000001";
const other = "00000000-0000-4000-a000-000000000002";
const codes = (result: { success: boolean; error?: { issues: readonly object[] } }) =>
  result.success
    ? []
    : result.error!.issues.map((i) => (i as { params?: { code?: string } }).params?.code);

describe("OrgRoleGrant (D7)", () => {
  it("holds admin global and the regional roles to one region", () => {
    expect(OrgRoleGrant.safeParse({ role: "admin", regionId: null }).success).toBe(true);
    expect(OrgRoleGrant.safeParse({ role: "regional_admin", regionId: region }).success).toBe(true);
    expect(
      OrgRoleGrant.safeParse({ role: "regional_operations_manager", regionId: region }).success,
    ).toBe(true);
    expect(codes(OrgRoleGrant.safeParse({ role: "admin", regionId: region }))).toEqual([
      "region_scope",
    ]);
    expect(codes(OrgRoleGrant.safeParse({ role: "regional_admin", regionId: null }))).toEqual([
      "region_scope",
    ]);
  });

  it("refuses a set that names one grant twice", () => {
    const grant = { role: "regional_admin", regionId: region };
    expect(SetOrgRolesInput.safeParse({ orgRoles: [grant] }).success).toBe(true);
    expect(SetOrgRolesInput.safeParse({ orgRoles: [] }).success).toBe(true);
    expect(codes(SetOrgRolesInput.safeParse({ orgRoles: [grant, grant] }))).toEqual([
      "duplicate_org_role",
    ]);
  });

  it("turns the wanted set into grants and revocations", () => {
    const admin = { role: "admin", regionId: null } as const;
    const north = { role: "regional_admin", regionId: region } as const;
    const south = { role: "regional_admin", regionId: other } as const;
    expect(orgRoleChanges([admin, north], [north, south])).toEqual({
      grant: [south],
      revoke: [admin],
    });
    expect(orgRoleChanges([north], [north])).toEqual({ grant: [], revoke: [] });
  });
});

describe("staff account inputs (Q126)", () => {
  it("creates an account with a name and an email, no project creation by default", () => {
    expect(
      CreateStaffUserInput.parse({ displayName: " Anna Beispiel ", email: "anna@example.org" }),
    ).toEqual({
      displayName: "Anna Beispiel",
      email: "anna@example.org",
      mayCreateProjects: false,
    });
    expect(
      CreateStaffUserInput.safeParse({ displayName: "A", email: "not-an-email" }).success,
    ).toBe(false);
    expect(
      CreateStaffUserInput.safeParse({ displayName: "", email: "a@example.org" }).success,
    ).toBe(false);
    // Strict: no role, no identity, no deactivation through the body
    expect(
      CreateStaffUserInput.safeParse({ displayName: "A", email: "a@example.org", role: "admin" })
        .success,
    ).toBe(false);
  });

  it("changes at least one field", () => {
    expect(UpdateStaffUserInput.safeParse({ mayCreateProjects: true }).success).toBe(true);
    expect(codes(UpdateStaffUserInput.safeParse({}))).toEqual(["nothing_to_change"]);
    expect(UpdateStaffUserInput.safeParse({ oidcSubject: "x" }).success).toBe(false);
  });

  it("searches the directory by a trimmed, non-empty name", () => {
    expect(StaffDirectoryQuery.parse({ search: " Bern " })).toEqual({ search: "Bern" });
    expect(StaffDirectoryQuery.safeParse({ search: " " }).success).toBe(false);
    expect(StaffDirectoryQuery.safeParse({ search: "x".repeat(101) }).success).toBe(false);
  });
});

describe("staffRoleLabel (the dev switcher's role)", () => {
  it("names the most telling role: an org role, then PL, consultant, back office", () => {
    const none = { orgRoles: [], mayCreateProjects: false, projectRoles: [] };
    expect(staffRoleLabel(none)).toBeNull();
    expect(staffRoleLabel({ ...none, mayCreateProjects: true })).toBe("project_lead");
    expect(staffRoleLabel({ ...none, projectRoles: ["back_office", "consultant"] })).toBe(
      "consultant",
    );
    expect(staffRoleLabel({ ...none, projectRoles: ["back_office"] })).toBe("back_office");
    expect(
      staffRoleLabel({
        orgRoles: ["regional_operations_manager"],
        mayCreateProjects: true,
        projectRoles: ["project_lead"],
      }),
    ).toBe("regional_operations_manager");
    expect(staffRoleLabel({ ...none, orgRoles: ["regional_admin", "admin"] })).toBe("admin");
  });
});
