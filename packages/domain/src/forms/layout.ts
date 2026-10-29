import type {
  FormColumnEntry,
  FieldBox,
  FormFieldEntry,
  FieldMap,
  FormTableEntry,
} from "./field-map";
import { formatFormDate, isFormDate, isFormTime } from "./format";
import type { FormInput, FormRow, FormValue } from "./input";
import type { FormIssue } from "./validate";

// The layout of a validated form input (ba-forms.md, overflow; Q41, Q182): each text at the
// form's size or smaller down to the minimum, measured with the embedded font; rows beyond the
// form's and texts beyond their box continue on the Anlage, without loss; identifiers never.

/** Text metrics of the embedded font at a size in points (the PDF adapter supplies them). */
export type TextMeasure = {
  widthOf(text: string, size: number): number;
  /** Ascender to descender. */
  heightAt(size: number): number;
};

/** A value as the PDF receives it: AcroForm name, export value or on-state, the text's size. */
export type FilledField =
  | { name: string; kind: "text"; value: string; fontSize: number; marker?: true }
  | { name: string; kind: "radio"; value: string }
  | { name: string; kind: "checkbox" }
  | { name: string; kind: "checkbox_choice"; value: string };

export type AnlageSection =
  | { kind: "table"; heading: string; columns: string[]; rows: string[][] }
  | { kind: "text"; heading: string; text: string };

/** The "Anlage zum Profilingbogen": the person on every page, each continuation under its heading. */
export type AnlageDocument = {
  template: string;
  title: string;
  name: string;
  birthDate: string;
  sections: AnlageSection[];
};

/** What continues on the Anlage: a table's displaced rows, or a text cut at its box. */
export type FormOverflow = { kind: "table" | "text"; key: string };

export type FormLayout = {
  fields: FilledField[];
  anlage: AnlageDocument | null;
  /** By key in the map's order, each once (a text column of a table by `table.column`). */
  overflow: FormOverflow[];
  /**
   * On a form without an Anlage: texts too long even at the minimum size, left for handwriting; a
   * table cell's with its row.
   */
  notFitting: FormIssue<"text_not_fitting">[];
};

export class FormLayoutError extends Error {
  constructor(readonly issues: FormIssue<string>[]) {
    super("The laid-out form fails its output check");
    this.name = "FormLayoutError";
  }
}

export const rowMarker = "weitere siehe Anlage";
/** The continuation notes, longest first: the shorter one where the longer doesn't fit. */
export const continuationNotes = ["Fortsetzung siehe Anlage", "siehe Anlage"] as const;

/** The border (1 pt) and padding (1 pt) the renderer keeps inside each side of a text box. */
const inset = 2;
/** The renderer's line height: 1.2 times the font height. */
const lineFactor = 1.2;
const sizeStep = 0.5;

/**
 * Lines as the renderer breaks them (pdf-lib's multiline layout): at line breaks, then at the
 * last whitespace before the width; a word wider than the box stays one line.
 */
function wrap(text: string, width: number, size: number, measure: TextMeasure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let rest: string | undefined = paragraph;
    while (rest !== undefined) {
      const line: string = rest;
      let end: number = line.length;
      while (end > 0 && measure.widthOf(line.slice(0, end), size) >= width) {
        end = Math.max(line.slice(0, end).search(/\s\S*$/), 0);
      }
      lines.push(end > 0 ? line.slice(0, end) : line);
      const remainder = end > 0 ? line.slice(end) : "";
      rest = remainder === "" ? undefined : remainder.trim();
    }
  }
  return lines;
}

function fits(text: string, box: FieldBox, multiline: boolean, size: number, m: TextMeasure) {
  const width = box.width - 2 * inset;
  const height = box.height - 2 * inset;
  if (!multiline) return m.widthOf(text, size) <= width && m.heightAt(size) <= height;
  const lines = wrap(text, width, size, m);
  return (
    lines.every((line) => m.widthOf(line, size) < width) &&
    lines.length * m.heightAt(size) * lineFactor <= height
  );
}

type TextEntry = Extract<FormColumnEntry | FormFieldEntry, { kind: "text" }>;

