import { DocumentView } from "../documents/api";
import { DsvScanMetadata } from "./scans";
import { z } from "zod";
import { isoDate } from "../iso-date";
import { DsvStatus } from "../lifecycle/enums";
import {
  DsvDeadlineChoice,
  DsvSourceToken,
  DsvTemplateVersion,
  type DsvGenerationBlocker,
  type DsvValueKey,
} from "./generation";

// The tab "DSV" (ADR-0010; process-and-lifecycle.md, the DSV: generation): built
// for the PL and back office, codes, dates and instants only. Never a value the paper prints: the
// file opens through the logged opening.

const instant = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });

const blockers = [
  "not_ta_tg",
  "project_not_active",
  "participation_closed",
  "no_entry_wave",
  "tg_dates_missing",
  "dsv_template_not_pinned",
  "dsv_template_not_approved",
  "dsv_offer_open",
  "dsv_already_signed",
] as const satisfies readonly (DsvGenerationBlocker | "dsv_template_not_approved")[];

const valueKeys = [
  "firstName",
  "lastName",
  "birthDate",
  "address",
  "customerName",
  "transfergesellschaft",
] as const satisfies readonly DsvValueKey[];

/** A value left for the hand (Q197): its key; the UI names it. */
export const DsvChecklistItem = z
  .strictObject({ code: z.literal("required_blank"), key: z.enum(valueKeys) })
  .meta({ id: "DsvChecklistItem" });

/** A generated DSV: the working copy, its deadline and whether it can still be handed out. */
export const DsvGenerationView = z
  .strictObject({
    generationId: z.uuid(),
    documentId: z.uuid(),
    generatedAt: instant,
    templateVersion: DsvTemplateVersion,
    offerDeadline: isoDate,
    deadlineKind: z.enum(["wave", "explicit"]),
    checklist: z.array(DsvChecklistItem),
    /** A printed value changed, its deadline passed or the wave's deadline moved (process-and-lifecycle.md, the DSV: generation as built). */
    stale: z.boolean(),
    capabilities: z.strictObject({ open: z.boolean() }),
  })
  .meta({ id: "DsvGenerationView" });

/** Where the signed original is kept (Q110: controlled, not free text). */
export const DsvOriginalLocation = z.enum(["paper_personnel_file"]);

/** The signed offer's contract: signature dates as retained, the original's tracking. */
export const DsvContractView = z
  .strictObject({
    offerId: z.uuid(),
    participantSignedOn: isoDate.nullable(),
    customerSignedOn: isoDate.nullable(),
    tgSignedOn: isoDate.nullable(),
    fullyExecutedOn: isoDate.nullable(),
    originalLocation: DsvOriginalLocation.nullable(),
    originalReceivedOn: isoDate.nullable(),
    sentToCustomerOn: isoDate.nullable(),
  })
  .meta({ id: "DsvContractView" });

/**
 * `PUT /participations/{id}/dsv/contract/original`: one field, against the value read
 * (`409 stale_value`); `expected` is null while nothing is recorded.
 */
export const DsvOriginalRequest = z
  .discriminatedUnion("field", [
    z.strictObject({
      field: z.literal("originalLocation"),
      value: DsvOriginalLocation,
      expected: DsvOriginalLocation.nullable(),
    }),
    z.strictObject({
      field: z.enum(["originalReceivedOn", "sentToCustomerOn"]),
      value: isoDate,
      expected: isoDate.nullable(),
    }),
  ])
  .meta({ id: "DsvOriginalRequest" });
export type DsvOriginalRequest = z.infer<typeof DsvOriginalRequest>;

