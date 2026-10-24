import { z } from "zod";
import { ProjectType } from "../project";

// The form registry's field maps (ADR-0009; ba-forms.md, registry): our input key → the
// AcroForm fields of one official form version. `packages/forms` loads them from
// `templates/ba/<formCode>/<version>/field-map.json`; a registry test checks each against its
// blank PDF (every field exists, kinds, options, on-states and boxes match, nothing unmapped).

/** The official forms in the registry (ba-forms.md). */
export const FormCode = z.enum(["tl407", "kug200b", "kug200a"]);
export type FormCode = z.infer<typeof FormCode>;

/** A version as the BA prints it, `MM/JJJJ`, written `MM-JJJJ` (a folder name). */
export const FormVersion = z.string().regex(/^(0[1-9]|1[0-2])-[0-9]{4}$/);
export type FormVersion = z.infer<typeof FormVersion>;

export type FormVersionRef = { formCode: FormCode; formVersion: FormVersion };

/**
 * Why a field is never filled (ba-forms.md, what is filled): the Agentur's own fields, the
 * places and dates of the signatures, what the participant writes or ticks by hand, and the
 * health line's text (data-protection.md: no health detail without explicit consent).
 */
export const NeverFilledReason = z.enum([
  "agentur",
  "signature",
  "handwritten",
  "declaration",
  "health_detail",
]);
export type NeverFilledReason = z.infer<typeof NeverFilledReason>;

const name = z.string().min(1);
const key = z.string().regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/);
/** Our value code → the AcroForm export value (radio) or widget on-state (checkbox choice). */
const options = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), name);

/** A widget rectangle in points, the smallest of the entry's fields; text is measured in it. */
export const FieldBox = z.strictObject({
  width: z.number().positive(),
  height: z.number().positive(),
});
export type FieldBox = z.infer<typeof FieldBox>;

const shapes = {
  text: {
    kind: z.literal("text"),
    box: FieldBox,
    multiline: z.boolean(),
    /** The field's own size where it differs from the map's (its `DA`). */
    fontSize: z.number().positive().optional(),
    /** Never cut, abbreviated or moved to the Anlage (Q180); longer is an error. */
    identifier: z.strictObject({ maxLength: z.int().positive() }).optional(),
  },
  /** `TT.MM.JJJJ` in a text field. */
  date: { kind: z.literal("date") },
  /** `hh:mm` in a text field. */
  time: { kind: z.literal("time") },
  radio: { kind: z.literal("radio"), options },
  checkbox: { kind: z.literal("checkbox"), onState: name },
  /** A checkbox whose widgets carry different on-states, one of them set (Kug 200a). */
  checkboxChoice: { kind: z.literal("checkbox_choice"), options },
};

function variants<T extends z.core.$ZodLooseShape>(extra: T) {
  return [
    z.strictObject({ ...shapes.text, ...extra }),
    z.strictObject({ ...shapes.date, ...extra }),
    z.strictObject({ ...shapes.time, ...extra }),
    z.strictObject({ ...shapes.radio, ...extra }),
    z.strictObject({ ...shapes.checkbox, ...extra }),
    z.strictObject({ ...shapes.checkboxChoice, ...extra }),
  ] as const;
}

const common = {
  key,
  /** As the form prints it, for the Anlage's headings and the staff's list of blanks. */
  label: name,
  fields: z.array(name).min(1),
};

/** A single field: one value, filled into each named AcroForm field (a repeated name). */
export const FormFieldEntry = z.discriminatedUnion(
  "kind",
  variants({
    ...common,
    /** The form marks it `*`. */
    required: z.boolean(),
    /** Only in this project type (Q181: the beE dates in `ta_tg`); blank and not required else. */
    applies: ProjectType.optional(),
    /** Required fields of one group are satisfied by any one of them (TL 407 field 49). */
    group: key.optional(),
  }),
);
export type FormFieldEntry = z.infer<typeof FormFieldEntry>;
export type FieldKind = FormFieldEntry["kind"];

/** A table column: `fields[n]` is the AcroForm field of row n + 1. */
export const FormColumnEntry = z.discriminatedUnion("kind", variants(common));
export type FormColumnEntry = z.infer<typeof FormColumnEntry>;

const range = z.strictObject({ from: key, to: key });
export type FieldRange = z.infer<typeof range>;

/** A fixed row table (ba-forms.md, row limits). */
export const FormTableEntry = z.strictObject({
  kind: z.literal("table"),
  key,
  label: name,
  /** At least one row (the form marks the table `*`). */
  required: z.boolean(),
  rows: z.int().positive(),
  /** The column whose last form row reads "weitere siehe Anlage" when the rows overflow. */
  markerColumn: key.optional(),
  columns: z.array(FormColumnEntry).min(1),
  /** `von > bis` is a warning. */
  dateRanges: z.array(range),
  /** `bis` not after `von` is an error. */
  timeRanges: z.array(range),
});
export type FormTableEntry = z.infer<typeof FormTableEntry>;

