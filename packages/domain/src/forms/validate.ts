import { compareIsoDates } from "../dates";
import { isValidIsoDate, type IsoDate } from "../iso-date";
import type {
  FormColumnEntry,
  FormFieldEntry,
  FieldMap,
  FieldRange,
  FormTableEntry,
} from "./field-map";
import { isFormTime, isPrintable } from "./format";
import type { FormInput, FormRow, FormValue } from "./input";

// Validation before rendering (ba-forms.md; ADR-0009): errors refuse generation, plausibility
// warnings are confirmed by staff (audited), and on a form that may be completed by hand a
// missing `*` field is a blank to show before printing. Issues carry codes and keys, never
// values.

export const FormErrorCode = [
  "unknown_key",
  "value_kind_invalid",
  "value_not_applicable",
  "option_invalid",
  "date_invalid",
  "time_invalid",
  "time_range_reversed",
  "identifier_too_long",
  "character_unsupported",
  "required_missing",
] as const;
export type FormErrorCode = (typeof FormErrorCode)[number];

/** The plausibility checks staff confirm by code (ba-forms.md, validation). */
export const PlausibilityWarning = [
  "age_implausible",
  "entry_before_birth",
  "range_reversed",
] as const;
export type PlausibilityWarning = (typeof PlausibilityWarning)[number];

export type FormIssue<Code extends string> = {
  code: Code;
  /** A field key, a table key, a required group or `table.column`. */
  key: string;
  /** The row's index in the input table. */
  row?: number;
};

export type FormValidation = {
  errors: FormIssue<FormErrorCode>[];
  warnings: FormIssue<PlausibilityWarning>[];
  /** Missing applicable `*` fields left for handwriting (`missingRequired: "blank"`). */
  blanks: FormIssue<"required_blank">[];
};

/** The age plausibility range (ba-forms.md, validation): 15–67 years. */
export const plausibleAge = { min: 15, max: 67 } as const;

