import { z } from "zod";

// The import contract (Slice 2 plan 5.1, 5.11; Q103 confirmed in round 32): what a column may
// map to, which targets are required, and the issue codes a row or mapping can raise. Codes
// only, never a value.

export const ImportTarget = z.enum([
  "personnelNumber",
  "lastName",
  "firstName",
  "birthDate",
  "oldEmploymentEndDate",
  "addressStreet",
  "addressPostalCode",
  "addressCity",
  "addressCountry",
  "phone",
  "mobile",
  "privateEmail",
  "workEmail",
]);
export type ImportTarget = z.infer<typeof ImportTarget>;

/** Street, postal code and city: with the country, one structured address (round 32). */
export const addressParts = ["addressStreet", "addressPostalCode", "addressCity"] as const;

export const ImportIssueCode = z.enum([
  // errors
  "required_missing",
  "invalid_date",
  "date_has_time",
  "birth_date_in_future",
  "end_before_birth",
  "too_long",
  "control_characters",
  "invalid_cell_type",
  "duplicate_in_file",
  "identifier_cell_numeric",
  "postal_code_invalid",
  "foreign_address_unsupported",
  "country_required",
  "country_source_conflict",
  "address_incomplete",
  "target_mapped_twice",
  // warnings
  "age_implausible",
  "value_invalid_dropped",
  "identifier_cell_converted",
  "possible_duplicate",
  "terminal_not_updated",
  "kept_existing",
]);
export type ImportIssueCode = z.infer<typeof ImportIssueCode>;

/**
 * One finding: the file's row number (the header row's number + n; null for the mapping), the
 * target (`address` for the address as a unit) and the code, never the value (5.11).
 */
export type ImportIssue = {
  row: number | null;
  target: ImportTarget | "address" | null;
  code: ImportIssueCode;
  severity: "error" | "warning";
};

/** The rule of the base defaults that requires a target, relaxable by the project (Q75). */
const relaxableRule: Partial<Record<ImportTarget | "address", string>> = {
  birthDate: "base-import-birthDate",
  oldEmploymentEndDate: "base-import-oldEmploymentEndDate",
  address: "base-import-address",
};

/**
 * Whether a target is required: Personalnummer (the match key), last and first name always
 * (R6); date of birth, Austrittsdatum and the address unless the project relaxed their rule.
 */
export function isRequired(
  target:
    | "personnelNumber"
    | "lastName"
    | "firstName"
    | "birthDate"
    | "oldEmploymentEndDate"
    | "address",
  relaxedRuleIds: ReadonlySet<string>,
): boolean {
  const rule = relaxableRule[target];
  return rule === undefined || !relaxedRuleIds.has(rule);
}

/** Germany as the MVP accepts it (round 32): these values, trimmed and case-insensitive. */
const germany = new Set(["de", "deu", "deutschland", "germany"]);

/** `DE` for an accepted spelling of Germany, else null (`foreign_address_unsupported`). */
export const normaliseCountry = (value: string): "DE" | null =>
  germany.has(value.trim().toLowerCase()) ? "DE" : null;

/**
 * Checks a column mapping (5.11): a target at most once; every required target mapped; the
 * address parts and a country column all or none; a country source (a mapped column or the import's selected country,
 * never both) whenever an address is mapped, and a selected country Germany. Issues have no row.
 */
