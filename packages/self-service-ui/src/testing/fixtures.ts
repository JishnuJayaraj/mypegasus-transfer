import type { PortalSelfService, SelfServicePage, WizardPage } from "@transfer/domain";
import { selfServiceValueSchemas } from "@transfer/domain";

// Synthetic wizard states for the tests (no real personal data).

type FieldSpec = string | { key: string; required?: boolean; help?: { de?: string; en?: string } };

export function page(name: SelfServicePage, fields: FieldSpec[], complete = true): WizardPage {
  return {
    page: name,
    sensitive: name === "ba_details" || name === "health",
    complete,
    fields: fields.map((spec) => {
      const { key, required, help } = typeof spec === "string" ? { key: spec } : spec;
      return { key, required: required ?? false, ...(help && { helpText: help }) };
    }),
  };
}

export const customPage = (complete = true): WizardPage => ({
  page: "further",
  sensitive: false,
  complete,
  fields: [
    {
      key: "custom.beispiel_nr",
      required: true,
      helpText: { de: "Oben rechts auf dem Nachweis.", en: "Top right of the certificate." },
      custom: {
        label: { de: "Nachweis-Nr. (Beispiel)", en: "Certificate no. (sample)" },
        schema: {
          type: "string",
          maxLength: 6,
          pattern: "^[0-9]+$",
          "x-dataClass": "confidential",
          "x-retentionClass": "participation_record",
          "x-label": { de: "Nachweis-Nr. (Beispiel)" },
        },
      },
    },
    {
      key: "custom.beispiel_ja",
      required: false,
      custom: {
        label: { de: "Beispiel ja/nein" },
        schema: {
          type: "boolean",
          "x-dataClass": "confidential",
          "x-retentionClass": "participation_record",
          "x-label": { de: "Beispiel ja/nein" },
        },
      },
    },
  ],
});

const emptyValues = Object.fromEntries(
  Object.keys(selfServiceValueSchemas).map((key) => [key, null]),
) as PortalSelfService["values"];

/** A participant who acknowledged the notice and has filled in nothing yet. */
export function wizardState(overrides: Partial<PortalSelfService> = {}): PortalSelfService {
  return {
    revision: 3,
    notice: { version: "self-service-purposes:v1", acknowledged: true },
    identity: { firstName: "Erika", lastName: "Beispiel", birthDate: "1970-01-01" },
    values: emptyValues,
    customValues: {},
    pages: [
      page("personal", [{ key: "gender", required: true }, "maritalStatus"], false),
      page("contact", ["address", "phone", "mobile", "privateEmail"]),
      page("ba_details", ["pensionInsuranceNumber", "nationality"], false),
      page("education", [{ key: "educationHistory", required: true }], false),
      page("work_history", ["workHistory"]),
      page("languages_mobility", ["languageSkills", "drivingLicence", "vehicleAvailable"]),
      page("job_wish", [
        "workingTimePreferences",
        "jobWishes",
        "desiredWorkLocations",
        "maxCommuteDistance",
        "earliestStartDate",
      ]),
      page("health", ["healthRestrictions", "severeDisability"], false),
    ],
    missing: [
      {
        step: "profiling",
        ruleId: "base-tl407-gender",
        kind: "field",
        key: "gender",
        reason: "missing",
      },
      {
        step: "profiling",
        ruleId: "base-tl407-nationality",
        kind: "field",
        key: "nationality",
        reason: "missing",
      },
      {
        step: "profiling",
        ruleId: "base-tl407-educationHistory",
        kind: "field",
        key: "educationHistory",
        reason: "missing",
      },
    ],
    ...overrides,
  };
}
