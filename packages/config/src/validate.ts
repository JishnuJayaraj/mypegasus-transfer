import { validateRules, type RuleIssue } from "@transfer/domain";
import type { z } from "zod";
import { ConfigLayer } from "./model";

export type ConfigIssueCode =
  | RuleIssue["code"]
  | "invalid"
  | "invalid_date"
  | "regional_setting_in_base"
  | "nationwide_setting"
  | "project_wide_setting"
  | "template_id_mismatch"
  | "field_redefined"
  // merging the layers (resolve.ts) and loading a pinned template (load.ts)
  | "wrong_layer_kind"
  | "template_key_mismatch"
  | "rule_redefined"
  | "relaxation_locked"
  | "invalid_reference"
  | "path_mismatch"
  // the field-schema profile
  | "data_class_not_allowed"
  | "unknown_retention_class"
  | "type_required"
  | "keyword_not_applicable"
  | "enum_type_mismatch"
  | "max_length_required"
  | "invalid_bounds"
  | "invalid_pattern";

/** One problem with a layer, with its path; `key` names an offending key, never a value. */
export type ConfigIssue = { code: ConfigIssueCode; path: (string | number)[]; key?: string };

/** A layer that can't be used. Its message names codes, never values. */
export class ConfigError extends Error {
  readonly layer: string;
  readonly issues: readonly ConfigIssue[];

  constructor(layer: string, issues: readonly ConfigIssue[]) {
    super(`${layer}: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "ConfigError";
    this.layer = layer;
    this.issues = issues;
  }
}

export type LayerValidation =
  | { ok: true; layer: ConfigLayer }
  | { ok: false; issues: ConfigIssue[] };

/** Top-level keys that exist, but not in this kind of layer (plan 5.7). */
const misplaced: Record<string, Partial<Record<string, ConfigIssueCode>>> = {
  base_defaults: { settings: "regional_setting_in_base" },
  regional_template: { nationwide: "nationwide_setting" },
  project_override: { nationwide: "nationwide_setting", settings: "project_wide_setting" },
};
const valueCodes: Partial<Record<string, ConfigIssueCode>> = {
  "x-dataClass": "data_class_not_allowed",
  "x-retentionClass": "unknown_retention_class",
};

/**
 * Validates one layer on its own: its shape, the field-schema profile of its custom fields,
 * and its rules against the field catalog plus the custom fields it declares or inherits from
 * the layers below (`inheritedFields`). Merging the layers is the resolver's job.
 */
export function parseLayer(
  input: unknown,
  { inheritedFields = new Set<string>() }: { inheritedFields?: ReadonlySet<string> } = {},
): LayerValidation {
  const parsed = ConfigLayer.safeParse(input);
  if (!parsed.success) {
    const kind = String((input as { kind?: unknown } | null)?.kind);
    return { ok: false, issues: parsed.error.issues.flatMap((issue) => toIssues(issue, kind)) };
  }
  const layer = parsed.data;
  const issues: ConfigIssue[] = [];
  if (layer.kind === "regional_template" && layer.id !== layer.agenturKey) {
    issues.push({ code: "template_id_mismatch", path: ["id"] });
  }
  const own = layer.kind === "base_defaults" ? [] : Object.keys(layer.fields ?? {});
  for (const key of own) {
    if (inheritedFields.has(key))
      issues.push({ code: "field_redefined", path: ["fields", key], key });
  }
  const rules = validateRules(layer.rules ?? {}, {
    customFields: new Set([...inheritedFields, ...own]),
  });
  if (!rules.ok) {
    issues.push(...rules.issues.map((issue) => ({ ...issue, path: ["rules", ...issue.path] })));
  }
  return issues.length ? { ok: false, issues } : { ok: true, layer };
}

function toIssues(issue: z.core.$ZodIssue, kind: string): ConfigIssue[] {
  const path = issue.path as (string | number)[];
  if (issue.code === "unrecognized_keys") {
    const step = path.length === 1 && path[0] === "rules";
    return issue.keys.map((key) => ({
      code: step ? "unknown_step" : (path.length === 0 && misplaced[kind]?.[key]) || "unknown_key",
      path,
      key,
    }));
  }
  const custom = issue.code === "custom" ? (issue.params?.code as ConfigIssueCode) : undefined;
  const value = issue.code === "invalid_value" ? valueCodes[String(path.at(-1))] : undefined;
  return [{ code: custom ?? value ?? "invalid", path }];
}
