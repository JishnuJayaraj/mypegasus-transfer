import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileFieldSchema, FieldSchema } from "./field-schema";
import { parseLayer } from "./validate";

const meta = {
  "x-dataClass": "confidential",
  "x-retentionClass": "participation_record",
  "x-label": { de: "Zusatzfeld" },
} as const;

/** The issues a template with this one custom field gets (field keys are fictional). */
function issuesOf(schema: Record<string, unknown>, key = "custom.zusatz") {
  const result = parseLayer({
    schemaVersion: 1,
    kind: "regional_template",
    id: "beispielstadt-test",
    version: 1,
    agenturKey: "beispielstadt-test",
    label: { de: "Test" },
    fields: { [key]: schema },
  });
  return result.ok ? [] : result.issues.map(({ code, path }) => ({ code, path: path.join("/") }));
}

describe("field-schema profile: allowed keywords compile like hand-written Zod (AC-34, S1)", () => {
  const cases: [string, Record<string, unknown>, z.ZodType, unknown[]][] = [
    [
      "string with lengths",
      { type: "string", minLength: 2, maxLength: 4 },
      z.string().min(2).max(4),
      ["a", "ab", "abcd", "abcde", "", 3, null, "äöü", "😀😀"],
    ],
    [
      "string with pattern",
      { type: "string", maxLength: 10, pattern: "^[A-Z]{2}-\\d+$" },
      z
        .string()
        .max(10)
        .regex(/^[A-Z]{2}-\d+$/),
      ["AB-1", "ab-1", "AB-", "AB-12345678", 1],
    ],
    [
      "integer with bounds",
      { type: "integer", minimum: 0, maximum: 10 },
      z.int().min(0).max(10),
      [0, 10, 11, -1, 1.5, "1", true],
    ],
    ["number", { type: "number", maximum: 2.5 }, z.number().max(2.5), [2.5, 2.6, -3, "2"]],
    ["boolean", { type: "boolean" }, z.boolean(), [true, false, 0, "true", null]],
    [
      "typed enum",
      { type: "string", enum: ["a", "b"] },
      z.enum(["a", "b"]),
      ["a", "b", "c", 1, null],
    ],
    ["untyped enum", { enum: ["a", 1] }, z.union([z.literal("a"), z.literal(1)]), ["a", 1, "1", 2]],
    ["const", { const: true }, z.literal(true), [true, false, "true"]],
    [
      "title and description",
      { type: "boolean", title: "T", description: "D" },
      z.boolean(),
      [true, "x"],
    ],
  ];

  it.each(cases)("%s", (_name, schema, handWritten, values) => {
    const parsed = FieldSchema.parse({ ...schema, ...meta });
    const compiled = compileFieldSchema(parsed);
    const results = (zod: z.ZodType) => values.map((value) => zod.safeParse(value).success);
    expect(results(compiled)).toEqual(results(handWritten));
  });

  it('`format: "date"` accepts only real calendar dates', () => {
    const compiled = compileFieldSchema(
      FieldSchema.parse({ type: "string", format: "date", ...meta }),
    );
    const accepted = ["2027-02-28", "2028-02-29", "2000-02-29", "2027-02-31", "2027-02-29"].filter(
      (value) => compiled.safeParse(value).success,
    );
    expect(accepted).toEqual(["2027-02-28", "2028-02-29", "2000-02-29"]);
    expect(compiled.safeParse("2027-03-01T00:00:00Z").success).toBe(false);
  });

  it("a valid field has no issues", () => {
    expect(issuesOf({ type: "string", maxLength: 40, ...meta })).toEqual([]);
    expect(issuesOf({ type: "string", format: "date", ...meta })).toEqual([]);
    expect(issuesOf({ type: "string", enum: ["a"], ...meta })).toEqual([]);
    expect(issuesOf({ type: "boolean", ...meta, "x-dataClass": "internal" })).toEqual([]);
  });
});

