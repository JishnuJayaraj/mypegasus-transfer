import { describe, expect, it } from "vitest";
import { parseLayer } from "./validate";

// Fictional Agenturen and staff ids only.
const staffId = "00000000-0000-4000-8000-000000000001";
const nationwide = {
  asuDueDate: { monthsBeforeEnd: 3, daysAfterKnowledge: 3 },
  profilingExceptionDeadlineMonths: 1,
  kug200bConfirmationFollowUpDays: 14,
  tl407EscalationDaysAfterTgStart: 14,
  cutoffWarningDays: 14,
  cutoffFinalReminderDays: 3,
};
const base = { schemaVersion: 1, kind: "base_defaults", version: 1, nationwide };
const template = {
  schemaVersion: 1,
  kind: "regional_template",
  id: "beispielstadt-test",
  version: 1,
  agenturKey: "beispielstadt-test",
  label: { de: "Agentur für Arbeit Beispielstadt Test (Beispiel)" },
};
const temporary = {
  settings: { agentur_submission: { submissionChannel: "email", leadTimeDays: 14 } },
  source: "phone_call_agentur",
  confirmedBy: staffId,
  confirmedOn: "2027-01-12",
};
const override = { schemaVersion: 1, kind: "project_override" };
const customField = {
  type: "string",
  maxLength: 40,
  "x-dataClass": "confidential",
  "x-retentionClass": "participation_record",
  "x-label": { de: "Zusatznachweis" },
};

const texts = (de: Record<string, string>) => issues({ ...template, helpTexts: { de } });

function issues(input: unknown, inheritedFields?: ReadonlySet<string>) {
  const result = parseLayer(input, inheritedFields && { inheritedFields });
  return result.ok
    ? []
    : result.issues.map(({ code, path, key }) => ({ code, path: path.join("/"), key }));
}

