import type { OrgRole, ProjectRole, Subject } from "@transfer/domain";

export type StaffSubject = Extract<Subject, { kind: "staff" }>;

/**
 * Builds a staff subject for the access checks. Until Slice 3 brings memberships, assignments and
 * regions, the caller (the seed, tests) states them explicitly.
 */
export function staffSubject(
  staffUserId: string,
  projectRoles: Readonly<Record<string, readonly ProjectRole[]>>,
  orgRoles: Partial<Record<OrgRole, "all" | readonly string[]>> = {},
  assignedParticipationIds: readonly string[] = [],
): StaffSubject {
  return {
    kind: "staff",
    staffUserId,
    orgRoles: new Map(
      Object.entries(orgRoles).map(([role, regions]) => [
        role as OrgRole,
        { regionIds: regions === "all" ? "all" : new Set(regions) },
      ]),
    ),
    projectRoles: Object.fromEntries(
      Object.entries(projectRoles).map(([projectId, roles]) => [projectId, new Set(roles)]),
    ),
    assignedParticipationIds: new Set(assignedParticipationIds),
  };
}
