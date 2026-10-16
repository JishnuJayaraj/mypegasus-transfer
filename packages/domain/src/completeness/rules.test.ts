import { describe, expect, it } from "vitest";
import { DocumentType } from "../documents/catalog";
import { isLocked, ruleAppliesTo, validateRules, type CompletenessRule } from "./rules";

const custom = { customFields: new Set(["custom.beispiel_nachweis_nr"]) };

const required = { kind: "required", field: "lastName" };
const ifTaxId = (when: object) => ({
  kind: "requiredIf",
  field: "iban",
  when: { field: "taxId", ...when },
});

/** The issues of a rule set (empty when valid). */
const issues = (input: unknown, options = custom) => {
  const result = validateRules(input, options);
  return result.ok ? [] : result.issues;
};

describe("validateRules (AC-22)", () => {
  const valid = {
    data_collection: [
      { id: "dc-1", kind: "required", field: "lastName", basis: "operational_default" },
      { id: "dc-2", kind: "required", field: "custom.beispiel_nachweis_nr" },
      {
        id: "dc-3",
        kind: "requiredIf",
        field: "iban",
        when: { field: "maritalStatus", equals: "married" },
        basis: "ba_form",
      },
      { id: "dc-4", kind: "requiredIf", field: "iban", when: { field: "taxId", exists: true } },
    ],
    dsv: [
      { id: "dsv-1", kind: "documentPresent", documentType: "dsv_signed_scan", basis: "statutory" },
      { id: "dsv-2", kind: "documentPresent", documentType: "asu_proof", accepted: true },
    ],
    profiling: [],
  };

  it("accepts a valid rule set and returns it", () => {
    expect(validateRules(valid, custom)).toEqual({ ok: true, rules: valid });
  });

  it("accepts every document type of the catalog", () => {
    const rules = DocumentType.options.map((documentType) => ({
      id: documentType,
      kind: "documentPresent",
      documentType,
    }));
    expect(issues({ dsv: rules })).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["unknown field", { kind: "required", field: "shoeSize" }, "shoeSize"],
    ["undeclared custom field", { kind: "required", field: "custom.other" }, "custom.other"],
    [
      "unknown condition field",
      { kind: "requiredIf", field: "iban", when: { field: "shoeSize", exists: true } },
      "shoeSize",
    ],
  ])("rejects an %s", (_, rule, key) => {
    const path =
      rule.kind === "required"
        ? ["data_collection", 0, "field"]
        : ["data_collection", 0, "when", "field"];
    expect(issues({ data_collection: [{ id: "x", ...rule }] })).toEqual([
      { code: "unknown_field", path, key },
    ]);
  });

  it("knows custom fields only when declared", () => {
    const rule = { id: "x", kind: "required", field: "custom.beispiel_nachweis_nr" };
    expect(issues({ data_collection: [rule] }, { customFields: new Set() })).toEqual([
      { code: "unknown_field", path: ["data_collection", 0, "field"], key: rule.field },
    ]);
  });

  it.each(["passport_scan", 7])("rejects the unknown document type %j", (documentType) => {
    expect(issues({ dsv: [{ id: "x", kind: "documentPresent", documentType }] })).toEqual([
      { code: "unknown_document_type", path: ["dsv", 0, "documentType"] },
    ]);
  });

  it("rejects duplicate ids within a step and across steps", () => {
    const rule = { id: "dup", kind: "required", field: "lastName" };
    expect(issues({ data_collection: [rule, rule], profiling: [rule] })).toEqual([
      { code: "duplicate_id", path: ["data_collection", 1, "id"], key: "dup" },
      { code: "duplicate_id", path: ["profiling", 0, "id"], key: "dup" },
    ]);
  });

  it("rejects unknown keys", () => {
    const rule = { id: "x", kind: "required", field: "lastName", script: "1", note: "" };
    expect(issues({ data_collection: [rule] })).toEqual([
      { code: "unknown_key", path: ["data_collection", 0], key: "script" },
      { code: "unknown_key", path: ["data_collection", 0], key: "note" },
    ]);
  });

  it("rejects an unknown step", () => {
    expect(issues({ onboarding: [] })).toEqual([{ code: "unknown_step", path: ["onboarding"] }]);
  });

  it.each<[string, unknown, (string | number)[]]>([
    ["a non-object rule set", [], []],
    ["a null rule set", null, []],
    ["a step that isn't a list", { dsv: {} }, ["dsv"]],
    ["a rule that isn't an object", { dsv: ["x"] }, ["dsv", 0]],
  ])("rejects %s", (_, input, path) => {
    expect(issues(input)).toEqual([{ code: "invalid_rule", path }]);
  });

  it.each<[string, object, string]>([
    ["an unknown kind", { ...required, kind: "script" }, "kind"],
    ["an empty id", { ...required, id: "" }, "id"],
    ["an unknown basis", { ...required, basis: "regional" }, "basis"],
    ["exists: false", ifTaxId({ exists: false }), "when"],
    ["equals with a non-scalar", ifTaxId({ equals: [] }), "when"],
    ["both equals and exists", ifTaxId({ equals: "x", exists: true }), "when"],
    [
      "a non-boolean accepted flag",
      { kind: "documentPresent", documentType: "asu_proof", accepted: "yes" },
      "accepted",
    ],
  ])("rejects a rule with %s", (_, rule, key) => {
    expect(issues({ dsv: [{ id: "x", ...rule }] })).toEqual([
      { code: "invalid_rule", path: ["dsv", 0, key] },
    ]);
  });

  it("reports every issue of a rule set", () => {
    const input = {
      data_collection: [
        { id: "a", kind: "required", field: "shoeSize" },
        { id: "a", kind: "documentPresent", documentType: "passport_scan" },
      ],
      onboarding: [],
    };
    expect(issues(input).map((issue) => issue.code)).toEqual([
      "unknown_field",
      "unknown_document_type",
      "unknown_step",
    ]);
  });
});

