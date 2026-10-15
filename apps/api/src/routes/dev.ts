import { createRoute, z } from "@hono/zod-openapi";
import { eq, staffUser } from "@transfer/db";
import { StaffUser } from "@transfer/domain";

import { createRouter, type Deps } from "../context";
import { problem, problemResponses } from "../problem";
import { clearSession, setSession } from "../session";

// Dev only: mounted when AUTH_MODE=dev, which the API refuses in production (env.ts).
const devOnly = { tags: ["dev"], "x-dev-only": true };
const staffUserColumns = {
  id: staffUser.id,
  displayName: staffUser.displayName,
  role: staffUser.role,
};

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
          content: { "application/json": { schema: z.array(StaffUser) } },
        },
      },
    }),
    async (c) =>
      c.json(await db.select(staffUserColumns).from(staffUser).orderBy(staffUser.id), 200),
  );

  router.openapi(
    createRoute({
      ...devOnly,
      method: "post",
      path: "/dev/session",
      summary: "Log in as a staff user (sets the session cookie)",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ staffUserId: z.uuid() }) } },
        },
      },
      responses: {
        204: { description: "Logged in" },
        ...problemResponses("validation-error", "not-found", "forbidden", "unsupported-media-type"),
      },
    }),
    async (c) => {
      const { staffUserId } = c.req.valid("json");
      const [user] = await db
        .select({ id: staffUser.id })
        .from(staffUser)
        .where(eq(staffUser.id, staffUserId));
      if (!user) return problem(c, "not-found");
      await setSession(c, deps, user.id);
      return c.body(null, 204);
    },
  );

  router.openapi(
    createRoute({
      ...devOnly,
      method: "delete",
      path: "/dev/session",
      summary: "Log out (clears the session cookie)",
      responses: { 204: { description: "Logged out" }, ...problemResponses("forbidden") },
    }),
    (c) => {
      clearSession(c);
      return c.body(null, 204);
    },
  );

  return router;
}
