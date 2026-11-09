import { createRoute, z } from "@hono/zod-openapi";
import { sql, transactionWithClient } from "@transfer/db";
import {
  EntryClarificationEscalationRequest,
  EntryClarificationInstructionRequest,
  EntryClarificationPendingRequest,
  EntryClarificationState,
  maySeeReview,
} from "@transfer/domain";
import type { Context } from "hono";
import { staffSubjectOf } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { dbGuardFacts } from "../participations/guard-facts";
import { loadClarification } from "../participations/entry-clarification";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// The entry clarification (process-and-lifecycle.md, the entry clarification; Q214, Q220 open): the
// PL's pending code, the escalation and the regional operations manager's instruction. Order as in
// ADR-0010: schema → visibility (404) → permission (403) → state (422; 409 for a status version
// that moved). The functions check roles and state again under the locks. Logs carry ids and codes
// only, never the documented source.

const ParticipationParams = z.object({ participationId: z.uuid() });
const ClarificationParams = z.object({ clarificationId: z.uuid() });

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

const domainCodes = new Set([
  "clarification_not_open",
  "clarification_escalated",
  "clarification_not_documented",
  "already_escalated",
  "not_escalated",
  "already_instructed",
  "invalid_argument",
]);

/** The functions' refusals as their problems (allowlisted), or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "actor_not_allowed" || code === "same_person_instruction") {
    return problem(c, "forbidden");
  }
  if (code === "participation_not_found" || code === "clarification_not_found") {
    return problem(c, "not-found");
  }
  if (code === "stale_status_version") {
    return problem(c, "conflict", {
      errors: [{ pointer: "/statusVersion", code, detail: "Read the case again" }],
    });
  }
  if (code !== undefined && domainCodes.has(code)) return domainProblem(c, [code]);
  throw error;
}

export function entryClarificationRoutes(deps: Deps) {
  const { db, clock, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const facts = deps.facts ?? dbGuardFacts;

  /** The state after a write, or the problem of the read that precedes every write. */
  async function stateOrProblem(c: Context<AppEnv>, participationId: string) {
    const result = await loadClarification({ db, clock, facts }, sessionUser(c), participationId);
    if (result.kind !== "ok") {
      const response = problem(c, result.kind === "not_found" ? "not-found" : "forbidden");
      return { ok: false as const, response };
    }
    return { ok: true as const, state: result.state };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/entry-clarification",
      tags: ["participations"],
      summary:
        "The entry clarification of a signed DSV that has not entered (the PL and back office): whether it is open (from the day after the planned TG start, until the participation leaves informed), the PL's recorded pending code and documented source, the escalation, the manager's instruction, which legitimate paths are open now and the viewer's capabilities",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(EntryClarificationState, "The clarification as the viewer may work it"),
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
      path: "/participations/{participationId}/entry-clarification",
      tags: ["participations"],
      summary:
        "Document what is pending on a signed DSV that has not entered (the project's PL): one of four codes with a documented source (one line, at most 200 characters), against the status version read; a second record replaces the first until the case is escalated. Audited by the code only",
      description: [
        "Refusals:",
        "- `409 stale_status_version` at `/statusVersion`: the participation changed since it was read.",
        "- `422`: `clarification_not_open` (not signed, entered, or before the day after the planned start), `clarification_escalated` (only the manager's instruction follows).",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: EntryClarificationPendingRequest } },
        },
      },
      responses: {
        200: json(EntryClarificationState, "Recorded: the clarification now"),
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
      try {
        await transactionWithClient(db, (tx) =>
          tx.execute(sql`select record_entry_clarification(p_context => ${context(c)},
            p_participation_id => ${participationId}::uuid, p_code => ${input.code},
            p_source => ${input.source}, p_status_version => ${input.statusVersion}::integer)`),
        );
      } catch (error) {
        return refused(c, error) as never;
      }
      logger.info(
        { requestId: c.get("requestId"), participationId, code: input.code, outcome: "recorded" },
        "entry clarification",
      );
      const after = await stateOrProblem(c, participationId);
      if (!after.ok) return after.response as never;
      c.header("Cache-Control", "no-store");
      return c.json(after.state, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/entry-clarification/escalation",
      tags: ["participations"],
      summary:
        "Escalate a documented entry clarification to the regional operations manager of the project's region (the project's PL), once: the manager records an instruction; neither may enter or end the participation by it",
      description: [
        "Refusals:",
        "- `409 stale_status_version` at `/statusVersion`.",
        "- `422`: `clarification_not_open`, `clarification_not_documented` (record the pending code first), `already_escalated`.",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: EntryClarificationEscalationRequest } },
        },
      },
      responses: {
        200: json(EntryClarificationState, "Escalated: the clarification now"),
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
      try {
        await transactionWithClient(db, (tx) =>
          tx.execute(sql`select escalate_entry_clarification(p_context => ${context(c)},
            p_participation_id => ${participationId}::uuid,
            p_status_version => ${input.statusVersion}::integer)`),
        );
      } catch (error) {
        return refused(c, error) as never;
      }
      logger.info(
        { requestId: c.get("requestId"), participationId, outcome: "escalated" },
        "entry clarification",
      );
      const after = await stateOrProblem(c, participationId);
      if (!after.ok) return after.response as never;
      c.header("Cache-Control", "no-store");
      return c.json(after.state, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/entry-clarifications/{clarificationId}/instruction",
      tags: ["participations"],
      summary:
        'Record the instruction of an escalated entry clarification (the regional operations manager of the project\'s region, never the PL who escalated): a code with a documented source, once, against the status version "Freigaben" showed. The case stays open: the instruction changes no status',
      description: [
        "Refusals:",
        "- `404` for a clarification outside the viewer's regions; `403` for any other role, and for the person who escalated.",
        "- `409 stale_status_version` at `/statusVersion`.",
        "- `422`: `clarification_not_open`, `not_escalated`, `already_instructed`.",
      ].join("\n"),
      middleware,
      request: {
        params: ClarificationParams,
        body: {
          required: true,
          content: { "application/json": { schema: EntryClarificationInstructionRequest } },
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
      const { clarificationId } = c.req.valid("param");
      const input = c.req.valid("json");
      // Visibility (404) before the permission (403): a clarification outside the manager's
      // regions doesn't exist for them.
      const subjectProject = await db.execute<{ region_id: string | null }>(
        sql`select pr.region_id from entry_clarification c join project pr on pr.id = c.project_id
          where c.id = ${clarificationId}::uuid`,
      );
      const found = subjectProject.rows[0];
      if (!found) return problem(c, "not-found") as never;
      const subject = await staffSubjectOf(db, sessionUser(c));
      if (!maySeeReview(subject, { regionId: found.region_id })) {
        return problem(c, "forbidden") as never;
      }
      try {
        await transactionWithClient(db, (tx) =>
          tx.execute(sql`select record_clarification_instruction(p_context => ${context(c)},
            p_clarification_id => ${clarificationId}::uuid, p_code => ${input.code},
            p_source => ${input.source}, p_status_version => ${input.statusVersion}::integer)`),
        );
      } catch (error) {
        return refused(c, error) as never;
      }
      logger.info(
        { requestId: c.get("requestId"), clarificationId, code: input.code, outcome: "instructed" },
        "entry clarification",
      );
      return c.body(null, 204) as never;
    },
  );

  return router;
}
