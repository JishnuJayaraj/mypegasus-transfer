import { createRoute, z } from "@hono/zod-openapi";
import { eq, profilingExceptionRequest, projectTemplatePin } from "@transfer/db";
import {
  ExceptionEvidenceCreated,
  ExceptionEvidenceInput,
  mayPerformOperation,
  maySeeReview,
  mayViewProfiling,
  ProfilingExceptionDecisionInput,
  ProfilingExceptionRequested,
  ProfilingExceptionRequestInput,
  ProfilingExceptionRevocationInput,
  ReviewQueue,
  seesReviews,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess, staffSubjectOf } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { loadRelease } from "../projects/template-pins";
import { createStatusService, StatusServiceError } from "../participations/status-service";
import { correctionReviewItemsOf } from "../participations/evidence-corrections";
import { clarificationReviewItemsOf } from "../participations/entry-clarification";
import { reviewItemsOf } from "../participations/profiling-exceptions";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { profilingAccess } from "./profiling";

// Profiling exceptions with evidence (process-and-lifecycle.md, profiling exceptions;
// data-protection.md, exception evidence; ADR-0010; D30, Q80, Q81, Q94, Q194). The PL records the
// evidence and requests on the tab "Profiling", the regional operations manager decides from
// "Freigaben", the PL revokes before entry. Order as in ADR-0010: schema → visibility (404: a
// participation or request the viewer can't see, whatever its state) → permission (403) → state
// (422; 409 for what changed since the viewer read it). The fingerprint never leaves the
// database. Logs carry ids and codes only.

const ParticipationParams = z.object({ participationId: z.uuid() });
const RequestParams = z.object({ requestId: z.uuid() });

/** Where a refused evidence field points (ADR-0010). */
const fields: Record<string, string> = {
  confirmation_in_future: "confirmedOn",
  reference_invalid: "reference",
  evidence_missing: "evidenceRecordId",
};

