import { z } from "zod";
import type { DocumentType } from "../documents/catalog";
import { Step } from "../lifecycle/enums";
import type { ProjectType } from "../project";
import { ruleAppliesTo, type CompletenessRule, type RulesByStep } from "./rules";

/** Review states of a stored document (process-and-lifecycle.md, document review). */
export const DocumentState = z.enum(["uploaded", "accepted", "rejected"]);
export type DocumentState = z.infer<typeof DocumentState>;

/**
 * The project's type (rules for other types are skipped, Q89), field values by key, and the
 * states of a participation's documents by type.
 */
export type CompletenessFacts = {
  projectType: ProjectType;
  fields: Readonly<Record<string, unknown>>;
  documents: Readonly<Partial<Record<DocumentType, readonly DocumentState[]>>>;
};

/** Keys only, never values. */
export type MissingItem = {
  step: Step;
  ruleId: string;
  kind: "field" | "document";
  key: string;
  reason: "missing" | "not_accepted";
};

export type StepCompleteness = { complete: boolean; missing: MissingItem[] };
export type Completeness = { byStep: Record<Step, StepCompleteness> };

/**
 * `null`, `undefined`, `""` (after trim) and `[]` are absent; everything else, `false` and `0`
 * included, is present. Completeness checks presence; value validity is checked on write.
 */
export function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Evaluates rules that passed `validateRules` against one participation's facts. Every step
 * is in the result; a step without applicable rules is complete. Each failed rule gives one
 * item; a rule for another project type gives none.
 */
export function evaluateCompleteness(
  rulesByStep: RulesByStep,
  facts: CompletenessFacts,
): Completeness {
  const byStep = Object.fromEntries(
    Step.options.map((step) => {
      const missing = (rulesByStep[step] ?? [])
        .filter((rule) => ruleAppliesTo(rule, facts.projectType))
        .flatMap((rule) => check(step, rule, facts));
      return [step, { complete: missing.length === 0, missing }];
    }),
  );
  return { byStep: byStep as Completeness["byStep"] };
}

/** An own property only: an inherited one (`toString`) is not a fact. */
const fieldValue = (facts: CompletenessFacts, key: string) =>
  Object.hasOwn(facts.fields, key) ? facts.fields[key] : undefined;

/**
 * The field a rule requires given the facts: a `required` rule's field, a `requiredIf` rule's
 * field while its condition holds, else null (a document rule, or a condition that doesn't hold).
 */
export function requiredField(
  rule: CompletenessRule,
  fields: CompletenessFacts["fields"],
): string | null {
  if (rule.kind === "documentPresent") return null;
  if (rule.kind === "required") return rule.field;
  const condition = Object.hasOwn(fields, rule.when.field) ? fields[rule.when.field] : undefined;
  const applies = "exists" in rule.when ? isPresent(condition) : condition === rule.when.equals;
  return applies ? rule.field : null;
}

function check(step: Step, rule: CompletenessRule, facts: CompletenessFacts): MissingItem[] {
  const item = (kind: MissingItem["kind"], key: string, reason: MissingItem["reason"]) => [
    { step, ruleId: rule.id, kind, key, reason },
  ];
  switch (rule.kind) {
    case "required":
    case "requiredIf": {
      const field = requiredField(rule, facts.fields);
      if (field === null || isPresent(fieldValue(facts, field))) return [];
      return item("field", field, "missing");
    }
    case "documentPresent": {
      // a rejected document is not present; `accepted: true` needs an accepted one
      const states = facts.documents[rule.documentType] ?? [];
      const satisfied = rule.accepted
        ? states.includes("accepted")
        : states.some((state) => state !== "rejected");
      if (satisfied) return [];
      return item("document", rule.documentType, states.length ? "not_accepted" : "missing");
    }
  }
}
