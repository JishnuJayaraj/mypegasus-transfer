import { DataClass, ParticipantRetentionClass } from "@transfer/domain";
import { z } from "zod";

/** A label in the staff (`de`) and portal (`de` + `en`) languages. */
export const LocalizedText = z.strictObject({
  de: z.string().min(1),
  en: z.string().min(1).optional(),
});

/** Custom fields are namespaced so they never collide with the field catalog. */
export const CustomFieldKey = z.string().regex(/^custom\.[a-z][a-z0-9_]{0,62}$/);

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const stringKeywords = ["minLength", "maxLength", "pattern", "format"] as const;
const numberKeywords = ["minimum", "maximum"] as const;

/**
 * The field-schema profile (plan 5.7, D5): the JSON Schema keywords a custom field may use.
 * Everything else is rejected before compiling. Special-category and highly confidential data
 * needs encrypted columns, never `jsonb`, so custom fields are only confidential or internal.
 */
export const FieldSchema = z
  .strictObject({
    type: z.enum(["string", "integer", "number", "boolean"]).optional(),
    enum: z.array(scalar).min(1).optional(),
    const: scalar.optional(),
    format: z.literal("date").optional(),
    minLength: z.int().min(0).max(2000).optional(),
    maxLength: z.int().min(0).max(2000).optional(),
    pattern: z.string().min(1).max(200).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    "x-dataClass": DataClass.extract(["confidential", "internal"]),
    "x-retentionClass": ParticipantRetentionClass,
    "x-label": LocalizedText,
  })
  .superRefine((schema, ctx) => {
    const fail = (code: string) =>
      ctx.addIssue({ code: "custom", message: code, params: { code } });
    const { type } = schema;
    const values = [...(schema.enum ?? []), ...(schema.const === undefined ? [] : [schema.const])];
    if (!type && !values.length) return fail("type_required");
    if (
      (type !== "string" && stringKeywords.some((key) => schema[key] !== undefined)) ||
      ((type === "string" || type === "boolean" || !type) &&
        numberKeywords.some((key) => schema[key] !== undefined))
    ) {
      return fail("keyword_not_applicable");
    }
    if (type && values.some((value) => !hasType(value, type))) return fail("enum_type_mismatch");
    if (type === "string" && !values.length && !schema.format && schema.maxLength === undefined) {
      return fail("max_length_required");
    }
    if (
      (schema.minLength ?? 0) > (schema.maxLength ?? Infinity) ||
      (schema.minimum ?? -Infinity) > (schema.maximum ?? Infinity)
    ) {
      return fail("invalid_bounds");
    }
    if (schema.pattern !== undefined && !isPortablePattern(schema.pattern)) {
      ctx.addIssue({ code: "custom", path: ["pattern"], params: { code: "invalid_pattern" } });
    }
  });
export type FieldSchema = z.infer<typeof FieldSchema>;

function hasType(value: string | number | boolean, type: NonNullable<FieldSchema["type"]>) {
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

/**
 * Patterns compile without the `u` flag (spike S1), so `\p{…}` and `\u{…}` would silently
 * mean something else: they are rejected, like anything that isn't a regular expression.
 */
function isPortablePattern(pattern: string): boolean {
  if (/\\[pP]\{|\\u\{/.test(pattern)) return false;
  try {
    return new RegExp(pattern) instanceof RegExp;
  } catch {
    return false;
  }
}

/** Compiles a field schema that passed the profile (S1: `z.fromJSONSchema`, no ajv). */
export function compileFieldSchema(schema: FieldSchema): z.ZodType {
  return z.fromJSONSchema(schema);
}

const validatorCache = new Map<string, ReadonlyMap<string, z.ZodType>>();

/**
 * The compiled custom-field validators of a pinned template, cached per (template id,
 * version): a version's content never changes (Q36).
 */
export function templateFieldValidators(template: {
  id: string;
  version: number;
  fields?: Record<string, FieldSchema>;
}): ReadonlyMap<string, z.ZodType> {
  const key = `${template.id}@${template.version}`;
  let validators = validatorCache.get(key);
  if (!validators) {
    validators = new Map(
      Object.entries(template.fields ?? {}).map(([field, schema]) => [
        field,
        compileFieldSchema(schema),
      ]),
    );
    validatorCache.set(key, validators);
  }
  return validators;
}