function fittingSize(text: string, entry: TextEntry, map: FieldMap, m: TextMeasure) {
  for (let size = entry.fontSize ?? map.fontSize; size >= map.minFontSize; size -= sizeStep) {
    if (fits(text, entry.box, entry.multiline, size, m)) return size;
  }
  return null;
}

/** The longest head at a word boundary that fits with the note, and the rest for the Anlage. */
function cut(text: string, entry: TextEntry, map: FieldMap, m: TextMeasure) {
  const boundaries = [0, ...[...text.matchAll(/\S(?=\s)/g)].map((match) => match.index + 1)];
  for (const note of continuationNotes) {
    const shown = (end: number) => (end === 0 ? note : `${text.slice(0, end)} … ${note}`);
    const fitting = (end: number) =>
      fits(shown(end), entry.box, entry.multiline, map.minFontSize, m);
    if (!fitting(0)) continue;
    let low = 0;
    let high = boundaries.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fitting(boundaries[mid]!)) low = mid;
      else high = mid - 1;
    }
    const end = boundaries[low]!;
    return { shown: shown(end), rest: text.slice(end).trim() };
  }
  return { shown: continuationNotes.at(-1)!, rest: text };
}

/** A value as the Anlage prints it (and as a text field holds it). */
function display(entry: FormColumnEntry | FormFieldEntry, value: FormValue): string {
  switch (entry.kind) {
    case "date":
      return formatFormDate(value as string);
    case "radio":
    case "checkbox_choice":
      return entry.options[value as string]!;
    case "checkbox":
      return "Ja";
    default:
      return value as string;
  }
}

const filled = (value: FormValue | null | undefined): value is FormValue =>
  value !== null && value !== undefined && value !== "" && value !== false;

/**
 * Lays out an input that passed `validateFormInput` (ba-forms.md, overflow): a table with more
 * rows than the form fills all but its last form row, which reads "weitere siehe Anlage", and
 * moves every row from that one on to the Anlage; a text too long for its box at the minimum
 * size is cut at a word boundary with "Fortsetzung siehe Anlage" and continues there under its
 * heading. Identifiers shrink but are never cut. The output is checked again (real `TT.MM.JJJJ`
 * dates, `hh:mm` times, no never-filled field): a failure is a `FormLayoutError`.
 */
