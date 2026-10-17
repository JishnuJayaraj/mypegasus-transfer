import { z } from "zod";
import { RuleBasis } from "../completeness/rules";
import { Step } from "../lifecycle/enums";
import { ExpectedOverrideVersion } from "./agentur-settings";

// Template version migration with review (Slice 2 plan 5.8; Q36, Q93, R15). A pinned Agentur
// moves to a newer catalog version only through this explicit migration, which shows what the new
// version changes and asks keep or remove for every key of that Agentur's scoped setting.

/** A key of an Agentur-scoped setting, `step.key` as `settingKeys` writes it. */
export const SettingKey = z.string().regex(/^[a-z_]+\.[A-Za-z]+$/);

/** The target version of a migration preview (`POST …/pins/{agenturKey}/migration-preview`). */
export const MigrationPreviewInput = z
  .strictObject({ version: z.int().min(1) })
  .meta({ id: "MigrationPreviewInput" });
export type MigrationPreviewInput = z.infer<typeof MigrationPreviewInput>;

export const MigrationDecision = z.enum(["keep", "remove"]);
export type MigrationDecision = z.infer<typeof MigrationDecision>;

/**
 * The confirmed migration (`POST …/pins/{agenturKey}/migration`): the pinned version and the
 * override version the preview was made on (409 when either moved), the target, and keep or
 * remove for exactly the keys of the review (R15); strict.
 */
export const MigrateTemplateInput = z
  .strictObject({
    fromVersion: z.int().min(1),
    version: z.int().min(1),
    expectedVersion: ExpectedOverrideVersion,
    decisions: z.record(SettingKey, MigrationDecision),
  })
  .meta({ id: "MigrateTemplateInput" });
export type MigrateTemplateInput = z.infer<typeof MigrateTemplateInput>;

/** A regional setting's value; null where a layer doesn't set it. */
export const SettingValue = z.union([z.string(), z.number(), z.boolean()]).nullable();
export type SettingValue = z.infer<typeof SettingValue>;

const ruleRef = z.strictObject({ id: z.string(), step: Step, basis: RuleBasis.optional() });

/**
 * What a migration would change (plan 5.8, AC-19): the template's settings that differ, its rules
 * and custom fields added, removed or changed, the issues the current override would have with the
 * new version (5.9; a confirm is refused with them), and the review: every key of the Agentur's
 * scoped setting with its project value and the old and new template value (R15, Q93).
 */
export const TemplateMigrationPreview = z
  .strictObject({
    agenturKey: z.string(),
    fromVersion: z.int().min(1),
    version: z.int().min(1),
    /** The override version the review was made on; the confirm sends it back. */
    expectedVersion: ExpectedOverrideVersion,
    settings: z.array(z.strictObject({ key: SettingKey, from: SettingValue, to: SettingValue })),
    rules: z.strictObject({
      added: z.array(ruleRef),
      removed: z.array(ruleRef),
      changed: z.array(ruleRef),
    }),
    fields: z.strictObject({
      added: z.array(z.string()),
      removed: z.array(z.string()),
      changed: z.array(z.string()),
    }),
    overrideIssues: z.array(z.string()),
    review: z.array(
      z.strictObject({
        key: SettingKey,
        value: SettingValue,
        from: SettingValue,
        to: SettingValue,
      }),
    ),
  })
  .meta({ id: "TemplateMigrationPreview" });
export type TemplateMigrationPreview = z.infer<typeof TemplateMigrationPreview>;

type TemplateRef = { agenturKey: string; version: number };

/** The catalog versions a pinned Agentur may migrate to: the newer ones, ascending. */
export const migrationTargets = (catalog: readonly TemplateRef[], pin: TemplateRef): number[] =>
  catalog
    .filter((t) => t.agenturKey === pin.agenturKey && t.version > pin.version)
    .map((t) => t.version)
    .toSorted((a, b) => a - b);

export type MigrationIssueCode =
  | "template_not_in_catalog"
  | "template_already_pinned"
  | "template_version_not_newer";

/**
 * Whether the pinned Agentur may move to `version` (plan 5.8): only to a newer catalog version;
 * the pinned one is `template_already_pinned`, an older one `template_version_not_newer`. No pin
 * (null) is the route's 404. Returns the pinned version, or the issue at `/version`.
 */
export function planTemplateMigration(state: {
  catalog: readonly TemplateRef[];
  pin: TemplateRef | undefined;
  version: number;
}): { fromVersion: number } | { issues: { code: MigrationIssueCode; field: "version" }[] } | null {
  const { catalog, pin, version } = state;
  if (!pin) return null;
  const issue = (code: MigrationIssueCode) => ({ issues: [{ code, field: "version" as const }] });
  if (!catalog.some((t) => t.agenturKey === pin.agenturKey && t.version === version)) {
    return issue("template_not_in_catalog");
  }
  if (version === pin.version) return issue("template_already_pinned");
  if (version < pin.version) return issue("template_version_not_newer");
  return { fromVersion: pin.version };
}

/**
 * The decisions must name exactly the review's keys (R15): a missing or extra key is
 * `review_incomplete` (at `/decisions`).
 */
export function checkMigrationDecisions(
  reviewKeys: readonly string[],
  decisions: Readonly<Record<string, MigrationDecision>>,
): { code: "review_incomplete"; field: "decisions" }[] {
  const decided = Object.keys(decisions);
  const exact =
    decided.length === reviewKeys.length &&
    reviewKeys.every((key) => Object.hasOwn(decisions, key));
  return exact ? [] : [{ code: "review_incomplete", field: "decisions" }];
}
