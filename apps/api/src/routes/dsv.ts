import { createRoute, z } from "@hono/zod-openapi";
import { createPdfRenderer } from "@transfer/adapters";
import { participation, eq, sql } from "@transfer/db";
import {
  documentCapabilities,
  DsvBulkGenerationRequest,
  DsvBulkGenerationResult,
  DsvGenerationRequest,
  DsvGenerationResult,
  dsvPinProblem,
  DsvTemplatePinInput,
  DsvTemplateView,
  DsvView,
  DsvOfferRequest,
  DsvOriginalRequest,
  DsvDeclineRequest,
  DocumentUploadInput,
  DocumentView,
  DsvScanMetadata,
  mayPinDsvTemplate,
  mayRequestCorrection,
  mayWorkDsv,
  mayPerformOperation,
  dsvCustomerNoticeDue,
  dsvCustomerNoticeProblem,
  DsvCustomerNoticeRequest,
  type DocumentTarget,
  type DsvStatus,
  type MainStatus,
  type DsvTemplateVersion,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { documentService, type DocumentActor, storageUnavailable } from "../documents/service";
import { dsvService, type DsvBatchRefusal, type DsvRead, type DsvRefusal } from "../forms/dsv";
import { formRegistry } from "../forms/registry";
import type { StaffSubject } from "../participations/subjects";
import { cancellationFacts } from "../participations/guard-facts";
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

/**
 * A refused batch as one problem, the position of each item in its pointer (`/items/3`): the
 * domain refusals first (422, all of them), else the stale ones (409), else the first other
 * failure. No participation id, name or value is named.
 */
function refusedBatch(c: Context<AppEnv>, refusals: readonly DsvBatchRefusal[]) {
  const domain = refusals.flatMap(({ index, refusal }) => {
    if (refusal.kind === "domain") {
      return refusal.codes.map(({ code, field }) => ({
        pointer: `/items/${index}${field ? `/${field}` : ""}`,
        code,
        detail: "Refused by a domain rule",
      }));
    }
    if (refusal.kind !== "function") return [];
    const code = functionRefusal(refusal.error);
    if (code === "offer_deadline_invalid") {
      return [{ pointer: `/items/${index}/deadline`, code, detail: "Refused by a domain rule" }];
    }
    return code !== undefined && domainCodes.has(code)
      ? [{ pointer: `/items/${index}`, code, detail: "Refused by a domain rule" }]
      : [];
  });
  if (domain.length > 0) return problem(c, "domain-error", { errors: domain });
  const stale = refusals.filter(({ refusal }) => refusal.kind === "stale");
  const changed = refusals.filter(
    ({ refusal }) =>
      refusal.kind === "function" && functionRefusal(refusal.error) === "source_changed",
  );
  if (stale.length + changed.length > 0) {
    return problem(c, "conflict", {
      errors: [...stale, ...changed].map(({ index }) => ({
        pointer: `/items/${index}`,
        code: "source_changed",
        detail: "Read the selection again",
      })),
    });
  }
  const first = refusals[0]!.refusal;
  if (first.kind === "function") {
    const code = functionRefusal(first.error);
    if (code === "actor_not_allowed") return problem(c, "forbidden");
    throw first.error;
  }
  return refused(c, first);
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
    }>(sql`select d.id, jsonb_build_object('offerId',d.dsv_offer_id,'receivedBy',d.dsv_received_by,'receivedOn',d.dsv_received_on::text,'signatures',case when d.review_state='accepted' then coalesce((select jsonb_object_agg(kind,signed_on::text) from dsv_scan_signature where document_id=d.id and superseded_by is null),'{}'::jsonb) else d.dsv_signatures end) as metadata,
      exists(select from dsv_facts(array[${target.participationId}::uuid]) f where f.document_id=d.id) as counting
      from document d where d.participation_id=${target.participationId}::uuid and d.type='dsv_signed_scan' and d.dsv_offer_id is not null and d.deleted_at is null`);
    // The cancellations of the signed contract (process-and-lifecycle.md, the cancellation).
    const { rows: cancellations } = await db.execute<{
      id: string;
      metadata: z.infer<typeof DsvScanMetadata>;
      counting: boolean;
    }>(sql`select d.id, jsonb_build_object('offerId',d.dsv_offer_id,'receivedBy',d.dsv_received_by,'receivedOn',d.dsv_received_on::text,'signatures',case when d.review_state='accepted' then coalesce((select jsonb_object_agg(kind,signed_on::text) from dsv_scan_signature where document_id=d.id and superseded_by is null),'{}'::jsonb) else d.dsv_signatures end) as metadata,
      exists(select from dsv_cancellation_facts(array[${target.participationId}::uuid]) f where f.document_id=d.id) as counting
      from document d where d.participation_id=${target.participationId}::uuid and d.type='dsv_cancellation' and d.dsv_offer_id is not null and d.deleted_at is null`);
    const cancellation = (await cancellationFacts(db, [target.participationId])).get(
      target.participationId,
    );
    const {
      rows: [notice],
    } = await db.execute<{ withdrawn_on: string | null; notified_on: string | null }>(
      sql`select p.withdrawn_on::text, n.notified_on::text from participation p
        left join dsv_customer_notice n on n.participation_id = p.id
        where p.id = ${target.participationId}::uuid`,
    );
    const noticeState = {
      status: read.status,
      dsvStatus: read.dsvStatus,
      withdrawnOn: notice?.withdrawn_on ?? null,
      notifiedOn: notice?.notified_on ?? null,
    };
    const noticeDue = dsvCustomerNoticeDue(noticeState);
    const { rows: receivers } = await db.execute<{ id: string; name: string }>(
      sql`select distinct u.id, u.display_name as name from staff_user u join project_membership m on m.staff_user_id=u.id where m.project_id=${target.projectId}::uuid and u.deactivated_at is null order by name`,
    );
    const { rows: facts } = await db.execute<{ validOn: string; recordedAt: string }>(
      sql`select signed_on::text as "validOn", to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt" from dsv_facts(array[${target.participationId}::uuid]) order by recorded_at, document_id limit 1`,
    );
    const { rows: packets } = await db.execute<{ validOn: string; recordedAt: string }>(
      sql`select executed_on::text as "validOn", to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt" from dsv_facts(array[${target.participationId}::uuid]) where executed_on is not null order by recorded_at, document_id limit 1`,
    );
    const { rows: contracts } = await db.execute<NonNullable<z.infer<typeof DsvView>["contract"]>>(
      sql`select dsv_offer_id as "offerId", participant_signed_on::text as "participantSignedOn",
        customer_signed_on::text as "customerSignedOn", tg_signed_on::text as "tgSignedOn",
        fully_executed_on::text as "fullyExecutedOn", original_location as "originalLocation",
        original_received_on::text as "originalReceivedOn", sent_to_customer_on::text as "sentToCustomerOn"
        from dsv_contract where participation_id = ${target.participationId}::uuid
        order by created_at desc, id limit 1`,
    );
    // The signature-date supersessions awaiting their decision (process-and-lifecycle.md, the DSV
    // signature-date supersession): no second request of the same offer, paper and signature.
    const { rows: pendingSignatures } = await db.execute<{
      offerId: string;
      paper: "dsv_signed_scan" | "dsv_cancellation";
      signature: "participant" | "customer" | "transfergesellschaft";
    }>(sql`select dsv_offer_id as "offerId", signature_paper as paper, signature_kind as signature
      from evidence_correction where participation_id = ${target.participationId}::uuid
        and status = 'requested' and target_kind = 'dsv_signature'`);
    const open = read.projectStatus === "active" && read.status === "informed";
    const canWorkScan = open && read.dsvStatus === "dsv_offered";
    // The countersigned original is a scan of the signed offer, until the participation entered.
    const signedOffer = read.offers.some((offer) => offer.endedAs === "signed");
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
      cancellations: cancellations.flatMap((scan) => {
        const document = list.documents.find((d) => d.id === scan.id);
        return document ? [{ document, metadata: scan.metadata, counting: scan.counting }] : [];
      }),
      customerNotice:
        noticeDue !== null || noticeState.notifiedOn !== null
          ? {
              dueSince: noticeDue ?? noticeState.withdrawnOn!,
              notifiedOn: noticeState.notifiedOn,
            }
          : null,
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
      contract: contracts[0] ?? null,
      facts: {
        dsvScanReceived: facts[0] ?? null,
        dsvFullyExecuted: packets[0] ?? null,
        dsvCancellation: cancellation
          ? { validOn: cancellation.validOn, recordedAt: cancellation.recordedAt.toISOString() }
          : null,
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
      signatureCorrections: {
        // The DSV's PL and back office, who read the scans (the correction-authority table).
        mayRequest: mayRequestCorrection(
          subject,
          { kind: "document", documentType: "dsv_signed_scan", documentId: target.participationId },
          target,
        ),
        pending: pendingSignatures,
      },
      capabilities: {
        uploadScan:
          (canWorkScan && read.offers.some((offer) => offer.endedAs === null)) ||
          (open && read.dsvStatus === "dsv_signed" && signedOffer),
        sign: canWorkScan,
        recordOriginal: contracts.length > 0,
        // Before the participation entered: the cancellation of the signed contract.
        uploadCancellation: open && read.dsvStatus === "dsv_signed" && signedOffer,
        recordCustomerNotice:
          noticeDue !== null &&
          mayPerformOperation(subject, { kind: "recordCustomerNotice" }, target).ok,
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
      path: "/projects/{projectId}/dsv/generations",
      tags: ["projects"],
      summary:
        "Generate the DSV of 1 to 100 participations of the project with one deadline, all or nothing (the PL or back office): every item is checked first, then every paper is rendered and stored and all are recorded in one transaction under the project's exclusive lock; any refusal records none",
      description: [
        "Each item is checked as a single generation is; the refusal names the item's position in the pointer (`/items/3`, `/items/3/deadline`) and never an id or a value:",
        "- `422`: the single generation's codes (`dsv_offer_open`, `no_entry_wave`, `tg_dates_missing`, `dsv_template_not_pinned`, `explicit_deadline_required`, `offer_deadline_invalid`, `dsv_already_signed`, ...), for every item that can't be generated.",
        "- `409 source_changed`: a wave's deadline moved since the dialog showed it (`wave` choice) or a printed value moved while recording.",
        "- `404`: a participation that isn't in the project or isn't visible. `503 pdf_unavailable` or `storage_unavailable`; nothing is recorded and every stored paper is removed.",
      ].join("\n"),
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: DsvBulkGenerationRequest } },
        },
      },
      responses: {
        201: json(DsvBulkGenerationResult, "Generated: one document per participation, in order"),
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
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), projectId);
      if (!visible) return problem(c, "not-found") as never;
      if (!mayWorkDsv(subject, { projectId, regionId, participationId: null }).ok) {
        return problem(c, "forbidden") as never;
      }
      const ids = input.items.map((item) => item.participationId);
      // A participation of another project, or that doesn't exist, is not found: the whole batch.
      const known = await db
        .select({ id: participation.id })
        .from(participation)
        .where(
          sql`${participation.projectId} = ${projectId}::uuid and ${participation.id} = any(${sql.param(ids)}::uuid[])`,
        );
      if (known.length !== ids.length) return problem(c, "not-found") as never;
      const outcome = await service.generateBatch(ids, input.deadline, clock.today(), context(c));
      logger.info(
        {
          requestId: c.get("requestId"),
          projectId,
          formCode: "dsv",
          count: ids.length,
          deadlineKind: input.deadline.kind,
          outcome: outcome.ok
            ? "generated"
            : (outcome.refusals
                .map(({ refusal }) =>
                  refusal.kind === "function"
                    ? (functionRefusal(refusal.error) ?? "failed")
                    : refusal.kind === "unavailable"
                      ? refusal.code
                      : refusal.kind === "stale"
                        ? "source_changed"
                        : "refused",
                )
                .find(() => true) ?? "refused"),
        },
        "form generation batch",
      );
      if (!outcome.ok) return refusedBatch(c, outcome.refusals) as never;
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          generations: outcome.results.map(({ participationId, result }) => ({
            participationId,
            ...result,
          })),
        },
        201,
      );
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
      path: "/participations/{participationId}/dsv/cancellation-scans",
      tags: ["participations"],
      summary:
        "Upload the cancellation of the signed contract (the PL or back office; process-and-lifecycle.md, the cancellation): against the signed offer, with the dates on the paper per signature, the receiver and the day received; nothing defaulted. Signed on paper; no e-signature",
      description: [
        "Refusals:",
        "- `404`: an offer of another participation.",
        "- `409 source_changed`: the offer isn't the signed one.",
        "- `422`: `cancellation_not_open` (not `informed` on a signed DSV), `signature_in_future`, `received_in_future`, `received_before_signature`, `receiver_required`, and the upload's own codes.",
      ].join("\n"),
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
        { type: "dsv_cancellation", ...file, dsv: metadata },
      ) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/dsv/customer-notice",
      tags: ["participations"],
      summary:
        'Record "Kunde informiert am" for a cancellation-based withdrawal (the PL; Q46): once, not in the future, not before the withdrawal; audited dsv_customer_notified with the day. The customer\'s data whitelist is unchanged',
      description: [
        "Refusals:",
        "- `403`: anyone but the project's PL.",
        "- `422` at `/notifiedOn`: `date_in_future`, `notice_before_withdrawal`.",
        "- `422`: `notice_not_due` (no withdrawal on a signed DSV), `notice_recorded` (once).",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: DsvCustomerNoticeRequest } },
        },
      },
      responses: {
        200: json(DsvView, "Recorded"),
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
      const { participationId } = c.req.valid("param");
      const { notifiedOn } = c.req.valid("json");
      const allowed = await access(c, participationId);
      if (!allowed.ok) return allowed.response as never;
      if (
        !mayPerformOperation(allowed.subject, { kind: "recordCustomerNotice" }, allowed.target).ok
      ) {
        return problem(c, "forbidden") as never;
      }
      const log = (outcome: string) =>
        logger.info(
          { requestId: c.get("requestId"), participationId, outcome },
          "dsv customer notice",
        );
      const {
        rows: [state],
      } = await db.execute<{
        status: MainStatus;
        dsv_status: DsvStatus;
        withdrawn_on: string | null;
        notified_on: string | null;
      }>(sql`select p.status::text, p.dsv_status::text, p.withdrawn_on::text, n.notified_on::text
        from participation p left join dsv_customer_notice n on n.participation_id = p.id
        where p.id = ${participationId}::uuid`);
      const problemCode = dsvCustomerNoticeProblem(
        {
          status: state!.status,
          dsvStatus: state!.dsv_status,
          withdrawnOn: state!.withdrawn_on,
          notifiedOn: state!.notified_on,
        },
        notifiedOn,
        clock.today(),
      );
      if (problemCode) {
        log(problemCode);
        return domainProblem(c, [{ code: problemCode, field: pointer(problemCode) }]) as never;
      }
      try {
        await db.execute(sql`select record_customer_notice(${context(c)}, ${participationId}::uuid,
          ${notifiedOn}::date)`);
      } catch (error) {
        const code = functionRefusal(error);
        if (code === "actor_not_allowed") return problem(c, "forbidden") as never;
        if (
          code &&
          [
            "notice_not_due",
            "notice_recorded",
            "date_in_future",
            "notice_before_withdrawal",
          ].includes(code)
        ) {
          log(code);
          return domainProblem(c, [{ code, field: pointer(code) }]) as never;
        }
        throw error;
      }
      log("recorded");
      return c.json(
        await viewOf(await service.read(participationId), allowed.subject, allowed.target),
        200,
      );
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

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/dsv/contract/original",
      tags: ["participations"],
      summary:
        "Record the signed original's location, receipt or dispatch to the customer (PL and back office), against the value read; audited by field and location code only. Not a guard",
      description: [
        "Refusals:",
        "- `404`: no signed offer (no contract) for a participation the viewer sees.",
        "- `409 stale_value` at `/expected`: the recorded value is not the one read.",
        "- `422`: `date_in_future`, `value_unchanged`.",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: DsvOriginalRequest } } },
      },
      responses: {
        200: json(DsvView, "Recorded"),
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
      try {
        await db.execute(sql`select record_dsv_original(${context(c)}, ${participationId}::uuid,
          ${input.field}, ${input.value}, ${input.expected})`);
      } catch (error) {
        const code = functionRefusal(error);
        if (code === "stale_value") {
          return problem(c, "conflict", {
            errors: [{ pointer: "/expected", code, detail: "Read the tab again" }],
          }) as never;
        }
        if (code === "contract_not_found") return problem(c, "not-found") as never;
        if (code === "date_in_future") {
          return domainProblem(c, [{ code, field: "value" }]) as never;
        }
        return offerRefusal(c, error) as never;
      }
      logger.info(
        { requestId: c.get("requestId"), participationId, field: input.field, outcome: "recorded" },
        "dsv original",
      );
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

/** The customer notice's date refusals point at its date. */
function pointer(code: string) {
  return code === "date_in_future" || code === "notice_before_withdrawal" ? "notifiedOn" : null;
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
      "dsv_packet_missing",
      "signature_date_mismatch",
      "value_unchanged",
    ].includes(code)
  )
    return domainProblem(c, [code]);
  throw error;
}
