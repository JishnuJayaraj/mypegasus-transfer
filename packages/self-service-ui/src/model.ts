import { compileFieldSchema, type FieldSchema } from "@transfer/config";
import {
  isValidIsoDate,
  pageValuesSchema,
  sensitiveValuesSchema,
  valueIssueCode,
  valueWarnings,
  type ConfidentialPage,
  type PortalSelfService,
  type PortalSensitiveValues,
  type PortalStepUp,
  type SelfServicePage,
  type SensitivePage,
  type WizardPage,
} from "@transfer/domain";
import { formatDate, parseDisplayDate } from "@transfer/ui";
import { z } from "zod";

// The wizard's form state and its conversion to the API's values (regional-variation.md,
// "Self-service wizard"). Inputs hold text: dates as `TT.MM.JJJJ`, numbers and choices as strings,
// so a half-typed value is never lost; on "Weiter" the page converts to the API's values (ISO dates,
// `null` for empty) and is checked with the same domain schema the API applies. Issues are codes
// at a path below the page's values, like the API's `422` pointers.

export type Issue = { path: string; code: string };
export type Draft = Record<string, unknown>;

export type AddressForm = { street: string; postalCode: string; city: string };
export type EducationForm = {
  id: number;
  from: string;
  to: string;
  institution: string;
  qualification: string;
  completed: string;
  /** The row of the highest school qualification (Q196); at most one. */
  highestSchool: boolean;
};
export type WorkForm = { id: number; from: string; to: string; employer: string; activity: string };
export type LanguageForm = { id: number; language: string; level: string };
export type LanguageSkillsForm = { german: string; others: LanguageForm[] };
export type DrivingLicenceForm = { none: boolean; classes: string[] };
export type WorkingTimeForm = { employmentType: string; weeklyHours: string; distribution: string };
export type JobWishesForm = { desired: string; alternative: string };
export type DistanceForm = { kind: string; km: string };
export type NationalityForm = { kind: string; country: string };

let lastRowId = 0;
/** A row's key in the page, so inputs keep their state when another row is removed. */
export const rowId = () => ++lastRowId;

export const emptyEducation = (): EducationForm => ({
  id: rowId(),
  from: "",
  to: "",
  institution: "",
  qualification: "",
  completed: "",
  highestSchool: false,
});
export const emptyWork = (): WorkForm => ({
  id: rowId(),
  from: "",
  to: "",
  employer: "",
  activity: "",
});
export const emptyLanguage = (): LanguageForm => ({ id: rowId(), language: "", level: "" });

type CustomKind = "boolean" | "number" | "date" | "enum" | "text";

/** How a custom field is entered, from its field schema (regional-variation.md, custom fields). */
export function customKind(schema: Readonly<Record<string, unknown>>): CustomKind {
  if (Array.isArray(schema.enum)) return "enum";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.format === "date") return "date";
  return "text";
}

const yesNo = (value: unknown) => (typeof value === "boolean" ? (value ? "yes" : "no") : "");
const orEmpty = (value: unknown) => (value === null || value === undefined ? "" : String(value));

/**
 * The wizard state the wizard renders: the portal's (`PortalSelfService`) or the assisted-mode
 * one, where fields the staff role can't see are left out and no step-up applies.
 */
export type WizardState = Omit<PortalSelfService, "values" | "sensitive" | "stepUp"> & {
  values: Partial<PortalSelfService["values"]>;
  sensitive: Partial<PortalSelfService["sensitive"]>;
  /** The participant session's step-up; absent for staff. */
  stepUp?: PortalStepUp;
};

type Values = PortalSelfService["values"] & PortalSensitiveValues["values"];
/** A sensitive group's decrypted values, read on their own logged route. */
export type SensitiveValues = PortalSensitiveValues["values"];