export function layoutForm(input: FormInput, map: FieldMap, measure: TextMeasure): FormLayout {
  if (input.formCode !== map.formCode) throw new RangeError("Input and field map differ");
  const fields: FilledField[] = [];
  const sections: AnlageSection[] = [];
  const notFitting: FormIssue<"text_not_fitting">[] = [];
  const overflow: FormOverflow[] = [];
  const overflows = (kind: FormOverflow["kind"], key: string) => {
    if (!overflow.some((entry) => entry.key === key)) overflow.push({ kind, key });
  };

  const placeText = (
    name: string,
    entry: TextEntry,
    text: string,
    heading: string,
    key: string,
    row: number | undefined,
  ) => {
    const size = fittingSize(text, entry, map, measure);
    if (size !== null) {
      fields.push({ name, kind: "text", value: text, fontSize: size });
    } else if (entry.identifier) {
      const scaled = (entry.box.width - 2 * inset) / measure.widthOf(text, 1);
      fields.push({ name, kind: "text", value: text, fontSize: Math.floor(scaled * 10) / 10 });
    } else if (map.anlage) {
      const { shown, rest } = cut(text, entry, map, measure);
      fields.push({ name, kind: "text", value: shown, fontSize: map.minFontSize });
      sections.push({ kind: "text", heading, text: rest });
      overflows("text", key);
    } else {
      notFitting.push({ code: "text_not_fitting", key, ...(row !== undefined && { row }) });
    }
  };

  /** Fills one value into one AcroForm field. */
  const place = (
    name: string,
    entry: FormColumnEntry | FormFieldEntry,
    value: FormValue,
    heading: string,
    key: string,
    row?: number,
  ) => {
    switch (entry.kind) {
      case "text":
        placeText(name, entry, value as string, heading, key, row);
        break;
      case "radio":
      case "checkbox_choice":
        fields.push({ name, kind: entry.kind, value: entry.options[value as string]! });
        break;
      case "checkbox":
        fields.push({ name, kind: "checkbox" });
        break;
      default:
        fields.push({ name, kind: "text", value: display(entry, value), fontSize: map.fontSize });
    }
  };

  const placeTable = (table: FormTableEntry, rows: readonly FormRow[]) => {
    const spills = rows.length > table.rows;
    if (spills && (table.markerColumn === undefined || map.anlage === null)) {
      throw new RangeError("More rows than the form holds, and no Anlage");
    }
    const onForm = spills ? rows.slice(0, table.rows - 1) : rows;
    onForm.forEach((row, index) => {
      for (const column of table.columns) {
        const value = row[column.key];
        if (!filled(value)) continue;
        const heading = `${table.label}, Zeile ${index + 1}: ${column.label}`;
        place(column.fields[index]!, column, value, heading, `${table.key}.${column.key}`, index);
      }
    });
    if (!spills) return;
    overflows("table", table.key);
    const marker = table.columns.find((column) => column.key === table.markerColumn)!;
    fields.push({
      name: marker.fields[table.rows - 1]!,
      kind: "text",
      value: rowMarker,
      fontSize: map.minFontSize,
      marker: true,
    });
    sections.push({
      kind: "table",
      heading: table.label,
      columns: table.columns.map((column) => column.label),
      rows: rows.slice(table.rows - 1).map((row) =>
        table.columns.map((column) => {
          const value = row[column.key];
          return filled(value) ? display(column, value) : "";
        }),
      ),
    });
  };

  for (const entry of map.entries) {
    if (entry.kind === "table") {
      placeTable(entry, input.tables[entry.key] ?? []);
      continue;
    }
    const value = input.values[entry.key];
    if (!filled(value) || (entry.applies && entry.applies !== input.projectType)) continue;
    for (const name of entry.fields) place(name, entry, value, entry.label, entry.key);
  }

  const issues = checkFilledFields(fields, map);
  if (issues.length > 0) throw new FormLayoutError(issues);
  const anlage = map.anlage;
  return {
    fields,
    anlage:
      anlage && sections.length > 0
        ? {
            template: anlage.template,
            title: anlage.title,
            name: [anlage.firstName, anlage.lastName]
              .map((key) => input.values[key])
              .filter(filled)
              .join(" "),
            birthDate: filled(input.values[anlage.birthDate])
              ? formatFormDate(input.values[anlage.birthDate] as string)
              : "",
            sections,
          }
        : null,
    overflow,
    notFitting,
  };
}

/** The TL 407's layout; its Anlage is `anlage-profilingbogen:v1`. */
export function layoutTl407(input: FormInput, map: FieldMap, measure: TextMeasure): FormLayout {
  if (map.formCode !== "tl407") throw new RangeError("Not a TL 407 field map");
  return layoutForm(input, map, measure);
}

/**
 * The output check (ba-forms.md, validation before rendering): every date field holds a real
 * `TT.MM.JJJJ` date (the month-14 `03.14.1998` is an error), every time `hh:mm`, and no value
 * goes into a field the map never fills or doesn't know. The row marker is exempt.
 */
export function checkFilledFields(
  fields: readonly FilledField[],
  map: FieldMap,
): FormIssue<"field_not_fillable" | "date_invalid" | "time_invalid">[] {
  const kinds = new Map<string, string>();
  for (const entry of map.entries) {
    const columns = entry.kind === "table" ? entry.columns : [entry];
    for (const column of columns) for (const name of column.fields) kinds.set(name, column.kind);
  }
  return fields.flatMap(
    (field): FormIssue<"field_not_fillable" | "date_invalid" | "time_invalid">[] => {
      const kind = kinds.get(field.name);
      if (kind === undefined) return [{ code: "field_not_fillable", key: field.name }];
      if (field.kind !== "text" || field.marker) return [];
      if (kind === "date" && !isFormDate(field.value))
        return [{ code: "date_invalid", key: field.name }];
      if (kind === "time" && !isFormTime(field.value))
        return [{ code: "time_invalid", key: field.name }];
      return [];
    },
  );
}
