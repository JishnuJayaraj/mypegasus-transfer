import { createRoute, z } from "@hono/zod-openapi";
import { agenturSubmission, eq, participation, sql } from "@transfer/db";
import {
  AgenturRejectionInput,
  mayRecordTl407Submission,
  OriginalSentInput,
  Tl407SubmissionCreated,
  Tl407SubmissionInput,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { formRegistry } from "../forms/registry";
import { submissionSettingsOf } from "../participations/tl407-submissions";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { sessionUser, requireSession } from "../session";
import { auditContext } from "../sql";
import { profilingAccess } from "./profiling";

// The TL 407's submission to the placement Agentur (process-and-lifecycle.md, TL 407 submission;
// ADR-0010; D26, Q54, Q92, Q188, Q189): the PL records "An Agentur übermittelt am", "Original
// versandt am" and the Agentur's rejection. Order as in ADR-0010: schema → visibility (404: the
// tab's, so an unassigned consultant and a hidden project get 404 whatever the submission's state)
// → permission (403: the PL only) → state (422). A submission takes the project's exclusive lock
// first, resolves the placement Agentur's settings under it, compares them with what the PL saw
// (409 `source_changed`) and passes them to the function, which compares the Agentur under the
// same lock. Logs carry ids and codes only.

const ParticipationParams = z.object({ participationId: z.uuid() });
const SubmissionParams = z.object({ submissionId: z.uuid() });

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

/** 409: what the PL saw (the Agentur's settings) changed before the record; read the tab again. */
const changed = (c: Context<AppEnv>) =>
  problem(c, "conflict", {
    errors: [{ pointer: "", code: "source_changed", detail: "Read the tab again" }],
  });

/** Where a refusal points in the body (ADR-0010). */
const fieldOf: Record<string, string> = {
  submitted_on_in_future: "submittedOn",
  submitted_before_signature: "submittedOn",
  submitted_before_rejection: "submittedOn",
  document_not_found: "documentId",
  scan_unusable: "documentId",
  form_version_outdated: "documentId",
};

/** The functions' refusals as their problems (allowlisted), or rethrown. */
function refused(c: Context<AppEnv>, error: unknown, dateField: string | null = null) {
  const code = functionRefusal(error);
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code === "settings_changed") return changed(c);
  if (code === "submission_not_found") return problem(c, "not-found");
  if (code === "date_in_future" || code === "date_before_submission") {
    return domainProblem(c, [{ code, field: dateField }]);
  }
  if (
    code !== undefined &&
    [
      "participation_closed",
      "placement_agentur_missing",
      "submission_settings_missing",
      "already_submitted",
      "original_not_required",
      "original_recorded",
      "already_rejected",
      "rejection_not_applicable",
      ...Object.keys(fieldOf),
    ].includes(code)
  ) {
    return domainProblem(c, [{ code, field: fieldOf[code] ?? null }]);
  }
  throw error;
}