/** Whole years from `birth` to `on`. */
function ageOn(birth: IsoDate, on: IsoDate): number {
  const [by, bm, bd] = birth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

type Cell = FormColumnEntry | FormFieldEntry;

/** The value's own errors: its JS type, option, date, time, characters and identifier length. */
function valueErrors(entry: Cell, value: FormValue): FormErrorCode[] {
  const isText = typeof value === "string";
  switch (entry.kind) {
    case "checkbox":
      return typeof value === "boolean" ? [] : ["value_kind_invalid"];
    case "radio":
    case "checkbox_choice":
      if (!isText) return ["value_kind_invalid"];
      return Object.hasOwn(entry.options, value) ? [] : ["option_invalid"];
    case "date":
      if (!isText) return ["value_kind_invalid"];
      return isValidIsoDate(value) ? [] : ["date_invalid"];
    case "time":
      if (!isText) return ["value_kind_invalid"];
      return isFormTime(value) ? [] : ["time_invalid"];
    case "text": {
      if (!isText) return ["value_kind_invalid"];
      const errors: FormErrorCode[] = [];
      if (!isPrintable(value, entry.multiline)) errors.push("character_unsupported");
      if (entry.identifier && [...value].length > entry.identifier.maxLength) {
        errors.push("identifier_too_long");
      }
      return errors;
    }
  }
}

const present = (value: FormValue | null | undefined): value is FormValue =>
  value !== null && value !== undefined && value !== "" && value !== false;

const validDate = (value: FormValue | null | undefined): value is IsoDate =>
  typeof value === "string" && isValidIsoDate(value);

function rangeReversed(row: FormRow, { from, to }: FieldRange): boolean {
  const start = row[from];
  const end = row[to];
  return validDate(start) && validDate(end) && compareIsoDates(start, end) > 0;
}

function timeReversed(row: FormRow, { from, to }: FieldRange): boolean {
  const start = row[from];
  const end = row[to];
  if (typeof start !== "string" || typeof end !== "string") return false;
  return isFormTime(start) && isFormTime(end) && end <= start;
}

function tableIssues(table: FormTableEntry, rows: readonly FormRow[], result: FormValidation) {
  const columns = new Map(table.columns.map((column) => [column.key, column]));
  rows.forEach((row, index) => {
    for (const [column, value] of Object.entries(row)) {
      const entry = columns.get(column);
      const key = `${table.key}.${column}`;
      if (!entry) {
        result.errors.push({ code: "unknown_key", key, row: index });
      } else if (value !== null && value !== "") {
        for (const code of valueErrors(entry, value)) result.errors.push({ code, key, row: index });
      }
    }
    for (const range of table.timeRanges) {
      if (timeReversed(row, range)) {
        result.errors.push({
          code: "time_range_reversed",
          key: `${table.key}.${range.to}`,
          row: index,
        });
      }
    }
    for (const range of table.dateRanges) {
      if (rangeReversed(row, range)) {
        result.warnings.push({
          code: "range_reversed",
          key: `${table.key}.${range.to}`,
          row: index,
        });
      }
    }
  });
}

/**
 * Checks a form input against its field map (ba-forms.md, validation before rendering). Errors:
 * an unknown key, a wrong kind or option, an impossible date or time, a time pair whose `bis`
 * isn't after `von`, an identifier longer than its field, a character the font can't print, a
 * value for a field that doesn't apply, and a missing applicable `*` field where the map says
 * `error` (else a blank). Warnings: the age outside 15–67 at the map's `ageAt` date (else at
 * `today`), entry before birth, and a date range with `von > bis`.
 */
export function validateFormInput(input: FormInput, map: FieldMap, today: IsoDate): FormValidation {
  if (input.formCode !== map.formCode) throw new RangeError("Input and field map differ");
  const result: FormValidation = { errors: [], warnings: [], blanks: [] };
  const fields = new Map<string, FormFieldEntry>();
  const tables = new Map<string, FormTableEntry>();
  for (const entry of map.entries) {
    if (entry.kind === "table") tables.set(entry.key, entry);
    else fields.set(entry.key, entry);
  }
  const applies = (entry: FormFieldEntry) =>
    entry.applies === undefined || entry.applies === input.projectType;

  for (const [key, value] of Object.entries(input.values)) {
    const entry = fields.get(key);
    if (!entry) result.errors.push({ code: "unknown_key", key });
    else if (present(value) && !applies(entry)) {
      result.errors.push({ code: "value_not_applicable", key });
    } else if (value !== null && value !== "") {
      for (const code of valueErrors(entry, value)) result.errors.push({ code, key });
    }
  }
  for (const [key, rows] of Object.entries(input.tables)) {
    const table = tables.get(key);
    if (table) tableIssues(table, rows, result);
    else result.errors.push({ code: "unknown_key", key });
  }

  const missing: string[] = [];
  const groups = new Map<string, boolean>();
  for (const entry of fields.values()) {
    if (!entry.required || !applies(entry)) continue;
    const filled = present(input.values[entry.key]);
    if (entry.group === undefined) {
      if (!filled) missing.push(entry.key);
    } else {
      if (!groups.has(entry.group)) missing.push(entry.group);
      groups.set(entry.group, (groups.get(entry.group) ?? false) || filled);
    }
  }
  for (const table of tables.values()) {
    if (table.required && (input.tables[table.key]?.length ?? 0) === 0) missing.push(table.key);
  }
  for (const key of missing.filter((missingKey) => !groups.get(missingKey))) {
    if (map.missingRequired === "error") result.errors.push({ code: "required_missing", key });
    else result.blanks.push({ code: "required_blank", key });
  }

  for (const range of map.dateRanges) {
    if (rangeReversed(input.values, range)) {
      result.warnings.push({ code: "range_reversed", key: range.to });
    }
  }
  const plausibility = map.plausibility;
  const birth = plausibility && input.values[plausibility.birthDate];
  if (plausibility && validDate(birth)) {
    const at = plausibility.ageAt && input.values[plausibility.ageAt];
    const age = ageOn(birth, validDate(at) ? at : today);
    if (age < plausibleAge.min || age > plausibleAge.max) {
      result.warnings.push({ code: "age_implausible", key: plausibility.birthDate });
    }
    const entry = plausibility.entryDate && input.values[plausibility.entryDate];
    if (validDate(entry) && compareIsoDates(entry, birth) < 0) {
      result.warnings.push({ code: "entry_before_birth", key: plausibility.entryDate! });
    }
  }
  return result;
}
