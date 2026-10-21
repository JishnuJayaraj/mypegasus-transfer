import {
  AgenturKey,
  CompletenessRule,
  isoDate,
  RegionalSettings,
  Step,
  TemporaryAgenturSetting,
} from "@transfer/domain";
import { z } from "zod";
import { CustomFieldKey, FieldSchema, LocalizedText } from "./field-schema";

export {
  AgenturKey,
  AsuChannel,
  Kug200bBatchChannel,
  RegionalSettings,
  TemporaryAgenturSetting,
  Tl407SubmissionChannel,
} from "@transfer/domain";

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
export type NationwideSettings = z.infer<typeof NationwideSettings>;

const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Relaxes one `operational_default` rule (Q75); approval and audit are stored in Slice 2. */
export const RuleRelaxation = z.strictObject({
  ruleId: z.string().min(1),
  reasonCode: code,
  approvedBy: z.uuid(),
  approvedOn: isoDate,
});
export type RuleRelaxation = z.infer<typeof RuleRelaxation>;

/** `<step or area>.<key>`; a field's key keeps its case (`self_service.educationHistory`). */
const helpTextKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][A-Za-z0-9_]*)+$/);
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
export type BaseDefaults = z.infer<typeof BaseDefaults>;

export const RegionalTemplate = z.strictObject({
  ...common,
  kind: z.literal("regional_template"),
  id: AgenturKey,
  version: positive,
  agenturKey: AgenturKey,
  /** Fictional sample Agentur (CLAUDE.md rule 1: synthetic data only). */
  sample: z.boolean().optional(),
  label: LocalizedText,
  settings: RegionalSettings.optional(),
  fields,
});
export type RegionalTemplate = z.infer<typeof RegionalTemplate>;

export const ProjectOverride = z.strictObject({
  ...common,
  kind: z.literal("project_override"),
  agenturSettings: z.record(AgenturKey, TemporaryAgenturSetting).optional(),
  fields,
  relax: z.array(RuleRelaxation).optional(),
});
export type ProjectOverride = z.infer<typeof ProjectOverride>;

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
