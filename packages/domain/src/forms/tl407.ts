import type { IsoDate } from "../iso-date";
import type { SensitiveValues } from "../self-service/sensitive";
import type { EducationRow } from "../self-service/values";
import type { FieldMap } from "./field-map";
import type { FormInput } from "./input";
import { layoutTl407, type FormLayout, type FormOverflow, type TextMeasure } from "./layout";
import {
  validateFormInput,
  type FormErrorCode,
  type FormIssue,
  type FormValidation,
  type PlausibilityWarning,
} from "./validate";

// The TL 407's readiness (ba-forms.md, validation before rendering; data-protection.md, the
// readiness projection): the profiler's full check of the decrypted input, and the PL's summary
// from presence alone, which names only what the PL may know about. Generation takes the same
// check: an error refuses it, each warning needs its confirmation by code.

/** No form version in use on the request's date (regional-variation.md, forms are versioned). */
export type Tl407ErrorCode = FormErrorCode | "form_version_unavailable";

/**
 * What generation needs confirmed by code: the plausibility warnings, and the explicit answer
 * that the participant has no school qualification (`school_qualification_none`, Q198).
 */
export type Tl407WarningCode = PlausibilityWarning | "school_qualification_none";

export const tl407WarningCodes = [
  "age_implausible",
  "entry_before_birth",
  "range_reversed",
  "school_qualification_none",
] as const satisfies readonly Tl407WarningCode[];

/** The readiness of one TL 407 generation as checked: its issues, and the layout once valid. */
export type Tl407Check = {
  errors: FormIssue<Tl407ErrorCode>[];
  warnings: FormIssue<Tl407WarningCode>[];
  /** Laid out only without errors; its overflow goes to the Anlage. */
  layout: FormLayout | null;
};

/**
 * The school designation (Q196, Q198): the education row the participant marked and the profiler
 * confirmed or corrected is the highest school qualification. With rows and none marked, the
 * answer is open until the profiler confirms with the participant that there is none
 * (`school_qualification_none`, given with the generation, which binds it to the profile's
 * revision): it is never inferred from an unmarked row, the texts or recency, and no row is made
 * up. Without any row the table itself is missing (`required_missing`).
 */
export function schoolQualificationCheck(
  education: readonly EducationRow[] | null,
): FormIssue<"school_qualification_none">[] {
  if (!education || education.length === 0) return [];
  if (education.some((row) => row.highestSchoolQualification)) return [];
  return [{ code: "school_qualification_none", key: "education" }];
}

/**
 * The profiler's check of a TL 407 input (ba-forms.md, validation before rendering): the field
 * map's errors and warnings, the school designation, and the layout of a valid input with its
 * overflow. `map` is null when no version is in use.
 */
export function checkTl407(
  input: FormInput,
  map: FieldMap | null,
  education: readonly EducationRow[] | null,
  today: IsoDate,
  measure: TextMeasure,
): Tl407Check {
  if (map === null) {
    return {
      errors: [{ code: "form_version_unavailable", key: "form" }],
      warnings: [],
      layout: null,
    };
  }
  const validation = validateFormInput(input, map, today);
  const warnings = [...validation.warnings, ...schoolQualificationCheck(education)];
  const layout = validation.errors.length === 0 ? layoutTl407(input, map, measure) : null;
  return { errors: validation.errors, warnings, layout };
}

/** The confirmation codes a check still needs that `confirmed` doesn't give. */
export function unconfirmedWarnings(
  check: Tl407Check,
  confirmed: readonly Tl407WarningCode[],
): Tl407WarningCode[] {
  return [...new Set(check.warnings.map((warning) => warning.code))].filter(
    (code) => !confirmed.includes(code),
  );
}

/** As the form prints it: a field, a table, a table's column, a group (field 49), or the form. */
export function tl407Label(map: FieldMap | null, key: string): string {
  if (key === "form" || map === null) return map?.label ?? "TL 407";
  const [head, column] = key.split(/\.(?=[^.]*$)/) as [string, string?];
  for (const entry of map.entries) {
    if (entry.key === key) return entry.label;
    if (entry.kind !== "table" && entry.group === key) return entry.label;
    if (entry.kind === "table" && entry.key === head && column !== undefined) {
      const found = entry.columns.find((candidate) => candidate.key === column);
      if (found) return `${entry.label}: ${found.label}`;
    }
  }
  return key;
}

type Issue<Code> = { code: Code; key: string; row?: number; label: string };

/** The profiler's readiness (data-protection.md, the readiness projection): every code. */
export type Tl407ProfilerReadiness = {
  view: "profiler";
  formVersion: string | null;
  /** No error: generation is possible once each warning is confirmed. */
  ready: boolean;
  errors: Issue<Tl407ErrorCode>[];
  warnings: Issue<Tl407WarningCode>[];
  overflow: (FormOverflow & { label: string })[];
};

const labelled =
  (map: FieldMap | null) =>
  <Code extends string>(issue: FormIssue<Code>): Issue<Code> => ({
    code: issue.code,
    key: issue.key,
    ...(issue.row !== undefined && { row: issue.row }),
    label: tl407Label(map, issue.key),
  });

