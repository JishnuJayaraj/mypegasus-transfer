import { compareIsoDates } from "../dates";
import { isValidIsoDate, type IsoDate } from "../iso-date";
import {
  addressParts,
  isRequired,
  normaliseCountry,
  type ImportIssue,
  type ImportIssueCode,
  type ImportTarget,
} from "./targets";

// Row validation (Slice 2 plan 5.11; R6, R23, R24; round 32). Pure: `today` comes from the
// Clock. Issues name the row, the target and the code, never the value.

/**
 * A cell as the parser returns it: text, a numeric XLSX cell with its stored value, or a date
 * cell as an ISO date (`time` when it carries a time other than 00:00).
 */
export type ImportCell = string | { number: string } | { date: string; time?: boolean };

/** The values of a row that passed, keyed by target; dates ISO, the country `DE`. */
export type ImportValues = Partial<Record<ImportTarget, string>>;

export type RowInput = {
  /** The row number in the file (the header row is row 1). */
  row: number;
  /** The cell of each mapped target; an unmapped target is absent. */
  cells: Partial<Record<ImportTarget, ImportCell | null>>;
  relaxedRuleIds: ReadonlySet<string>;
  /** The whole-import country the PL selected, if any. */
  country: string | null;
  today: IsoDate;
};

export type ValidatedRow = { row: number; values: ImportValues; issues: ImportIssue[] };

const maxLength: Partial<Record<ImportTarget, number>> = {
  personnelNumber: 50,
  lastName: 100,
  firstName: 100,
  addressStreet: 200,
  addressPostalCode: 200,
  addressCity: 200,
  addressCountry: 200,
};

// oxlint-disable-next-line no-control-regex -- control characters are what this finds
const controlCharacters = /\p{Cc}/u;
const germanDate = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneCharacters = /^\+?[\d /()-]+$/;

/** A pragmatic phone check (round 32): 6–30 characters, at least five digits, `+` only first. */
const isPhone = (value: string) =>
  value.length >= 6 &&
  value.length <= 30 &&
  phoneCharacters.test(value) &&
  (value.match(/\d/g) ?? []).length >= 5;

const isEmail = (value: string) => value.length <= 254 && email.test(value);