describe("layers of one schema", () => {
  it("accepts a base, a template and an override", () => {
    expect(issues(base)).toEqual([]);
    expect(
      issues({
        ...template,
        $schema: "../../schema/regional-template.schema.json",
        sample: true,
        settings: {
          asu_registration: { defaultChannel: "kug_200b", batchSubmissionChannel: "scan_email" },
          agentur_submission: {
            submissionChannel: "upload",
            originalRequired: false,
            leadTimeDays: 10,
            rejectsOutdatedFormVersions: true,
          },
        },
        fields: { "custom.zusatznachweis_nr": customField },
        rules: {
          data_collection: [
            {
              id: "test-1",
              kind: "required",
              field: "custom.zusatznachweis_nr",
              basis: "operational_default",
            },
          ],
        },
        helpTexts: {
          de: { "asu_registration.intro": "Hinweis" },
          en: { "asu_registration.intro": "Note" },
        },
      }),
    ).toEqual([]);
    expect(
      issues({
        ...override,
        agenturSettings: { "beispielstadt-ost": temporary },
        relax: [
          {
            ruleId: "base-x",
            reasonCode: "collected_elsewhere",
            approvedBy: staffId,
            approvedOn: "2027-01-12",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("takes help texts per self-service field, its key keeping its case", () => {
    expect(
      texts({
        "self_service.educationHistory": "Höchster Abschluss zuerst",
        "self_service.custom.zusatznachweis_nr": "Steht auf dem Nachweis",
      }),
    ).toEqual([]);
    for (const key of ["self_service", "Self_service.gender", "self_service.Gender"]) {
      expect(texts({ [key]: "x" })).not.toEqual([]);
    }
  });

  it("returns the parsed layer", () => {
    const result = parseLayer(base);
    expect(result).toEqual({ ok: true, layer: base });
  });

  it("rejects anything that isn't a layer", () => {
    expect(issues(null)).toEqual([{ code: "invalid", path: "", key: undefined }]);
    expect(issues({ ...base, kind: "project" })).toEqual([
      { code: "invalid", path: "kind", key: undefined },
    ]);
    expect(issues({ ...base, schemaVersion: 2 })).toEqual([
      { code: "invalid", path: "schemaVersion", key: undefined },
    ]);
    expect(issues({ ...template, colour: "blue" })).toEqual([
      { code: "unknown_key", path: "", key: "colour" },
    ]);
  });
});

describe("nationwide vs. regional settings (AC-31, AC-32)", () => {
  it("base defaults need every nationwide setting and hold no regional setting", () => {
    expect(
      issues({ ...base, nationwide: { ...nationwide, cutoffWarningDays: undefined } }),
    ).toEqual([{ code: "invalid", path: "nationwide/cutoffWarningDays", key: undefined }]);
    expect(
      issues({ ...base, settings: { agentur_submission: { submissionChannel: "upload" } } }),
    ).toEqual([{ code: "regional_setting_in_base", path: "", key: "settings" }]);
  });

  it("base defaults add no custom fields", () => {
    expect(issues({ ...base, fields: {} })).toEqual([
      { code: "unknown_key", path: "", key: "fields" },
    ]);
  });

  it("templates and overrides can't set a nationwide setting", () => {
    expect(issues({ ...template, nationwide })).toEqual([
      { code: "nationwide_setting", path: "", key: "nationwide" },
    ]);
    expect(issues({ ...override, nationwide })).toEqual([
      { code: "nationwide_setting", path: "", key: "nationwide" },
    ]);
    expect(
      issues({ ...template, settings: { agentur_submission: { cutoffWarningDays: 7 } } }),
    ).toEqual([
      { code: "unknown_key", path: "settings/agentur_submission", key: "cutoffWarningDays" },
    ]);
  });

  it("an override has no project-wide regional settings", () => {
    expect(issues({ ...override, settings: temporary.settings })).toEqual([
      { code: "project_wide_setting", path: "", key: "settings" },
    ]);
  });

  it("only the allowed channel values", () => {
    expect(
      issues({
        ...template,
        settings: {
          asu_registration: { defaultChannel: "phone", batchSubmissionChannel: "fax" },
          agentur_submission: { submissionChannel: "paper_post", leadTimeDays: -1 },
        },
      }).map(({ path }) => path),
    ).toEqual([
      "settings/asu_registration/defaultChannel",
      "settings/asu_registration/batchSubmissionChannel",
      "settings/agentur_submission/submissionChannel",
      "settings/agentur_submission/leadTimeDays",
    ]);
  });

  it("a template is named by its Agentur", () => {
    expect(issues({ ...template, id: "other" })).toEqual([
      { code: "template_id_mismatch", path: "id", key: undefined },
    ]);
    expect(issues({ ...template, id: "Beispielstadt", agenturKey: "Beispielstadt" })).toEqual([
      { code: "invalid", path: "id", key: undefined },
      { code: "invalid", path: "agenturKey", key: undefined },
    ]);
  });
});

describe("Agentur-scoped temporary settings (AC-33)", () => {
  it.each(["source", "confirmedBy", "confirmedOn"] as const)("need %s", (key) => {
    const { [key]: _omitted, ...rest } = temporary;
    expect(issues({ ...override, agenturSettings: { "beispielstadt-ost": rest } })).toEqual([
      { code: "invalid", path: `agenturSettings/beispielstadt-ost/${key}`, key: undefined },
    ]);
  });

  it("need a real confirmation date, a staff user id and a known source", () => {
    const bad = {
      ...temporary,
      source: "rumour",
      confirmedBy: "PL Müller",
      confirmedOn: "2027-02-30",
    };
    expect(issues({ ...override, agenturSettings: { "beispielstadt-ost": bad } })).toEqual(
      ["source", "confirmedBy", "confirmedOn"].map((key) => ({
        code: key === "confirmedOn" ? "invalid_date" : "invalid",
        path: `agenturSettings/beispielstadt-ost/${key}`,
        key: undefined,
      })),
    );
  });

  it("hold regional settings only", () => {
    const bad = { ...temporary, settings: { agentur_submission: { cutoffWarningDays: 7 } } };
    expect(issues({ ...override, agenturSettings: { "beispielstadt-ost": bad } })).toEqual([
      {
        code: "unknown_key",
        path: "agenturSettings/beispielstadt-ost/settings/agentur_submission",
        key: "cutoffWarningDays",
      },
    ]);
  });

  it("alone carry the Agentur's acceptance of an alternative to the Kug 200a (Q187)", () => {
    const settings = { asu_registration: { kug200aAlternativeAccepted: true } };
    expect(
      issues({ ...override, agenturSettings: { "beispielstadt-ost": { ...temporary, settings } } }),
    ).toEqual([]);
    expect(issues({ ...template, settings })).toEqual([
      {
        code: "agentur_scoped_setting",
        path: "settings/asu_registration/kug200aAlternativeAccepted",
        key: undefined,
      },
    ]);
    const declined = { asu_registration: { kug200aAlternativeAccepted: false } };
    expect(
      issues({
        ...override,
        agenturSettings: { "beispielstadt-ost": { ...temporary, settings: declined } },
      }).map(({ code }) => code),
    ).toEqual(["invalid"]);
  });

  it("a relaxation names the rule, a reason code and its approval", () => {
    const relax = [{ ruleId: "", reasonCode: "Weil es so ist", approvedBy: staffId }];
    expect(issues({ ...override, relax }).map(({ path }) => path)).toEqual([
      "relax/0/ruleId",
      "relax/0/reasonCode",
      "relax/0/approvedOn",
    ]);
  });
});

describe("rules and custom fields of a layer", () => {
  it("reuses the closed completeness rule schema of the domain", () => {
    expect(
      issues({
        ...base,
        rules: {
          dsv: [{ id: "x", kind: "documentPresent", documentType: "dsv_signed_scan", extra: 1 }],
        },
      }),
    ).toEqual([{ code: "unknown_key", path: "rules/dsv/0", key: "extra" }]);
    expect(issues({ ...base, rules: { onboarding: [] } })).toEqual([
      { code: "unknown_step", path: "rules", key: "onboarding" },
    ]);
  });

  it("checks fields against the catalog plus declared custom fields, and unique ids", () => {
    const rules = {
      data_collection: [
        { id: "a", kind: "required", field: "custom.zusatznachweis_nr" },
        { id: "a", kind: "required", field: "custom.undeclared" },
        {
          id: "b",
          kind: "requiredIf",
          field: "lastName",
          when: { field: "custom.inherited", exists: true },
        },
      ],
    };
    const fields = { "custom.zusatznachweis_nr": customField };
    expect(issues({ ...template, fields, rules }, new Set(["custom.inherited"]))).toEqual([
      { code: "unknown_field", path: "rules/data_collection/1/field", key: "custom.undeclared" },
      { code: "duplicate_id", path: "rules/data_collection/1/id", key: "a" },
    ]);
    expect(issues({ ...template, fields, rules }).at(-1)).toEqual({
      code: "unknown_field",
      path: "rules/data_collection/2/when/field",
      key: "custom.inherited",
    });
  });

  it("a later layer can't redefine a custom field", () => {
    const fields = { "custom.zusatznachweis_nr": customField };
    expect(issues({ ...override, fields }, new Set(["custom.zusatznachweis_nr"]))).toEqual([
      {
        code: "field_redefined",
        path: "fields/custom.zusatznachweis_nr",
        key: "custom.zusatznachweis_nr",
      },
    ]);
  });
});