/** A refusal of the status service as its problem; anything else is rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof StatusServiceError)) throw error;
  if (error.kind === "not_found") return problem(c, "not-found");
  if (error.kind === "forbidden") return problem(c, "forbidden");
  if (error.kind === "stale") {
    return problem(c, "conflict", {
      errors: [{ pointer: "", code: error.code, detail: "Read it again" }],
    });
  }
  if (error.kind === "domain") {
    return domainProblem(c, [{ code: error.code, field: fields[error.code] ?? null }]);
  }
  throw error;
}

const correlation = (c: Context<AppEnv>) => ({ requestId: c.get("requestId") as string });

export function profilingExceptionRoutes(deps: Deps) {
  const { db, clock, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const service = createStatusService({ db, clock, ...(deps.facts && { facts: deps.facts }) });
  const release = loadRelease(deps.env.configDir);

  /**
   * The Agenturen a BA confirmation may name: the participation's Agentur choices, the release
   * catalog's and the project's pinned ones (Q208 (6), enforced here, not only in the dropdown).
   */
  async function knownAgentur(projectId: string, agenturKey: string) {
    if (release.catalog.some((t) => t.agenturKey === agenturKey)) return true;
    const pins = await db
      .select({ agenturKey: projectTemplatePin.agenturKey })
      .from(projectTemplatePin)
      .where(eq(projectTemplatePin.projectId, projectId));
    return pins.some((pin) => pin.agenturKey === agenturKey);
  }

  /**
   * A request as the viewer may know it: a 404 unless they decide it from "Freigaben" (the
   * regional operations manager of its project's region) or see the participation's profiling
   * (the PL, the assigned consultant).
   */
  async function requestAccess(c: Context<AppEnv>, requestId: string) {
    const [found] = await db
      .select({
        projectId: profilingExceptionRequest.projectId,
        participationId: profilingExceptionRequest.participationId,
      })
      .from(profilingExceptionRequest)
      .where(eq(profilingExceptionRequest.id, requestId));
    if (!found) return undefined;
    const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), found.projectId);
    const target = { projectId: found.projectId, regionId, participationId: found.participationId };
    const sees =
      visible && (maySeeReview(subject, { regionId }) || mayViewProfiling(subject, target).ok);
    return sees ? { subject } : undefined;
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/exception-evidence",
      tags: ["participations"],
      summary:
        "An evidence record for a profiling exception (the PL, while informed): accepted evidence documents of the participation, or a BA confirmation (Agentur, contact or reference, date; normalised). Immutable; its fingerprint stays in the database",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ExceptionEvidenceInput } },
        },
      },
      responses: {
        201: json(ExceptionEvidenceCreated, "Recorded; the record's opaque id"),
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
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const access = await profilingAccess(db, c, participationId);
      if (!access.ok) return access.response as never;
      // Permission before state (ADR-0010): only then whether the Agentur is one of the choices.
      const { subject, target } = access.access;
      if (!mayPerformOperation(subject, { kind: "requestProfilingException" }, target).ok) {
        return problem(c, "forbidden") as never;
      }
      if (
        input.kind === "ba_confirmation" &&
        !(await knownAgentur(access.access.target.projectId, input.agenturKey))
      ) {
        return domainProblem(c, [{ code: "agentur_unknown", field: "agenturKey" }]) as never;
      }
      try {
        const created = await service.createExceptionEvidence(
          access.access.subject,
          { participationId, ...input },
          correlation(c),
        );
        logger.info(
          { requestId: c.get("requestId"), participationId, kind: input.kind },
          "exception evidence recorded",
        );
        return c.json(created, 201) as never;
      } catch (error) {
        return refused(c, error) as never;
      }
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/profiling-exception-requests",
      tags: ["participations"],
      summary:
        "Request a profiling exception (the PL, while informed and before the TG start): a reason code and the evidence record it rests on; a new request after a rejection or revocation needs changed evidence (evidence_unchanged)",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ProfilingExceptionRequestInput } },
        },
      },
      responses: {
        201: json(ProfilingExceptionRequested, "Requested; the request id"),
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
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const access = await profilingAccess(db, c, participationId);
      if (!access.ok) return access.response as never;
      try {
        const created = await service.requestProfilingException(
          access.access.subject,
          { participationId, ...input },
          correlation(c),
        );
        logger.info(
          { requestId: c.get("requestId"), participationId, reason: input.reason },
          "profiling exception requested",
        );
        return c.json(created, 201) as never;
      } catch (error) {
        return refused(c, error) as never;
      }
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/profiling-exception-requests/{requestId}/decision",
      tags: ["participations"],
      summary:
        "Approve or reject a pending profiling exception (the regional operations manager of the project's region, never the requester): names the evidence record shown in Freigaben (409 source_changed if the request rests on another); an approval needs that evidence still usable",
      middleware,
      request: {
        params: RequestParams,
        body: {
          required: true,
          content: { "application/json": { schema: ProfilingExceptionDecisionInput } },
        },
      },
      responses: {
        204: { description: "Decided" },
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
      const { requestId } = c.req.valid("param");
      const input = c.req.valid("json");
      const access = await requestAccess(c, requestId);
      if (!access) return problem(c, "not-found") as never;
      try {
        await service.decideProfilingException(
          access.subject,
          {
            requestId,
            approve: input.decision === "approve",
            evidenceRecordId: input.evidenceRecordId,
          },
          correlation(c),
        );
      } catch (error) {
        return refused(c, error) as never;
      }
      logger.info(
        { requestId: c.get("requestId"), exceptionRequestId: requestId, decision: input.decision },
        "profiling exception decided",
      );
      return c.body(null, 204) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/profiling-exception-requests/{requestId}/revocation",
      tags: ["participations"],
      summary:
        "Revoke the current profiling exception request or approval (the PL, before TG entry): names the status shown on the tab (409 source_changed if it was decided meanwhile). After entry the completion and compliance workflow applies instead",
      middleware,
      request: {
        params: RequestParams,
        body: {
          required: true,
          content: { "application/json": { schema: ProfilingExceptionRevocationInput } },
        },
      },
      responses: {
        204: { description: "Revoked" },
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
      const { requestId } = c.req.valid("param");
      const input = c.req.valid("json");
      const access = await requestAccess(c, requestId);
      if (!access) return problem(c, "not-found") as never;
      try {
        await service.revokeProfilingException(
          access.subject,
          { requestId, status: input.status },
          correlation(c),
        );
      } catch (error) {
        return refused(c, error) as never;
      }
      logger.info(
        { requestId: c.get("requestId"), exceptionRequestId: requestId },
        "profiling exception revoked",
      );
      return c.body(null, 204) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/reviews",
      tags: ["participations"],
      summary:
        "The queue Freigaben (the regional operations manager): the pending profiling exceptions of the projects of their regions with project, reason code, dates, the evidence's kind and whether it is present; the pending evidence corrections with the target's kind and category, the action, reason, documented source and dates; the escalated entry clarifications with the project, dates, the PL's code and documented source; no name, case data, evidence content or corrected value",
      middleware,
      responses: {
        200: json(ReviewQueue, "The pending requests"),
        ...problemResponses("unauthenticated", "forbidden"),
      },
    }),
    async (c) => {
      const subject = await staffSubjectOf(db, sessionUser(c));
      if (!seesReviews(subject)) return problem(c, "forbidden") as never;
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          items: await reviewItemsOf(db, subject),
          corrections: await correctionReviewItemsOf(db, subject),
          clarifications: await clarificationReviewItemsOf(db, subject, clock.today()),
        },
        200,
      ) as never;
    },
  );

  return router;
}
