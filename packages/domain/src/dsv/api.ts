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

// The tab "DSV" (ADR-0010; process-and-lifecycle.md, the DSV: generation; Slice 7 D1–D3): built
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
    documentId: z.uuid(),
    generatedAt: instant,
    templateVersion: DsvTemplateVersion,
    offerDeadline: isoDate,
    deadlineKind: z.enum(["wave", "explicit"]),
    checklist: z.array(DsvChecklistItem),
    /** A printed value changed, its deadline passed or the wave's deadline moved (D3). */
    stale: z.boolean(),
    capabilities: z.strictObject({ open: z.boolean() }),
  })
  .meta({ id: "DsvGenerationView" });

export const DsvView = z
  .strictObject({
    participationId: z.uuid(),
    track: DsvStatus,
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
    /** `dsvGenerated` (D3): the current generation's Berlin day and instant; null when none. */
    facts: z.strictObject({
      dsvGenerated: z.strictObject({ validOn: isoDate, recordedAt: instant }).nullable(),
    }),
    capabilities: z.strictObject({ generate: z.boolean() }),
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
