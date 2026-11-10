import { createRoute, z } from "@hono/zod-openapi";
import { sql, transactionWithClient } from "@transfer/db";
import {
  ReconciliationReplyRequest,
  ReconciliationReviewRequest,
  TgEntryReconciliationRequest,
  TgEntryReconciliationState,
  maySeeReview,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { dbGuardFacts } from "../participations/guard-facts";
import { loadReconciliation } from "../participations/reconciliation";
import { createStatusService, StatusServiceError } from "../participations/status-service";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// The reconciliation of a missed TG entry, its review, the PL's reply and the resolution
// (process-and-lifecycle.md, the reconciliation; Q68 case 2, Q80, Q216). Order as in ADR-0010:
// schema → visibility (404) → permission (403) → state (409 for what moved since it was read, 422
// for a domain rule). The functions check roles and state again under the locks. Logs carry ids
// and codes only, never a documented source.

const ParticipationParams = z.object({ participationId: z.uuid() });
const ReconciliationParams = z.object({ reconciliationId: z.uuid() });

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

/** Where a refusal points in the request body. */
const pointerOf: Record<string, string> = {
  stale_status: "/statusVersion",
  stale_status_version: "/statusVersion",
  source_changed: "/evidence",
  evidence_after_tg_start: "/evidence",
  evidence_incomplete: "/evidence",
  confirmation_required: "/confirmed",
  stale_reconciliation: "/revision",
  outcome_not_allowed: "/outcome",
};

const conflict = (c: Context<AppEnv>, code: string) =>
  problem(c, "conflict", {
    errors: [{ pointer: pointerOf[code] ?? "", code, detail: "Read the reconciliation again" }],
  });

const reviewDomainCodes = new Set(["not_awaiting", "outcome_not_allowed", "invalid_argument"]);

/** The review and reply functions' refusals as their problems (allowlisted), or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "actor_not_allowed" || code === "four_eyes") {
    return problem(c, "forbidden", {
      errors: [{ pointer: "", code, detail: "Not yours to record" }],
    });
  }
  if (code === "reconciliation_not_found") return problem(c, "not-found");
  if (code === "stale_reconciliation") return conflict(c, code);
  if (code !== undefined && reviewDomainCodes.has(code)) {
    return domainProblem(c, [{ code, field: pointerOf[code]?.slice(1) ?? null }]);
  }
  throw error;
}

export function reconciliationRoutes(deps: Deps) {
  const { db, clock, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const service = createStatusService({ db, clock, facts: deps.facts ?? dbGuardFacts });

  async function stateOrProblem(c: Context<AppEnv>, participationId: string) {
    const result = await loadReconciliation({ db, service }, sessionUser(c), participationId);
    if (result.kind !== "ok") {
      const response = problem(c, result.kind === "not_found" ? "not-found" : "forbidden");
      return { ok: false as const, response };
    }
    return { ok: true as const, state: result.state, subject: result.subject };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/tg-entry-reconciliation",
      tags: ["participations"],
      summary:
        "The reconciliation of a missed TG entry (the PL and back office): the effective TG start, the evidence of every entry fact with its actual day and when it was recorded (the complete packet, the ASU registration with proof, the TL 407 or the approved exception), what doesn't hold on the TG start, why the reconciliation is closed now, the recorded reconciliation with its review's steps, and the viewer's capabilities",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(TgEntryReconciliationState, "The reconciliation as the viewer may work it"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const result = await stateOrProblem(c, participationId);
      if (!result.ok) return result.response as never;
      c.header("Cache-Control", "no-store");
      return c.json(result.state, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/tg-entry-reconciliation",
      tags: ["participations"],
      summary:
        "Enter a missed participation with its TG start as the effective date (the project's PL; Q68 case 2): for an informed ta_tg participation after its effective TG start, or on it once that day's lifecycle run completed, when every entry fact was valid on the TG start though recorded later. The request names the evidence the dialog listed, the status version read and the PL's confirmation; the server recomputes the evidence under the lock. One reconciliation and the status change (flagged for review by the region's manager) in one transaction",
      description: [
        "Refusals:",
        "- `403` for anyone but a PL of the project.",
        "- `409` at `/statusVersion` (`stale_status`): the participation changed since it was read; at `/evidence` (`source_changed`): the evidence differs from what the dialog listed.",
        "- `422` with the failed guards at their codes: `tg_start_date` (before the TG start, or on it before that day's run completed), `dsv_fully_executed`, `asu_registered_with_proof`, `profiling_done_or_approved_exception` (each valid on the TG start); `not_informed`, `project_not_active`, `evidence_incomplete`, `evidence_after_tg_start` at `/evidence`.",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: TgEntryReconciliationRequest } },
        },
      },
      responses: {
        201: json(TgEntryReconciliationState, "Reconciled: the reconciliation now"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const before = await stateOrProblem(c, participationId);
      if (!before.ok) return before.response as never;
      const log = (outcome: string) =>
        logger.info(
          { requestId: c.get("requestId"), participationId, outcome },
          "tg entry reconciliation",
        );
      try {
        await service.reconcileTgEntry(
          before.subject,
          { participationId, ...input },
          { requestId: c.get("requestId") },
        );
      } catch (error) {
        if (!(error instanceof StatusServiceError)) throw error;
        log(error.code);
        if (error.kind === "forbidden") return problem(c, "forbidden") as never;
        if (error.kind === "not_found") return problem(c, "not-found") as never;
        if (error.kind === "stale") return conflict(c, error.code) as never;
        if (error.kind === "domain") {
          const codes = error.failedGuards.length > 0 ? error.failedGuards : [error.code];
          return domainProblem(
            c,
            codes.map((code) => ({ code, field: pointerOf[code]?.slice(1) ?? null })),
          ) as never;
        }
        throw error;
      }
      log("reconciled");
      const after = await stateOrProblem(c, participationId);
      if (!after.ok) return after.response as never;
      c.header("Cache-Control", "no-store");
      return c.json(after.state, 201);
    },
  );

  /**
   * Visibility first: a reconciliation the viewer can't see (unknown, or a project they don't
   * see) is a 404 whoever asks. Then `allowed` (403) before the function, which checks the role,
   * the four eyes and the state again under the lock.
   */
  async function write(
    c: Context<AppEnv>,
    reconciliationId: string,
    allowed: (
      access: Awaited<ReturnType<typeof projectAccess>>,
      regionId: string | null,
    ) => boolean,
    statement: (ctx: ReturnType<typeof context>) => ReturnType<typeof sql>,
    outcome: string,
    code: string | null,
  ) {
    const found = (
      await db.execute<{ project_id: string; region_id: string | null }>(
        sql`select t.project_id, pr.region_id from tg_entry_reconciliation t
          join project pr on pr.id = t.project_id where t.id = ${reconciliationId}::uuid`,
      )
    ).rows[0];
    if (!found) return problem(c, "not-found");
    const access = await projectAccess(db, sessionUser(c), found.project_id);
    if (!access.visible) return problem(c, "not-found");
    if (!allowed(access, found.region_id)) return problem(c, "forbidden");
    try {
      await transactionWithClient(db, (tx) => tx.execute(statement(context(c))));
    } catch (error) {
      const refusal = functionRefusal(error);
      logger.info(
        { requestId: c.get("requestId"), reconciliationId, outcome: refusal ?? "error" },
        "reconciliation review",
      );
      return refused(c, error);
    }
    logger.info(
      { requestId: c.get("requestId"), reconciliationId, outcome, code },
      "reconciliation review",
    );
    return c.body(null, 204);
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/reconciliations/{reconciliationId}/review",
      tags: ["participations"],
      summary:
        "Review a reconciliation (the regional operations manager of the project's region, never the PL who reconciled; Q80, Q216): `no_objection`, or `clarification_requested` with a reason code and a documented source; after the PL's reply `resolved_no_objection`, `escalated_to_dpo` or another request; an escalation stays open until `resolved_no_objection` on the DPO's documented instruction. Against the revision \"Freigaben\" showed. Never a status change, never a deadline",
      description: [
        "Refusals:",
        "- `404` for a reconciliation the viewer can't see; `403` for a visible one the viewer may not review: any other role (`actor_not_allowed`), and the PL who reconciled (`four_eyes`).",
        '- `409 stale_reconciliation` at `/revision`: read "Freigaben" again.',
        "- `422`: `not_awaiting` (with the PL, or closed), `outcome_not_allowed` at `/outcome`.",
      ].join("\n"),
      middleware,
      request: {
        params: ReconciliationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ReconciliationReviewRequest } },
        },
      },
      responses: {
        204: { description: "Recorded" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { reconciliationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const code = "code" in input ? input.code : null;
      const source = "source" in input ? input.source : null;
      return (await write(
        c,
        reconciliationId,
        ({ subject }, regionId) => maySeeReview(subject, { regionId }),
        (ctx) => sql`select review_reconciliation(p_context => ${ctx},
          p_reconciliation_id => ${reconciliationId}::uuid, p_outcome => ${input.outcome},
          p_code => ${code}, p_source => ${source},
          p_expected_revision => ${input.revision}::integer)`,
        input.outcome,
        code,
      )) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/reconciliations/{reconciliationId}/reply",
      tags: ["participations"],
      summary:
        "Reply to the manager's clarification of a reconciliation (a PL of the project; Q216): a reply code with a documented source, against the revision read. Supplementing evidence happens through its own operations; the reply changes no status",
      description: [
        "Refusals:",
        "- `404` for a reconciliation the viewer can't see; `403` for anyone but a PL of the project.",
        "- `409 stale_reconciliation` at `/revision`.",
        "- `422`: `not_awaiting` (no clarification awaits a reply).",
      ].join("\n"),
      middleware,
      request: {
        params: ReconciliationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ReconciliationReplyRequest } },
        },
      },
      responses: {
        204: { description: "Recorded" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { reconciliationId } = c.req.valid("param");
      const input = c.req.valid("json");
      return (await write(
        c,
        reconciliationId,
        ({ subject }) => subject.kind === "staff",
        (ctx) => sql`select reply_reconciliation_clarification(p_context => ${ctx},
          p_reconciliation_id => ${reconciliationId}::uuid, p_code => ${input.code},
          p_source => ${input.source}, p_expected_revision => ${input.revision}::integer)`,
        "replied",
        input.code,
      )) as never;
    },
  );

  return router;
}
