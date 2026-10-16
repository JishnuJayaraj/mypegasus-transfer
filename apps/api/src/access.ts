import { eq, projectMembership, type Database } from "@transfer/db";
import { OrgRole, type ProjectRole, type StaffUser } from "@transfer/domain";
import { staffSubject, type StaffSubject } from "./participations/subjects";

/**
 * The access subject of a staff user (Slice 2 plan 5.4): project roles from `project_membership`
 * (zero or more per project, D6); an org role from the flat `StaffRole`, with global scope until
 * Slice 3 gives projects a region (round 18, reading 2); no participant assignments yet (Q62).
 */
export async function staffSubjectOf(db: Database, user: StaffUser): Promise<StaffSubject> {
  const rows = await db
    .select({ projectId: projectMembership.projectId, role: projectMembership.role })
    .from(projectMembership)
    .where(eq(projectMembership.staffUserId, user.id));
  const projectRoles: Record<string, ProjectRole[]> = {};
  for (const { projectId, role } of rows) (projectRoles[projectId] ??= []).push(role);
  const orgRole = OrgRole.safeParse(user.role);
  return staffSubject(user.id, projectRoles, orgRole.success ? { [orgRole.data]: "all" } : {});
}

/** A global org role sees every project's metadata, a member their projects' (Q106). */
export function hasGlobalOrgRole(subject: StaffSubject): boolean {
  return [...subject.orgRoles.values()].some(({ regionIds }) => regionIds === "all");
}

export function seesProject(subject: StaffSubject, projectId: string): boolean {
  return hasGlobalOrgRole(subject) || (subject.projectRoles[projectId]?.size ?? 0) > 0;
}

/** The stable code of a database function's refusal (`P0001`), or undefined. */
export function functionRefusal(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause ?? error;
  const { code, message } = cause as { code?: string; message?: string };
  return code === "P0001" ? message : undefined;
}
