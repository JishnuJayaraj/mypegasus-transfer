import { createRoute, z } from "@hono/zod-openapi";
import {
  asuRegistration,
  baReportingTask,
  document,
  dsvOffer,
  eq,
  evidenceCorrection,
  participation,
  sql,
  transactionWithClient,
} from "@transfer/db";
import {
  correctionShape,
  documentsHidden,
  fieldCorrectionProblem,
  signatureCorrectionProblem,
  EvidenceCorrectionDecisionInput,
  EvidenceCorrectionRequested,
  EvidenceCorrectionRequestInput,
  mayDecideCorrection,
  mayReadAsuRegistration,
  mayReadBaReportingTasks,
  maySeeReview,
  mayRequestCorrection,
  readableDocumentTypes,
  type DateCorrectionProblem,
  type DocumentType,
  type EvidenceCorrectionRequestInput as RequestInput,
  type EvidenceCorrectionTarget,
  type Subject,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { purgeDocumentObject } from "../documents/purge";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// Evidence corrections (data-protection.md, evidence corrections; ADR-0010; D29, Q183, Q186, Q190;
// readings Q209): the PL requests one on an accepted document, an ASU registration or a closed BA
// reporting task; the regional operations manager decides it in "Freigaben". Order as in ADR-0010:
// schema → visibility (404: a participation, target or correction the viewer can't see, whatever
// its state; a target is visible to whoever reads it or may request its correction, a grant of its
// own) → permission (403) → state (422; 409 for a correction decided since "Freigaben" showed it).
// The functions check the roles and states again under the locks. Logs carry ids and codes only,
// never the source.

const ParticipationParams = z.object({ participationId: z.uuid() });
const CorrectionParams = z.object({ correctionId: z.uuid() });

const normal = { kind: "normal" } as const;

/** The staff user acting for themselves in this request. */
const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

/** Where a refused request points (ADR-0010). */
const fields: Record<string, string> = {
  source_invalid: "source",
  registered_on_in_future: "registeredOn",
  correction_unchanged: "registeredOn",
};

/** A date correction's refusals point at its own fields (the request's shape decides which). */
function pointerOf(code: string, input: RequestInput | undefined): string | null {
  if (input?.correction === "correct_field") {
    return code === "field_not_recorded" || code === "withdrawal_by_system" ? "field" : "value";
  }
  if (input?.correction === "supersede_dsv_signature") {
    return code === "signature_not_shown" || code === "signature_date_mismatch"
      ? "signature"
      : "signedOn";
  }
  return fields[code] ?? null;
}

/** The functions' refusals as their problems (allowlisted), or rethrown. */
function refused(c: Context<AppEnv>, error: unknown, input?: RequestInput) {
  const code = functionRefusal(error);
  switch (code) {
    case "actor_not_allowed":
    case "same_person_approval":
      return problem(c, "forbidden");
    case "target_not_found":
    case "correction_not_found":
      return problem(c, "not-found");
    case "correction_not_pending":
      return problem(c, "conflict", {
        errors: [{ pointer: "", code: "source_changed", detail: "Read Freigaben again" }],
      });
    case "source_invalid":
    case "registered_on_in_future":
    case "correction_unchanged":
    case "document_not_accepted":
    case "task_pending":
    case "asu_route_kug200b":
    case "target_corrected":
    case "correction_pending":
    case "field_not_recorded":
    case "corrected_on_in_future":
    case "effective_date_before_signature":
    case "withdrawal_by_system":
    case "effective_date_before_cancellation":
    case "signature_not_shown":
    case "signature_date_mismatch":
    case "received_before_signature":
      return domainProblem(c, [{ code, field: pointerOf(code, input) }]);
    default:
      throw error;
  }
}

type Target = { participationId: string; projectId: string; regionId: string | null };

/**
 * The request's target as the viewer may know it: the participation's live document, ASU
 * registration or BA reporting task, read by the viewer or one whose correction they may request.
 * Undefined (a 404) otherwise, whatever its state.
 */
async function targetOf(
  db: Deps["db"],
  subject: Subject,
  target: Target,
  input: RequestInput,
): Promise<
  | { kind: "document"; id: string; documentType: DocumentType }
  | { kind: "asu_registration"; id: string }
  | { kind: "ba_reporting_task"; id: string }
  | { kind: "field"; fieldKey: string }
  | { kind: "dsv_signature"; id: string; documentType: DocumentType }
  | undefined
> {
  const { participationId, projectId } = target;
  // A field of the participation the viewer sees: its correction is the authority table's.
  if (input.correction === "correct_field") return { kind: "field", fieldKey: input.field };
  if (input.correction === "supersede_dsv_signature") {
    // The offer of this participation, seen by whoever reads its paper or may request the
    // correction of its signatures (the DSV's PL and back office).
    if (documentsHidden(subject, target)) return undefined;
    const [found] = await db
      .select({ participationId: dsvOffer.participationId })
      .from(dsvOffer)
      .where(eq(dsvOffer.id, input.offerId));
    if (found?.participationId !== participationId) return undefined;
    const sees =
      readableDocumentTypes(subject, target, normal).includes(input.paper) ||
      mayRequestCorrection(
        subject,
        { kind: "document", documentType: input.paper, documentId: input.offerId },
        target,
      );
    return sees
      ? { kind: "dsv_signature", id: input.offerId, documentType: input.paper }
      : undefined;
  }
  if (input.correction === "invalidate_document") {
    if (documentsHidden(subject, target)) return undefined;
    const [found] = await db
      .select({ type: document.type, participationId: document.participationId })
      .from(document)
      .where(sql`${document.id} = ${input.documentId} and ${document.deletedAt} is null`);
    if (found?.participationId !== participationId) return undefined;
    const sees =
      readableDocumentTypes(subject, target, normal).includes(found.type) ||
      mayRequestCorrection(
        subject,
        { kind: "document", documentType: found.type, documentId: input.documentId },
        target,
      );
    return sees ? { kind: "document", id: input.documentId, documentType: found.type } : undefined;
  }
  if (input.correction === "supersede_ba_report") {
    const [found] = await db
      .select({ participationId: baReportingTask.participationId })
      .from(baReportingTask)
      .where(eq(baReportingTask.id, input.taskId));
    if (found?.participationId !== participationId) return undefined;
    const sees =
      mayReadBaReportingTasks(subject, projectId, participationId) ||
      mayRequestCorrection(subject, { kind: "ba_reporting_task", taskId: input.taskId }, target);
    return sees ? { kind: "ba_reporting_task", id: input.taskId } : undefined;
  }
  const [found] = await db
    .select({ participationId: asuRegistration.participationId })
    .from(asuRegistration)
    .where(eq(asuRegistration.id, input.registrationId));
  if (found?.participationId !== participationId) return undefined;
  const sees =
    mayReadAsuRegistration(subject, projectId, participationId) ||
    mayRequestCorrection(
      subject,
      { kind: "asu_registration", registrationId: input.registrationId },
      target,
    );
  return sees ? { kind: "asu_registration", id: input.registrationId } : undefined;
}

/** The authority table's target for a request's target (`mayRequestCorrection`). */
function authorityOf(
  target: NonNullable<Awaited<ReturnType<typeof targetOf>>>,
): EvidenceCorrectionTarget {
  switch (target.kind) {
    case "document":
    case "dsv_signature":
      return { kind: "document", documentType: target.documentType, documentId: target.id };
    case "asu_registration":
      return { kind: "asu_registration", registrationId: target.id };
    case "ba_reporting_task":
      return { kind: "ba_reporting_task", taskId: target.id };
    case "field":
      return { kind: "field", fieldKey: target.fieldKey };
  }
}

/**
 * The domain's rules for a date correction on the values recorded now (data-protection.md,
 * evidence corrections: field targets and the DSV signature-date supersession); the function
 * checks the same under the lock.
 */
async function dateProblem(
  db: Deps["db"],
  participationId: string,
  input: RequestInput,
  today: string,
): Promise<DateCorrectionProblem | null> {
  if (input.correction === "correct_field") {
    const { rows } = await db.execute<{
      profiling_done_on: string | null;
      withdrawn_on: string | null;
      tl407_signed_on: string | null;
      withdrawn_by: "user" | "system" | null;
      signed_dsv: boolean;
      cancellation_valid_on: string | null;
    }>(sql`select
        case when p.profiling_status = 'profiling_done' then p.profiling_done_on::text end
          as profiling_done_on,
        case when p.status = 'withdrawn' then p.withdrawn_on::text end as withdrawn_on,
        (select min(greatest(d.signed_on, d.countersigned_on))::text from document d
          where d.participation_id = p.id and d.type = 'tl407_signed_scan'
            and d.review_state = 'accepted' and d.deleted_at is null
            and d.quarantined_at is null and d.invalidated_by_correction is null) as tl407_signed_on,
        (select a.actor_type::text from audit_event a where a.participation_id = p.id
            and a.event_type = 'status_changed' and a.field = 'status' and a.to_value = 'withdrawn'
          order by a.occurred_at desc, a.seq desc limit 1) as withdrawn_by,
        p.dsv_status = 'dsv_signed' as signed_dsv,
        (select min(f.valid_on)::text from dsv_cancellation_facts(array[p.id]) f)
          as cancellation_valid_on
      from participation p where p.id = ${participationId}::uuid`);
    const row = rows[0]!;
    return fieldCorrectionProblem(
      input.field === "profilingDoneOn"
        ? { field: "profilingDoneOn", current: row.profiling_done_on, tl407SignedOn: row.tl407_signed_on }
        : {
            field: "withdrawnOn",
            current: row.withdrawn_on,
            withdrawnBy: row.withdrawn_by,
            signedDsv: row.signed_dsv,
            cancellationValidOn: row.cancellation_valid_on,
          },
      input.value,
      today,
    );
  }
  if (input.correction === "supersede_dsv_signature") {
    const { rows } = await db.execute<{ signedOn: string; receivedOn: string }>(sql`select
        s.signed_on::text as "signedOn", d.dsv_received_on::text as "receivedOn"
      from document d join dsv_scan_signature s on s.document_id = d.id
        and s.kind = ${input.signature} and s.superseded_by is null
      where d.dsv_offer_id = ${input.offerId}::uuid and d.type::text = ${input.paper}
        and d.participation_id = ${participationId}::uuid and d.review_state = 'accepted'
        and d.deleted_at is null and d.invalidated_by_correction is null`);
    return signatureCorrectionProblem(rows, input.signature, input.signedOn, today);
  }
  return null;
}

export function evidenceCorrectionRoutes(deps: Deps) {
  const { db, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/evidence-corrections",
      tags: ["participations"],
      summary:
        "Request a correction of wrong evidence (the PL, by the correction-authority table): invalidate an accepted document (stating whether it is a wrong person's file), supersede an ASU registration with the corrected date or invalidate it, or supersede a closed BA reporting outcome; with a reason code and the documented source. Changes nothing until the regional operations manager approves it",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: EvidenceCorrectionRequestInput } },
        },
      },
      responses: {
        201: json(EvidenceCorrectionRequested, "Requested; the correction's id"),
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
      const target = { projectId: found.projectId, regionId, participationId };
      const correctionTarget = await targetOf(db, subject, target, input);
      if (!correctionTarget) return problem(c, "not-found") as never;
      const authority = authorityOf(correctionTarget);
      if (!mayRequestCorrection(subject, authority, target)) {
        return problem(c, "forbidden") as never;
      }
      const problemNow = await dateProblem(db, participationId, input, deps.clock.today());
      if (problemNow) {
        return domainProblem(c, [{ code: problemNow.code, field: problemNow.field }]) as never;
      }
      const { targetKind, action } = correctionShape(input.correction);
      const targetId = correctionTarget.kind === "field" ? null : correctionTarget.id;
      let correctionId: string;
      try {
        const { rows } = await db.execute<{ result: string }>(sql`select
          request_evidence_correction(p_context => ${context(c)},
            p_participation_id => ${participationId}::uuid,
            p_target_kind => ${targetKind}::correction_target_kind,
            p_action => ${action}::correction_action, p_target_id => ${targetId}::uuid,
            p_wrong_person => ${input.correction === "invalidate_document" ? input.wrongPerson : null}::boolean,
            p_corrected_registered_on => ${input.correction === "supersede_asu_registration" ? input.registeredOn : null}::date,
            p_reason => ${input.reason}::correction_reason, p_source => ${input.source},
            p_field_key => ${input.correction === "correct_field" ? input.field : null}::text,
            p_corrected_on => ${input.correction === "correct_field" ? input.value : input.correction === "supersede_dsv_signature" ? input.signedOn : null}::date,
            p_signature_paper => ${input.correction === "supersede_dsv_signature" ? input.paper : null}::text,
            p_signature_kind => ${input.correction === "supersede_dsv_signature" ? input.signature : null}::text) as result`);
        correctionId = rows[0]!.result;
      } catch (error) {
        return refused(c, error, input) as never;
      }
      logger.info(
        {
          requestId: c.get("requestId"),
          participationId,
          correctionId,
          targetKind,
          action,
          reason: input.reason,
          ...(input.correction === "correct_field" && { fieldKey: input.field }),
          ...(input.correction === "supersede_dsv_signature" && {
            paper: input.paper,
            signatureKind: input.signature,
          }),
        },
        "evidence correction requested",
      );
      return c.json({ correctionId }, 201) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/evidence-corrections/{correctionId}/decision",
      tags: ["participations"],
      summary:
        "Approve or reject a pending evidence correction (the regional operations manager of the project's region, never the requester), as Freigaben showed it (409 source_changed once decided). An approval invalidates or supersedes the target, keeping the original linked; a wrong person's file is purged. No status, guard or date moves",
      middleware,
      request: {
        params: CorrectionParams,
        body: {
          required: true,
          content: { "application/json": { schema: EvidenceCorrectionDecisionInput } },
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
      const { correctionId } = c.req.valid("param");
      const input = c.req.valid("json");
      const [found] = await db
        .select({
          projectId: evidenceCorrection.projectId,
          participationId: evidenceCorrection.participationId,
          requestedBy: evidenceCorrection.requestedBy,
        })
        .from(evidenceCorrection)
        .where(eq(evidenceCorrection.id, correctionId));
      if (!found) return problem(c, "not-found") as never;
      const { subject, visible, regionId } = await projectAccess(
        db,
        sessionUser(c),
        found.projectId,
      );
      const target = {
        projectId: found.projectId,
        regionId,
        participationId: found.participationId,
      };
      // Visible in "Freigaben" (the manager of its region) or to the case's PL, who requested it.
      const sees =
        visible &&
        (maySeeReview(subject, { regionId }) ||
          (subject.kind === "staff" &&
            (subject.projectRoles[found.projectId]?.has("project_lead") ?? false)));
      if (!sees) return problem(c, "not-found") as never;
      if (!mayDecideCorrection(subject, found.requestedBy, target)) {
        return problem(c, "forbidden") as never;
      }
      let purge: string | null = null;
      try {
        await transactionWithClient(db, async (tx, client) => {
          const { rows } = await tx.execute<{ result: string | null }>(sql`select
            decide_evidence_correction(p_context => ${context(c)},
              p_correction_id => ${correctionId}::uuid,
              p_approve => ${input.decision === "approve"}) as result`);
          purge = rows[0]!.result;
          // A wrong person's file: its object's purge is queued in the decision's transaction.
          if (purge !== null) {
            await deps.documentPurges?.enqueue(purge, {
              executeSql: (text, values) => client.query(text, values),
            });
          }
        });
      } catch (error) {
        return refused(c, error) as never;
      }
      const purged: string | null = purge;
      if (purged !== null && !deps.documentPurges && deps.documentFiles) {
        const storage = deps.documentFiles.storage;
        deps.detached!.run("documents.purge-object", async () => {
          await purgeDocumentObject({ db, storage, logger }, purged, `detached:${purged}`);
        });
      }
      logger.info(
        {
          requestId: c.get("requestId"),
          correctionId,
          decision: input.decision,
          purge: purged !== null,
        },
        "evidence correction decided",
      );
      return c.body(null, 204) as never;
    },
  );

  return router;
}
