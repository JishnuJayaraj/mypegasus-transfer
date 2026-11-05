import { createRoute } from "@hono/zod-openapi";
import { Escalations } from "@transfer/domain";
import { createRouter, json, type Deps } from "../context";
import { loadEscalations } from "../participations/escalations";
import { dbGuardFacts } from "../participations/guard-facts";
import { problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";

// The regional view of escalations (data-protection.md, the regional view; process-and-lifecycle.md,
// TL 407 submission; Q57): a regional admin sees the projects of their regions, a global admin
// every project; per project its PLs and, per type, the count and the days overdue of the oldest.
// Never a participant. Nobody else has the view (403); not cached.

export function escalationRoutes(deps: Deps) {
  const { db, clock } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const facts = deps.facts ?? dbGuardFacts;

  router.openapi(
    createRoute({
      method: "get",
      path: "/escalations",
      tags: ["worklist"],
      summary:
        "The regional admin's escalations: per visible TG project its PLs and, per type (tl407_not_submitted, profiling_compliance), how many participations and the days overdue of the oldest; never a participant",
      middleware,
      responses: {
        200: json(Escalations, "The counts"),
        ...problemResponses("unauthenticated", "forbidden"),
      },
    }),
    async (c) => {
      const result = await loadEscalations({ db, clock, facts }, sessionUser(c));
      if (result.kind === "forbidden") return problem(c, "forbidden") as never;
      c.header("Cache-Control", "no-store");
      return c.json({ generatedAt: result.generatedAt, rows: result.rows }, 200);
    },
  );

  return router;
}
