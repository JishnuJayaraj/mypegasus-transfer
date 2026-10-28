import { z } from "zod";
import { DocumentCapabilities } from "../documents/api";
import { DocumentReviewReason, DocumentReviewState, QuarantineReason } from "../documents/state";
import { isoDate } from "../iso-date";
import { AsuChannel } from "../projects/agentur-settings";
import { AsuProofKind, AttestationSource, BaCustomerNumber, directAsuChannels } from "./model";

// The tab "Arbeitsuche" (ADR-0010; process-and-lifecycle.md, Arbeitsuchendmeldung;
// data-protection.md, the ASU record): built per viewer, properties a viewer may not know about
// absent; codes, dates and instants only. The BA-Kundennummer is write-only: no response holds it.

const instant = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });

/** The due date (dates.ts, `asuDueDate`): statutory with a knowledge date, else an orientation. */
export const AsuDueDateView = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("statutory"),
      date: isoDate,
      branch: z.enum(["reference_date", "after_knowledge"]),
    }),
    z.strictObject({ kind: z.literal("orientation"), date: isoDate }),
  ])
  .meta({ id: "AsuDueDate" });

export const AsuRegistrationView = z
  .strictObject({
    id: z.uuid(),
    channel: AsuChannel,
    registeredOn: isoDate,
    recordedAt: instant,
    proof: z
      .strictObject({
        kind: AsuProofKind,
        /** Where the PL verified it (the attestation only); a schema of its own, nullable. */
        attestationSource: z.enum(AttestationSource.options).nullable(),
        /** The proving `asu_proof` document (a BA confirmation only). */
        documentId: z.uuid().nullable(),
        linkedAt: instant,
      })
      .nullable(),
    /**
     * The fact `asuRegisteredWithProof` and the instant it counts from, while it exists: a
     * quarantined or invalidated proving document supplies none.
     */
    withProofSince: instant.nullable(),
  })
  .meta({ id: "AsuRegistration" });
export type AsuRegistrationView = z.infer<typeof AsuRegistrationView>;

/** A BA confirmation (`asu_proof`) as the tab lists it: metadata only (the PL never opens it). */
export const AsuProofDocumentView = z
  .strictObject({
    documentId: z.uuid(),
    addedAt: instant,
    review: z.strictObject({
      state: DocumentReviewState,
      reasonCode: DocumentReviewReason.nullable(),
      reviewedAt: instant.nullable(),
    }),
    quarantine: z.strictObject({ reasonCode: QuarantineReason, quarantinedAt: instant }).nullable(),
    /** It proves the registration. */
    linked: z.boolean(),
    capabilities: DocumentCapabilities,
  })
  .meta({ id: "AsuProofDocument" });

/** A missing item of the `asu_registration` step: keys only, the fields the viewer may know. */
export const AsuMissingItem = z
  .strictObject({
    ruleId: z.string(),
    kind: z.enum(["field", "document"]),
    key: z.string(),
    reason: z.enum(["missing", "not_accepted"]),
  })
  .meta({ id: "AsuMissingItem" });

export const AsuView = z
  .strictObject({
    participationId: z.uuid(),
    /** `ta_tg` only (Q89); the tab says nothing about a duty in `ta_only`. */
    applies: z.boolean(),
    closed: z.boolean(),
    route: z.strictObject({
      channel: AsuChannel.nullable(),
      /** The route's version, which a change names (409 stale_revision). */
      version: z.int().min(0),
      /** The placement Agentur's resolved `defaultChannel`, preselected; never a blocker. */
      defaultChannel: AsuChannel.nullable(),
    }),
    /** For viewers of the confidential case data. */
    knowledgeDate: isoDate.nullable().optional(),
    oldEmploymentEndDate: isoDate.nullable().optional(),
    /** While it applies (`applicableAsuDueDate`); for viewers of the knowledge date. */
    dueDate: AsuDueDateView.nullable().optional(),
    registration: AsuRegistrationView.nullable(),
    proofDocuments: z.array(AsuProofDocumentView),
    /** The step `asu_registration` of the resolved rules (the Kug 200b ones on its route only). */
    missing: z.array(AsuMissingItem),
    capabilities: z.strictObject({
      setRoute: z.boolean(),
      recordRegistration: z.boolean(),
      attest: z.boolean(),
      linkProof: z.boolean(),
      setKnowledgeDate: z.boolean(),
      addProof: z.boolean(),
    }),
  })
  .meta({ id: "AsuView" });
export type AsuView = z.infer<typeof AsuView>;

/** `PUT …/asu/route`: the route, with the version read. */
export const AsuRouteInput = z
  .strictObject({ channel: AsuChannel, version: z.int().min(0) })
  .meta({ id: "AsuRouteInput" });

/**
 * `POST …/asu/registration` on `online_self` / `in_person`: the actual date and, for the PL's
 * attestation, the BA-Kundennummer with where it was verified; without it the proof is a BA
 * confirmation linked afterwards.
 */
export const AsuRegistrationInput = z
  .strictObject({
    registeredOn: isoDate,
    attestation: z
      .strictObject({
        customerNumber: BaCustomerNumber.meta({ description: "Write-only; never returned" }),
        source: AttestationSource,
      })
      .optional(),
  })
  .meta({ id: "AsuRegistrationInput" });
export type AsuRegistrationInput = z.infer<typeof AsuRegistrationInput>;

/** `POST …/asu/proof-link`: an accepted BA confirmation proves the registration. */
export const AsuProofLinkInput = z
  .strictObject({ registrationId: z.uuid(), documentId: z.uuid() })
  .meta({ id: "AsuProofLinkInput" });

/** `PUT …/knowledge-date`: the new date or null (cleared), with the one read. */
export const KnowledgeDateInput = z
  .strictObject({ knowledgeDate: isoDate.nullable(), previous: isoDate.nullable() })
  .meta({ id: "KnowledgeDateInput" });

/** A registration is recorded directly on these routes only. */
export const isDirectAsuChannel = (channel: z.infer<typeof AsuChannel> | null) =>
  (directAsuChannels as readonly string[]).includes(channel ?? "");
