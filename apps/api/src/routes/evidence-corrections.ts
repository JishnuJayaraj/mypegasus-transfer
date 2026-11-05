import { createRoute, z } from "@hono/zod-openapi";
import {
  asuRegistration,
  baReportingTask,
  document,
  eq,
  evidenceCorrection,
  participation,
  sql,
  transactionWithClient,
} from "@transfer/db";
import {
  correctionShape,
  documentsHidden,
  EvidenceCorrectionDecisionInput,
  EvidenceCorrectionRequested,
  EvidenceCorrectionRequestInput,
  mayDecideCorrection,
  mayReadAsuRegistration,
  mayReadBaReportingTasks,
  maySeeReview,
  mayRequestCorrection,
  readableDocumentTypes,
  type DocumentType,
  type EvidenceCorrectionRequestInput as RequestInput,
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

/** The functions' refusals as their problems (allowlisted), or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
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
      return domainProblem(c, [{ code, field: fields[code] ?? null }]);
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
  | undefined
> {
  const { participationId, projectId } = target;
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
      const authority =
        correctionTarget.kind === "document"
          ? ({
              kind: "document",
              documentType: correctionTarget.documentType,
              documentId: correctionTarget.id,
            } as const)
          : correctionTarget.kind === "asu_registration"
            ? ({ kind: "asu_registration", registrationId: correctionTarget.id } as const)
            : ({ kind: "ba_reporting_task", taskId: correctionTarget.id } as const);
      if (!mayRequestCorrection(subject, authority, target)) {
        return problem(c, "forbidden") as never;
      }
      const { targetKind, action } = correctionShape(input.correction);
      let correctionId: string;
      try {
        const { rows } = await db.execute<{ result: string }>(sql`select
          request_evidence_correction(p_context => ${context(c)},
            p_participation_id => ${participationId}::uuid,
            p_target_kind => ${targetKind}::correction_target_kind,
            p_action => ${action}::correction_action, p_target_id => ${correctionTarget.id}::uuid,
            p_wrong_person => ${input.correction === "invalidate_document" ? input.wrongPerson : null}::boolean,
            p_corrected_registered_on => ${input.correction === "supersede_asu_registration" ? input.registeredOn : null}::date,
            p_reason => ${input.reason}::correction_reason, p_source => ${input.source}) as result`);
        correctionId = rows[0]!.result;
      } catch (error) {
        return refused(c, error) as never;
      }
      logger.info(
        {
          requestId: c.get("requestId"),
          participationId,
          correctionId,
          targetKind,
          action,
          reason: input.reason,
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