/** A catalog field's value as its form state. */
function toForm(key: string, values: Values): unknown {
  switch (key) {
    case "nationality": {
      const value = values.nationality;
      return { kind: value?.kind ?? "", country: value?.kind === "other" ? value.country : "" };
    }
    case "entryToGermanyDate":
      return formatDate(values.entryToGermanyDate);
    case "buergergeld":
    case "healthRestrictions":
    case "severeDisability":
      return yesNo(values[key]);
    case "address": {
      const value = values.address;
      return {
        street: value?.street ?? "",
        postalCode: value?.postalCode ?? "",
        city: value?.city ?? "",
      };
    }
    case "educationHistory":
      return (values.educationHistory ?? []).map((row) => ({
        id: rowId(),
        from: formatDate(row.from),
        to: formatDate(row.to),
        institution: row.institution,
        qualification: row.qualification,
        completed: row.completed === null ? "running" : yesNo(row.completed),
        highestSchool: row.highestSchoolQualification === true,
      }));
    case "workHistory":
      return (values.workHistory ?? []).map((row) => ({
        id: rowId(),
        from: formatDate(row.from),
        to: formatDate(row.to),
        employer: row.employer,
        activity: row.activity,
      }));
    case "languageSkills":
      return {
        german: values.languageSkills?.german ?? "",
        others: (values.languageSkills?.others ?? []).map((row) => ({ id: rowId(), ...row })),
      };
    case "drivingLicence": {
      const value = values.drivingLicence;
      return { none: value === "none", classes: Array.isArray(value) ? [...value] : [] };
    }
    case "vehicleAvailable":
      return yesNo(values.vehicleAvailable);
    case "workingTimePreferences": {
      const value = values.workingTimePreferences;
      return {
        employmentType: value?.employmentType ?? "",
        weeklyHours: orEmpty(value?.weeklyHours),
        distribution: value?.distribution ?? "",
      };
    }
    case "jobWishes":
      return {
        desired: values.jobWishes?.desired ?? "",
        alternative: values.jobWishes?.alternative ?? "",
      };
    case "maxCommuteDistance": {
      const value = values.maxCommuteDistance;
      return { kind: value?.kind ?? "", km: value?.kind === "km" ? String(value.km) : "" };
    }
    case "earliestStartDate":
      return formatDate(values.earliestStartDate);
    default:
      return orEmpty(values[key as keyof Values]);
  }
}

function customToForm(schema: Readonly<Record<string, unknown>>, value: unknown): string {
  const kind = customKind(schema);
  if (kind === "boolean") return yesNo(value);
  if (kind === "date") return typeof value === "string" ? formatDate(value) : "";
  return orEmpty(value);
}

/**
 * The form state of a page from the wizard state; a sensitive page's from its group's values
 * (data-protection.md, self-service: never in the wizard state).
 */
export function pageDraft(
  page: WizardPage,
  state: WizardState,
  sensitive: SensitiveValues = {},
): Draft {
  const values = { ...state.values, ...sensitive } as Values;
  return Object.fromEntries(
    page.fields.map((field) => [
      field.key,
      field.custom
        ? customToForm(field.custom.schema, state.customValues[field.key])
        : toForm(field.key, values),
    ]),
  );
}

/** Converts form text to values, collecting the issues only the form can see. */
class Converter {
  readonly issues: Issue[] = [];

  text(value: string) {
    return value.trim() === "" ? null : value;
  }

  choice(value: string, path: string, required = false) {
    if (value === "" && required) this.issues.push({ path, code: "required_missing" });
    return value === "" ? null : value;
  }

  /** `yes`/`no`; anything else (empty, "läuft noch") is `null`. */
  yesNo(value: string) {
    return value === "yes" ? true : value === "no" ? false : null;
  }

  /** `TT.MM.JJJJ` to ISO; an impossible date is an error, never another date. */
  date(value: string, path: string, required = false) {
    if (value.trim() === "") {
      if (required) this.issues.push({ path, code: "required_missing" });
      return null;
    }
    const parsed = parseDisplayDate(value);
    if (parsed.ok) return parsed.value!;
    this.issues.push({ path, code: "date_invalid" });
    return value;
  }

  number(value: string, path: string, required = false) {
    if (value.trim() === "") {
      if (required) this.issues.push({ path, code: "required_missing" });
      return null;
    }
    const number = Number(value.trim().replace(",", "."));
    if (Number.isFinite(number)) return number;
    this.issues.push({ path, code: "number_invalid" });
    return value;
  }
}

const filled = (form: Readonly<Record<string, unknown>>) =>
  Object.values(form).some((value) => typeof value === "string" && value.trim() !== "");