export function checkMapping(input: {
  /** The target of each mapped column. */
  targets: readonly ImportTarget[];
  relaxedRuleIds: ReadonlySet<string>;
  /** The whole-import country the PL selected, if any. */
  country: string | null;
}): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const at = (target: ImportIssue["target"], code: ImportIssueCode): ImportIssue => ({
    row: null,
    target,
    code,
    severity: "error",
  });
  const mapped = new Set<ImportTarget>();
  for (const target of input.targets) {
    if (mapped.has(target)) issues.push(at(target, "target_mapped_twice"));
    mapped.add(target);
  }
  for (const target of ["personnelNumber", "lastName", "firstName"] as const) {
    if (!mapped.has(target)) issues.push(at(target, "required_missing"));
  }
  for (const target of ["birthDate", "oldEmploymentEndDate"] as const) {
    if (isRequired(target, input.relaxedRuleIds) && !mapped.has(target)) {
      issues.push(at(target, "required_missing"));
    }
  }
  const parts = addressParts.filter((part) => mapped.has(part)).length;
  const column = mapped.has("addressCountry");
  // The country belongs to the address unit: mapped without the other parts it is incomplete.
  if (parts === 0 && !column && isRequired("address", input.relaxedRuleIds)) {
    issues.push(at("address", "required_missing"));
  } else if (parts < addressParts.length && (parts > 0 || column)) {
    issues.push(at("address", "address_incomplete"));
  }
  if (column && input.country !== null)
    issues.push(at("addressCountry", "country_source_conflict"));
  else if (parts > 0 && !column && input.country === null) {
    issues.push(at("addressCountry", "country_required"));
  }
  if (input.country !== null && !normaliseCountry(input.country)) {
    issues.push(at("addressCountry", "foreign_address_unsupported"));
  }
  return issues;
}

/**
 * Built-in header suggestions (round 32), compared case-insensitively without punctuation or
 * spacing. A combined `Anschrift` is deliberately absent. Suggestions are only suggestions.
 */
const headerSynonyms: Record<ImportTarget, readonly string[]> = {
  personnelNumber: [
    "Personalnummer",
    "Personal-Nr.",
    "Pers.-Nr.",
    "PersNr",
    "Mitarbeiternummer",
    "Mitarbeiter-Nr.",
    "MA-Nr.",
    "PERNR",
    "Employee ID",
  ],
  lastName: ["Nachname", "Familienname", "Name"],
  firstName: ["Vorname", "Vornamen", "Vorname(n)"],
  birthDate: ["Geburtsdatum", "Geb.-Datum", "GebDatum"],
  oldEmploymentEndDate: [
    "Austrittsdatum",
    "Austritt",
    "Beschäftigungsende",
    "Ende Arbeitsverhältnis",
  ],
  addressStreet: [
    "Straße",
    "Strasse",
    "Straße/Hausnummer",
    "Strasse/Hausnummer",
    "Anschrift Straße",
    "Hausanschrift",
  ],
  addressPostalCode: ["PLZ", "Postleitzahl"],
  addressCity: ["Ort", "Wohnort", "Stadt"],
  addressCountry: ["Land", "Ländercode", "Länderkennzeichen", "Staat", "Country"],
  phone: ["Telefon", "Telefonnummer", "Tel.", "Festnetz"],
  mobile: ["Mobil", "Mobiltelefon", "Handy", "Handynummer"],
  privateEmail: ["E-Mail privat", "Private E-Mail", "E-Mail (privat)"],
  workEmail: ["E-Mail dienstlich", "Geschäftliche E-Mail", "E-Mail geschäftlich", "Firmen-E-Mail"],
};

/** A header compared without case, punctuation or spacing. */
export const normaliseHeader = (header: string) =>
  header
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]/gu, "");

const bySynonym = new Map(
  (Object.entries(headerSynonyms) as [ImportTarget, readonly string[]][]).flatMap(
    ([target, synonyms]) => synonyms.map((synonym) => [normaliseHeader(synonym), target] as const),
  ),
);

/**
 * The suggested target per column (by index; null for none): the first column whose header is a
 * synonym gets the target, a later one with the same target none.
 */
export function suggestTargets(headers: readonly string[]): (ImportTarget | null)[] {
  const used = new Set<ImportTarget>();
  return headers.map((header) => {
    const target = bySynonym.get(normaliseHeader(header));
    if (!target || used.has(target)) return null;
    used.add(target);
    return target;
  });
}

const digits = /\d/g;
const textDate = /\d{1,2}\.\d{1,2}\.\d{4}/;

/**
 * Whether the chosen header row looks like a person's data row (R44, round 33): a cell with a
 * date, an `@` or five or more digits. A real header row has none; a confirm with such a row
 * saves no column mapping, because its keyed hashes would be pseudonymised values of a person.
 * A date cell arrives as an ISO date, which has eight digits.
 */
export const headerLooksLikeData = (headers: readonly string[]) =>
  headers.some(
    (header) =>
      textDate.test(header) || header.includes("@") || (header.match(digits) ?? []).length >= 5,
  );