export const NeverFilled = z.strictObject({ field: name, reason: NeverFilledReason });
export type NeverFilled = z.infer<typeof NeverFilled>;

export const FieldMap = z
  .strictObject({
    formCode: FormCode,
    version: FormVersion,
    /** As printed in the form's footer, e.g. `TL 407 08/2025`. */
    label: name,
    /** The size of the form's own text fields (their `DA`) and the smallest we shrink to. */
    fontSize: z.number().positive(),
    minFontSize: z.number().positive(),
    /** A missing applicable `*` field refuses generation, or stays blank for handwriting. */
    missingRequired: z.enum(["error", "blank"]),
    /** Our template that continues overflowing rows and texts, or none. */
    anlage: z
      .strictObject({
        template: z.string().regex(/^[a-z0-9-]+:v[1-9][0-9]*$/),
        /** Its heading on every page, e.g. "Anlage zum Profilingbogen (TL 407 08/2025)". */
        title: name,
        /** The keys that identify the person on every page of the Anlage. */
        firstName: key,
        lastName: key,
        birthDate: key,
      })
      .nullable(),
    /** In form order. */
    entries: z.array(z.union([FormFieldEntry, FormTableEntry])).min(1),
    /** `von > bis` is a warning. */
    dateRanges: z.array(range),
    /** Plausibility (ba-forms.md, validation): age 15–67 at `at` (else today), entry not before birth. */
    plausibility: z
      .strictObject({ birthDate: key, ageAt: key.optional(), entryDate: key.optional() })
      .optional(),
    neverFilled: z.array(NeverFilled),
  })
  .superRefine((map, ctx) => {
    const issue = (code: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", path, message: code, params: { code } });
    const keys = new Map<string, FormFieldEntry>();
    const tables = new Set<string>();
    const names = new Set<string>();
    const claim = (field: string, path: (string | number)[]) => {
      if (names.has(field)) issue("field_mapped_twice", path);
      names.add(field);
    };
    map.entries.forEach((entry, at) => {
      if (keys.has(entry.key) || tables.has(entry.key)) issue("duplicate_key", ["entries", at]);
      if (entry.kind === "table") {
        tables.add(entry.key);
        const columns = new Map(entry.columns.map((column) => [column.key, column]));
        if (columns.size !== entry.columns.length) issue("duplicate_key", ["entries", at]);
        entry.columns.forEach((column, c) => {
          if (column.fields.length !== entry.rows) {
            issue("column_rows_mismatch", ["entries", at, "columns", c]);
          }
          column.fields.forEach((field, r) =>
            claim(field, ["entries", at, "columns", c, "fields", r]),
          );
        });
        if (entry.markerColumn !== undefined && !columns.has(entry.markerColumn)) {
          issue("unknown_key", ["entries", at, "markerColumn"]);
        }
        for (const [list, kind] of [
          ["dateRanges", "date"],
          ["timeRanges", "time"],
        ] as const) {
          entry[list].forEach((pair, r) => {
            if (columns.get(pair.from)?.kind !== kind || columns.get(pair.to)?.kind !== kind) {
              issue("range_kind_mismatch", ["entries", at, list, r]);
            }
          });
        }
      } else {
        keys.set(entry.key, entry);
        entry.fields.forEach((field, f) => claim(field, ["entries", at, "fields", f]));
      }
    });
    map.neverFilled.forEach(({ field }, at) => claim(field, ["neverFilled", at]));
    map.dateRanges.forEach((pair, at) => {
      if (keys.get(pair.from)?.kind !== "date" || keys.get(pair.to)?.kind !== "date") {
        issue("range_kind_mismatch", ["dateRanges", at]);
      }
    });
    const refs = [
      ["date", map.plausibility?.birthDate, "plausibility"],
      ["date", map.plausibility?.ageAt, "plausibility"],
      ["date", map.plausibility?.entryDate, "plausibility"],
      ["date", map.anlage?.birthDate, "anlage"],
      ["text", map.anlage?.firstName, "anlage"],
      ["text", map.anlage?.lastName, "anlage"],
    ] as const;
    for (const [kind, ref, path] of refs) {
      if (ref !== undefined && keys.get(ref)?.kind !== kind) issue("unknown_key", [path]);
    }
    if (map.minFontSize > map.fontSize) issue("font_size_order", ["minFontSize"]);
  });
export type FieldMap = z.infer<typeof FieldMap>;

/** The AcroForm field names a map fills or deliberately leaves blank, in map order. */
export function mappedFieldNames(map: FieldMap): string[] {
  return [
    ...map.entries.flatMap((entry) =>
      entry.kind === "table" ? entry.columns.flatMap((column) => column.fields) : entry.fields,
    ),
    ...map.neverFilled.map(({ field }) => field),
  ];
}
