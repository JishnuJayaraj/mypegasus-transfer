import { createRoute, z } from "@hono/zod-openapi";
import { createPdfRenderer } from "@transfer/adapters";
import {
  staffSelfServiceAccess,
  Tl407Generation,
  Tl407GenerationInput,
  Tl407Readiness,
  tl407ReadinessViewer,
} from "@transfer/domain";
import type { Context } from "hono";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { storageUnavailable } from "../documents/service";
import { fieldEncryptionKey } from "../field-encryption";
import { formRegistry } from "../forms/registry";
import { tl407Service, type Tl407Refusal } from "../forms/tl407";
import { loadRelease } from "../projects/template-pins";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";
import { closedStatuses, profilingAccess } from "./profiling";

// The TL 407 on the tab "Profiling" (data-protection.md, generated forms and the readiness
// projection; ba-forms.md, validation before rendering; Q179): the readiness built per viewer
// and the assigned consultant's generation. Order as in ADR-0010: schema → visibility (404, an
// unassigned consultant too) → permission (403) → state (422, 409) → service (503). Logs carry
// ids, codes and outcomes only, never a value of the form.

const ParticipationParams = z.object({ participationId: z.uuid() });

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

/** A refused generation as its problem, or rethrown. */
function refused(c: Context<AppEnv>, refusal: Tl407Refusal) {
  if (refusal.kind === "domain") return domainProblem(c, refusal.codes);
  if (refusal.kind === "stale") {
    return problem(c, "conflict", {
      errors: [
        { pointer: "/sourceToken", code: "source_changed", detail: "Check the readiness again" },
      ],
    });
  }
  if (refusal.kind === "unavailable") {
    if (refusal.code === "storage_unavailable") return storageUnavailable(c);
    return problem(c, "service-unavailable", {
      errors: [{ pointer: "", code: refusal.code, detail: "Not available now; try again later" }],
    });
  }
  const code = functionRefusal(refusal.error);
  // Found at the record, under the lock: the same answer as a stale token.
  if (code === "source_changed") return refused(c, { kind: "stale" });
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code === "participation_closed") return domainProblem(c, [code]);
  throw refusal.error;
}

export function formRoutes(deps: Deps) {
  const { db, clock, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const registry = deps.formRegistry ?? formRegistry(deps.env.configDir);
  const service = tl407Service({
    db,
    release: loadRelease(deps.env.configDir),
    registry,
    // The adapter `PDF_ADAPTER` selects, with the registry's font, built on the first generation.
    renderer: () =>
      deps.pdfRenderer ??
      createPdfRenderer({
        adapter: deps.env.pdfAdapter,
        gotenbergUrl: deps.env.gotenbergUrl,
        production: deps.env.nodeEnv === "production",
        font: registry.font(),
      }),
    files: deps.documentFiles,
    fieldKey: fieldEncryptionKey(deps.env.fieldEncryptionKey!),
    documentKeyRoot: deps.env.documentEncryptionKey,
    configDir: deps.env.configDir,
  });

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/forms/tl407/readiness",
      tags: ["participations"],
      summary:
        "The TL 407's readiness for the viewer: the assigned consultant every error and warning code and the overflow (each decryption audited sensitive_read); the PL ready or not and the missing fields they may know about, from presence only; others 403",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(Tl407Readiness, "The readiness as projected for the viewer"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const result = await profilingAccess(db, c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      const viewer = tl407ReadinessViewer(subject, target);
      if (viewer === null) return problem(c, "forbidden");
      const readiness = await service.readiness(
        participationId,
        viewer === "profiler"
          ? { kind: "profiler", context: context(c) }
          : {
              kind: "project_lead",
              knows: staffSelfServiceAccess(subject, { ...target, participationId }).knows,
            },
        clock.today(),
      );
      c.header("Cache-Control", "no-store");
      return c.json(readiness, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/forms/tl407",
      tags: ["participations"],
      summary:
        "Generate the TL 407 (the assigned consultant) for the readiness checked: its source token, every warning confirmed by code (each audited warning_confirmed); stored encrypted as a document with its provenance (form_generated)",
      description: [
        "Refusals:",
        "- `409 source_changed` at `/sourceToken`: a source moved since the readiness (also when found at the record); check again.",
        "- `422` with a warning code at `/confirmWarnings`: that warning isn't confirmed.",
        "- `422` with form-level error codes (pointer empty: `form_version_unavailable`, `required_missing`, `character_unsupported`, …; each code once): the form can't be generated. The readiness names the fields.",
        "- `422 participation_closed`; `503 pdf_unavailable` (the Anlage can't be rendered) or `storage_unavailable`.",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: Tl407GenerationInput } },
        },
      },
      responses: {
        201: json(
          Tl407Generation,
          "Generated: the document, its version and whether an Anlage was appended",
        ),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
          "service-unavailable",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await profilingAccess(db, c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (tl407ReadinessViewer(subject, target) !== "profiler") return problem(c, "forbidden");
      // Refused before any decryption; the function checks again under the lock.
      if (closedStatuses.has(result.access.found.status)) {
        return domainProblem(c, ["participation_closed"]) as never;
      }
      const outcome = await service.generate(participationId, clock.today(), context(c), input);
      logger.info(
        {
          requestId: c.get("requestId"),
          participationId,
          formCode: "tl407",
          outcome: outcome.ok
            ? "generated"
            : outcome.refusal.kind === "function"
              ? (functionRefusal(outcome.refusal.error) ?? "failed")
              : outcome.refusal.kind === "unavailable"
                ? outcome.refusal.code
                : "refused",
        },
        "form generation",
      );
      if (!outcome.ok) return refused(c, outcome.refusal) as never;
      c.header("Cache-Control", "no-store");
      return c.json(outcome.generation, 201);
    },
  );

  return router;
}