/** `TT.MM.JJJJ` strictly, as an ISO date; null for anything else or an impossible date. */
export function parseGermanDate(value: string): IsoDate | null {
  const match = germanDate.exec(value);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** Full years from `birth` to `on`. */
function age(birth: IsoDate, on: IsoDate): number {
  const years = Number(on.slice(0, 4)) - Number(birth.slice(0, 4));
  return on.slice(5) < birth.slice(5) ? years - 1 : years;
}

const dateTargets = new Set<ImportTarget>(["birthDate", "oldEmploymentEndDate"]);
const droppable = new Set<ImportTarget>(["phone", "mobile", "privateEmail", "workEmail"]);

export function validateRow(input: RowInput): ValidatedRow {
  const { row, relaxedRuleIds } = input;
  const issues: ImportIssue[] = [];
  const values: ImportValues = {};
  const error = (target: ImportIssue["target"], code: ImportIssueCode) =>
    issues.push({ row, target, code, severity: "error" });
  const warning = (target: ImportTarget, code: ImportIssueCode) =>
    issues.push({ row, target, code, severity: "warning" });

  for (const [target, cell] of Object.entries(input.cells) as [ImportTarget, ImportCell | null][]) {
    const value = readCell(target, cell);
    if (value === null) continue;
    if ("code" in value) {
      // An optional contact value is dropped with a warning; the row proceeds (round 32).
      if (!droppable.has(target)) error(target, value.code);
      else if (value.code === "identifier_cell_numeric") warning(target, value.code);
      else warning(target, "value_invalid_dropped");
    } else {
      if (value.converted) warning(target, "identifier_cell_converted");
      values[target] = value.text;
    }
  }

  for (const target of ["personnelNumber", "lastName", "firstName"] as const) {
    if (values[target] === undefined && !failed(issues, target)) error(target, "required_missing");
  }
  for (const target of ["birthDate", "oldEmploymentEndDate"] as const) {
    if (
      values[target] === undefined &&
      !failed(issues, target) &&
      isRequired(target, relaxedRuleIds)
    ) {
      error(target, "required_missing");
    }
  }

  const { birthDate, oldEmploymentEndDate } = values;
  if (birthDate !== undefined && compareIsoDates(birthDate, input.today) > 0) {
    error("birthDate", "birth_date_in_future");
  } else if (birthDate !== undefined && oldEmploymentEndDate !== undefined) {
    if (compareIsoDates(oldEmploymentEndDate, birthDate) < 0) {
      error("oldEmploymentEndDate", "end_before_birth");
    } else {
      const years = age(birthDate, oldEmploymentEndDate);
      if (years < 15 || years > 67) warning("birthDate", "age_implausible");
    }
  }

  checkAddress(input, values, issues, error);
  return { row, values, issues };
}

/** Whether a target already has an error (so `required_missing` isn't added on top). */
const failed = (issues: readonly ImportIssue[], target: ImportTarget) =>
  issues.some((issue) => issue.target === target && issue.severity === "error");

type CellResult = { text: string; converted?: boolean } | { code: ImportIssueCode } | null;

/** One cell: its text, an issue or null (empty). */
function readCell(target: ImportTarget, cell: ImportCell | null): CellResult {
  if (cell === null) return null;
  if (typeof cell === "object" && "number" in cell) return readNumber(target, cell.number);
  if (typeof cell === "object") {
    if (!dateTargets.has(target)) return { code: "invalid_cell_type" };
    if (cell.time) return { code: "date_has_time" };
    return isValidIsoDate(cell.date) ? { text: cell.date } : { code: "invalid_date" };
  }
  const text = cell.trim();
  if (text === "") return null;
  if (controlCharacters.test(text)) return { code: "control_characters" };
  if (text.length > (maxLength[target] ?? Infinity)) return { code: "too_long" };
  if (dateTargets.has(target)) {
    const date = parseGermanDate(text);
    return date === null ? { code: "invalid_date" } : { text: date };
  }
  if (target === "phone" || target === "mobile") {
    return isPhone(text) ? { text } : { code: "value_invalid_dropped" };
  }
  if (target === "privateEmail" || target === "workEmail") {
    return isEmail(text) ? { text } : { code: "value_invalid_dropped" };
  }
  return { text };
}

/** A numeric XLSX cell (R24, round 32): never an identifier, a five-digit postcode converted. */
function readNumber(target: ImportTarget, stored: string): CellResult {
  if (target === "addressPostalCode") {
    return /^\d{5}$/.test(stored)
      ? { text: stored, converted: true }
      : { code: "identifier_cell_numeric" };
  }
  const identifier = ["personnelNumber", "phone", "mobile"].includes(target);
  return { code: identifier ? "identifier_cell_numeric" : "invalid_cell_type" };
}

/**
 * The address as one unit (R23, round 32): street, postal code and city all or none (a country
 * cell alone is incomplete too); none only with `base-import-address` relaxed; the country from the
 * cell, else the import's selected one, stored as `DE`; a German postal code is five digits.
 */
function checkAddress(
  input: RowInput,
  values: ImportValues,
  issues: ImportIssue[],
  error: (target: ImportIssue["target"], code: ImportIssueCode) => void,
) {
  const unit = [...addressParts, "addressCountry"] as const;
  if (unit.some((target) => failed(issues, target))) {
    for (const target of unit) delete values[target];
    return;
  }
  const parts = addressParts.filter((part) => values[part] !== undefined).length;
  const country = values.addressCountry ?? input.country ?? undefined;
  if (parts === 0 && values.addressCountry === undefined) {
    if (isRequired("address", input.relaxedRuleIds)) error("address", "required_missing");
    return;
  }
  if (parts < addressParts.length) error("address", "address_incomplete");
  else if (country === undefined) error("addressCountry", "country_required");
  else if (normaliseCountry(country) === null)
    error("addressCountry", "foreign_address_unsupported");
  else if (!/^\d{5}$/.test(values.addressPostalCode as string)) {
    error("addressPostalCode", "postal_code_invalid");
  } else {
    values.addressCountry = "DE";
    return;
  }
  for (const target of unit) delete values[target];
}
