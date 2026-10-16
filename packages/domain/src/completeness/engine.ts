import { z } from "zod";
import type { DocumentType } from "../documents/catalog";
import { Step } from "../lifecycle/enums";
import type { CompletenessRule, RulesByStep } from "./rules";

/** Review states of a stored document (plan 5.5); document review comes with Slice 4b. */
export const DocumentState = z.enum(["uploaded", "accepted", "rejected"]);
export type DocumentState = z.infer<typeof DocumentState>;

/** Field values by key, and the states of a participation's documents by type. */
export type CompletenessFacts = {
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
 * is in the result; a step without rules is complete. Each failed rule gives one item.
 */
export function evaluateCompleteness(
  rulesByStep: RulesByStep,
  facts: CompletenessFacts,
): Completeness {
  const byStep = Object.fromEntries(
    Step.options.map((step) => {
      const missing = (rulesByStep[step] ?? []).flatMap((rule) => check(step, rule, facts));
      return [step, { complete: missing.length === 0, missing }];
    }),
  );
  return { byStep: byStep as Completeness["byStep"] };
}

/** An own property only: an inherited one (`toString`) is not a fact. */
const fieldValue = (facts: CompletenessFacts, key: string) =>
  Object.hasOwn(facts.fields, key) ? facts.fields[key] : undefined;

function check(step: Step, rule: CompletenessRule, facts: CompletenessFacts): MissingItem[] {
  const item = (kind: MissingItem["kind"], key: string, reason: MissingItem["reason"]) => [
    { step, ruleId: rule.id, kind, key, reason },
  ];
  switch (rule.kind) {
    case "required":
      return isPresent(fieldValue(facts, rule.field)) ? [] : item("field", rule.field, "missing");
    case "requiredIf": {
      const condition = fieldValue(facts, rule.when.field);
      const applies = "exists" in rule.when ? isPresent(condition) : condition === rule.when.equals;
      if (!applies || isPresent(fieldValue(facts, rule.field))) return [];
      return item("field", rule.field, "missing");
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
