import { createRoute, z } from "@hono/zod-openapi";
import { asc, eq, participation, projectMembership, sql, staffUser } from "@transfer/db";
import {
  AddMemberInput,
  AssignmentResult,
  AssignParticipationsInput,
  mayAddMember,
  mayPerformOperation,
  ProjectRole,
  ProjectTeam,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess, projectTarget } from "../access";
import { createRouter, json, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext, callFunction } from "../sql";

// A project's team and the participant assignments (Q61, Q62, Q126; data-protection.md, access
// matrix): the PL adds and removes members and their project roles and assigns participations to
// the project's consultants; a global admin may add a replacement PL, never themselves. The
// functions re-check the actor and write the audit events; access follows at the next request.

const ProjectParams = z.object({ projectId: z.uuid() });
const MemberParams = z.object({ projectId: z.uuid(), staffUserId: z.uuid(), role: ProjectRole });
const AssignmentParams = z.object({ participationId: z.uuid(), staffUserId: z.uuid() });

/** A function's refusal, if it is one of `codes`; anything else propagates (a 500). */
function refusalIn(error: unknown, codes: readonly string[]) {
  const code = functionRefusal(error);
  if (code !== undefined && codes.includes(code)) return code;
  throw error;
}

/** Where a refusal points in the body (ADR-0010). */
const fieldOf: Record<string, string> = {
  unknown_account: "staffUserId",
  account_deactivated: "staffUserId",
  not_consultant: "staffUserId",
  participation_not_found: "participationIds",
};
const asProblem = (c: Context, code: string) =>
  domainProblem(c, [{ code, field: fieldOf[code] ?? null }]);