describe("field-schema profile: everything else is rejected before compiling (AC-34)", () => {
  const at = "fields/custom.zusatz";

  it.each(["items", "properties", "$ref", "oneOf", "exclusiveMinimum", "default", "x-other"])(
    "rejects the keyword %s",
    (keyword) => {
      expect(issuesOf({ type: "string", maxLength: 4, [keyword]: 1, ...meta })).toEqual([
        { code: "unknown_key", path: at },
      ]);
    },
  );

  it.each(["object", "array", "null"])("rejects type %s", (type) => {
    expect(issuesOf({ type, ...meta })).toEqual([{ code: "invalid", path: `${at}/type` }]);
  });

  it.each(["special_category", "highly_confidential", "aggregated"])(
    "rejects x-dataClass %s: sensitive data needs encrypted columns, never jsonb",
    (dataClass) => {
      expect(issuesOf({ type: "boolean", ...meta, "x-dataClass": dataClass })).toEqual([
        { code: "data_class_not_allowed", path: `${at}/x-dataClass` },
      ]);
    },
  );

  it("rejects an unknown retention class", () => {
    expect(issuesOf({ type: "boolean", ...meta, "x-retentionClass": "forever" })).toEqual([
      { code: "unknown_retention_class", path: `${at}/x-retentionClass` },
    ]);
  });

  it("needs a class, a retention class and a German label", () => {
    const { "x-dataClass": _d, "x-retentionClass": _r, ...rest } = meta;
    expect(issuesOf({ type: "boolean", ...rest, "x-label": { en: "Extra" } })).toEqual([
      { code: "data_class_not_allowed", path: `${at}/x-dataClass` },
      { code: "unknown_retention_class", path: `${at}/x-retentionClass` },
      { code: "invalid", path: `${at}/x-label/de` },
    ]);
  });

  it("limits maxLength to 2000 and pattern to 200 characters", () => {
    expect(issuesOf({ type: "string", maxLength: 2001, ...meta })).toEqual([
      { code: "invalid", path: `${at}/maxLength` },
    ]);
    expect(issuesOf({ type: "string", maxLength: 4, pattern: "a".repeat(201), ...meta })).toEqual([
      { code: "invalid", path: `${at}/pattern` },
    ]);
  });

  it("rejects a pattern that isn't a regular expression or needs the u flag (S1)", () => {
    for (const pattern of ["^[a-", "\\p{L}+", "\\P{L}", "\\u{1F600}"]) {
      expect(issuesOf({ type: "string", maxLength: 4, pattern, ...meta })).toEqual([
        { code: "invalid_pattern", path: `${at}/pattern` },
      ]);
    }
  });

  it("needs a type, an enum or a const", () => {
    expect(issuesOf({ title: "T", ...meta })).toEqual([{ code: "type_required", path: at }]);
  });

  it("bounds every free string", () => {
    expect(issuesOf({ type: "string", ...meta })).toEqual([
      { code: "max_length_required", path: at },
    ]);
  });

  it("rejects keywords that don't apply to the type", () => {
    for (const schema of [
      { type: "integer", maxLength: 4 },
      { type: "boolean", pattern: "a" },
      { type: "number", format: "date" },
      { type: "string", maxLength: 4, minimum: 1 },
      { enum: ["a"], maxLength: 4 },
    ]) {
      expect(issuesOf({ ...schema, ...meta })).toEqual([
        { code: "keyword_not_applicable", path: at },
      ]);
    }
  });

  it("rejects contradictory bounds", () => {
    expect(issuesOf({ type: "string", minLength: 5, maxLength: 4, ...meta })).toEqual([
      { code: "invalid_bounds", path: at },
    ]);
    expect(issuesOf({ type: "integer", minimum: 5, maximum: 4, ...meta })).toEqual([
      { code: "invalid_bounds", path: at },
    ]);
  });

  it("rejects enum and const values of another type", () => {
    for (const schema of [
      { type: "string", enum: ["a", 1] },
      { type: "integer", enum: [1.5] },
      { type: "number", const: "1" },
      { type: "boolean", enum: [true, "false"] },
    ]) {
      expect(issuesOf({ ...schema, ...meta })).toEqual([{ code: "enum_type_mismatch", path: at }]);
    }
  });

  it("needs keys of the form custom.<snake_case>", () => {
    for (const key of ["zusatz", "custom.Zusatz", "custom.", "custom.a-b", "firstName"]) {
      expect(issuesOf({ type: "boolean", ...meta }, key)).toEqual([
        { code: "invalid", path: `fields/${key}` },
      ]);
    }
  });
});
