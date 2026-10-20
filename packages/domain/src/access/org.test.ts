import { describe, expect, it } from "vitest";
import type { OrgRole, ProjectRole } from "../enums";
import type { Subject } from "./decide";
import {
  hasGlobalOrgRole,
  isGlobalAdmin,
  mayAddMember,
  readsStaffDirectory,
  regionChangeRefusal,
  seesProject,
} from "./org";

const projectId = "project-a";
const north = { id: projectId, regionId: "region-north" };

function staff(
  options: {
    org?: [OrgRole, string[] | "all"][];
    projects?: Record<string, ProjectRole[]>;
    id?: string;
  } = {},
): Subject {
  return {
    kind: "staff",
    staffUserId: options.id ?? "staff-a",
    orgRoles: new Map(
      (options.org ?? []).map(([role, regions]) => [
        role,
        { regionIds: regions === "all" ? "all" : new Set(regions) },
      ]),
    ),
    projectRoles: Object.fromEntries(
      Object.entries(options.projects ?? {}).map(([id, roles]) => [id, new Set(roles)]),
    ),
    assignedParticipationIds: new Set(),
  };
}

const participant: Subject = {
  kind: "participant",
  participationId: "participation-a",
  knowledgeCheckPassed: true,
};
const admin = staff({ org: [["admin", "all"]] });
const regionalAdmin = staff({ org: [["regional_admin", ["region-north"]]] });
const operationsManager = staff({ org: [["regional_operations_manager", ["region-north"]]] });
const lead = staff({ projects: { [projectId]: ["project_lead"] } });
const consultant = staff({ projects: { [projectId]: ["consultant"] } });

describe("org administration (Q126)", () => {
  it("is the global admin's alone", () => {
    expect(isGlobalAdmin(admin)).toBe(true);
    for (const other of [regionalAdmin, operationsManager, lead, participant]) {
      expect(isGlobalAdmin(other)).toBe(false);
    }
    // An admin role scoped to regions is no global admin
    expect(isGlobalAdmin(staff({ org: [["admin", ["region-north"]]] }))).toBe(false);
  });

  it("opens the staff directory to those who build teams: a PL or the global admin", () => {
    expect(readsStaffDirectory(admin)).toBe(true);
    expect(readsStaffDirectory(lead)).toBe(true);
    for (const other of [regionalAdmin, operationsManager, consultant, participant]) {
      expect(readsStaffDirectory(other)).toBe(false);
    }
  });
});

describe("seesProject (Q106, Q126)", () => {
  it("knows the global org roles, which see every project", () => {
    expect(hasGlobalOrgRole(admin)).toBe(true);
    expect(hasGlobalOrgRole(staff({ org: [["regional_operations_manager", "all"]] }))).toBe(true);
    for (const other of [regionalAdmin, operationsManager, lead, participant]) {
      expect(hasGlobalOrgRole(other)).toBe(false);
    }
  });

  it("shows a project to global roles, its members and the regional roles of its region", () => {
    expect(seesProject(admin, north)).toBe(true);
    expect(seesProject(lead, north)).toBe(true);
    expect(seesProject(consultant, north)).toBe(true);
    expect(seesProject(regionalAdmin, north)).toBe(true);
    expect(seesProject(operationsManager, north)).toBe(true);
    const south = { id: "project-b", regionId: "region-south" };
    expect(seesProject(regionalAdmin, south)).toBe(false);
    expect(seesProject(operationsManager, south)).toBe(false);
    expect(seesProject(lead, south)).toBe(false);
    expect(seesProject(participant, north)).toBe(false);
  });

  it("shows a project without a region only to global roles and members", () => {
    const unassigned = { id: projectId, regionId: null };
    expect(seesProject(admin, unassigned)).toBe(true);
    expect(seesProject(staff({ org: [["regional_operations_manager", "all"]] }), unassigned)).toBe(
      true,
    );
    expect(seesProject(lead, unassigned)).toBe(true);
    expect(seesProject(regionalAdmin, unassigned)).toBe(false);
    expect(seesProject(operationsManager, unassigned)).toBe(false);
  });
});

describe("regionChangeRefusal (Q126)", () => {
  it("lets the PL change the region only while draft, the global admin at any time", () => {
    expect(regionChangeRefusal(lead, { ...north, status: "draft" })).toBeNull();
    expect(regionChangeRefusal(lead, { ...north, status: "active" })).toBe("project_not_draft");
    expect(regionChangeRefusal(admin, { ...north, status: "active" })).toBeNull();
    const both = staff({ org: [["admin", "all"]], projects: { [projectId]: ["project_lead"] } });
    expect(regionChangeRefusal(both, { ...north, status: "active" })).toBeNull();
  });

  it("refuses everyone else", () => {
    for (const other of [consultant, regionalAdmin, operationsManager, participant]) {
      expect(regionChangeRefusal(other, { ...north, status: "draft" })).toBe("forbidden");
    }
  });
});

const add = (subject: Subject, staffUserId: string, role: ProjectRole) =>
  mayAddMember(subject, north, { staffUserId, role });

describe("mayAddMember (Q126)", () => {
  it("lets the PL add any role, the global admin only another person as PL", () => {
    for (const role of ["project_lead", "consultant", "back_office"] as const) {
      expect(add(lead, "staff-b", role)).toBe(true);
    }
    expect(add(admin, "staff-b", "project_lead")).toBe(true);
    expect(add(admin, "staff-a", "project_lead")).toBe(false);
    expect(add(admin, "staff-b", "consultant")).toBe(false);
    expect(add(regionalAdmin, "staff-b", "project_lead")).toBe(false);
    expect(add(consultant, "staff-b", "consultant")).toBe(false);
    expect(add(participant, "staff-b", "consultant")).toBe(false);
  });
});
