import { eq, project, projectMembership, type Database } from "@transfer/db";
import {
  mayCreateProject,
  mayPerformOperation,
  OrgRole,
  type Operation,
  type ProjectRole,
  type StaffUser,
} from "@transfer/domain";
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

/**
 * Who reads the global template catalog (plan 5.8; Q108, confirmed in round 25): those who
 * choose or pin templates, i.e. the flat role `project_lead` (creates projects and chooses their
 * Project Agentur, R9, R12) and the PL of any project (`pinTemplate`), and the global org roles,
 * who see every project's configuration (Q106). Other members only see their projects' pins.
 */
export function readsTemplateCatalog(subject: StaffSubject, user: StaffUser): boolean {
  return (
    mayCreateProject(user.role) ||
    hasGlobalOrgRole(subject) ||
    Object.values(subject.projectRoles).some((roles) => roles.has("project_lead"))
  );
}

/** The user's subject, and whether the project exists and they may see it (else a 404). */
export async function projectAccess(db: Database, user: StaffUser, projectId: string) {
  const subject = await staffSubjectOf(db, user);
  if (!seesProject(subject, projectId)) return { subject, visible: false };
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.id, projectId));
  return { subject, visible: found !== undefined };
}

/** Whether `subject` may perform a project-level operation in the project (5.4). */
const mayIn = (subject: StaffSubject, projectId: string, operation: Operation) =>
  mayPerformOperation(subject, operation, { projectId, regionId: null, participationId: null }).ok;

/**
 * Which of `kinds` the user may perform in the project, as the server-derived capabilities the
 * UI follows (round 26); undefined when they can't see it (a 404).
 */
export async function projectOperations<K extends Extract<Operation, { kind: string }>["kind"]>(
  db: Database,
  user: StaffUser,
  projectId: string,
  kinds: readonly K[],
): Promise<Record<K, boolean> | undefined> {
  const { subject, visible } = await projectAccess(db, user, projectId);
  if (!visible) return undefined;
  return Object.fromEntries(
    kinds.map((kind) => [kind, mayIn(subject, projectId, { kind } as Operation)]),
  ) as Record<K, boolean>;
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
  const { subject, visible } = await projectAccess(db, user, projectId);
  if (!visible) return "not-found";
  if (operation && !mayIn(subject, projectId, operation)) return "forbidden";
  return undefined;
}
