import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql, staffUser } from "@transfer/db";
import { DevStaffUser, staffRoleLabel, type OrgRole, type ProjectRole } from "@transfer/domain";

import { createRouter, type Deps } from "../context";
import { domainProblem, problem, problemResponses } from "../problem";
import { endSession } from "../session";
import { loginAsDevUser } from "../staff-login";

// Dev only: mounted when AUTH_MODE=dev, which the API refuses in production (env.ts).
const devOnly = { tags: ["dev"], "x-dev-only": true };

export function devRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();

  router.openapi(
    createRoute({
      ...devOnly,
      method: "get",
      path: "/dev/staff-users",
      summary: "Synthetic staff users for the dev user switcher",
      responses: {
        200: {
          description: "All staff users",
          content: { "application/json": { schema: z.array(DevStaffUser) } },
        },
      },
    }),
    async (c) => {
      // Each with the role it is best known by, for "Name · Rolle" (no flat role since Q126).
      const users = await db
        .select({
          id: staffUser.id,
          displayName: staffUser.displayName,
          mayCreateProjects: staffUser.mayCreateProjects,
          orgRoles: sql<
            OrgRole[]
          >`array(select distinct r.role::text from staff_org_role r where r.staff_user_id = staff_user.id)`,
          projectRoles: sql<
            ProjectRole[]
          >`array(select distinct m.role::text from project_membership m where m.staff_user_id = staff_user.id)`,
        })
        .from(staffUser)
        .orderBy(staffUser.id);
      return c.json(
        users.map(({ id, displayName, ...roles }) => ({
          id,
          displayName,
          role: staffRoleLabel(roles),
        })),
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      ...devOnly,
      method: "post",
      path: "/dev/session",
      summary: "Log in as a staff user: a session in the store, as an OIDC login starts one",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ staffUserId: z.uuid() }) } },
        },
      },
      responses: {
        204: { description: "Logged in" },
        ...problemResponses(
          "validation-error",
          "not-found",
          "forbidden",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { staffUserId } = c.req.valid("json");
      const [user] = await db
        .select({ id: staffUser.id })
        .from(staffUser)
        .where(eq(staffUser.id, staffUserId));
      if (!user) return problem(c, "not-found");
      const result = await loginAsDevUser(c, deps, user.id);
      return result.ok ? c.body(null, 204) : domainProblem(c, [result.code]);
    },
  );

  router.openapi(
    createRoute({
      ...devOnly,
      method: "delete",
      path: "/dev/session",
      summary: "Log out: ends the session, as `POST /auth/logout` does",
      responses: { 204: { description: "Logged out" }, ...problemResponses("forbidden") },
    }),
    async (c) => {
      await endSession(c, deps);
      return c.body(null, 204);
    },
  );

  return router;
}
