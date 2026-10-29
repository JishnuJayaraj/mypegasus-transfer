import { z } from "zod";
import type { IsoDate } from "../iso-date";
import {
  escapeHtml,
  fillTemplate,
  type HtmlTemplate,
  type PrintDocument,
  type TextBlock,
} from "../forms/anlage";
import type { FieldMap, FormTableEntry } from "../forms/field-map";
import { formatFormDate } from "../forms/format";
import type { FormInput, FormRow, FormValue, TransferCompany } from "../forms/input";
import { layoutForm, type FilledField, type TextMeasure } from "../forms/layout";
import { tl407Label } from "../forms/tl407";
import { validateFormInput } from "../forms/validate";
import type { ContactAddress } from "../self-service/values";

// The Kug 200a 07/2025, the cover list of a Kug 200b batch (ba-forms.md, the Kug 200a as built;
// process-and-lifecycle.md, Kug 200b batches; Q195, Q197, Q205), and the Agentur's accepted
// alternative with the same contents (regional-variation.md, the accepted alternative). Pure: the
// API reads the sources under the project's exclusive lock and renders. A batch of more than six
// members spans several copies of six rows (two on p. 1, four on p. 2), each with the header.
// What the data doesn't decide stays blank and goes on the handwriting checklist, never a guess.

/** The participant rows of one Kug 200a copy. */
export const kug200aRowsPerCopy = 6;
const table = "participants";

/** The header's sources: the organisation configuration and the project's fields. */
export type Kug200aHeaderSource = {
  transferCompany: Pick<TransferCompany, "name" | "betriebsnummer" | "economicClass">;
  /** The project's T-Kug-Nummer, if known. */
  tKugNumber: string | null;
  /** The personalabgebender Betrieb: the project's customer and its numbers. */
  employer: { name: string | null; betriebsnummer: string | null; economicClass: string | null };
};

/** One member as read for the list, in the batch's printed order. */
export type Kug200aMemberSource = {
  participationId: string;
  identity: { firstName: string | null; lastName: string | null };
  address: ContactAddress | null;
  /** The RV-Nummer, the purpose-bound read's value. */
  insuranceNumber: string | null;
  /** The effective contractual TG dates (the planned period in the TG). */
  tgStart: IsoDate | null;
  tgEnd: IsoDate | null;
  /** Declaration 17 in force on usable paper: the consent "ist beigefügt", else "liegt nicht vor". */
  profileAccess: boolean;
  /** The Berlin dates of the project's info events the member attended. */
  infoEventDates: readonly IsoDate[];
};

export type Kug200aSource = {
  header: Kug200aHeaderSource;
  members: readonly Kug200aMemberSource[];
};

/**
 * Why a value is on the checklist (codes and keys, never values): `not_recorded` (the platform
 * holds no value), `not_decided` (the data doesn't decide it: the last activity, its period, the
 * info event's date over several dates; Q205), `text_not_fitting` (too long at 6 pt) and a value
 * the form can't take (`character_unsupported`, `identifier_too_long`): each left blank for
 * handwriting.
 */
export const Kug200aChecklistCode = z
  .enum([
    "not_recorded",
    "not_decided",
    "text_not_fitting",
    "character_unsupported",
    "identifier_too_long",
  ])
  .meta({ id: "Kug200aChecklistCode" });
export type Kug200aChecklistCode = z.infer<typeof Kug200aChecklistCode>;

/** A header key (no participations) or a row column with the members it concerns. */
export const Kug200aChecklistItem = z
  .strictObject({
    code: Kug200aChecklistCode,
    key: z.string(),
    label: z.string(),
    participationIds: z.array(z.uuid()),
  })
  .meta({ id: "Kug200aChecklistItem" });
export type Kug200aChecklistItem = z.infer<typeof Kug200aChecklistItem>;

/** The values of the list before any layout: the header, then one row per member. */
type Values = {
  header: Record<string, FormValue | null>;
  rows: FormRow[];
  undecided: { key: string; rows: number[] }[];
};

const present = (value: string | null): value is string => value !== null && value !== "";

