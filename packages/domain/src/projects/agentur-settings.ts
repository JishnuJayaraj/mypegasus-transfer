import { z } from "zod";
import { isoDate } from "../iso-date";

// The vocabulary of Agentur-scoped settings (round 8, Q93). `@transfer/config`'s model composes
// its layers from it, as it does from `Step` and `CompletenessRule` (ADR-0004); here the API and
// both SPAs share it without depending on the configuration package.

/** An Agentur key, e.g. `beispielstadt-nord` (the database checks the same pattern). */
export const AgenturKey = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// Allowed channel values (Slice 1 plan 5.7). Base defaults carry the values, never an Agentur's
// choice.
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

/** How the Agentur confirmed a setting (round 8): the four Slice 1 codes. */
export const AgenturSettingSource = z.enum([
  "phone_call_agentur",
  "email_agentur",
  "letter_agentur",
  "meeting_agentur",
]);
export type AgenturSettingSource = z.infer<typeof AgenturSettingSource>;

/**
 * An Agentur-scoped project setting (round 8, Q93): a fallback while the Agentur has no
 * template, or a confirmed project-specific exception to its pinned template. It wins only for
 * the keys it supplies and keeps its source, confirmer and confirmation date.
 */
export const TemporaryAgenturSetting = z.strictObject({
  settings: RegionalSettings,
  source: AgenturSettingSource,
  confirmedBy: z.uuid(),
  confirmedOn: isoDate,
});
export type TemporaryAgenturSetting = z.infer<typeof TemporaryAgenturSetting>;

/**
 * What a new override version changes (`config_override_changed`): an Agentur-scoped setting set
 * or removed, an approved relaxation added or removed (PR 2d-2), or keys of an Agentur-scoped
 * setting removed in a template migration's review (`agentur_setting_reviewed`, PR 2e-2; R15).
 */
export const OverrideChange = z.enum([
  "agentur_setting_set",
  "agentur_setting_removed",
  "relaxation_added",
  "relaxation_removed",
  "agentur_setting_reviewed",
]);
export type OverrideChange = z.infer<typeof OverrideChange>;

/** The override version a write expects (optimistic concurrency, 5.9); 0 = no override yet. */
export const ExpectedOverrideVersion = z.int().min(0);

/**
 * Sets an Agentur's scoped setting (`PUT …/config/agentur-settings/{agenturKey}`, 5.9). The
 * confirmer is the acting user (R14), never sent. Strict.
 */
export const SetAgenturSettingInput = z
  .strictObject({
    expectedVersion: ExpectedOverrideVersion,
    settings: RegionalSettings,
    source: AgenturSettingSource,
    confirmedOn: isoDate,
  })
  .meta({ id: "SetAgenturSettingInput" });
export type SetAgenturSettingInput = z.infer<typeof SetAgenturSettingInput>;

/** Removes an Agentur's scoped setting (`DELETE`, query); strict. */
export const RemoveAgenturSettingQuery = z.strictObject({
  expectedVersion: z.coerce.number().pipe(ExpectedOverrideVersion),
});

/** `step.key` of every setting a scoped setting supplies, in a stable order. */
export function settingKeys(settings: RegionalSettings): string[] {
  return Object.entries(settings)
    .flatMap(([step, values]) => Object.keys(values ?? {}).map((key) => `${step}.${key}`))
    .toSorted();
}

export type AgenturSettingIssue = {
  code: "settings_empty" | "confirmed_on_in_future";
  field: "settings" | "confirmedOn";
};

/**
 * The rules of a scoped setting (round 8, R14): it supplies at least one setting, and it was
 * confirmed by today (the injected `Clock`'s Berlin date) at the latest.
 */
export function checkAgenturSetting(
  input: Pick<SetAgenturSettingInput, "settings" | "confirmedOn">,
  today: string,
): AgenturSettingIssue[] {
  const issues: AgenturSettingIssue[] = [];
  if (!settingKeys(input.settings).length)
    issues.push({ code: "settings_empty", field: "settings" });
  if (input.confirmedOn > today) {
    issues.push({ code: "confirmed_on_in_future", field: "confirmedOn" });
  }
  return issues;
}
