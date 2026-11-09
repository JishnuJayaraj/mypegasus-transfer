import { createRoute, z } from "@hono/zod-openapi";
import { createPdfRenderer } from "@transfer/adapters";
import { participation, eq, sql } from "@transfer/db";
import {
  documentCapabilities,
  DsvGenerationRequest,
  DsvGenerationResult,
  dsvPinProblem,
  DsvTemplatePinInput,
  DsvTemplateView,
  DsvView,
  DsvOfferRequest,
  DsvDeclineRequest,
  DocumentUploadInput,
  DocumentView,
  DsvScanMetadata,
  mayPinDsvTemplate,
  mayWorkDsv,
  type DocumentTarget,
  type DsvTemplateVersion,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { documentService, type DocumentActor, storageUnavailable } from "../documents/service";
import { dsvService, type DsvRead, type DsvRefusal } from "../forms/dsv";
import { formRegistry } from "../forms/registry";
import type { StaffSubject } from "../participations/subjects";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { requireSession, sessionUser, sessionHash } from "../session";
import { auditContext } from "../sql";

// The tab "DSV" (process-and-lifecycle.md, the DSV: generation; data-protection.md, generated forms
// and the access matrix: `employment_contract`; ADR-0009, the DSV template): the
// view, the generation with the deadline chosen before it, and the project's template pin. Order
// as in ADR-0010: schema → visibility (404) → permission (403) → state (422, 409) → service (503).
// Logs carry ids, codes and outcomes only, never a value the paper prints.

const ParticipationParams = z.object({ participationId: z.uuid() });
const ProjectParams = z.object({ projectId: z.uuid() });
const normal = { kind: "normal" } as const;

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

/** The codes the generation's function refuses with as a domain error (422). */
const domainCodes = new Set([
  "dsv_offer_open",
  "dsv_not_generatable",
  "offer_deadline_invalid",
  "participation_not_found",
]);

/** A refused generation as its problem, or rethrown. */
function refused(c: Context<AppEnv>, refusal: DsvRefusal) {
  if (refusal.kind === "domain") return domainProblem(c, refusal.codes);
  if (refusal.kind === "stale") {
    return problem(c, "conflict", {
      errors: [
        { pointer: "/expectedSourceToken", code: "source_changed", detail: "Read the tab again" },
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
  if (code === "source_changed") return refused(c, { kind: "stale" });
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code === "offer_deadline_invalid") return domainProblem(c, [{ code, field: "deadline" }]);
  if (code !== undefined && domainCodes.has(code)) return domainProblem(c, [code]);
  throw refusal.error;
}

export function dsvRoutes(deps: Deps) {
  const { db, clock, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const registry = deps.formRegistry ?? formRegistry(deps.env.configDir);
  const service = dsvService({
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
    documentKeyRoot: deps.env.documentEncryptionKey,
    configDir: deps.env.configDir,
    production: deps.env.nodeEnv === "production",
  });

  /** Visibility (404), then the DSV's permission (403). */
  async function access(
    c: Context<AppEnv>,
    participationId: string,
  ): Promise<
    { ok: true; subject: StaffSubject; target: DocumentTarget } | { ok: false; response: Response }
  > {
    const [found] = await db
      .select({ projectId: participation.projectId })
      .from(participation)
      .where(eq(participation.id, participationId));
    if (!found) return { ok: false, response: problem(c, "not-found") };
    const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), found.projectId);
    if (!visible) return { ok: false, response: problem(c, "not-found") };
    const target = { projectId: found.projectId, regionId, participationId };
    const allowed = mayWorkDsv(subject, target);
    if (!allowed.ok) {
      const hidden = allowed.because === "not_assigned";
      return { ok: false, response: problem(c, hidden ? "not-found" : "forbidden") };
    }
    return { ok: true, subject, target };
  }

  const documents = documentService(deps);
  async function viewOf(
    read: DsvRead,
    subject: StaffSubject,
    target: DocumentTarget,
  ): Promise<z.infer<typeof DsvView>> {
    const actor: DocumentActor = {
      subject,
      target,
      mode: normal,
      context: sql`null::audit_context`,
      session: { kind: "staff", hash: "" },
      tokenHash: null,
    };
    const list = await documents.list(actor);
    const { rows: scans } = await db.execute<{
      id: string;
      metadata: z.infer<typeof DsvScanMetadata>;
      counting: boolean;
    }>(sql`select d.id, jsonb_build_object('offerId',d.dsv_offer_id,'receivedBy',d.dsv_received_by,'receivedOn',d.dsv_received_on::text,'signatures',case when d.review_state='accepted' then coalesce((select jsonb_object_agg(kind,signed_on::text) from dsv_scan_signature where document_id=d.id),'{}'::jsonb) else d.dsv_signatures end) as metadata,
      exists(select from dsv_facts(array[${target.participationId}::uuid]) f where f.document_id=d.id) as counting
      from document d where d.participation_id=${target.participationId}::uuid and d.type='dsv_signed_scan' and d.dsv_offer_id is not null and d.deleted_at is null`);
    const { rows: receivers } = await db.execute<{ id: string; name: string }>(
      sql`select distinct u.id, u.display_name as name from staff_user u join project_membership m on m.staff_user_id=u.id where m.project_id=${target.projectId}::uuid and u.deactivated_at is null order by name`,
    );
    const { rows: facts } = await db.execute<{ validOn: string; recordedAt: string }>(
      sql`select signed_on::text as "validOn", to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt" from dsv_facts(array[${target.participationId}::uuid]) order by recorded_at, document_id limit 1`,
    );
    const canWorkScan =
      read.projectStatus === "active" &&
      read.status === "informed" &&
      read.dsvStatus === "dsv_offered";
    const today = clock.today();
    const blockers = service.blockers(read);
    const fact = service.generatedFact(read, today);
    return {
      participationId: target.participationId,
      track: read.dsvStatus,
      statusVersion: read.statusVersion,
      scans: scans.flatMap((scan) => {
        const document = list.documents.find((d) => d.id === scan.id);
        return document ? [{ document, metadata: scan.metadata, counting: scan.counting }] : [];
      }),
      receivers,
      offers: read.offers.map((offer) => ({
        ...offer,
        capabilities: {
          decline:
            read.projectStatus === "active" &&
            read.status === "informed" &&
            read.dsvStatus === "dsv_offered" &&
            offer.endedAs === null,
        },
      })),
      template:
        read.templateVersion === null
          ? null
          : {
              version: read.templateVersion as DsvTemplateVersion,
              approvedForLive: read.templateApproved ?? false,
            },
      deadline: {
        waveSigningDeadline: read.wave?.signingDeadline ?? null,
        explicitRequired: read.dsvStatus !== "not_offered",
        latestEntryDate: read.wave?.latestEntryDate ?? null,
        tgStart: read.source.tgStart,
      },
      sourceToken: read.projectType === "ta_tg" ? read.sourceToken : null,
      checklist: read.validation.checklist,
      blockers,
      generations: read.generations.map((generation) => ({
        generationId: generation.generationId,
        documentId: generation.documentId,
        generatedAt: generation.generatedAt,
        templateVersion: generation.templateVersion as DsvTemplateVersion,
        offerDeadline: generation.offerDeadline,
        deadlineKind: generation.deadlineKind,
        checklist: generation.checklist,
        stale: service.stale(read, generation, today),
        capabilities: {
          open:
            !generation.purged &&
            documentCapabilities(subject, target, normal, {
              type: "dsv_form",
              addedByParticipant: false,
              reviewState: "unreviewed",
              quarantinedBy: null,
              invalidated: false,
              correctionPending: false,
            }).open,
        },
      })),
      facts: {
        dsvScanReceived: facts[0] ?? null,
        // The instant as stored (microseconds kept), from the generation the fact rests on.
        dsvGenerated: fact
          ? {
              validOn: fact.validOn,
              recordedAt: read.generations.find(
                (generation) =>
                  new Date(generation.generatedAt).getTime() === fact.recordedAt.getTime(),
              )!.generatedAt,
            }
          : null,
      },
      capabilities: {
        uploadScan: canWorkScan && read.offers.some((offer) => offer.endedAs === null),
        sign: canWorkScan,
        generate: read.projectType === "ta_tg" && blockers.length === 0,
        offer:
          read.projectType === "ta_tg" &&
          read.projectStatus === "active" &&
          read.status === "informed" &&
          ["not_offered", "dsv_declined", "dsv_expired"].includes(read.dsvStatus),
      },
    };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/dsv",
      tags: ["participations"],
      summary:
        "The tab DSV (the PL and back office): the track, the pinned template, the deadline's choices and bounds, the source token, what a generation would leave for the hand, why none can be generated now, the generations with their currency, and dsvGenerated; never a value the paper prints",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(DsvView, "The DSV as the viewer may work it"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const allowed = await access(c, participationId);
      if (!allowed.ok) return allowed.response as never;
      const read = await service.read(participationId);
      c.header("Cache-Control", "no-store");
      return c.json(await viewOf(read, allowed.subject, allowed.target), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/dsv/generations",
      tags: ["participations"],
      summary:
        "Generate the DSV (the PL or back office) with the deadline chosen first: the wave's signing deadline as shown (a first offer) or an explicit date; stored encrypted as a working copy with its source token and deadline, audited dsv_form_generated. Signed on paper; no e-signature",
      description: [
        "Refusals:",
        "- `409 source_changed` at `/expectedSourceToken`: a printed value or the wave's deadline moved since the tab was read (also when found at the record).",
        "- `422` at `/deadline`: `explicit_deadline_required` (a re-offer), `wave_deadline_missing`, `offer_deadline_invalid` (not today ≤ deadline ≤ the latest entry date and ≤ the TG start).",
        "- `422` (pointer empty): `not_ta_tg`, `project_not_active`, `participation_closed`, `no_entry_wave`, `tg_dates_missing`, `dsv_template_not_pinned`, `dsv_template_not_approved` (production only), `dsv_offer_open` (the paper is reopened, not regenerated), `dsv_already_signed`, `dsv_not_generatable`, `character_unsupported`.",
        "- `503 pdf_unavailable` or `storage_unavailable`.",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: DsvGenerationRequest } },
        },
      },
      responses: {
        201: json(DsvGenerationResult, "Generated: the document, its deadline and checklist"),
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
      const allowed = await access(c, participationId);
      if (!allowed.ok) return allowed.response as never;
      const outcome = await service.generate(participationId, input, clock.today(), context(c));
      logger.info(
        {
          requestId: c.get("requestId"),
          participationId,
          formCode: "dsv",
          deadlineKind: input.deadline.kind,
          outcome: outcome.ok
            ? "generated"
            : outcome.refusal.kind === "function"
              ? (functionRefusal(outcome.refusal.error) ?? "failed")
              : outcome.refusal.kind === "unavailable"
                ? outcome.refusal.code
                : outcome.refusal.kind === "stale"
                  ? "source_changed"
                  : "refused",
        },
        "form generation",
      );
      if (!outcome.ok) return refused(c, outcome.refusal) as never;
      c.header("Cache-Control", "no-store");
      return c.json(outcome.result, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/dsv/offers",
      tags: ["participations"],
      summary: "Record the offered generated or external paper (PL and back office)",
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: DsvOfferRequest } } },
      },
      responses: {
        201: json(DsvView, "The recorded offer"),
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
      const allowed = await access(c, participationId);
      if (!allowed.ok) return allowed.response as never;
      const input = c.req.valid("json");
      try {
        await db.execute(sql`select offer_dsv(${context(c)}, ${participationId}::uuid,
        ${"generationId" in input ? input.generationId : null}::uuid,
        ${"external" in input ? JSON.stringify(input.external) : null}::jsonb,
        ${input.statusVersion}::integer)`);
      } catch (error) {
        return offerRefusal(c, error) as never;
      }
      return c.json(
        await viewOf(await service.read(participationId), allowed.subject, allowed.target),
        201,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/dsv/offers/{offerId}/decline",
      tags: ["participations"],
      summary: "Record that the participant declined this offer",
      middleware,
      request: {
        params: ParticipationParams.extend({ offerId: z.uuid() }),
        body: { required: true, content: { "application/json": { schema: DsvDeclineRequest } } },
      },
      responses: {
        200: json(DsvView, "The declined offer"),
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
      const { participationId, offerId } = c.req.valid("param");
      const allowed = await access(c, participationId);
      if (!allowed.ok) return allowed.response as never;
      try {
        await db.execute(sql`select decline_dsv_offer(${context(c)}, ${participationId}::uuid,
        ${offerId}::uuid, ${c.req.valid("json").statusVersion}::integer)`);
      } catch (error) {
        return offerRefusal(c, error) as never;
      }
      return c.json(
        await viewOf(await service.read(participationId), allowed.subject, allowed.target),
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/dsv/scans",
      tags: ["participations"],
      summary: "Upload the signed offered paper with explicit receipt and signature dates",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: DsvScanMetadata.extend({
                file: DocumentUploadInput.pick({ content: true, fileName: true }),
              }),
            },
          },
        },
      },
      responses: {
        201: json(DocumentView, "Uploaded"),
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
      const allowed = await access(c, participationId);
      if (!allowed.ok) return allowed.response as never;
      const { file, ...metadata } = c.req.valid("json");
      return documents.upload(
        c,
        {
          subject: allowed.subject,
          target: allowed.target,
          mode: normal,
          context: context(c),
          session: { kind: "staff", hash: sessionHash(c) },
          tokenHash: null,
        },
        { type: "dsv_signed_scan", ...file, dsv: metadata },
      ) as never;
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/dsv/signed",
      tags: ["participations"],
      summary: "Record the participant signature from counting evidence",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.strictObject({
                scanId: z.uuid(),
                statusVersion: z.number().int().nonnegative(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(DsvView, "Signed"),
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
      const allowed = await access(c, participationId);
      if (!allowed.ok) return allowed.response as never;
      const { rows } = await db.execute(
        sql`select document_id from dsv_facts(array[${participationId}::uuid]) where document_id=${input.scanId}::uuid`,
      );
      if (!rows.length) {
        const { rows: found } = await db.execute(
          sql`select id from document where id=${input.scanId}::uuid and participation_id=${participationId}::uuid and type='dsv_signed_scan' and deleted_at is null`,
        );
        return (
          found.length ? domainProblem(c, ["dsv_scan_missing"]) : problem(c, "not-found")
        ) as never;
      }
      try {
        await db.execute(
          sql`select sign_dsv(${context(c)},${participationId}::uuid,${input.scanId}::uuid,${input.statusVersion}::integer)`,
        );
      } catch (error) {
        return offerRefusal(c, error) as never;
      }
      return c.json(
        await viewOf(await service.read(participationId), allowed.subject, allowed.target),
        200,
      );
    },
  );

  /** The project's DSV template for a viewer who works the DSV (PL, back office). */
  async function templateOf(projectId: string, subject: StaffSubject, regionId: string | null) {
    const { rows } = await db.execute<{ version: string | null; type: string }>(
      sql`select dsv_template_version as version, type::text from project
        where id = ${projectId}::uuid`,
    );
    const fixed = await service.pinFixed(projectId);
    const target = { projectId, regionId, participationId: null };
    return {
      type: rows[0]!.type,
      view: {
        version: rows[0]!.version as DsvTemplateVersion | null,
        fixed,
        versions: registry.ownTemplateVersions("dsv") as {
          version: DsvTemplateVersion;
          approvedForLive: boolean;
        }[],
        capabilities: {
          pin: rows[0]!.type === "ta_tg" && !fixed && mayPinDsvTemplate(subject, target).ok,
        },
      } satisfies z.infer<typeof DsvTemplateView>,
    };
  }

  /** Visibility (404), then a role that works the DSV (403). */
  async function projectDsvAccess(c: Context<AppEnv>, projectId: string) {
    const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), projectId);
    if (!visible) return { ok: false as const, response: problem(c, "not-found") };
    const target = { projectId, regionId, participationId: null };
    if (!mayWorkDsv(subject, target).ok && !mayPinDsvTemplate(subject, target).ok) {
      return { ok: false as const, response: problem(c, "forbidden") };
    }
    return { ok: true as const, subject, regionId };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/dsv-template",
      tags: ["projects"],
      summary:
        "The project's DSV template (the PL and back office): the pinned version, the versions with their approval for live use, and whether the pin is fixed (from the first generation)",
      middleware,
      request: { params: ProjectParams },
      responses: {
        200: json(DsvTemplateView, "The project's DSV template"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const allowed = await projectDsvAccess(c, projectId);
      if (!allowed.ok) return allowed.response as never;
      const { view } = await templateOf(projectId, allowed.subject, allowed.regionId);
      return c.json(view, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/projects/{projectId}/dsv-template",
      tags: ["projects"],
      summary:
        "Pin the project's DSV template version (the PL; ta_tg): while no DSV of the project was generated, audited dsv_template_pinned",
      description: [
        "Refusals:",
        "- `422` at `/version`: `template_unknown` (not in the form registry).",
        "- `422`: `not_ta_tg`, `template_pinned` (fixed from the first generation), `project_unchanged`.",
      ].join("\n"),
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: DsvTemplatePinInput } } },
      },
      responses: {
        200: json(DsvTemplateView, "Pinned"),
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
      const { projectId } = c.req.valid("param");
      const { version } = c.req.valid("json");
      const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), projectId);
      if (!visible) return problem(c, "not-found") as never;
      if (!mayPinDsvTemplate(subject, { projectId, regionId, participationId: null }).ok) {
        return problem(c, "forbidden") as never;
      }
      if (!registry.ownTemplateVersions("dsv").some((entry) => entry.version === version)) {
        return domainProblem(c, [{ code: "template_unknown", field: "version" }]) as never;
      }
      const before = await templateOf(projectId, subject, regionId);
      const problemCode = dsvPinProblem(
        {
          type: before.type as "ta_tg" | "ta_only",
          pinned: before.view.version,
          generated: before.view.fixed,
        },
        version,
      );
      if (problemCode) return domainProblem(c, [problemCode]) as never;
      try {
        await db.execute(sql`select update_project(p_id => ${projectId}::uuid,
          p_context => ${context(c)}, p_dsv_template_version => ${version})`);
      } catch (error) {
        const code = functionRefusal(error);
        if (code === "actor_not_allowed") return problem(c, "forbidden") as never;
        if (code === "template_pinned" || code === "project_unchanged" || code === "not_ta_tg") {
          return domainProblem(c, [code]) as never;
        }
        throw error;
      }
      logger.info({ requestId: c.get("requestId"), projectId, outcome: "pinned" }, "dsv template");
      return c.json((await templateOf(projectId, subject, regionId)).view, 200);
    },
  );

  return router;
}

function offerRefusal(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (
    code === "document_not_found" ||
    code === "offer_not_found" ||
    code === "generation_not_found"
  )
    return problem(c, "not-found");
  if (code === "stale_status" || code === "source_changed")
    return problem(c, "conflict", {
      errors: [{ pointer: "", code, detail: "Read the tab again" }],
    });
  if (
    code &&
    [
      "dsv_scan_missing",
      "dsv_generation_stale",
      "offer_deadline_invalid",
      "terms_mismatch",
      "invalid_transition",
      "track_inactive",
      "project_not_active",
      "wave_required",
      "dsv_template_not_approved",
    ].includes(code)
  )
    return domainProblem(c, [code]);
  throw error;
}
