import { createRoute, z } from "@hono/zod-openapi";
import {
  ImportConfirmInput,
  ImportPreview,
  ImportPreviewInput,
  ImportResult,
  mayPerformOperation,
} from "@transfer/domain";
import { projectAccess } from "../access";
import { createRouter, json, type Deps } from "../context";
import { createImportService, ImportRefusal } from "../imports/service";
import { ImportBusyError } from "../imports/slots";
import { StatusServiceError } from "../participations/status-service";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";
import type { Context } from "hono";

const ProjectParams = z.object({ projectId: z.uuid() });

const problems = problemResponses(
  "validation-error",
  "unauthenticated",
  "forbidden",
  "not-found",
  "conflict",
  "payload-too-large",
  "unsupported-media-type",
  "domain-error",
  "service-unavailable",
);

/** A refusal as its problem (R21): codes only, never a value of the file. */
function refusal(c: Context, error: unknown) {
  if (error instanceof ImportRefusal) {
    if (error.kind === "not_found") return problem(c, "not-found");
    if (error.kind === "conflict") {
      return problem(c, "conflict", {
        errors: error.issues.map(({ code }) => ({
          pointer: "",
          code,
          detail: "The preview no longer matches the stored state",
        })),
      });
    }
    return domainProblem(c, error.issues);
  }
  if (error instanceof ImportBusyError) {
    // R43: no parse worker became free in time; the wizard asks the PL to try again shortly.
    c.header("Retry-After", "10");
    return problem(c, "service-unavailable", {
      errors: [{ pointer: "", code: "import_busy", detail: "Too many imports at once" }],
    });
  }
  if (error instanceof StatusServiceError && error.kind === "forbidden") {
    return problem(c, "forbidden");
  }
  throw error;
}

export function importRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const service = createImportService({
    db,
    release: loadRelease(deps.env.configDir),
    clock: deps.clock,
    logger: deps.logger,
    sessionSecret: deps.env.sessionSecret,
  });

  /** Visibility (404) and the PL's `importParticipations` (403) come before anything else. */
  async function access(c: Context, projectId: string) {
    const user = sessionUser(c as never);
    const { subject, visible } = await projectAccess(db, user, projectId);
    if (!visible) return { denied: problem(c, "not-found") };
    const target = { projectId, regionId: null, participationId: null };
    if (!mayPerformOperation(subject, { kind: "importParticipations" }, target).ok) {
      return { denied: problem(c, "forbidden") };
    }
    return {
      actor: { staffUserId: user.id, requestId: c.get("requestId") as string, subject },
    };
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/imports/preview",
      tags: ["imports"],
      summary:
        "Preview an Excel/CSV import: sheets, headers, suggested mapping and, for a mapping, the report; writes nothing",
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: ImportPreviewInput } } },
      },
      responses: { 200: json(ImportPreview, "The preview"), ...problems },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { denied, actor } = await access(c, projectId);
      if (!actor) return denied;
      try {
        return c.json(await service.preview(actor, projectId, c.req.valid("json")), 200);
      } catch (error) {
        return refusal(c, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/imports",
      tags: ["imports"],
      summary:
        "Confirm an import: the same file again with the mapping, the PL's decisions and the preview token; atomic",
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: ImportConfirmInput } } },
      },
      responses: { 200: json(ImportResult, "What the import did"), ...problems },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { denied, actor } = await access(c, projectId);
      if (!actor) return denied;
      try {
        return c.json(await service.confirm(actor, projectId, c.req.valid("json")), 200);
      } catch (error) {
        return refusal(c, error);
      }
    },
  );

  return router;
}
