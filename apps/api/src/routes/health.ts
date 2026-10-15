import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "@transfer/db";
import packageJson from "../../package.json" with { type: "json" };
import { createRouter, type Deps } from "../context";
import { problem, problemResponses } from "../problem";

const Health = z.object({ status: z.literal("ok"), version: z.string() });

export function healthRoutes({ db }: Deps) {
  const router = createRouter();

  router.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags: ["health"],
      summary: "Liveness",
      responses: {
        200: { description: "The API runs", content: { "application/json": { schema: Health } } },
      },
    }),
    (c) => c.json({ status: "ok" as const, version: packageJson.version }, 200),
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/health/ready",
      tags: ["health"],
      summary: "Readiness: the database answers",
      responses: {
        200: { description: "Ready", content: { "application/json": { schema: Health } } },
        ...problemResponses("service-unavailable"),
      },
    }),
    async (c) => {
      try {
        await db.execute(sql`select 1`);
      } catch {
        return problem(c, "service-unavailable");
      }
      return c.json({ status: "ok" as const, version: packageJson.version }, 200);
    },
  );

  return router;
}
