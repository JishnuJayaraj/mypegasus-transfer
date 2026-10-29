import { createRoute, z } from "@hono/zod-openapi";
import { createPdfRenderer } from "@transfer/adapters";
import {
  Kug200bBulkGeneration,
  Kug200bBulkInput,
  Kug200bGeneration,
  mayGenerateKug200bBulk,
  mayWorkKug200b,
  staffSelfServiceAccess,
  Tl407Generation,
  Tl407GenerationInput,
  Tl407Readiness,
  tl407ReadinessViewer,
} from "@transfer/domain";
import type { Context } from "hono";
import { and, eq, inArray, participation } from "@transfer/db";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { storageUnavailable } from "../documents/service";
import { fieldEncryptionKey } from "../field-encryption";
import { formRegistry } from "../forms/registry";
import { kug200bService, type Kug200bRefusal } from "../forms/kug200b";
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

/** The codes a Kug 200b generation's functions refuse with, answered as 422. */
const kug200bDomainCodes = new Set([
  "participation_closed",
  "asu_not_applicable",
  "participation_not_found",
]);

/** A refused Kug 200b generation as its problem, or rethrown; `index` names a bulk member. */
function kug200bRefused(
  c: Context<AppEnv>,
  refusal: Kug200bRefusal,
  index: (participationId: string) => number | null,
) {
  if (refusal.kind === "domain") {
    const at = index(refusal.participationId);
    const field = at === null ? null : `participationIds/${at}`;
    return domainProblem(
      c,
      refusal.codes.map((code) => ({ code, field })),
    );
  }
  if (refusal.kind === "unavailable") {
    if (refusal.code === "storage_unavailable") return storageUnavailable(c);
    return problem(c, "service-unavailable", {
      errors: [{ pointer: "", code: refusal.code, detail: "Not available now; try again later" }],
    });
  }
  const code = functionRefusal(refusal.error);
  if (code === "source_changed") {
    return problem(c, "conflict", {
      errors: [{ pointer: "", code, detail: "A source changed meanwhile; generate again" }],
    });
  }
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code !== undefined && kug200bDomainCodes.has(code)) return domainProblem(c, [code]);
  throw refusal.error;
}

const kug200bResponses = (schema: typeof Kug200bGeneration | typeof Kug200bBulkGeneration) => ({
  201: json(schema, "Generated: the document(s), the version and the handwriting checklist"),
  ...problemResponses(
    "validation-error",
    "unauthenticated",
    "forbidden",
    "not-found",
    "conflict",
    "domain-error",
    "service-unavailable",
  ),
});

const kug200bRefusals = [
  "Refusals:",
  "- `422` with form-level error codes (`form_version_unavailable`, `character_unsupported`, `identifier_too_long`, …), `participation_closed`, `asu_not_applicable` (a `ta_only` project); in a bulk at `/participationIds/<index>`.",
  "- `409 source_changed`: a source moved between the read and the record; generate again.",
  "- `503 storage_unavailable`.",
].join("\n");

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

  const kug200b = kug200bService({
    db,
    release: loadRelease(deps.env.configDir),
    registry,
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

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/forms/kug200b",
      tags: ["participations"],
      summary:
        "Generate the Kug 200b (the PL or the assigned consultant; ta_tg): 1–12 filled, 13–19 and the declarations left for the participant's hand; stored encrypted with its handwriting checklist (blank * fields, text that doesn't fit), audited form_generated; the values it prints from the sensitive answers each read audited",
      description: kug200bRefusals,
      middleware,
      request: { params: ParticipationParams },
      responses: kug200bResponses(Kug200bGeneration),
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const [found] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      if (!found) return problem(c, "not-found") as never;
      const { subject, visible, regionId } = await projectAccess(
        db,
        sessionUser(c),
        found.projectId,
      );
      if (!visible) return problem(c, "not-found") as never;
      const allowed = mayWorkKug200b(subject, {
        projectId: found.projectId,
        regionId,
        participationId,
      });
      if (!allowed.ok) {
        return problem(c, allowed.because === "not_assigned" ? "not-found" : "forbidden") as never;
      }
      const outcome = await kug200b.generate([participationId], clock.today(), context(c), null);
      logger.info(
        {
          requestId: c.get("requestId"),
          participationId,
          formCode: "kug200b",
          outcome: outcome.ok ? "generated" : outcomeCode(outcome.refusal),
        },
        "form generation",
      );
      if (!outcome.ok) return kug200bRefused(c, outcome.refusal, () => null) as never;
      c.header("Cache-Control", "no-store");
      return c.json(outcome.generations[0]!, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/forms/kug200b",
      tags: ["projects"],
      summary:
        "Generate the Kug 200b for 1–100 participations of a ta_tg project at once (the PL): all or nothing under the project's exclusive lock, in the order asked; the print file is an export (POST /exports/kug200b_print)",
      description: kug200bRefusals,
      middleware,
      request: {
        params: z.object({ projectId: z.uuid() }),
        body: { required: true, content: { "application/json": { schema: Kug200bBulkInput } } },
      },
      responses: kug200bResponses(Kug200bBulkGeneration),
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { participationIds } = c.req.valid("json");
      const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), projectId);
      if (!visible) return problem(c, "not-found") as never;
      if (!mayGenerateKug200bBulk(subject, { projectId, regionId, participationId: null }).ok) {
        return problem(c, "forbidden") as never;
      }
      // A participation of another project or none is named by its place in the body.
      const own = new Set(
        (
          await db
            .select({ id: participation.id })
            .from(participation)
            .where(
              and(
                inArray(participation.id, participationIds),
                eq(participation.projectId, projectId),
              ),
            )
        ).map((row) => row.id),
      );
      const foreign = participationIds.flatMap((id, index) =>
        own.has(id)
          ? []
          : [{ code: "participation_not_found", field: `participationIds/${index}` }],
      );
      if (foreign.length > 0) return domainProblem(c, foreign) as never;
      const outcome = await kug200b.generate(participationIds, clock.today(), context(c), {
        projectId,
      });
      logger.info(
        {
          requestId: c.get("requestId"),
          projectId,
          formCode: "kug200b",
          count: participationIds.length,
          outcome: outcome.ok ? "generated" : outcomeCode(outcome.refusal),
        },
        "form generation",
      );
      if (!outcome.ok) {
        return kug200bRefused(c, outcome.refusal, (id) => participationIds.indexOf(id)) as never;
      }
      c.header("Cache-Control", "no-store");
      return c.json({ generations: outcome.generations }, 201);
    },
  );

  return router;
}

/** A refusal's code for the log: never a value. */
function outcomeCode(refusal: Kug200bRefusal) {
  if (refusal.kind === "function") return functionRefusal(refusal.error) ?? "failed";
  return refusal.kind === "unavailable" ? refusal.code : "refused";
}
