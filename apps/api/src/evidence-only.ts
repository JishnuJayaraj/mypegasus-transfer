import { eq, participation } from "@transfer/db";
import type { MiddlewareHandler } from "hono";
import { projectAccess } from "./access";
import type { AppEnv, Deps } from "./context";
import { problem } from "./problem";
import { requireSession, sessionUser } from "./session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Ordinary reads and writes of a participation in the evidence-only phase are refused
 * (data-protection.md, the evidence-only phase; Q64): access is break-glass only, which isn't
 * built. After visibility (a hidden participation stays the route's 404), before the route:
 * `403 evidence_set_phase`. Its legal holds stay readable and placeable.
 */
export function evidenceOnlyGuard(deps: Deps): MiddlewareHandler<AppEnv> {
  const session = requireSession(deps);
  return async (c, next) => {
    const id = c.req.param("participationId");
    if (!id || !UUID.test(id) || /\/legal-holds$/.test(c.req.path)) return next();
    const [found] = await deps.db
      .select({ projectId: participation.projectId, since: participation.evidenceSetSince })
      .from(participation)
      .where(eq(participation.id, id));
    if (!found || found.since === null) return next();
    let visible = false;
    const refused = await session(c, async () => {
      visible = (await projectAccess(deps.db, sessionUser(c), found.projectId)).visible;
    });
    if (refused) return refused;
    if (!visible) return next();
    deps.logger.info(
      { requestId: c.get("requestId"), participationId: id, outcome: "evidence_set_phase" },
      "participation read",
    );
    return problem(c, "forbidden", {
      errors: [{ pointer: "/", code: "evidence_set_phase", detail: "Break-glass access only" }],
    });
  };
}
