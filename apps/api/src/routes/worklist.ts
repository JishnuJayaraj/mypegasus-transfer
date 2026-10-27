import { createRoute, z } from "@hono/zod-openapi";
import {
  EntryWaveAssignmentsInput,
  EntryWaveAssignmentsResult,
  mayPerformOperation,
  ProjectDashboard,
  projectFunnel,
  Worklist,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess, projectTarget } from "../access";
import { createRouter, json, type Deps } from "../context";
import { dbGuardFacts } from "../participations/guard-facts";
import {
  BulkRefusal,
  createStatusService,
  StatusServiceError,
} from "../participations/status-service";
import { loadWorklist, type WorklistResult } from "../participations/worklist";
import { loadRelease } from "../projects/template-pins";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";

// The dashboard, the work list and the bulk wave assignment (data-protection.md, the work list and
// the dashboard; process-and-lifecycle.md, assigning a wave). Both reads are one snapshot of the
// viewer's scope; neither is cached by the browser or a proxy, nor logged beyond the route.

const ProjectParams = z.object({ projectId: z.uuid() });

/** The problem of a snapshot that isn't there: 404, 403 or 422 `worklist_too_large`. */
function refused(c: Context, result: Exclude<WorklistResult, { kind: "ok" }>) {
  if (result.kind === "not_found") return problem(c, "not-found");
  if (result.kind === "forbidden") return problem(c, "forbidden");
  return domainProblem(c, ["worklist_too_large"]);
}

export function worklistRoutes(deps: Deps) {
  const { db, clock } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const release = loadRelease(deps.env.configDir);
  const facts = deps.facts ?? dbGuardFacts;
  const statusService = createStatusService({ db, clock, facts });
  const snapshot = (c: Context, projectId: string) =>
    loadWorklist({ db, clock, release, facts }, sessionUser(c), projectId);

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/dashboard",
      tags: ["worklist"],
      summary:
        "The project's dashboard: exact counts of distinct participations in the viewer's scope, each with its work list filter",
      middleware,
      request: { params: ProjectParams },
      responses: {
        200: json(ProjectDashboard, "The counts"),
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
      const result = await snapshot(c, c.req.valid("param").projectId);
      if (result.kind !== "ok") return refused(c, result);
      c.header("Cache-Control", "private, no-store");
      const { scope, generatedAt, project, items } = result;
      return c.json({ scope, generatedAt, counts: projectFunnel(items, project) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/worklist",
      tags: ["worklist"],
      summary:
        "The work list: every participation of the viewer's scope in one snapshot (no cursor), at most 5,000",
      middleware,
      request: { params: ProjectParams },
      responses: {
        200: json(Worklist, "The snapshot"),
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
      const result = await snapshot(c, c.req.valid("param").projectId);
      if (result.kind !== "ok") return refused(c, result);
      c.header("Cache-Control", "private, no-store");
      return c.json({ generatedAt: result.generatedAt, items: result.items }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/entry-wave-assignments",
      tags: ["worklist"],
      summary:
        "Assign one wave to up to 500 participations (the PL), all or nothing; those already in it stay",
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: EntryWaveAssignmentsInput } },
        },
      },
      responses: {
        200: json(EntryWaveAssignmentsResult, "The assigned and unchanged participations"),
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
      const { subject, visible, regionId } = await projectAccess(db, user, projectId);
      if (!visible) return problem(c, "not-found");
      const target = projectTarget(projectId, regionId);
      if (!mayPerformOperation(subject, { kind: "assignEntryWave" }, target).ok) {
        return problem(c, "forbidden");
      }
      try {
        const result = await statusService.assignEntryWaves(
          subject,
          { projectId, ...c.req.valid("json") },
          { requestId: c.get("requestId") },
        );
        return c.json(result, 200);
      } catch (error) {
        if (error instanceof BulkRefusal) {
          return domainProblem(
            c,
            error.rows.map(({ index, code }) => ({ code, field: `participationIds/${index}` })),
          );
        }
        if (!(error instanceof StatusServiceError)) throw error;
        if (error.kind === "forbidden") return problem(c, "forbidden");
        const field = error.code === "wave_of_other_project" ? "waveId" : null;
        return domainProblem(c, [{ code: error.code, field }]);
      }
    },
  );

  return router;
}