export const DsvView = z
  .strictObject({
    participationId: z.uuid(),
    track: DsvStatus,
    statusVersion: z.number().int().nonnegative(),
    scans: z.array(
      z.strictObject({ document: DocumentView, metadata: DsvScanMetadata, counting: z.boolean() }),
    ),
    receivers: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
    offers: z.array(
      z.strictObject({
        id: z.uuid(),
        origin: z.enum(["generated", "external_paper"]),
        offerDeadline: isoDate,
        offeredAt: instant,
        endedAs: z.enum(["signed", "declined", "expired"]).nullable(),
        capabilities: z.strictObject({ decline: z.boolean() }),
      }),
    ),
    /** The project's pinned template version and whether its wording is approved for live use. */
    template: z
      .strictObject({ version: DsvTemplateVersion, approvedForLive: z.boolean() })
      .nullable(),
    /** What the dialog offers: the wave's deadline for a first offer, the bounds of any. */
    deadline: z.strictObject({
      waveSigningDeadline: isoDate.nullable(),
      /** A re-offer needs an explicit deadline (Q69). */
      explicitRequired: z.boolean(),
      latestEntryDate: isoDate.nullable(),
      tgStart: isoDate.nullable(),
    }),
    /** The printed values' token now, sent back with a generation (`409 source_changed`). */
    sourceToken: DsvSourceToken.nullable(),
    /** What a generation now would leave for the hand. */
    checklist: z.array(DsvChecklistItem),
    /** Why no DSV can be generated now (C1: the prerequisite next to the button). */
    blockers: z.array(z.enum(blockers)),
    generations: z.array(DsvGenerationView),
    /**
     * The signed offer's contract (process-and-lifecycle.md, DSV packet and original): the
     * retained signature dates and the original's tracking; null until the offer is signed.
     */
    contract: DsvContractView.nullable(),
    /** `dsvGenerated` (process-and-lifecycle.md, the DSV: generation as built): the current generation's Berlin day and instant; null when none. */
    facts: z.strictObject({
      dsvGenerated: z.strictObject({ validOn: isoDate, recordedAt: instant }).nullable(),
      dsvScanReceived: z.strictObject({ validOn: isoDate, recordedAt: instant }).nullable(),
      /** The complete packet: valid on the latest actual date, recorded when its scan counted. */
      dsvFullyExecuted: z.strictObject({ validOn: isoDate, recordedAt: instant }).nullable(),
    }),
    capabilities: z.strictObject({
      generate: z.boolean(),
      offer: z.boolean(),
      uploadScan: z.boolean(),
      sign: z.boolean(),
      recordOriginal: z.boolean(),
    }),
  })
  .meta({ id: "DsvView" });
export type DsvView = z.infer<typeof DsvView>;

/** `POST /participations/{id}/dsv/generations`. */
export const DsvGenerationRequest = z
  .strictObject({ deadline: DsvDeadlineChoice, expectedSourceToken: DsvSourceToken })
  .meta({ id: "DsvGenerationRequest" });

export const DsvGenerationResult = z
  .strictObject({
    documentId: z.uuid(),
    templateVersion: DsvTemplateVersion,
    offerDeadline: isoDate,
    checklist: z.array(DsvChecklistItem),
  })
  .meta({ id: "DsvGenerationResult" });
export type DsvGenerationResult = z.infer<typeof DsvGenerationResult>;

/** The most DSV one bulk generation takes . */
export const dsvBulkMax = 100;

/**
 * `POST /projects/{id}/dsv/generations`: 1 to 100 participations of the project with one deadline,
 * all or nothing. Each paper prints the values current at the call (the function compares them
 * again under the lock); a participation that can't be generated refuses the whole batch with its
 * position. `wave`'s `shown` is compared with each participation's wave deadline.
 */
export const DsvBulkGenerationRequest = z
  .strictObject({
    deadline: DsvDeadlineChoice,
    items: z
      .array(z.strictObject({ participationId: z.uuid() }))
      .min(1)
      .max(dsvBulkMax),
  })
  .refine(
    (value) => new Set(value.items.map((i) => i.participationId)).size === value.items.length,
    {
      message: "participation_duplicated",
      path: ["items"],
    },
  )
  .meta({ id: "DsvBulkGenerationRequest" });
export type DsvBulkGenerationRequest = z.infer<typeof DsvBulkGenerationRequest>;

/** The generations of a batch, in the request's order. */
export const DsvBulkGenerationResult = z
  .strictObject({
    generations: z.array(
      z.strictObject({ participationId: z.uuid(), ...DsvGenerationResult.shape }),
    ),
  })
  .meta({ id: "DsvBulkGenerationResult" });
export type DsvBulkGenerationResult = z.infer<typeof DsvBulkGenerationResult>;

/** `PUT /projects/{id}/dsv-template` (the PL). */
export const DsvTemplatePinInput = z
  .strictObject({ version: DsvTemplateVersion })
  .meta({ id: "DsvTemplatePinInput" });

/** The project's DSV template: pinned version, the versions to choose from, whether it is fixed. */
export const DsvTemplateView = z
  .strictObject({
    version: DsvTemplateVersion.nullable(),
    /** Fixed from the project's first generation. */
    fixed: z.boolean(),
    versions: z.array(
      z.strictObject({ version: DsvTemplateVersion, approvedForLive: z.boolean() }),
    ),
    capabilities: z.strictObject({ pin: z.boolean() }),
  })
  .meta({ id: "DsvTemplateView" });
export type DsvTemplateView = z.infer<typeof DsvTemplateView>;

export const DsvOfferRequest = z
  .union([
    z.strictObject({ generationId: z.uuid(), statusVersion: z.number().int().nonnegative() }),
    z.strictObject({
      external: z.strictObject({
        deadline: isoDate,
        printedTgStart: isoDate,
        printedTgEnd: isoDate,
      }),
      statusVersion: z.number().int().nonnegative(),
    }),
  ])
  .meta({ id: "DsvOfferRequest" });
export const DsvDeclineRequest = z
  .strictObject({ statusVersion: z.number().int().nonnegative() })
  .meta({ id: "DsvDeclineRequest" });
