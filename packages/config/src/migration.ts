import {
  settingKeys,
  type CompletenessRule,
  type MigrationDecision,
  type ProjectType,
  type SettingValue,
  type Step,
  type TemplateMigrationPreview,
} from "@transfer/domain";
import { canonicalJson } from "./canonical.ts";
import type { BaseDefaults, ProjectOverride, RegionalSettings, RegionalTemplate } from "./model";
import { validateProjectOverride, withAgenturSetting } from "./override";

export type MigrationPreview = Pick<
  TemplateMigrationPreview,
  "settings" | "rules" | "fields" | "overrideIssues" | "review"
>;

/**
 * What migrating `agenturKey`'s pinned template to `target` would change (Slice 2 plan 5.8,
 * AC-19; Q36, Q93, R15): the template settings that differ, the rules and custom fields added,
 * removed or changed (by id or key), the codes of the issues the current override would have with
 * the new version against every chain (5.9, AC-16), and the review: every key of the Agentur's
 * scoped setting, with its project value and the old and new template value. Pure; the Agentur
 * must be pinned in `templatesByAgentur`.
 */
export function migrationPreview(input: {
  base: BaseDefaults;
  templatesByAgentur: Readonly<Record<string, RegionalTemplate>>;
  agenturKey: string;
  target: RegionalTemplate;
  override: ProjectOverride | undefined;
  projectType: ProjectType;
}): MigrationPreview {
  const { agenturKey, target, override } = input;
  const current = input.templatesByAgentur[agenturKey]!;
  const from = valuesOf(current.settings);
  const to = valuesOf(target.settings);
  const settings = [...new Set([...from.keys(), ...to.keys()])]
    .toSorted()
    .filter((key) => from.get(key) !== to.get(key))
    .map((key) => ({ key, from: from.get(key) ?? null, to: to.get(key) ?? null }));

  const oldRules = rulesOf(current);
  const newRules = rulesOf(target);
  const rules = changes(oldRules, newRules);
  const fields = changes(new Map(Object.entries(current.fields ?? {})), fieldsOf(target));

  const validation = validateProjectOverride({
    base: input.base,
    templatesByAgentur: { ...input.templatesByAgentur, [agenturKey]: target },
    override: override ?? { schemaVersion: 1, kind: "project_override" },
    projectType: input.projectType,
  });
  const scoped = override?.agenturSettings?.[agenturKey]?.settings ?? {};
  const own = valuesOf(scoped);
  return {
    settings,
    rules: {
      added: rules.added.map(ref(newRules)),
      removed: rules.removed.map(ref(oldRules)),
      changed: rules.changed.map(ref(newRules)),
    },
    fields,
    overrideIssues: validation.ok ? [] : validation.issues.map((issue) => issue.code),
    review: settingKeys(scoped).map((key) => ({
      key,
      value: own.get(key)!,
      from: from.get(key) ?? null,
      to: to.get(key) ?? null,
    })),
  };
}

/**
 * The override after the review (R15): the Agentur's scoped setting without the keys decided
 * `remove`, and without the setting once none is left; its source and confirmation stay. Null when
 * nothing is removed, so no override version is written.
 */
export function withReviewedSetting(
  current: ProjectOverride | undefined,
  agenturKey: string,
  decisions: Readonly<Record<string, MigrationDecision>>,
): ProjectOverride | null {
  const setting = current?.agenturSettings?.[agenturKey];
  const removed = new Set(Object.keys(decisions).filter((key) => decisions[key] === "remove"));
  if (!setting || !removed.size) return null;
  const settings = Object.fromEntries(
    Object.entries(setting.settings)
      .map(([step, values]) => [
        step,
        Object.fromEntries(
          Object.entries(values as object).filter(([key]) => !removed.has(`${step}.${key}`)),
        ),
      ])
      .filter(([, values]) => Object.keys(values as object).length),
  ) as RegionalSettings;
  const kept = Object.keys(settings).length ? { ...setting, settings } : null;
  return withAgenturSetting(current, agenturKey, kept);
}

type Rules = Map<string, { step: Step; rule: CompletenessRule }>;

/** A rule as the preview names it: id, step and basis. */
const ref = (rules: Rules) => (id: string) => {
  const { step, rule } = rules.get(id)!;
  return { id, step, ...(rule.basis && { basis: rule.basis }) };
};

/** Regional settings as `step.key` → value. */
function valuesOf(settings: RegionalSettings | undefined): Map<string, SettingValue> {
  return new Map(
    Object.entries(settings ?? {}).flatMap(([step, values]) =>
      Object.entries(values as object).map(([key, value]): [string, SettingValue] => [
        `${step}.${key}`,
        value as SettingValue,
      ]),
    ),
  );
}

function rulesOf(template: RegionalTemplate): Rules {
  const rules: Rules = new Map();
  for (const [step, list] of Object.entries(template.rules ?? {}) as [Step, CompletenessRule[]][]) {
    for (const rule of list) rules.set(rule.id, { step, rule });
  }
  return rules;
}

const fieldsOf = (template: RegionalTemplate) => new Map(Object.entries(template.fields ?? {}));

/** The keys added, removed and changed (another value or step) between two maps, sorted. */
function changes(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  return {
    added: keys.filter((key) => !before.has(key)),
    removed: keys.filter((key) => !after.has(key)),
    changed: keys.filter(
      (key) =>
        before.has(key) &&
        after.has(key) &&
        canonicalJson(before.get(key)) !== canonicalJson(after.get(key)),
    ),
  };
}
