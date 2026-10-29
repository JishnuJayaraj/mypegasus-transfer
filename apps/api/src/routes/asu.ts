import { createRoute, z } from "@hono/zod-openapi";
import {
  and,
  asc,
  desc,
  document,
  eq,
  formGeneration,
  isNull,
  participation,
  participantDetails,
  sql,
} from "@transfer/db";
import {
  applicableAsuDueDate,
  asuRegisteredSince,
  asuRegistrationProblem,
  AsuConfirmationInput,
  AsuProofLinkInput,
  AsuRegistrationInput,
  AsuRouteInput,
  AsuView,
  documentCapabilities,
  evaluateCompleteness,
  isDirectAsuChannel,
  KnowledgeDateInput,
  Kug200bBaNoticeInput,
  kug200bDeclineProblem,
  Kug200bDeclineInput,
  kug200bOfferOutcome,
  Kug200bWithdrawalInput,
  mayAddDocument,
  mayAttestAsu,
  mayLinkAsuProof,
  mayReadKnowledgeDate,
  mayRecordAsu,
  mayRecordAsuConfirmation,
  maySetKnowledgeDate,
  mayViewAsu,
  mayWorkKug200b,
  readableDocumentTypes,
  tl407Label,
  staffSelfServiceAccess,
  type PermissionTarget,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { fieldEncryptionKey } from "../field-encryption";
import { formRegistry } from "../forms/registry";
import { asuStatesOf, registrationFacts } from "../participations/asu";
import { kug200bStatesOf } from "../participations/kug200b";
import { loadSelfService } from "../participations/self-service";
import type { StaffSubject } from "../participations/subjects";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";
import { auditContext, utc } from "../sql";
import { closedStatuses } from "./profiling";

// The tab "Arbeitsuche" (process-and-lifecycle.md, Arbeitsuchendmeldung and dates;
// data-protection.md, the ASU record; Q184, Q186; readings Q201): the route, the knowledge date
// and the due date it gives, the registration and its proof, the step's missing items. Order as in
// ADR-0010: schema → visibility (404, also for an unassigned consultant) → permission (403) →
// state (422, 409). Writes go through the SECURITY DEFINER functions; the BA-Kundennummer is passed
// to `record_asu_registration` and never returned, logged or put in an error.

const ParticipationParams = z.object({ participationId: z.uuid() });

type Access = { subject: StaffSubject; target: PermissionTarget & { participationId: string } };

const normal = { kind: "normal" } as const;

/** The staff user acting for themselves in this request. */
const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

/** A refusal of the ASU functions as its problem, or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "stale_revision" || code === "stale_value") {
    return problem(c, "conflict", {
      errors: [{ pointer: "", code, detail: "Read the tab again" }],
    });
  }
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (
    code === "participation_closed" ||
    code === "asu_not_applicable" ||
    code === "asu_registered" ||
    code === "asu_kug200b_submitted" ||
    code === "asu_route_unset" ||
    code === "asu_route_kug200b" ||
    code === "registered_on_in_future" ||
    code === "asu_registration_not_found" ||
    code === "asu_proof_present" ||
    code === "document_not_found" ||
    code === "document_not_accepted" ||
    code === "document_quarantined" ||
    code === "document_invalidated" ||
    code === "knowledge_date_in_future" ||
    code === "kug200b_signed" ||
    code === "kug200b_declined" ||
    code === "declined_on_in_future" ||
    code === "consent_not_found" ||
    code === "consent_ended" ||
    code === "received_on_in_future" ||
    code === "received_before_consent" ||
    code === "withdrawal_not_found" ||
    code === "ba_notice_recorded" ||
    code === "notified_on_in_future" ||
    code === "notified_before_receipt" ||
    code === "asu_not_kug200b" ||
    code === "asu_confirmed" ||
    code === "confirmed_on_in_future" ||
    code === "confirmed_before_submission"
  ) {
    return domainProblem(c, [code]);
  }
  throw error;
}

export function asuRoutes(deps: Deps) {
  const { db, clock } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const release = loadRelease(deps.env.configDir);
  const fieldKey = fieldEncryptionKey(deps.env.fieldEncryptionKey!);
  const registry = deps.formRegistry ?? formRegistry(deps.env.configDir);

  /**
   * The participation and the viewer's access to the tab: a 404 for no participation, a project
   * the viewer can't see, or an unassigned consultant; a 403 for a role without the case data.
   */
  async function access(
    c: Context<AppEnv>,
    participationId: string,
  ): Promise<{ ok: true; access: Access } | { ok: false; response: Response }> {
    const [found] = await db
      .select({ projectId: participation.projectId })
      .from(participation)
      .where(eq(participation.id, participationId));
    if (!found) return { ok: false, response: problem(c, "not-found") };
    const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), found.projectId);
    if (!visible) return { ok: false, response: problem(c, "not-found") };
    const target = { projectId: found.projectId, regionId, participationId };
    const view = mayViewAsu(subject, target);
    if (!view.ok) {
      const hidden = view.because === "not_assigned";
      return { ok: false, response: problem(c, hidden ? "not-found" : "forbidden") };
    }
    return { ok: true, access: { subject, target } };
  }

  /**
   * The tab for the viewer in **one snapshot** (a read-only REPEATABLE READ transaction, ADR-0010):
   * the route with its version, the registration, the proof documents and the step's missing
   * items go together, so a write naming the version read can't undo another commit unseen.
   */
  async function viewOf({ subject, target }: Access): Promise<z.infer<typeof AsuView>> {
    const participationId = target.participationId;
    return db.transaction(
      async (tx) => {
        const [current] = await tx
          .select({
            status: participation.status,
            endDate: participantDetails.oldEmploymentEndDate,
            knowledgeDate: participantDetails.knowledgeDate,
          })
          .from(participation)
          .leftJoin(participantDetails, eq(participantDetails.participationId, participation.id))
          .where(eq(participation.id, participationId));
        const asu = (await asuStatesOf(tx, [participationId])).get(participationId)!;
        // The BA confirmations' metadata only for its readers; back office gets the summary.
        const readsProofs = readableDocumentTypes(subject, target, normal).includes("asu_proof");
        const proofs = !readsProofs
          ? []
          : await tx
              .select({
                documentId: document.id,
                addedAt: utc(document.addedAt),
                reviewState: document.reviewState,
                reviewReason: document.reviewReason,
                reviewedAt: sql<string | null>`case when ${document.reviewedAt} is not null
              then ${utc(document.reviewedAt)} end`,
                quarantineReason: document.quarantineReason,
                quarantinedBy: document.quarantinedBy,
                quarantinedAt: sql<string | null>`case when ${document.quarantinedAt} is not null
              then ${utc(document.quarantinedAt)} end`,
              })
              .from(document)
              .where(
                and(
                  eq(document.participationId, participationId),
                  eq(document.type, "asu_proof"),
                  isNull(document.deletedAt),
                ),
              )
              .orderBy(asc(document.addedAt), asc(document.id));
        // The Kug 200b's forms and scans for their readers (the PL, the assigned consultant).
        const readsKug200b = readableDocumentTypes(subject, target, normal).includes(
          "kug200b_form",
        );
        const kug200bForms = !readsKug200b
          ? []
          : await tx
              .select({
                documentId: formGeneration.documentId,
                formVersion: formGeneration.formVersion,
                generatedAt: utc(formGeneration.generatedAt),
                checklist: formGeneration.checklist,
                reviewState: document.reviewState,
              })
              .from(formGeneration)
              .innerJoin(document, eq(document.id, formGeneration.documentId))
              .where(
                and(
                  eq(formGeneration.participationId, participationId),
                  eq(formGeneration.formCode, "kug200b"),
                  isNull(document.deletedAt),
                ),
              )
              .orderBy(desc(formGeneration.generatedAt), desc(formGeneration.id));
        const kug200bScans = !readsKug200b
          ? []
          : await tx
              .select({
                documentId: document.id,
                origin: document.scanOrigin,
                generationDocumentId: document.generationDocumentId,
                formVersion: document.formVersion,
                addedAt: utc(document.addedAt),
                reviewState: document.reviewState,
                reviewReason: document.reviewReason,
                reviewedAt: sql<string | null>`case when ${document.reviewedAt} is not null
              then ${utc(document.reviewedAt)} end`,
                signedOn: document.signedOn,
                quarantineReason: document.quarantineReason,
                quarantinedBy: document.quarantinedBy,
                quarantinedAt: sql<string | null>`case when ${document.quarantinedAt} is not null
              then ${utc(document.quarantinedAt)} end`,
              })
              .from(document)
              .where(
                and(
                  eq(document.participationId, participationId),
                  eq(document.type, "kug200b_signed_scan"),
                  isNull(document.deletedAt),
                ),
              )
              .orderBy(asc(document.addedAt), asc(document.id));
        const offer = (await kug200bStatesOf(tx, [participationId])).get(participationId)!;
        const record = (await loadSelfService(tx, release, participationId))!;
        const { projectType } = record.wizard;
        const applies = projectType === "ta_tg";
        const closed = closedStatuses.has(current!.status);
        const open = applies && !closed;
        const registration = asu.registration;
        const { knows } = staffSelfServiceAccess(subject, target);
        const missing = evaluateCompleteness(record.wizard.rules, {
          projectType,
          fields: record.wizard.fields,
          documents: record.wizard.documents,
        })
          .byStep.asu_registration.missing.filter(
            (item) => item.kind === "document" || knows(item.key),
          )
          .map(({ step: _, ...item }) => item);
        const readsDates = mayReadKnowledgeDate(subject, target);
        const records = mayRecordAsu(subject, target).ok;
        const unregistered = open && registration === null;
        const worksKug200b = applies && mayWorkKug200b(subject, target).ok;
        const outcome = kug200bOfferOutcome(offer);
        const today = clock.today();
        const label = (version: string, key: string) =>
          tl407Label(registry.version("kug200b", version)?.fieldMap ?? null, key);
        return {
          participationId,
          applies,
          closed,
          route: {
            channel: asu.channel,
            version: asu.version,
            defaultChannel: record.asuDefaultChannel,
          },
          ...(readsDates && {
            knowledgeDate: current!.knowledgeDate,
            oldEmploymentEndDate: current!.endDate,
            dueDate: applicableAsuDueDate({
              projectType,
              status: current!.status,
              registered: asu.fact !== null,
              endDate: current!.endDate,
              knowledgeDate: current!.knowledgeDate,
            }),
          }),
          registration: registration && {
            id: registration.id,
            channel: registration.channel,
            registeredOn: registration.registeredOn,
            recordedAt: registration.recordedAt,
            proof:
              registration.proofKind === null
                ? null
                : {
                    kind: registration.proofKind,
                    attestationSource: registration.attestationSource,
                    ...(readsProofs && { documentId: registration.proofDocumentId }),
                    linkedAt: registration.proofLinkedAt!,
                  },
            withProofSince: asuRegisteredSince(registrationFacts(registration)),
            confirmedOn: registration.confirmedOn,
          },
          ...(readsProofs && {
            proofDocuments: proofs.map((proof) => ({
              documentId: proof.documentId,
              addedAt: proof.addedAt,
              review: {
                state: proof.reviewState,
                reasonCode: proof.reviewReason,
                reviewedAt: proof.reviewedAt,
              },
              quarantine:
                proof.quarantineReason === null
                  ? null
                  : { reasonCode: proof.quarantineReason, quarantinedAt: proof.quarantinedAt! },
              linked: registration?.proofDocumentId === proof.documentId,
              capabilities: documentCapabilities(subject, target, normal, {
                type: "asu_proof",
                addedByParticipant: false,
                reviewState: proof.reviewState,
                quarantinedBy: proof.quarantinedBy,
              }),
            })),
          }),
          missing,
          kug200b: {
            offeredOn: offer.offeredOn,
            outcome,
            declinedOn: offer.declinedOn,
            profileAccess: offer.profileAccess,
            withdrawals: offer.withdrawals,
            ...(readsKug200b && {
              forms: kug200bForms.map((form, index) => ({
                documentId: form.documentId,
                formVersion: form.formVersion,
                generatedAt: form.generatedAt,
                latest: index === 0,
                versionInUse: registry.versionInUse("kug200b", form.formVersion, today),
                checklist: (
                  (form.checklist ?? []) as {
                    code: "required_blank" | "text_not_fitting";
                    key: string;
                  }[]
                ).map((item) => ({ ...item, label: label(form.formVersion, item.key) })),
                capabilities: {
                  open: documentCapabilities(subject, target, normal, {
                    type: "kug200b_form",
                    addedByParticipant: false,
                    reviewState: form.reviewState,
                    quarantinedBy: null,
                  }).open,
                },
              })),
              scans: kug200bScans.map((scan) => {
                const capabilities = documentCapabilities(subject, target, normal, {
                  type: "kug200b_signed_scan",
                  addedByParticipant: false,
                  reviewState: scan.reviewState,
                  quarantinedBy: scan.quarantinedBy,
                });
                return {
                  documentId: scan.documentId,
                  origin: scan.origin!,
                  generationDocumentId: scan.generationDocumentId,
                  formVersion: scan.formVersion,
                  addedAt: scan.addedAt,
                  review: {
                    state: scan.reviewState,
                    reasonCode: scan.reviewReason,
                    reviewedAt: scan.reviewedAt,
                  },
                  signedOn: scan.signedOn,
                  quarantine:
                    scan.quarantineReason === null
                      ? null
                      : { reasonCode: scan.quarantineReason, quarantinedAt: scan.quarantinedAt! },
                  // A scan is reviewed only while the participation is open.
                  capabilities: { ...capabilities, review: capabilities.review && open },
                };
              }),
              versions: registry.versions("kug200b"),
            }),
            capabilities: {
              generate: open && worksKug200b,
              addScan:
                open &&
                applies &&
                mayAddDocument(subject, "kug200b_signed_scan", target, normal).ok,
              decline: open && worksKug200b && outcome === null && asu.channel !== "kug_200b",
              recordWithdrawal: worksKug200b && offer.profileAccess !== null,
              recordBaNotice:
                worksKug200b && offer.withdrawals.some((w) => w.baNotifiedOn === null),
            },
          },
          capabilities: {
            setRoute: unregistered && records,
            recordRegistration: unregistered && records && isDirectAsuChannel(asu.channel),
            attest:
              unregistered && isDirectAsuChannel(asu.channel) && mayAttestAsu(subject, target).ok,
            linkProof:
              open &&
              registration !== null &&
              registration.proofKind === null &&
              mayLinkAsuProof(subject, target).ok,
            setKnowledgeDate: !closed && maySetKnowledgeDate(subject, target).ok,
            // Nothing to prove once the registration has its proof.
            addProof:
              open &&
              !registration?.proofKind &&
              mayAddDocument(subject, "asu_proof", target, normal).ok,
            // Follow-up of a batch's submission, also after the end (D19).
            recordConfirmation:
              applies &&
              registration?.channel === "kug_200b" &&
              registration.confirmedOn === null &&
              mayRecordAsuConfirmation(subject, target).ok,
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /** The tab after a write, never cached. */
  async function answer(c: Context<AppEnv>, viewer: Access) {
    c.header("Cache-Control", "no-store");
    return c.json(await viewOf(viewer), 200);
  }

  const writeResponses = {
    200: json(AsuView, "Saved: the tab as it is now"),
    ...problemResponses(
      "validation-error",
      "unauthenticated",
      "forbidden",
      "not-found",
      "conflict",
      "domain-error",
    ),
  };

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/asu",
      tags: ["participations"],
      summary:
        "The tab Arbeitsuche: the route, the knowledge and due date, the registration and its proof, the step's missing items (never the BA-Kundennummer)",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(AsuView, "The ASU record as the viewer may know it"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const result = await access(c, c.req.valid("param").participationId);
      if (!result.ok) return result.response as never;
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/asu/route",
      tags: ["participations"],
      summary:
        "Set the ASU route (the PL or the assigned consultant) with the version read; fixed once a registration is recorded (422 asu_registered); 409 stale_revision",
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: AsuRouteInput } } },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayRecordAsu(subject, target).ok) return problem(c, "forbidden");
      try {
        await db.execute(sql`select set_asu_route(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid,
          p_channel => ${input.channel}::asu_channel, p_version => ${input.version}::integer)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/asu/registration",
      tags: ["participations"],
      summary:
        "Record the registration on online_self or in_person with the route version reviewed (409 stale_revision): its actual date and, for the PL, the attestation (the BA-Kundennummer, write-only, with where it was verified); otherwise the BA confirmation is linked afterwards",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: AsuRegistrationInput } },
        },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      const permitted = input.attestation ? mayAttestAsu : mayRecordAsu;
      if (!permitted(subject, target).ok) return problem(c, "forbidden");
      const problemCode = asuRegistrationProblem(input.registeredOn, clock.today());
      if (problemCode) return domainProblem(c, [{ code: problemCode, field: "registeredOn" }]);
      const attestation = input.attestation;
      try {
        await db.execute(sql`select record_asu_registration(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid, p_id => ${randomUUID()}::uuid,
          p_registered_on => ${input.registeredOn}::date,
          p_route_version => ${input.routeVersion}::integer,
          p_customer_number => ${attestation?.customerNumber ?? null}::text,
          p_attestation_source => ${attestation?.source ?? null}::asu_attestation_source,
          p_key => ${attestation ? fieldKey.key : null}::text,
          p_key_id => ${attestation ? fieldKey.keyId : null}::text)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/asu/proof-link",
      tags: ["participations"],
      summary:
        "Link an accepted BA confirmation (asu_proof) as the registration's proof (the assigned consultant); the complete fact counts from the link",
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: AsuProofLinkInput } } },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayLinkAsuProof(subject, target).ok) return problem(c, "forbidden");
      try {
        await db.execute(sql`select link_asu_proof(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid,
          p_registration_id => ${input.registrationId}::uuid,
          p_document_id => ${input.documentId}::uuid)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/knowledge-date",
      tags: ["participations"],
      summary:
        "Set, change or clear the knowledge date (the PL) against the date read (409 stale_value); audited without the date",
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: KnowledgeDateInput } } },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!maySetKnowledgeDate(subject, target).ok) return problem(c, "forbidden");
      if (input.knowledgeDate !== null && input.knowledgeDate > clock.today()) {
        return domainProblem(c, [{ code: "knowledge_date_in_future", field: "knowledgeDate" }]);
      }
      try {
        await db.execute(sql`select set_knowledge_date(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid,
          p_knowledge_date => ${input.knowledgeDate}::date, p_previous => ${input.previous}::date)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/asu/kug200b-decline",
      tags: ["participations"],
      summary:
        "Record that the participant declined the Kug 200b (the PL or the assigned consultant) with the date; once, not once signed, not on the route kug_200b (change the route first); the registration stays as it is",
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: Kug200bDeclineInput } } },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const { declinedOn } = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayWorkKug200b(subject, target).ok) return problem(c, "forbidden");
      const dateProblem = kug200bDeclineProblem(declinedOn, clock.today());
      if (dateProblem) return domainProblem(c, [{ code: dateProblem, field: "declinedOn" }]);
      try {
        await db.execute(sql`select decline_kug200b_offer(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid, p_declined_on => ${declinedOn}::date)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/asu/withdrawal",
      tags: ["participations"],
      summary:
        'Record a written withdrawal of Kug 200b declaration 17 that reached the TG (the PL or the assigned consultant, also after the end), with the date received: ends its record (consent_ended, revoked) and opens "BA informiert am"; the registration stays as it is',
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: Kug200bWithdrawalInput } },
        },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayWorkKug200b(subject, target).ok) return problem(c, "forbidden");
      if (input.receivedOn > clock.today()) {
        return domainProblem(c, [{ code: "received_on_in_future", field: "receivedOn" }]);
      }
      try {
        await db.execute(sql`select record_declaration_withdrawal(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid, p_id => ${randomUUID()}::uuid,
          p_consent_id => ${input.consentId}::uuid, p_received_on => ${input.receivedOn}::date)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/asu/withdrawal-ba-notice",
      tags: ["participations"],
      summary:
        'Record "BA informiert am" for a withdrawal (the PL or the assigned consultant, also after the end): once, not before the receipt; it records that the BA was told, never that its access was disabled',
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: Kug200bBaNoticeInput } } },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayWorkKug200b(subject, target).ok) return problem(c, "forbidden");
      if (input.notifiedOn > clock.today()) {
        return domainProblem(c, [{ code: "notified_on_in_future", field: "notifiedOn" }]);
      }
      try {
        await db.execute(sql`select record_withdrawal_ba_notice(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid,
          p_withdrawal_id => ${input.withdrawalId}::uuid,
          p_notified_on => ${input.notifiedOn}::date)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/asu/confirmation",
      tags: ["participations"],
      summary:
        '"Bestätigung der Agentur am" for a Kug 200b batch\'s registration (the PL, also after the end): once, from the submission to today; follow-up work, never a condition of the registration',
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: AsuConfirmationInput } } },
      },
      responses: writeResponses,
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayRecordAsuConfirmation(subject, target).ok) return problem(c, "forbidden");
      if (input.confirmedOn > clock.today()) {
        return domainProblem(c, [{ code: "confirmed_on_in_future", field: "confirmedOn" }]);
      }
      try {
        await db.execute(sql`select record_asu_confirmation(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid,
          p_registration_id => ${input.registrationId}::uuid,
          p_confirmed_on => ${input.confirmedOn}::date)`);
      } catch (error) {
        return refused(c, error);
      }
      return answer(c, result.access);
    },
  );

  return router;
}