/** A catalog field's form state as the API's value (`null` for empty). */
function fromForm(key: string, form: unknown, c: Converter): unknown {
  switch (key) {
    case "pensionInsuranceNumber": {
      // Typed as printed ("65 170839 J 003"): spaces removed, the letter capitalised.
      const value = (form as string).replaceAll(/\s/g, "").toUpperCase();
      return value === "" ? null : value;
    }
    case "nationality": {
      const value = form as NationalityForm;
      if (value.kind === "") return null;
      if (value.kind !== "other") return { kind: value.kind };
      return { kind: "other", country: c.choice(value.country, `${key}/country`, true) };
    }
    case "residenceStatus":
      return c.choice(form as string, key);
    case "entryToGermanyDate":
      return c.date(form as string, key);
    case "buergergeld":
    case "healthRestrictions":
    case "severeDisability":
      return c.yesNo(form as string);
    case "gender":
    case "maritalStatus":
      return c.choice(form as string, key);
    case "address": {
      const value = form as AddressForm;
      return filled(value) ? { ...value, country: "DE" } : null;
    }
    case "educationHistory": {
      const rows = form as EducationForm[];
      if (rows.length === 0) return null;
      return rows.map(({ id: _, ...row }, index) => ({
        from: c.date(row.from, `${key}/${index}/from`, true),
        to: c.date(row.to, `${key}/${index}/to`),
        institution: row.institution,
        qualification: row.qualification,
        completed: c.yesNo(row.completed),
        ...(row.highestSchool && { highestSchoolQualification: true as const }),
      }));
    }
    case "workHistory": {
      const rows = form as WorkForm[];
      if (rows.length === 0) return null;
      return rows.map(({ id: _, ...row }, index) => ({
        ...row,
        from: c.date(row.from, `${key}/${index}/from`, true),
        to: c.date(row.to, `${key}/${index}/to`),
      }));
    }
    case "languageSkills": {
      const value = form as LanguageSkillsForm;
      if (value.german === "" && value.others.length === 0) return null;
      return {
        german: c.choice(value.german, `${key}/german`, true),
        others: value.others.map(({ language, level }, index) => ({
          language,
          level: c.choice(level, `${key}/others/${index}/level`, true),
        })),
      };
    }
    case "drivingLicence": {
      const value = form as DrivingLicenceForm;
      if (value.none) return "none";
      return value.classes.length > 0 ? value.classes : null;
    }
    case "vehicleAvailable":
      return c.yesNo(form as string);
    case "workingTimePreferences": {
      const value = form as WorkingTimeForm;
      if (!filled(value)) return null;
      return {
        employmentType: c.choice(value.employmentType, `${key}/employmentType`, true),
        weeklyHours: c.number(value.weeklyHours, `${key}/weeklyHours`),
        distribution: c.text(value.distribution),
      };
    }
    case "jobWishes": {
      const value = form as JobWishesForm;
      if (!filled(value)) return null;
      return { desired: value.desired, alternative: c.text(value.alternative) };
    }
    case "maxCommuteDistance": {
      const value = form as DistanceForm;
      if (value.kind === "") return null;
      if (value.kind !== "km") return { kind: value.kind };
      return { kind: "km", km: c.number(value.km, `${key}/km`, true) };
    }
    case "earliestStartDate":
      return c.date(form as string, key);
    default:
      return c.text(form as string);
  }
}

function customFromForm(
  key: string,
  schema: Readonly<Record<string, unknown>>,
  form: string,
  c: Converter,
) {
  switch (customKind(schema)) {
    case "boolean":
      return c.yesNo(form);
    case "number":
      return c.number(form, key);
    case "date":
      return c.date(form, key);
    case "enum":
      return form === ""
        ? null
        : ((schema.enum as unknown[]).find((v) => String(v) === form) ?? form);
    default:
      return c.text(form);
  }
}

const validators = new Map<string, z.ZodType | null>();

/**
 * A custom field's validator, compiled in the browser like on the API (ADR-0004: the SPAs run
 * jitless, so this raises no CSP violation). A schema that doesn't compile is left to the API.
 */
function customValidator(schema: Readonly<Record<string, unknown>>) {
  const key = JSON.stringify(schema);
  if (!validators.has(key)) {
    try {
      validators.set(key, compileFieldSchema(schema as FieldSchema));
    } catch {
      validators.set(key, null);
    }
  }
  return validators.get(key) ?? undefined;
}

