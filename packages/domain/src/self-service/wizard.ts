import { z } from "zod";
import {
  evaluateCompleteness,
  requiredField,
  type CompletenessFacts,
  type MissingItem,
} from "../completeness/engine";
import { ruleAppliesTo, type RulesByStep } from "../completeness/rules";
import { documentTypeCatalog, type DocumentType } from "../documents/catalog";
import type { Step } from "../lifecycle/enums";
import type { ProjectType } from "../project";
import { contactFields, selfServiceValueSchemas, type SelfServiceField } from "./values";

// The self-service wizard (regional-variation.md, "Self-service wizard"; Q140). The pages and the
// fields on them are code, in the order of TL 407 section B (ba-forms.md) with the special-category
// page last, behind its step-up, then the participant's documents; which fields are required, the custom fields of the final page
// and the help texts come from the participation's resolved chain. Pure: the API loads the values
// and the resolution.

export const SelfServicePage = z
  .enum([
    "personal",
    "contact",
    "ba_details",
    "education",
    "work_history",
    "languages_mobility",
    "job_wish",
    "health",
    "further",
    "documents",
  ])
  .meta({ id: "SelfServicePage" });
export type SelfServicePage = z.infer<typeof SelfServicePage>;

/** The pages of highly confidential and special-category fields: their own encrypted path. */
export const SensitivePage = SelfServicePage.extract(["ba_details", "health"]);
export type SensitivePage = z.infer<typeof SensitivePage>;

/**
 * The pages `PUT /portal/self-service/pages/{page}` writes: not the sensitive ones, and not
 * "Unterlagen" (`documents`), which has no fields and adds documents on their own routes.
 */
export const ConfidentialPage = SelfServicePage.exclude([
  ...SensitivePage.options,
  "documents",
]).meta({ id: "SelfServiceConfidentialPage" });
export type ConfidentialPage = z.infer<typeof ConfidentialPage>;

/**
 * Each page's catalog fields. "Weitere Angaben" (`further`) holds the chain's confidential custom
 * fields instead, "Unterlagen" (`documents`) none: one section per `wizardDocumentTypes`. Not on any
 * page: `unemploymentPeriod` (Q85, the profiler records it) and `qualifications` (no TL 407
 * section B field; certificates are uploads).
 */
export const wizardPages: readonly { page: SelfServicePage; fields: readonly string[] }[] = [
  { page: "personal", fields: ["gender", "maritalStatus"] },
  { page: "contact", fields: contactFields },
  {
    page: "ba_details",
    fields: [
      "pensionInsuranceNumber",
      "nationality",
      "entryToGermanyDate",
      "residenceStatus",
      "buergergeld",
    ],
  },
  { page: "education", fields: ["educationHistory"] },
  { page: "work_history", fields: ["workHistory"] },
  { page: "languages_mobility", fields: ["languageSkills", "drivingLicence", "vehicleAvailable"] },
  {
    page: "job_wish",
    fields: [
      "workingTimePreferences",
      "jobWishes",
      "desiredWorkLocations",
      "maxCommuteDistance",
      "earliestStartDate",
    ],
  },
  { page: "health", fields: ["healthRestrictions", "severeDisability"] },
  { page: "further", fields: [] },
  { page: "documents", fields: [] },
];

/**
 * The sections of "Unterlagen", in catalog order: the types the participant adds themselves
 * (data-protection.md, documents; Q142, Q146 *assumed*).
 */
export const wizardDocumentTypes: readonly DocumentType[] = documentTypeCatalog.types
  .filter(
    (entry) =>
      typeof entry.operations === "object" &&
      (entry.operations.add as readonly string[]).includes("participant"),
  )
  .map((entry) => entry.type);

const fieldsOf = (page: SelfServicePage) => wizardPages.find((p) => p.page === page)!.fields;

/** The confidential fields of a page, keyed for its values. */
export const confidentialFieldsOf = (page: Exclude<ConfidentialPage, "further">) =>
  fieldsOf(page) as readonly SelfServiceField[];

/**
 * The values a page write carries: each of the page's fields, `null` or absent for empty (the page
 * is saved whole). Unknown keys are refused, so nothing sensitive passes. `further` takes the
 * compiled validators of the chain's custom fields.
 */
export function pageValuesSchema(
  page: ConfidentialPage,
  customValidators: ReadonlyMap<string, z.ZodType> = new Map(),
) {
  const entries: [string, z.ZodType][] =
    page === "further"
      ? [...customValidators]
      : confidentialFieldsOf(page).map((key) => [key, selfServiceValueSchemas[key]]);
  return z.strictObject(
    Object.fromEntries(entries.map(([key, schema]) => [key, schema.nullable().optional()])),
  );
}

