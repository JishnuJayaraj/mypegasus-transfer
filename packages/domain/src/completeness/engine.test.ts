import { describe, expect, it } from "vitest";
import { Step } from "../lifecycle/enums";
import {
  evaluateCompleteness,
  isPresent,
  type CompletenessFacts,
  type DocumentState,
} from "./engine";
import type { CompletenessRule, RulesByStep } from "./rules";

const noFacts: CompletenessFacts = { projectType: "ta_tg", fields: {}, documents: {} };

const missingItem = (step: string, ruleId: string, kind: string, key: string, reason: string) => ({
  step,
  ruleId,
  kind,
  key,
  reason,
});

/** The missing items of one rule in `data_collection`. */
function missing(rule: CompletenessRule, facts: Partial<CompletenessFacts>) {
  const result = evaluateCompleteness({ data_collection: [rule] }, { ...noFacts, ...facts });
  return result.byStep.data_collection.missing.map((m) => m.reason);
}

const ifEquals = (equals: string | number | boolean): CompletenessRule => ({
  id: "r",
  kind: "requiredIf",
  field: "iban",
  when: { field: "maritalStatus", equals },
});

const doc = (accepted?: boolean): CompletenessRule => ({
  id: "r",
  kind: "documentPresent",
  documentType: "asu_proof",
  ...(accepted !== undefined && { accepted }),
});

// Plan 5.5: `null`, `undefined`, `""` (after trim) and `[]` are absent; `false` and `0` present.
const presence: [label: string, value: unknown, present: boolean][] = [
  ["undefined", undefined, false],
  ["null", null, false],
  ['""', "", false],
  ["whitespace", " \t\n", false],
  ["[]", [], false],
  ["false", false, true],
  ["0", 0, true],
  ['"0"', "0", true],
  ["text", "x", true],
  ["[0]", [0], true],
  ['[""]', [""], true],
  ["{}", {}, true],
];

describe("presence (plan 5.5)", () => {
  it.each(presence)("%s → present %s", (_, value, present) => {
    expect(isPresent(value)).toBe(present);
  });
});

describe("required (AC-21)", () => {
  const rule: CompletenessRule = { id: "r", kind: "required", field: "lastName" };

  it.each(presence)("lastName %s → complete %s", (_, value, present) => {
    expect(missing(rule, { fields: { lastName: value } })).toEqual(present ? [] : ["missing"]);
  });

  it("treats an absent key and an inherited property as missing", () => {
    expect(missing(rule, {})).toEqual(["missing"]);
    const toString: CompletenessRule = { id: "r", kind: "required", field: "toString" };
    expect(missing(toString, {})).toEqual(["missing"]);
  });
});

describe("requiredIf (AC-21)", () => {
  const ifExists: CompletenessRule = {
    id: "r",
    kind: "requiredIf",
    field: "iban",
    when: { field: "pensionInsuranceNumber", exists: true },
  };

  // [equals, condition value, applies]: strict equality, no trimming or coercion
  it.each<[string | number | boolean, unknown, boolean]>([
    ["married", "married", true],
    ["married", "Married", false],
    ["married", " married", false],
    ["married", undefined, false],
    [0, 0, true],
    [0, "0", false],
    [0, false, false],
    [false, false, true],
    [false, undefined, false],
    [false, null, false],
    [false, 0, false],
    [true, true, true],
    [true, "true", false],
    ["", "", true],
  ])("equals %j, condition %j → applies %s", (equals, condition, applies) => {
    const fields = { maritalStatus: condition };
    expect(missing(ifEquals(equals), { fields })).toEqual(applies ? ["missing"] : []);
    const filled = { ...fields, iban: "DE00" };
    expect(missing(ifEquals(equals), { fields: filled })).toEqual([]);
  });

  it.each(presence)("exists, condition %s → applies %s", (_, value, present) => {
    const fields = { pensionInsuranceNumber: value };
    expect(missing(ifExists, { fields })).toEqual(present ? ["missing"] : []);
  });

  it.each(presence)("applies; the field %s → complete %s", (_, value, present) => {
    const fields = { pensionInsuranceNumber: "x", iban: value };
    expect(missing(ifExists, { fields })).toEqual(present ? [] : ["missing"]);
  });
});

describe("documentPresent (AC-21)", () => {
  // [states, without accepted (and accepted: false), with accepted: true]
  it.each<[DocumentState[] | undefined, string[], string[]]>([
    [undefined, ["missing"], ["missing"]],
    [[], ["missing"], ["missing"]],
    [["uploaded"], [], ["not_accepted"]],
    [["accepted"], [], []],
    [["rejected"], ["not_accepted"], ["not_accepted"]],
    [["rejected", "uploaded"], [], ["not_accepted"]],
    [["rejected", "accepted"], [], []],
    [["uploaded", "accepted"], [], []],
  ])("%j → %j / accepted %j", (states, plain, accepted) => {
    const documents = states ? { asu_proof: states } : {};
    expect(missing(doc(), { documents })).toEqual(plain);
    expect(missing(doc(false), { documents })).toEqual(plain);
    expect(missing(doc(true), { documents })).toEqual(accepted);
  });
});