export function teamRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  /** The members with their roles, and what the viewer may do (capabilities, round 26). */
  async function teamOf(user: StaffUser, projectId: string) {
    const { subject, visible, regionId } = await projectAccess(db, user, projectId);
    if (!visible) return undefined;
    const members = await db
      .select({
        staffUserId: projectMembership.staffUserId,
        displayName: staffUser.displayName,
        roles: sql<
          ProjectRole[]
        >`array_agg(${projectMembership.role}::text order by ${projectMembership.role})`,
        deactivated: sql<boolean>`${staffUser.deactivatedAt} is not null`,
      })
      .from(projectMembership)
      .innerJoin(staffUser, eq(staffUser.id, projectMembership.staffUserId))
      .where(eq(projectMembership.projectId, projectId))
      .groupBy(projectMembership.staffUserId, staffUser.id)
      .orderBy(asc(staffUser.displayName), asc(projectMembership.staffUserId));
    const target = projectTarget(projectId, regionId);
    const may = (operation: Parameters<typeof mayPerformOperation>[1]) =>
      mayPerformOperation(subject, operation, target).ok;
    return {
      members,
      capabilities: {
        manageMembers: may({ kind: "manageMembers" }),
        // For someone else: nobody adds themselves as a replacement (Q126).
        addReplacementLead: may({ kind: "addReplacementLead", staffUserId: "" }),
        assignParticipations: may({ kind: "assignParticipations" }),
      },
    };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/members",
      tags: ["team"],
      summary: "The project's members with their project roles, and the viewer's capabilities",
      middleware,
      request: { params: ProjectParams },
      responses: {
        200: json(ProjectTeam, "The team"),
        ...problemResponses("validation-error", "unauthenticated", "not-found"),
      },
    }),
    async (c) => {
      const team = await teamOf(sessionUser(c), c.req.valid("param").projectId);
      return team ? c.json(team, 200) : problem(c, "not-found");
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/members",
      tags: ["team"],
      summary:
        "Add a project role for a staff member (the PL; a global admin only a replacement PL other than themselves)",
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: AddMemberInput } } },
      },
      responses: {
        201: json(ProjectTeam, "The team"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { subject, visible, regionId } = await projectAccess(db, user, projectId);
      if (!visible) return problem(c, "not-found");
      if (!mayAddMember(subject, { id: projectId, regionId }, input)) {
        return problem(c, "forbidden");
      }
      const refused = await callFunction(
        db,
        sql`add_project_member(p_project_id => ${projectId}::uuid,
          p_staff_user_id => ${input.staffUserId}::uuid, p_role => ${input.role}::project_role,
          p_context => ${auditContext(user.id, c.get("requestId"))})`,
      ).then(
        () => null,
        (error: unknown) =>
          refusalIn(error, ["unknown_account", "account_deactivated", "membership_exists"]),
      );
      if (refused) return asProblem(c, refused);
      return c.json((await teamOf(user, projectId))!, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/projects/{projectId}/members/{staffUserId}/{role}",
      tags: ["team"],
      summary:
        "Remove a member's project role (the PL); never the last active PL; removing consultant ends their assignments",
      middleware,
      request: { params: MemberParams },
      responses: {
        204: { description: "Removed" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { projectId, staffUserId, role } = c.req.valid("param");
      const { subject, visible, regionId } = await projectAccess(db, user, projectId);
      if (!visible) return problem(c, "not-found");
      const target = projectTarget(projectId, regionId);
      if (!mayPerformOperation(subject, { kind: "manageMembers" }, target).ok) {
        return problem(c, "forbidden");
      }
      const refused = await callFunction(
        db,
        sql`remove_project_member(p_project_id => ${projectId}::uuid,
          p_staff_user_id => ${staffUserId}::uuid, p_role => ${role}::project_role,
          p_context => ${auditContext(user.id, c.get("requestId"))})`,
      ).then(
        () => null,
        (error: unknown) => refusalIn(error, ["membership_not_found", "last_project_lead"]),
      );
      if (refused === "membership_not_found") return problem(c, "not-found");
      if (refused) return asProblem(c, refused);
      return c.body(null, 204);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/assignments",
      tags: ["team"],
      summary:
        "Assign up to 500 participations to a consultant of the project (the PL), all or nothing; already assigned ones stay",
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: AssignParticipationsInput } },
        },
      },
      responses: {
        200: json(AssignmentResult, "The number of new assignments"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { projectId } = c.req.valid("param");
      const { staffUserId, participationIds } = c.req.valid("json");
      const { subject, visible, regionId } = await projectAccess(db, user, projectId);
      if (!visible) return problem(c, "not-found");
      const target = projectTarget(projectId, regionId);
      if (!mayPerformOperation(subject, { kind: "assignParticipations" }, target).ok) {
        return problem(c, "forbidden");
      }
      const result = await callFunction(
        db,
        sql`assign_participations(p_project_id => ${projectId}::uuid,
          p_staff_user_id => ${staffUserId}::uuid,
          p_participation_ids => ${`{${participationIds.join(",")}}`}::uuid[],
          p_context => ${auditContext(user.id, c.get("requestId"))})`,
      ).catch((error: unknown) => ({
        refused: refusalIn(error, ["not_consultant", "participation_not_found"]),
      }));
      if (typeof result === "object") return asProblem(c, result.refused);
      return c.json({ assigned: Number(result) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/participations/{participationId}/assignments/{staffUserId}",
      tags: ["team"],
      summary: "Close a consultant's assignment (the PL); their access ends with the next request",
      middleware,
      request: { params: AssignmentParams },
      responses: {
        204: { description: "Unassigned" },
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { participationId, staffUserId } = c.req.valid("param");
      // Visibility first, so a hidden participation is a 404.
      const [found] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      const access = found && (await projectAccess(db, user, found.projectId));
      if (!found || !access?.visible) return problem(c, "not-found");
      const target = projectTarget(found.projectId, access.regionId, participationId);
      if (!mayPerformOperation(access.subject, { kind: "assignParticipations" }, target).ok) {
        return problem(c, "forbidden");
      }
      const refused = await callFunction(
        db,
        sql`unassign_participation(p_participation_id => ${participationId}::uuid,
          p_staff_user_id => ${staffUserId}::uuid,
          p_context => ${auditContext(user.id, c.get("requestId"))})`,
      ).then(
        () => null,
        (error: unknown) => refusalIn(error, ["assignment_not_found"]),
      );
      return refused ? problem(c, "not-found") : c.body(null, 204);
    },
  );

  return router;
}