const withBasis = (basis?: CompletenessRule["basis"]): CompletenessRule => ({
  id: "x",
  kind: "required",
  field: "lastName",
  ...(basis && { basis }),
});

describe("isLocked (Q75)", () => {
  it.each([
    ["no basis", undefined, true],
    ["statutory", "statutory", true],
    ["ba_form", "ba_form", true],
    ["operational_default", "operational_default", false],
  ] as const)("%s → locked %s", (_, basis, locked) => {
    expect(isLocked(withBasis(basis))).toBe(locked);
  });
});

const rule = (projectTypes?: unknown) => ({
  data_collection: [{ id: "r", ...required, ...(projectTypes !== undefined && { projectTypes }) }],
});

describe("project-type applicability (Q89)", () => {
  it("accepts a non-empty list of project types", () => {
    expect(issues(rule(["ta_tg"]))).toEqual([]);
    expect(issues(rule(["ta_only", "ta_tg"]))).toEqual([]);
  });

  it.each<[unknown, (string | number)[]]>([
    [[], []],
    [["ta_tg", "ta_tg"], []],
    ["ta_tg", []],
    [["tg"], [0]],
  ])("rejects %j", (projectTypes, rest) => {
    expect(issues(rule(projectTypes))).toEqual([
      { code: "invalid_rule", path: ["data_collection", 0, "projectTypes", ...rest] },
    ]);
  });

  it("absence means every project type", () => {
    const [all, tgOnly] = [{}, { projectTypes: ["ta_tg"] }].map(
      (extra) => ({ id: "r", ...required, ...extra }) as CompletenessRule,
    ) as [CompletenessRule, CompletenessRule];
    expect([ruleAppliesTo(all, "ta_only"), ruleAppliesTo(all, "ta_tg")]).toEqual([true, true]);
    expect([ruleAppliesTo(tgOnly, "ta_only"), ruleAppliesTo(tgOnly, "ta_tg")]).toEqual([
      false,
      true,
    ]);
  });
});