export type Submission = {
  values: Record<string, unknown>;
  issues: Issue[];
  /** Rows whose `von` is after their `bis`, as `<field>/<index>`: shown, never refused. */
  warnings: string[];
};

/** Whether a nationality form is another country's: entry date and residence status apply. */
export const foreignNationality = (draft: Draft) =>
  (draft.nationality as NationalityForm | undefined)?.kind === "other";

/** The page's values for its write, with the issues the API would refuse and the warnings. */
export function pageSubmission(page: WizardPage, draft: Draft): Submission {
  const c = new Converter();
  // Entry date and residence status are hidden, and sent empty, without another nationality.
  const hidden = new Set(
    page.page === "ba_details" && !foreignNationality(draft)
      ? ["entryToGermanyDate", "residenceStatus"]
      : [],
  );
  const values = Object.fromEntries(
    page.fields.map((field) => [
      field.key,
      hidden.has(field.key)
        ? null
        : field.custom
          ? customFromForm(field.key, field.custom.schema, draft[field.key] as string, c)
          : fromForm(field.key, draft[field.key], c),
    ]),
  );
  // A custom field whose schema doesn't compile here is left to the API.
  const compiled = new Map(
    page.fields.flatMap((field) =>
      field.custom
        ? [[field.key, customValidator(field.custom.schema) ?? z.unknown()] as const]
        : [],
    ),
  );
  const schema = page.sensitive
    ? sensitiveValuesSchema(page.page as SensitivePage)
    : pageValuesSchema(page.page as ConfidentialPage, compiled);
  const parsed = schema.safeParse(values);
  const issues = [...c.issues];
  for (const issue of parsed.error?.issues ?? []) {
    const path = issue.path.join("/");
    if (!issues.some((known) => known.path === path)) {
      issues.push({ path, code: valueIssueCode(issue) });
    }
  }
  return { values, issues, warnings: rowWarnings(values) };
}

type Period = { from: unknown; to: unknown };
const validPeriod = (row: Period) =>
  typeof row.from === "string" &&
  isValidIsoDate(row.from) &&
  (row.to === null || (typeof row.to === "string" && isValidIsoDate(row.to)));

/** `von > bis` per row (ba-forms.md, validation before rendering), for the rows already dated. */
function rowWarnings(values: Record<string, unknown>): string[] {
  return (["educationHistory", "workHistory"] as const).flatMap((field) => {
    const rows = values[field];
    if (!Array.isArray(rows)) return [];
    return (rows as Period[]).flatMap((row, index) =>
      validPeriod(row) &&
      valueWarnings({ [field]: [row] } as Parameters<typeof valueWarnings>[0]).length > 0
        ? [`${field}/${index}`]
        : [],
    );
  });
}

export type Step = "notice" | "overview" | SelfServicePage;

/**
 * Pages without a missing required field (the progress bar, Q140): every page the participant
 * fills in, the sensitive ones by their fields' presence.
 */
export function progress(state: WizardState) {
  const { pages } = state;
  return { complete: pages.filter((page) => page.complete).length, total: pages.length };
}

/** Where a returning participant resumes: the notice, the first page with missing items, else the overview. */
export function resumeStep(state: WizardState): Step {
  if (!state.notice.acknowledged) return "notice";
  return state.pages.find((page) => !page.complete)?.page ?? "overview";
}

/** The step to show for a requested one: the notice comes first; unknown steps resume. */
export function currentStep(state: WizardState, requested: string | undefined): Step {
  if (!state.notice.acknowledged) return "notice";
  if (requested === "overview") return "overview";
  const page = state.pages.find((candidate) => candidate.page === requested);
  return page ? page.page : resumeStep(state);
}

/** The page after `page` in the sequence, or the overview after the last one. */
export function nextStep(state: WizardState, page: SelfServicePage): Step {
  const { pages } = state;
  return pages[pages.findIndex((candidate) => candidate.page === page) + 1]?.page ?? "overview";
}

/** The page before `page`, if there is one. */
export function previousStep(state: WizardState, page: SelfServicePage): Step | undefined {
  const { pages } = state;
  const index = pages.findIndex((candidate) => candidate.page === page);
  return index > 0 ? pages[index - 1]!.page : undefined;
}