/** Every field of the page, `null` where the write left it empty. */
export function completePageValues(
  page: ConfidentialPage,
  values: Readonly<Record<string, unknown>>,
  customKeys: readonly string[] = [],
): Record<string, unknown> {
  const keys = page === "further" ? customKeys : confidentialFieldsOf(page);
  return Object.fromEntries(keys.map((key) => [key, values[key] ?? null]));
}

/** The steps whose rules the wizard's required fields come from (Q140). */
export const wizardSteps: readonly Step[] = ["data_collection", "profiling"];

export type CustomFieldDefinition = {
  label: { de: string; en?: string | undefined };
  /** The field schema of the profile (ADR-0004), for the portal to render and validate. */
  schema: Readonly<Record<string, unknown>>;
};

export type WizardInput = {
  projectType: ProjectType;
  /** The participation's resolved rules (relaxed ones removed). */
  rules: RulesByStep;
  /** The chain's confidential custom fields, by key. */
  customFields: Readonly<Record<string, CustomFieldDefinition>>;
  helpTexts: { de: Readonly<Record<string, string>>; en: Readonly<Record<string, string>> };
  /** Values by field key; a sensitive field's presence as `true` or `null`. */
  fields: CompletenessFacts["fields"];
  /** The states of the live documents by type (`documentState`); a deleted one counts nothing. */
  documents: CompletenessFacts["documents"];
};

export type WizardField = {
  key: string;
  required: boolean;
  helpText?: { de?: string; en?: string };
  /** Only for a custom field. */
  custom?: CustomFieldDefinition;
};
export type WizardPage = {
  page: SelfServicePage;
  sensitive: boolean;
  /**
   * No required field of the page is missing, on "Unterlagen" no document item of its types (the
   * progress bar counts these).
   */
  complete: boolean;
  fields: WizardField[];
  /** Only on "Unterlagen": its sections. */
  documentTypes?: DocumentType[];
};

/** The missing items of the wizard's steps: codes only (process-and-lifecycle.md, profiling). */
export function selfServiceMissing(input: Omit<WizardInput, "customFields" | "helpTexts">) {
  const { byStep } = evaluateCompleteness(input.rules, {
    projectType: input.projectType,
    fields: input.fields,
    documents: input.documents,
  });
  return wizardSteps.flatMap((step) => byStep[step].missing);
}

/**
 * The pages with their fields, which are required now, help texts (`self_service.<field>`) and
 * whether each page is complete; the "further" page only when the chain has custom fields. The
 * missing items are those a participant can fix: fields on a page and documents of their own types
 * (a template's `documentPresent` rule; none in the base defaults).
 */
export function selfServiceWizard(input: WizardInput): {
  pages: WizardPage[];
  missing: MissingItem[];
} {
  const required = new Set(
    wizardSteps.flatMap((step) =>
      (input.rules[step] ?? [])
        .filter((rule) => ruleAppliesTo(rule, input.projectType))
        .map((rule) => requiredField(rule, input.fields))
        .filter((key) => key !== null),
    ),
  );
  const customKeys = Object.keys(input.customFields).toSorted();
  const onPage = new Set([...wizardPages.flatMap((p) => p.fields), ...customKeys]);
  const ownTypes = new Set<string>(wizardDocumentTypes);
  const missing = selfServiceMissing(input).filter((item) =>
    item.kind === "field" ? onPage.has(item.key) : ownTypes.has(item.key),
  );
  const missingKeys = new Set(missing.map((item) => item.key));
  const pages = wizardPages
    .filter(({ page }) => page !== "further" || customKeys.length > 0)
    .map(({ page, fields }): WizardPage => {
      if (page === "documents") {
        const documentTypes = [...wizardDocumentTypes];
        const complete = documentTypes.every((type) => !missingKeys.has(type));
        return { page, sensitive: false, complete, fields: [], documentTypes };
      }
      const keys = page === "further" ? customKeys : fields;
      return {
        page,
        sensitive: SensitivePage.safeParse(page).success,
        complete: keys.every((key) => !missingKeys.has(key)),
        fields: keys.map((key) => ({
          key,
          required: required.has(key),
          ...helpText(input.helpTexts, key),
          ...(page === "further" && { custom: input.customFields[key]! }),
        })),
      };
    });
  return { pages, missing };
}

function helpText(texts: WizardInput["helpTexts"], key: string) {
  const at = `self_service.${key}`;
  const de = Object.hasOwn(texts.de, at) ? texts.de[at] : undefined;
  const en = Object.hasOwn(texts.en, at) ? texts.en[at] : undefined;
  if (de === undefined && en === undefined) return {};
  return { helpText: { ...(de !== undefined && { de }), ...(en !== undefined && { en }) } };
}
