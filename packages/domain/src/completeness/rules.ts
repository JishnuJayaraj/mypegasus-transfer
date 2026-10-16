import { z } from "zod";
import { DocumentType } from "../documents/catalog";
import { fieldCatalog } from "../fields/catalog";
import { Step } from "../lifecycle/enums";
import { ProjectType } from "../project";

/** Why a rule exists (Q75): only an `operational_default` may be relaxed by a project override. */
export const RuleBasis = z.enum(["statutory", "ba_form", "operational_default"]);
export type RuleBasis = z.infer<typeof RuleBasis>;

/** The project types a rule applies to (Q89); absent means every project type. */
const projectTypes = z
  .array(ProjectType)
  .min(1)
  .refine((types) => new Set(types).size === types.length)
  .optional();

const base = { id: z.string().min(1), basis: RuleBasis.optional(), projectTypes };
const fieldKey = z.string().min(1);

/**
 * The minimal rule language of ADR-0004 (plan 5.5): data in a closed schema, no scripting.
 * Unknown keys are rejected at every level.
 */
export const CompletenessRule = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("required"), field: fieldKey }),
  z.strictObject({
    ...base,
    kind: z.literal("requiredIf"),
    field: fieldKey,
    when: z.union([
      z.strictObject({ field: fieldKey, equals: z.union([z.string(), z.number(), z.boolean()]) }),
      z.strictObject({ field: fieldKey, exists: z.literal(true) }),
    ]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("documentPresent"),
    documentType: DocumentType,
    accepted: z.boolean().optional(),
  }),
]);
export type CompletenessRule = z.infer<typeof CompletenessRule>;

export type RulesByStep = Partial<Record<Step, readonly CompletenessRule[]>>;

/** Statutory, BA-form and unclassified rules are locked (Q75). */
export const isLocked = (rule: CompletenessRule) => rule.basis !== "operational_default";

/** A rule for other project types is skipped: no missing item, no reminder (Q89). */
export const ruleAppliesTo = (rule: CompletenessRule, projectType: ProjectType) =>
  !rule.projectTypes || rule.projectTypes.includes(projectType);

export type RuleIssue = {
  code:
    | "invalid_rule"
    | "unknown_key"
    | "unknown_step"
    | "unknown_field"
    | "unknown_document_type"
    | "duplicate_id";
  path: (string | number)[];
  /** The offending field key, rule id or unknown key; never a participant value. */
  key?: string;
};

export type RuleValidation = { ok: true; rules: RulesByStep } | { ok: false; issues: RuleIssue[] };

const catalogKeys: ReadonlySet<string> = new Set(fieldCatalog.map((entry) => entry.key));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a rule set against the closed schema, the field catalog plus the declared custom
 * fields, and the document-type catalog. Rule ids are unique across all steps.
 */
export function validateRules(
  input: unknown,
  { customFields }: { customFields: ReadonlySet<string> },
): RuleValidation {
  if (!isRecord(input)) return { ok: false, issues: [{ code: "invalid_rule", path: [] }] };
  const issues: RuleIssue[] = [];
  const parsedRules: Record<string, CompletenessRule[]> = {};
  const ids = new Set<string>();
  const knownField = (key: string) => catalogKeys.has(key) || customFields.has(key);

  for (const [step, rules] of Object.entries(input)) {
    if (!Step.safeParse(step).success) {
      issues.push({ code: "unknown_step", path: [step] });
      continue;
    }
    if (!Array.isArray(rules)) {
      issues.push({ code: "invalid_rule", path: [step] });
      continue;
    }
    const valid: CompletenessRule[] = [];
    parsedRules[step] = valid;
    rules.forEach((raw: unknown, index) => {
      const at = (...rest: (string | number)[]) => [step, index, ...rest];
      const parsed = CompletenessRule.safeParse(raw);
      if (!parsed.success) {
        issues.push(...shapeIssues(parsed.error.issues, at));
        return;
      }
      const rule = parsed.data;
      valid.push(rule);
      if (rule.kind !== "documentPresent" && !knownField(rule.field)) {
        issues.push({ code: "unknown_field", path: at("field"), key: rule.field });
      }
      if (rule.kind === "requiredIf" && !knownField(rule.when.field)) {
        issues.push({ code: "unknown_field", path: at("when", "field"), key: rule.when.field });
      }
      if (ids.has(rule.id)) issues.push({ code: "duplicate_id", path: at("id"), key: rule.id });
      ids.add(rule.id);
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, rules: parsedRules };
}

function shapeIssues(
  zodIssues: readonly z.core.$ZodIssue[],
  at: (...rest: (string | number)[]) => (string | number)[],
): RuleIssue[] {
  return zodIssues.flatMap((issue): RuleIssue[] => {
    const path = at(...(issue.path as (string | number)[]));
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ code: "unknown_key", path, key }));
    }
    const code = issue.path.at(-1) === "documentType" ? "unknown_document_type" : "invalid_rule";
    return [{ code, path }];
  });
}