export function tl407SubmissionRoutes(deps: Deps) {
  const { db, clock, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const release = loadRelease(deps.env.configDir);
  const registry = deps.formRegistry ?? formRegistry(deps.env.configDir);

  /** The tab's visibility (404), then the PL's permission (403); else the response. */
  async function leadOf(c: Context<AppEnv>, participationId: string) {
    const result = await profilingAccess(db, c, participationId);
    if (!result.ok) return { response: result.response };
    if (!mayRecordTl407Submission(result.access.subject, result.access.target).ok) {
      return { response: problem(c, "forbidden") };
    }
    return { projectId: result.access.found.projectId };
  }

  /** A submission's participation as the PL's (404 for an id that isn't one or isn't visible). */
  async function submissionLead(c: Context<AppEnv>, submissionId: string) {
    const [found] = await db
      .select({ participationId: agenturSubmission.participationId })
      .from(agenturSubmission)
      .where(eq(agenturSubmission.id, submissionId));
    if (!found) return { response: problem(c, "not-found") };
    return leadOf(c, found.participationId);
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/tl407-submissions",
      tags: ["participations"],
      summary:
        '"An Agentur übermittelt am" (the PL): an accepted, unquarantined signed TL 407 to the placement Agentur by its resolved channel, the actual sent date from the signature to today; refused without a placement Agentur, with the agentur_submission blocker, while a submission stands and, only where the Agentur rejects outdated forms, for an expired version; 409 source_changed when the settings the PL saw changed',
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: Tl407SubmissionInput } } },
      },
      responses: {
        201: json(Tl407SubmissionCreated, "Recorded: the attempt's id"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const lead = await leadOf(c, participationId);
      if ("response" in lead) return lead.response as never;
      const submissionId = randomUUID();
      const today = clock.today();
      try {
        const outcome = await db.transaction(async (tx) => {
          await tx.execute(sql`select lock_project_setup(${lead.projectId}::uuid)`);
          const [current] = await tx
            .select({ key: participation.placementAgenturKey, status: participation.status })
            .from(participation)
            .where(eq(participation.id, participationId));
          const closed = ["withdrawn", "ta_completed", "exited"].includes(current!.status);
          // A closed participation is refused by the function; its Agentur is never resolved.
          const resolved =
            current!.key !== null && !closed
              ? (
                  await submissionSettingsOf(
                    tx,
                    release,
                    registry,
                    lead.projectId,
                    [current!.key],
                    today,
                  )
                ).get(current!.key)!
              : { settings: null, outdatedVersions: [] };
          const { settings } = resolved;
          if (
            settings !== null &&
            (settings.channel !== input.channel ||
              settings.originalRequired !== input.originalRequired)
          ) {
            return "changed" as const;
          }
          await tx.execute(
            sql`select submit_tl407(p_context => ${context(c)},
              p_participation_id => ${participationId}::uuid,
              p_submission_id => ${submissionId}::uuid, p_document_id => ${input.documentId}::uuid,
              p_submitted_on => ${input.submittedOn}::date, p_agentur_key => ${current!.key},
              p_channel => ${settings?.channel ?? null}::agentur_submission_channel,
              p_original_required => ${settings?.originalRequired ?? null}::boolean,
              p_outdated_versions => ${`{${resolved.outdatedVersions.join(",")}}`}::text[])`,
          );
          return "recorded" as const;
        });
        if (outcome === "changed") return changed(c) as never;
      } catch (error) {
        logger.info(
          {
            requestId: c.get("requestId"),
            participationId,
            outcome: functionRefusal(error) ?? "failed",
          },
          "tl407 submission",
        );
        return refused(c, error) as never;
      }
      logger.info({ requestId: c.get("requestId"), participationId }, "tl407 submission");
      return c.json({ submissionId }, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/agentur-submissions/{submissionId}/original",
      tags: ["participations"],
      summary:
        '"Original versandt am" (the PL): once, for a TL 407 submission whose Agentur needed the paper original apart from it, from the submission to today',
      middleware,
      request: {
        params: SubmissionParams,
        body: { required: true, content: { "application/json": { schema: OriginalSentInput } } },
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
      const { submissionId } = c.req.valid("param");
      const { originalSentOn } = c.req.valid("json");
      const lead = await submissionLead(c, submissionId);
      if ("response" in lead) return lead.response as never;
      try {
        await db.execute(
          sql`select record_original_sent(p_context => ${context(c)},
            p_submission_id => ${submissionId}::uuid,
            p_original_sent_on => ${originalSentOn}::date)`,
        );
      } catch (error) {
        return refused(c, error, "originalSentOn") as never;
      }
      return c.body(null, 204) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/agentur-submissions/{submissionId}/rejection",
      tags: ["participations"],
      summary:
        '"Von der Agentur abgelehnt" (the PL): once per TL 407 attempt, the date from the submission to today and the reason; reopens the submission work, leaves the signatures and the profiling track alone',
      middleware,
      request: {
        params: SubmissionParams,
        body: {
          required: true,
          content: { "application/json": { schema: AgenturRejectionInput } },
        },
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
      const { submissionId } = c.req.valid("param");
      const { rejectedOn, reason } = c.req.valid("json");
      const lead = await submissionLead(c, submissionId);
      if ("response" in lead) return lead.response as never;
      try {
        await db.execute(
          sql`select record_agentur_rejection(p_context => ${context(c)},
            p_submission_id => ${submissionId}::uuid, p_rejected_on => ${rejectedOn}::date,
            p_reason => ${reason}::agentur_rejection_reason)`,
        );
      } catch (error) {
        return refused(c, error, "rejectedOn") as never;
      }
      logger.info({ requestId: c.get("requestId"), submissionId, reason }, "tl407 rejection");
      return c.body(null, 204) as never;
    },
  );

  return router;
}