export function tl407ProfilerReadiness(
  map: FieldMap | null,
  check: Tl407Check,
): Tl407ProfilerReadiness {
  return {
    view: "profiler",
    formVersion: map?.version ?? null,
    ready: check.errors.length === 0,
    errors: check.errors.map(labelled(map)),
    warnings: check.warnings.map(labelled(map)),
    overflow: (check.layout?.overflow ?? []).map((entry) => ({
      ...entry,
      label: tl407Label(map, entry.key),
    })),
  };
}

/**
 * The catalog field each TL 407 input key comes from (ba-forms.md, what is filled): the PL's
 * summary names a missing key only when the PL may know about its source (data-protection.md,
 * access matrix). `null`: the organisation or the form itself.
 */
export const tl407FieldSources: Readonly<Record<string, string | null>> = {
  paragraph110: null,
  paragraph111: null,
  "carrier.name": null,
  "carrier.street": null,
  "carrier.houseNumber": null,
  "carrier.postalCode": null,
  "carrier.city": null,
  firstName: "firstName",
  lastName: "lastName",
  birthDate: "birthDate",
  beeFrom: "tgStart",
  beeTo: "tgEnd",
  sessions: "profilingSessions",
  pensionInsuranceNumber: "pensionInsuranceNumber",
  gender: "gender",
  street: "address",
  houseNumber: "address",
  postalCode: "address",
  city: "address",
  phone: "phone",
  mobile: "mobile",
  email: "privateEmail",
  maritalStatus: "maritalStatus",
  nationality: "nationality",
  otherNationality: "nationality",
  entryToGermanyDate: "entryToGermanyDate",
  residenceStatus: "residenceStatus",
  unemployedFrom: "unemploymentPeriod",
  unemployedUntil: "unemploymentPeriod",
  buergergeld: "buergergeld",
  healthRestrictions: "healthRestrictions",
  severeDisability: "severeDisability",
  education: "educationHistory",
  work: "workHistory",
  germanLevel: "languageSkills",
  languages: "languageSkills",
  drivingLicence: "drivingLicence",
  vehicleAvailable: "vehicleAvailable",
  employmentType: "workingTimePreferences",
  weeklyHours: "workingTimePreferences",
  workingTimeDistribution: "workingTimePreferences",
  desiredJob: "jobWishes",
  alternativeJob: "jobWishes",
  desiredWorkLocations: "desiredWorkLocations",
  maxDistance: "maxCommuteDistance",
  maxDistanceKm: "maxCommuteDistance",
  maxDistanceScope: "maxCommuteDistance",
  jobboerseChoice: "jobboerseChoice",
  earliestStartDate: "earliestStartDate",
};

/** The source of a key; a section C or p. 7 key is the profiler's assessment. */
export function tl407FieldSource(key: string): string | null {
  if (key.startsWith("assessment.health.")) return "profilingHealthAssessment";
  if (key.startsWith("assessment.")) return "profilingAssessment";
  if (key === "overallAssessment" || key === "nextSteps") return key;
  const source = tl407FieldSources[key];
  if (source === undefined) throw new RangeError(`No source for TL 407 key ${key}`);
  return source;
}

/**
 * Stand-ins for the sensitive values the PL's summary may count as present: never rendered and
 * never shown, since the summary keeps only `required_missing` (data-protection.md, the readiness
 * projection: presence flags, no decryption).
 */
export function presentSensitiveValues(
  present: Readonly<Record<keyof SensitiveValues, boolean>>,
): SensitiveValues {
  const when = <T>(field: keyof SensitiveValues, value: T) => (present[field] ? value : null);
  return {
    pensionInsuranceNumber: when("pensionInsuranceNumber", "present"),
    nationality: when("nationality", { kind: "german" as const }),
    entryToGermanyDate: when("entryToGermanyDate", "2000-01-01"),
    residenceStatus: when("residenceStatus", "residence_permit" as const),
    buergergeld: when("buergergeld", false),
    healthRestrictions: when("healthRestrictions", false),
    severeDisability: when("severeDisability", false),
  };
}

/** The PL's readiness (data-protection.md, the readiness projection): no warning, no overflow. */
export type Tl407ReadinessSummary = {
  view: "project_lead";
  /** Nothing the PL may know about is missing; the profiler's readiness decides generation. */
  ready: boolean;
  missing: { key: string; label: string }[];
};

/**
 * The PL's summary from an input built of the values they read and presence stand-ins: the
 * missing applicable `*` fields whose source `knows` admits, each once. A form without a version
 * in use isn't ready.
 */
export function tl407ReadinessSummary(
  input: FormInput,
  map: FieldMap | null,
  today: IsoDate,
  knows: (field: string) => boolean,
): Tl407ReadinessSummary {
  if (map === null) return { view: "project_lead", ready: false, missing: [] };
  const validation: FormValidation = validateFormInput(input, map, today);
  const missing = validation.errors
    .filter((issue) => issue.code === "required_missing")
    .filter((issue) => {
      const source = tl407FieldSource(issue.key);
      return source === null || knows(source);
    })
    .map((issue) => ({ key: issue.key, label: tl407Label(map, issue.key) }));
  return { view: "project_lead", ready: missing.length === 0, missing };
}
