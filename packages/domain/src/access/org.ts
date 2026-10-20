import type { ProjectRole } from "../enums";
import type { ProjectStatus } from "../project";
import type { Subject } from "./decide";
import { mayPerformOperation } from "./permissions";

/**
 * Org administration and project visibility (Q106, Q126; data-protection.md, access matrix).
 * Accounts, org roles, `mayCreateProjects` and regions are the global admin's alone; regional
 * roles see the projects of their regions; a project without a region only global roles see.
 */

type Project = { id: string; regionId: string | null };

const staffOf = (subject: Subject) => (subject.kind === "staff" ? subject : undefined);

/**
 * Holds `admin` for all regions (the only admin there is: `admin` is never region-scoped). Staff
 * accounts, org roles and the regions are administered by the global admin alone (Q126).
 */
export const isGlobalAdmin = (subject: Subject) =>
  staffOf(subject)?.orgRoles.get("admin")?.regionIds === "all";

/** An org role for all regions sees every project's metadata (Q106). */
export const hasGlobalOrgRole = (subject: Subject) =>
  [...(staffOf(subject)?.orgRoles.values() ?? [])].some(({ regionIds }) => regionIds === "all");

/** Members see their projects, org roles the projects of their regions, global roles all. */
export function seesProject(subject: Subject, project: Project): boolean {
  const staff = staffOf(subject);
  if (!staff) return false;
  if ((staff.projectRoles[project.id]?.size ?? 0) > 0) return true;
  return [...staff.orgRoles.values()].some(
    ({ regionIds }) =>
      regionIds === "all" || (project.regionId !== null && regionIds.has(project.regionId)),
  );
}

/** The member pickers' directory: whoever may build a team, a PL anywhere or the global admin. */
export function readsStaffDirectory(subject: Subject): boolean {
  const staff = staffOf(subject);
  if (!staff) return false;
  const leads = Object.values(staff.projectRoles).some((roles) => roles.has("project_lead"));
  return leads || isGlobalAdmin(subject);
}

const target = (project: Project) => ({
  projectId: project.id,
  regionId: project.regionId,
  participationId: null,
});

/** Whether the region may change now: the PL only while draft, the global admin at any time. */
export function regionChangeRefusal(
  subject: Subject,
  project: Project & { status: ProjectStatus },
): "forbidden" | "project_not_draft" | null {
  if (!mayPerformOperation(subject, { kind: "setProjectRegion" }, target(project)).ok) {
    return "forbidden";
  }
  return project.status === "draft" || isGlobalAdmin(subject) ? null : "project_not_draft";
}

/** The PL adds any member; a global admin only a replacement PL other than themselves (Q126). */
export function mayAddMember(
  subject: Subject,
  project: Project,
  member: { staffUserId: string; role: ProjectRole },
): boolean {
  if (mayPerformOperation(subject, { kind: "manageMembers" }, target(project)).ok) return true;
  return (
    member.role === "project_lead" &&
    mayPerformOperation(
      subject,
      { kind: "addReplacementLead", staffUserId: member.staffUserId },
      target(project),
    ).ok
  );
}
