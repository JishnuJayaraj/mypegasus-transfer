import { z } from "zod";
import { FormVersion } from "../forms/field-map";
import { isoDate } from "../iso-date";
import {
  AgenturKey,
  AsuChannel,
  Kug200bBatchChannel,
  Tl407SubmissionChannel,
} from "../projects/agentur-settings";
import {
  BatchStaleRow,
  Kug200bArtifactView,
  Kug200bBatchArtifact,
  kug200bBatchMax,
  Kug200bBatchStatus,
} from "./batches";
import { Kug200aChecklistItem } from "./kug200a";

// The project tab "Agentur" (ADR-0010; process-and-lifecycle.md, Kug 200b batches): the PL's view
// of the placement Agenturen, their ready scans and the batches. Names, codes, dates and instants;
// never a scan's content, an RV-Nummer or another sensitive value.

const instant = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });

/** How a submission went to the Agentur: a batch's channel or, from PR 6-5b, a TL 407's. */
export const AgenturSubmissionChannel = z
  .enum([
    ...Kug200bBatchChannel.options,
    ...Tl407SubmissionChannel.options.filter((c) => c !== "upload"),
  ])
  .meta({ id: "AgenturSubmissionChannel" });
export type AgenturSubmissionChannel = z.infer<typeof AgenturSubmissionChannel>;

/** A participation as the tab lists it: its name and its accepted Kug 200b scan. */
const person = {
  participationId: z.uuid(),
  documentId: z.uuid(),
  lastName: z.string(),
  firstName: z.string(),
  formVersion: FormVersion,
  /** The ASU route: on `kug_200b` the submission is the registration. */
  asuChannel: AsuChannel.nullable(),
};

export const Kug200bBatchCandidate = z.strictObject(person).meta({ id: "Kug200bBatchCandidate" });

export const Kug200bBatchMember = z.strictObject(person).meta({ id: "Kug200bBatchMember" });

export const Kug200bBatchView = z
  .strictObject({
    id: z.uuid(),
    agenturKey: AgenturKey,
    channel: Kug200bBatchChannel,
    artifact: Kug200bBatchArtifact,
    status: Kug200bBatchStatus,
    createdAt: instant,
    /** The Berlin date it was built: "Übermittelt am" is not before it. */
    createdOn: isoDate,
    submittedOn: isoDate.nullable(),
    submittedAt: instant.nullable(),
    discardedAt: instant.nullable(),
    members: z.array(Kug200bBatchMember),
    /** An open batch's recheck as read now: any row refuses its export and submission. */
    staleRows: z.array(BatchStaleRow),
    /**
     * An open, current batch's handwriting checklist, shown before its artifact is printed (Q197
     * (8), Q205): codes, keys and the members concerned, never a value; null otherwise.
     */
    checklist: z.array(Kug200aChecklistItem).nullable(),
    capabilities: z.strictObject({
      submit: z.boolean(),
      discard: z.boolean(),
      exportIndex: z.boolean(),
      /** The official artifact: the Kug 200a, or the accepted alternative list. */
      exportArtifact: z.boolean(),
      /** The members' scans as one PDF: the channels `scan_email` and `upload` only. */
      exportScans: z.boolean(),
    }),
  })
  .meta({ id: "Kug200bBatch" });
export type Kug200bBatchView = z.infer<typeof Kug200bBatchView>;

/** One placement Agentur of the project's participations. */
export const Kug200bAgenturView = z
  .strictObject({
    agenturKey: AgenturKey,
    /** The resolved `batchSubmissionChannel`; null: "Einstellungen fehlen" (the step blocker, Q91). */
    channel: Kug200bBatchChannel.nullable(),
    artifact: Kug200bArtifactView,
    /** The scans ready for a new batch. */
    candidates: z.array(Kug200bBatchCandidate),
    /**
     * Ready but for the ASU route: it is chosen on "Arbeitsuche" first, since it decides whether
     * the submission is the registration (Q203).
     */
    routeMissing: z.array(
      z.strictObject({ participationId: z.uuid(), lastName: z.string(), firstName: z.string() }),
    ),
    capabilities: z.strictObject({ createBatch: z.boolean() }),
  })
  .meta({ id: "Kug200bAgentur" });

export const Kug200bBatchesView = z
  .strictObject({
    /** Accepted scans of open participations without a placement Agentur: no batch takes them. */
    withoutPlacementAgentur: z.int().min(0),
    agenturen: z.array(Kug200bAgenturView),
    /** The project's batches, newest first. */
    batches: z.array(Kug200bBatchView),
  })
  .meta({ id: "Kug200bBatches" });
export type Kug200bBatchesView = z.infer<typeof Kug200bBatchesView>;

/** `POST /projects/{id}/kug200b-batches`: the Agentur and 1–200 scans, each once. */
export const CreateKug200bBatchInput = z
  .strictObject({
    agenturKey: AgenturKey,
    documentIds: z
      .array(z.uuid())
      .min(1)
      .max(kug200bBatchMax)
      .refine((ids) => new Set(ids).size === ids.length, { params: { code: "duplicate_value" } }),
  })
  .meta({ id: "CreateKug200bBatchInput" });
export type CreateKug200bBatchInput = z.infer<typeof CreateKug200bBatchInput>;

export const Kug200bBatchCreated = z
  .strictObject({ batchId: z.uuid() })
  .meta({ id: "Kug200bBatchCreated" });

/** `POST /kug200b-batches/{id}/submission`: "Übermittelt am", the actual sent date. */
export const Kug200bBatchSubmissionInput = z
  .strictObject({ submittedOn: isoDate })
  .meta({ id: "Kug200bBatchSubmissionInput" });

export const Kug200bBatchSubmitted = z
  .strictObject({ submissions: z.int().min(1), registrations: z.int().min(0) })
  .meta({ id: "Kug200bBatchSubmitted" });

export const Kug200bBatchParams = z.object({ batchId: z.uuid() });

/** `POST /participations/{id}/asu/confirmation`: "Bestätigung der Agentur am". */
export const AsuConfirmationInput = z
  .strictObject({ registrationId: z.uuid(), confirmedOn: isoDate })
  .meta({ id: "AsuConfirmationInput" });