describe("documentPresent with when (regional-variation.md, rule language)", () => {
  const onRoute = (when: object): CompletenessRule => ({
    id: "r",
    kind: "documentPresent",
    documentType: "kug200b_signed_scan",
    accepted: true,
    when: { field: "asuChannel", ...when } as never,
  });

  it.each<[string, unknown, string[]]>([
    ["the route the condition names", "kug_200b", ["missing"]],
    ["another route", "online_self", []],
    ["no route", null, []],
  ])("equals: applies on %s", (_, asuChannel, expected) => {
    expect(missing(onRoute({ equals: "kug_200b" }), { fields: { asuChannel } })).toEqual(expected);
  });

  it("exists: applies while the field is present", () => {
    expect(missing(onRoute({ exists: true }), { fields: { asuChannel: "in_person" } })).toEqual([
      "missing",
    ]);
    expect(missing(onRoute({ exists: true }), { fields: {} })).toEqual([]);
  });

  it("an accepted document satisfies it while it applies", () => {
    const documents = { kug200b_signed_scan: ["accepted" as const] };
    expect(
      missing(onRoute({ equals: "kug_200b" }), { fields: { asuChannel: "kug_200b" }, documents }),
    ).toEqual([]);
  });
});

describe("evaluateCompleteness", () => {
  const rules: RulesByStep = {
    data_collection: [
      { id: "dc-1", kind: "required", field: "lastName" },
      { id: "dc-2", kind: "required", field: "lastName", basis: "operational_default" },
      { id: "dc-3", kind: "required", field: "healthRestrictions" },
    ],
    asu_registration: [
      { id: "asu-1", kind: "documentPresent", documentType: "asu_proof", accepted: true },
    ],
    dsv: [{ id: "dsv-1", kind: "documentPresent", documentType: "dsv_signed_scan" }],
  };

  it("has every step; a step without rules is complete", () => {
    const { byStep } = evaluateCompleteness({}, noFacts);
    expect(Object.keys(byStep)).toEqual(Step.options);
    for (const step of Step.options) expect(byStep[step]).toEqual({ complete: true, missing: [] });
  });

  it("reports one item per failed rule, in rule order, with step, rule id, kind and key", () => {
    const facts: CompletenessFacts = {
      projectType: "ta_tg",
      fields: { healthRestrictions: "x" },
      documents: { asu_proof: ["uploaded"], dsv_signed_scan: ["accepted"] },
    };
    const { byStep } = evaluateCompleteness(rules, facts);
    expect(byStep.data_collection).toEqual({
      complete: false,
      missing: [
        missingItem("data_collection", "dc-1", "field", "lastName", "missing"),
        missingItem("data_collection", "dc-2", "field", "lastName", "missing"),
      ],
    });
    expect(byStep.asu_registration.missing).toEqual([
      missingItem("asu_registration", "asu-1", "document", "asu_proof", "not_accepted"),
    ]);
    expect(byStep.dsv).toEqual({ complete: true, missing: [] });
  });

  it("carries keys, never values", () => {
    const secret = "SYNTHETIC-SECRET";
    const facts: CompletenessFacts = {
      projectType: "ta_tg",
      fields: { lastName: ` ${secret} `, healthRestrictions: [secret], maritalStatus: secret },
      documents: { asu_proof: ["rejected"] },
    };
    const withCondition: RulesByStep = {
      ...rules,
      profiling: [
        {
          id: "p-1",
          kind: "requiredIf",
          field: "iban",
          when: { field: "maritalStatus", exists: true },
        },
      ],
    };
    const result = evaluateCompleteness(withCondition, facts);
    expect(JSON.stringify(result)).not.toContain(secret);
    const items = Object.values(result.byStep).flatMap((s) => s.missing);
    expect(items.map((m) => m.key)).toEqual(["asu_proof", "iban", "dsv_signed_scan"]);
    for (const item of items) {
      expect(Object.keys(item).toSorted()).toEqual(["key", "kind", "reason", "ruleId", "step"]);
    }
  });
});

describe("project-type applicability (Q89)", () => {
  const rules: RulesByStep = {
    data_collection: [
      { id: "all", kind: "required", field: "lastName" },
      { id: "both", kind: "required", field: "firstName", projectTypes: ["ta_only", "ta_tg"] },
    ],
    dsv: [
      {
        id: "tg",
        kind: "documentPresent",
        documentType: "dsv_signed_scan",
        projectTypes: ["ta_tg"],
      },
    ],
  };
  const ids = (projectType: CompletenessFacts["projectType"]) =>
    Object.values(evaluateCompleteness(rules, { ...noFacts, projectType }).byStep)
      .flatMap((step) => step.missing)
      .map((item) => item.ruleId);

  it("applies a rule without projectTypes, or listing the type", () => {
    expect(ids("ta_tg")).toEqual(["all", "both", "tg"]);
  });

  it("skips a rule for another project type: no item, the step is complete", () => {
    expect(ids("ta_only")).toEqual(["all", "both"]);
    const { byStep } = evaluateCompleteness(rules, { ...noFacts, projectType: "ta_only" });
    expect(byStep.dsv).toEqual({ complete: true, missing: [] });
  });
});
