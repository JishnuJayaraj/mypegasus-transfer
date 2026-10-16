import { CompletenessRule, isoDate, Step } from "@transfer/domain";
import { z } from "zod";
import { CustomFieldKey, FieldSchema, LocalizedText } from "./field-schema";

// Allowed channel values (plan 5.7). Base defaults carry the values, never an Agentur's choice.
export const AsuChannel = z.enum(["kug_200b", "online_self", "in_person"]);
export const Kug200bBatchChannel = z.enum(["paper_courier", "paper_post", "scan_email", "upload"]);
export const Tl407SubmissionChannel = z.enum(["email", "upload", "paper_original"]);

/**
 * Regional settings, keyed by step. They come only from an Agentur's template or an
 * Agentur-scoped temporary setting; there is no nationwide default for any of them (round 8).
 */
export const RegionalSettings = z.strictObject({
  asu_registration: z
    .strictObject({
      defaultChannel: AsuChannel.optional(),
      batchSubmissionChannel: Kug200bBatchChannel.optional(),
    })
    .optional(),
  agentur_submission: z
    .strictObject({
      submissionChannel: Tl407SubmissionChannel.optional(),
      originalRequired: z.boolean().optional(),
      leadTimeDays: z.int().min(0).optional(),
      rejectsOutdatedFormVersions: z.boolean().optional(),
    })
    .optional(),
});
export type RegionalSettings = z.infer<typeof RegionalSettings>;

const positive = z.int().min(1);

/** Set only by the base defaults; a template or override that sets one is invalid. */
export const NationwideSettings = z.strictObject({
  asuDueDate: z.strictObject({ monthsBeforeEnd: positive, daysAfterKnowledge: positive }), // Q1
  profilingExceptionDeadlineMonths: positive, // Q17
  kug200bConfirmationFollowUpDays: positive,
  tl407EscalationDaysAfterTgStart: positive, // Q54
  cutoffWarningDays: positive, // Q78
  cutoffFinalReminderDays: positive,
});

export const AgenturKey = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** A temporary setting while an Agentur has no template: scoped to that Agentur (round 8). */
export const TemporaryAgenturSetting = z.strictObject({
  settings: RegionalSettings,
  source: z.enum(["phone_call_agentur", "email_agentur", "letter_agentur", "meeting_agentur"]),
  confirmedBy: z.uuid(),
  confirmedOn: isoDate,
});

const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Relaxes one `operational_default` rule (Q75); approval and audit are stored in Slice 2. */
export const RuleRelaxation = z.strictObject({
  ruleId: z.string().min(1),
  reasonCode: code,
  approvedBy: z.uuid(),
  approvedOn: isoDate,
});

const helpTextKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const helpTexts = z.record(helpTextKey, z.string().min(1).max(2000));

const common = {
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  rules: z.partialRecord(Step, z.array(CompletenessRule)).optional(),
  helpTexts: z.strictObject({ de: helpTexts.optional(), en: helpTexts.optional() }).optional(),
};
const fields = z.record(CustomFieldKey, FieldSchema).optional();

export const BaseDefaults = z.strictObject({
  ...common,
  kind: z.literal("base_defaults"),
  version: positive,
  nationwide: NationwideSettings,
});

export const RegionalTemplate = z.strictObject({
  ...common,
  kind: z.literal("regional_template"),
  id: AgenturKey,
  version: positive,
  agenturKey: AgenturKey,
  /** Fictional sample Agentur (D8). */
  sample: z.boolean().optional(),
  label: LocalizedText,
  settings: RegionalSettings.optional(),
  fields,
});

export const ProjectOverride = z.strictObject({
  ...common,
  kind: z.literal("project_override"),
  agenturSettings: z.record(AgenturKey, TemporaryAgenturSetting).optional(),
  fields,
  relax: z.array(RuleRelaxation).optional(),
});

/** Base defaults, regional templates and project overrides are layers of one schema. */
export const ConfigLayer = z
  .discriminatedUnion("kind", [BaseDefaults, RegionalTemplate, ProjectOverride])
  .meta({
    title: "Regional configuration layer",
    description:
      "Base defaults, a regional template or a project override (ADR-0004). Generated from " +
      "packages/config/src/model.ts by `pnpm generate`; do not edit.",
  });
export type ConfigLayer = z.infer<typeof ConfigLayer>;
