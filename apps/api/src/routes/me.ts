import { createRoute } from "@hono/zod-openapi";
import { StaffUser } from "@transfer/domain";
import { createRouter, type Deps } from "../context";
import { problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";

export function meRoutes(deps: Deps) {
  const router = createRouter();
  router.openapi(
    createRoute({
      method: "get",
      path: "/me",
      tags: ["session"],
      summary: "The current staff user",
      middleware: [requireSession(deps)],
      responses: {
        200: {
          description: "The current staff user",
          content: { "application/json": { schema: StaffUser } },
        },
        ...problemResponses("unauthenticated"),
      },
    }),
    (c) => c.json(sessionUser(c), 200),
  );
  return router;
}
