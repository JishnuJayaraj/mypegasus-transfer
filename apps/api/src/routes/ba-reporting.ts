import { createRoute, z } from "@hono/zod-openapi";
import { baReportingTask, eq, sql } from "@transfer/db";
import { BaReportInput, mayReadBaReportingTasks, mayRecordBaReport } from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// Closing a BA reporting task (process-and-lifecycle.md, BA reporting; ADR-0010; D28, Q111, Q207):
// "Gemeldet am" or "Nicht erforderlich" on the overview's "BA-Meldungen". Order as in ADR-0010:
// schema → visibility (404: a task of a hidden project, or one the viewer doesn't read, whatever
// its state) → permission (403: the PL or back office, never a consultant) → state (422). The
// function checks the role and the state again under the participation's lock. No setting is
// read. Logs carry ids and codes only.

const TaskParams = z.object({ taskId: z.uuid() });

/** The function's refusals as their problems (allowlisted), or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code === "task_not_found") return problem(c, "not-found");
  if (code === "date_in_future" || code === "date_before_task") {
    return domainProblem(c, [{ code, field: "reportedOn" }]);
  }
  if (code === "already_recorded") return domainProblem(c, [code]);
  throw error;
}

export function baReportingRoutes(deps: Deps) {
  const { db, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  router.openapi(
    createRoute({
      method: "post",
      path: "/ba-reporting-tasks/{taskId}/outcome",
      tags: ["participations"],
      summary:
        '"Gemeldet am" or "Nicht erforderlich" (the PL or back office): closes a pending BA reporting task once, with the actual sent date (from the task\'s day to today) or a closed reason; never edited afterwards',
      middleware,
      request: {
        params: TaskParams,
        body: { required: true, content: { "application/json": { schema: BaReportInput } } },
      },
      responses: {
        204: { description: "Recorded" },
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
      const { taskId } = c.req.valid("param");
      const input = c.req.valid("json");
      const [task] = await db
        .select({
          participationId: baReportingTask.participationId,
          projectId: baReportingTask.projectId,
        })
        .from(baReportingTask)
        .where(eq(baReportingTask.id, taskId));
      if (!task) return problem(c, "not-found") as never;
      const { subject, visible, regionId } = await projectAccess(
        db,
        sessionUser(c),
        task.projectId,
      );
      if (!visible || !mayReadBaReportingTasks(subject, task.projectId, task.participationId)) {
        return problem(c, "not-found") as never;
      }
      const target = { projectId: task.projectId, regionId, participationId: task.participationId };
      if (!mayRecordBaReport(subject, target).ok) return problem(c, "forbidden") as never;
      try {
        await db.execute(
          sql`select record_ba_report(
            p_context => ${auditContext(sessionUser(c).id, c.get("requestId") as string)},
            p_task_id => ${taskId}::uuid, p_outcome => ${input.outcome}::ba_reporting_status,
            p_reported_on => ${input.outcome === "reported" ? input.reportedOn : null}::date,
            p_reason => ${input.outcome === "not_required" ? input.reason : null}::ba_report_not_required_reason)`,
        );
      } catch (error) {
        return refused(c, error) as never;
      }
      logger.info(
        { requestId: c.get("requestId"), taskId, outcome: input.outcome },
        "ba report recorded",
      );
      return c.body(null, 204) as never;
    },
  );

  return router;
}