function personalData(member: Kug200aMemberSource): string | null {
  const name = [member.identity.lastName, member.identity.firstName].filter(present).join(", ");
  const address = member.address
    ? [member.address.street, `${member.address.postalCode} ${member.address.city}`]
    : [];
  const lines = [name, ...address].filter((line) => line !== "");
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * The values (Q205): the info event's date only when every attendance of the batch's members
 * falls on one Berlin date (several dates: blank, `not_decided`), a member ticked when they
 * attended an info event (on that date when there is one); the last activity at the employer
 * and its period never filled (`not_decided`); "Erklärung … beigefügt" for every member, whose
 * accepted Kug 200b goes with the list; the consent by declaration 17's record in force.
 */
function valuesOf(source: Kug200aSource): Values {
  const { header, members } = source;
  const dates = new Set(members.flatMap((member) => member.infoEventDates));
  const common = dates.size === 1 ? [...dates][0]! : null;
  const rows = members.map((member): FormRow => ({
    personalData: personalData(member),
    insuranceNumber: member.insuranceNumber,
    lastActivity: null,
    lastActivityPeriod: null,
    plannedTgPeriod:
      member.tgStart && member.tgEnd
        ? `${formatFormDate(member.tgStart)} – ${formatFormDate(member.tgEnd)}`
        : null,
    declarationAttached: true,
    consentDeclaration: member.profileAccess ? "attached" : "not_available",
    infoEventAttended:
      common === null ? member.infoEventDates.length > 0 : member.infoEventDates.includes(common),
  }));
  const every = members.map((_, index) => index);
  return {
    header: {
      tgName: header.transferCompany.name,
      tgBetriebsnummer: header.transferCompany.betriebsnummer ?? null,
      tgKugNumber: header.tKugNumber,
      tgEconomicClass: header.transferCompany.economicClass ?? null,
      employerName: header.employer.name,
      employerBetriebsnummer: header.employer.betriebsnummer,
      employerEconomicClass: header.employer.economicClass,
      infoEventDate: common,
    },
    rows,
    undecided: [
      ...(dates.size > 1 ? [{ key: "infoEventDate", rows: [] }] : []),
      { key: `${table}.lastActivity`, rows: every },
      { key: `${table}.lastActivityPeriod`, rows: every },
    ],
  };
}

/** The keys a member's missing data leaves blank (the address with the name, the RV-Nummer, the TG dates). */
function unrecorded(source: Kug200aSource, values: Values) {
  const header = Object.entries(values.header)
    .filter(([key, value]) => key !== "infoEventDate" && (value === null || value === ""))
    .map(([key]) => ({ key, rows: [] as number[] }));
  const column = (key: string, missing: (member: Kug200aMemberSource) => boolean) => ({
    key: `${table}.${key}`,
    rows: source.members.flatMap((member, index) => (missing(member) ? [index] : [])),
  });
  return [
    ...header,
    column("personalData", (m) => m.address === null || !present(m.identity.lastName)),
    column("insuranceNumber", (m) => !present(m.insuranceNumber)),
    column("plannedTgPeriod", (m) => m.tgStart === null || m.tgEnd === null),
  ].filter((entry) => entry.key.indexOf(".") < 0 || entry.rows.length > 0);
}

type Issue = { code: Kug200aChecklistCode; key: string; rows: number[] };

/** The checklist, each code and key once, its members in the list's order. */
function checklistOf(issues: Issue[], map: FieldMap, members: readonly Kug200aMemberSource[]) {
  const grouped = new Map<string, Issue>();
  for (const issue of issues) {
    const id = `${issue.code}\n${issue.key}`;
    const found = grouped.get(id);
    if (found) found.rows.push(...issue.rows);
    else grouped.set(id, { ...issue, rows: [...issue.rows] });
  }
  return [...grouped.values()].map(({ code, key, rows }): Kug200aChecklistItem => ({
    code,
    key,
    label: tl407Label(map, key),
    participationIds: [...new Set(rows)]
      .toSorted((a, b) => a - b)
      .map((i) => members[i]!.participationId),
  }));
}

function assertMap(map: FieldMap): FormTableEntry {
  const entry = map.entries.find((candidate) => candidate.key === table);
  if (map.formCode !== "kug200a" || entry?.kind !== "table") {
    throw new RangeError("Not a Kug 200a field map");
  }
  if (entry.rows !== kug200aRowsPerCopy) throw new RangeError("A Kug 200a copy holds six rows");
  return entry;
}

export type Kug200aCheck = {
  /** One filled copy per six members, in order, each with the header. */
  copies: FilledField[][];
  checklist: Kug200aChecklistItem[];
};

/**
 * The Kug 200a of a batch (ba-forms.md, the Kug 200a as built; Q197, Q205): validated against its
 * field map, where a value the form can't take is left blank and listed rather than refusing the
 * whole list (the PL writes it by hand); split into copies of six rows, each laid out with texts
 * shrunk to the map's 6 pt floor and, beyond it, left blank and listed (`text_not_fitting`).
 */
export function checkKug200a(
  source: Kug200aSource,
  map: FieldMap,
  today: IsoDate,
  measure: TextMeasure,
): Kug200aCheck {
  assertMap(map);
  if (source.members.length === 0) throw new RangeError("A batch has at least one member");
  const values = valuesOf(source);
  const whole: FormInput = {
    formCode: "kug200a",
    projectType: "ta_tg",
    values: values.header,
    tables: { [table]: values.rows },
  };
  const issues: Issue[] = [
    ...unrecorded(source, values).map((entry) => ({ code: "not_recorded" as const, ...entry })),
    ...values.undecided.map((entry) => ({ code: "not_decided" as const, ...entry })),
  ];
  const header = { ...values.header };
  const rows: Record<string, FormValue | null>[] = values.rows.map((row) => ({ ...row }));
  for (const error of validateFormInput(whole, map, today).errors) {
    if (error.code !== "character_unsupported" && error.code !== "identifier_too_long") {
      throw new RangeError(`Unexpected Kug 200a input error: ${error.code}`);
    }
    if (error.row === undefined) header[error.key] = null;
    else rows[error.row]![error.key.slice(table.length + 1)] = null;
    issues.push({
      code: error.code,
      key: error.key,
      rows: error.row === undefined ? [] : [error.row],
    });
  }
  const copies: FilledField[][] = [];
  for (let start = 0; start < rows.length; start += kug200aRowsPerCopy) {
    const input: FormInput = {
      ...whole,
      values: header,
      tables: { [table]: rows.slice(start, start + kug200aRowsPerCopy) },
    };
    const layout = layoutForm(input, map, measure);
    copies.push(layout.fields);
    for (const issue of layout.notFitting) {
      issues.push({
        code: issue.code,
        key: issue.key,
        rows: issue.row === undefined ? [] : [start + issue.row],
      });
    }
  }
  return { copies, checklist: checklistOf(issues, map, source.members) };
}

/** The alternative list's template (regional-variation.md, the accepted alternative). */
export const kug200aListTemplate = "sammelliste-kug200b:v1";

/**
 * The accepted alternative (Q203, Q205): our own list with the Kug 200a's contents, the header as
 * a table of labels and values and one row per member in one table (no copies of six), numbered;
 * every value escaped. Its checklist is the Kug 200a's but for what only the form's boxes refuse.
 */
export function kug200aList(
  source: Kug200aSource,
  map: FieldMap,
  template: HtmlTemplate,
  meta: { createdOn: IsoDate },
): { document: PrintDocument; checklist: Kug200aChecklistItem[] } {
  const entry = assertMap(map);
  if (source.members.length === 0) throw new RangeError("A batch has at least one member");
  const values = valuesOf(source);
  const issues: Issue[] = [
    ...unrecorded(source, values).map((e) => ({ code: "not_recorded" as const, ...e })),
    ...values.undecided.map((e) => ({ code: "not_decided" as const, ...e })),
  ];
  const shown = (key: string, value: FormValue | null | undefined): string => {
    if (value === null || value === undefined || value === "" || value === false) return "";
    const field = map.entries.find((candidate) => candidate.key === key);
    if (field?.kind === "date") return formatFormDate(value as string);
    return value as string;
  };
  const cell = (key: string, value: FormValue | null | undefined): string => {
    const column = entry.columns.find((candidate) => candidate.key === key)!;
    if (value === null || value === undefined || value === "" || value === false) return "";
    if (column.kind === "checkbox") return "Ja";
    if (column.kind === "checkbox_choice") return column.options[value as string]!;
    return value as string;
  };
  const headerRows = map.entries
    .filter((candidate) => candidate.kind !== "table")
    .map((field) => [field.label, shown(field.key, values.header[field.key])]);
  const columns = ["Nr.", ...entry.columns.map((column) => column.label)];
  const rows = values.rows.map((row, index) => [
    String(index + 1),
    ...entry.columns.map((column) => cell(column.key, row[column.key])),
  ]);
  const title = "Liste der Teilnehmenden an einer Transfergesellschaft";
  const subtitle = `Sammelmeldung Kug 200b vom ${formatFormDate(meta.createdOn)}, ${rows.length} ${
    rows.length === 1 ? "Teilnehmende/r" : "Teilnehmende"
  }`;
  const tr = (cells: string[], tag: "td" | "th") =>
    `<tr>${cells.map((text) => `<${tag}>${escapeHtml(text)}</${tag}>`).join("")}</tr>`;
  const headerHtml = `<table class="header"><tbody>${headerRows
    .map(
      ([label, value]) => `<tr><th>${escapeHtml(label!)}</th><td>${escapeHtml(value!)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
  const listHtml = `<table class="list"><thead>${tr(columns, "th")}</thead><tbody>${rows
    .map((row) => tr(row, "td"))
    .join("")}</tbody></table>`;
  const head = { title: escapeHtml(title), subtitle: escapeHtml(subtitle) };
  const blocks: TextBlock[] = [
    { kind: "table", columns: ["Angabe", "Wert"], rows: headerRows },
    { kind: "table", columns, rows },
  ];
  return {
    document: {
      html: fillTemplate(template.index, { ...head, header: headerHtml, list: listHtml }),
      headerHtml: fillTemplate(template.header, head),
      footerHtml: fillTemplate(template.footer, {}),
      text: { pageHeader: [title, subtitle], blocks },
    },
    checklist: checklistOf(issues, map, source.members),
  };
}
