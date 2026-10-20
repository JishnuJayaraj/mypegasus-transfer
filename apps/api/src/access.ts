import {
  and,
  eq,
  isNull,
  participantAssignment,
  project,
  projectMembership,
  type Database,
} from "@transfer/db";
import {
  isGlobalAdmin,
  mayPerformOperation,
  seesProject,
  type Operation,
  type OrgRole,
  type ProjectRole,
  type StaffUser,
} from "@transfer/domain";
import { staffSubject, type StaffSubject } from "./participations/subjects";

/**
 * The access subject of a staff user, loaded per request so a change takes effect at the next one
 * (Q62, Q126): project roles from `project_membership` (zero or more per project, D6), org roles
 * from the session's `staff_org_role` rows (`admin` for all regions, the regional roles for theirs)
 * and the open participant assignments.
 */
export async function staffSubjectOf(db: Database, user: StaffUser): Promise<StaffSubject> {
  const [memberships, assignments] = await Promise.all([
    db
      .select({ projectId: projectMembership.projectId, role: projectMembership.role })
      .from(projectMembership)
      .where(eq(projectMembership.staffUserId, user.id)),
    db
      .select({ participationId: participantAssignment.participationId })
      .from(participantAssignment)
      .where(
        and(eq(participantAssignment.staffUserId, user.id), isNull(participantAssignment.endedAt)),
      ),
  ]);
  const projectRoles: Record<string, ProjectRole[]> = {};
  for (const { projectId, role } of memberships) (projectRoles[projectId] ??= []).push(role);
  const orgRoles: Partial<Record<OrgRole, "all" | string[]>> = {};
  for (const { role, regionId } of user.orgRoles) {
    const held = orgRoles[role];
    if (regionId === null || held === "all") orgRoles[role] = "all";
    else orgRoles[role] = [...(held ?? []), regionId];
  }
  return staffSubject(
    user.id,
    projectRoles,
    orgRoles,
    assignments.map(({ participationId }) => participationId),
  );
}

/**
 * Who reads the global template catalog (plan 5.8; Q108, confirmed in round 25): those who
 * choose or pin templates, i.e. staff who may create projects (and choose their Project Agentur,
 * R9, R12) and the PL of any project (`pinTemplate`), and the org roles, who see the
 * configuration of every project in their scope (Q106; the catalog itself is global reference
 * data). Other members only see their projects' pins.
 */
export function readsTemplateCatalog(subject: StaffSubject, user: StaffUser): boolean {
  return (
    user.mayCreateProjects ||
    subject.orgRoles.size > 0 ||
    Object.values(subject.projectRoles).some((roles) => roles.has("project_lead"))
  );
}

/** A permission target in a project of `regionId` (the project's region, Q126). */
export const projectTarget = (
  projectId: string,
  regionId: string | null,
  participationId: string | null = null,
) => ({ projectId, regionId, participationId });

/**
 * The user's subject, and whether the project exists and they may see it (else a 404): members,
 * the org roles of its region and global roles (Q106, Q126). With the project's region for the
 * permission targets.
 */
export async function projectAccess(db: Database, user: StaffUser, projectId: string) {
  const [subject, [found]] = await Promise.all([
    staffSubjectOf(db, user),
    db.select({ regionId: project.regionId }).from(project).where(eq(project.id, projectId)),
  ]);
  const regionId = found?.regionId ?? null;
  const visible = found !== undefined && seesProject(subject, { id: projectId, regionId });
  return { subject, visible, regionId };
}

/**
 * The user's operation check in a project, and whether they hold the global admin role (who
 * changes a region at any time, Q126).
 */
export type ProjectPermissions = ((operation: Operation) => boolean) & { globalAdmin: boolean };

/**
 * The user's operation check in a project, from which the server derives the capabilities the UI
 * follows (round 26); undefined when they can't see it (a 404).
 */
export async function projectPermissions(
  db: Database,
  user: StaffUser,
  projectId: string,
): Promise<ProjectPermissions | undefined> {
  const { subject, visible, regionId } = await projectAccess(db, user, projectId);
  if (!visible) return undefined;
  const may = (operation: Operation) =>
    mayPerformOperation(subject, operation, projectTarget(projectId, regionId)).ok;
  return Object.assign(may, { globalAdmin: isGlobalAdmin(subject) });
}

/**
 * Whether the user may read the project's setup (members and global org roles, R9) or, with an
 * operation, perform it (5.4): undefined, else the problem type. A project the user can't see is
 * a 404, so its existence isn't revealed; a visible one they may not change is a 403.
 */
export async function projectDenial(
  db: Database,
  user: StaffUser,
  projectId: string,
  operation?: Operation,
): Promise<"not-found" | "forbidden" | undefined> {
  const may = await projectPermissions(db, user, projectId);
  if (!may) return "not-found";
  if (operation && !may(operation)) return "forbidden";
  return undefined;
}
