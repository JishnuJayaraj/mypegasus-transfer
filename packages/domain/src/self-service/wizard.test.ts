import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CompletenessRule, RulesByStep } from "../completeness/rules";
import { fieldCatalog, fieldEntry } from "../fields/catalog";
import {
  completePageValues,
  ConfidentialPage,
  confidentialFieldsOf,
  pageValuesSchema,
  selfServiceMissing,
  selfServiceWizard,
  SensitivePage,
  wizardPages,
  type WizardInput,
} from "./wizard";

const required = (field: string, extra: Partial<CompletenessRule> = {}) =>
  ({ id: `r-${field}`, kind: "required", field, basis: "ba_form", ...extra }) as CompletenessRule;

describe("the wizard pages (Q140)", () => {
  it("follow TL 407 section B, the special-category page last before the custom fields", () => {
    expect(wizardPages.map((p) => p.page)).toEqual([
      "personal",
      "contact",
      "ba_details",
      "education",
      "work_history",
      "languages_mobility",
      "job_wish",
      "health",
      "further",
    ]);
  });

  it("list self-service catalog fields, each on one page", () => {
    const keys = wizardPages.flatMap((p) => p.fields);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(fieldEntry(key).selfService).toBe(true);
    const left = fieldCatalog
      .filter((entry) => entry.selfService && !keys.includes(entry.key))
      .map((entry) => entry.key);
    // the profiler's (Q85), back office's (GdB), uploads, and the portal's own channels
    expect(left.toSorted()).toEqual([
      "disabilityDegree",
      "portalChannels",
      "qualifications",
      "unemploymentPeriod",
    ]);
  });

  it("keep highly confidential and special-category fields on the sensitive pages only", () => {
    for (const { page, fields } of wizardPages) {
      const sensitive = SensitivePage.safeParse(page).success;
      for (const key of fields) {
        expect([key, fieldEntry(key).storage === "encrypted_column"]).toEqual([key, sensitive]);
      }
    }
    expect(ConfidentialPage.options).not.toContain("health");
    expect(ConfidentialPage.options).not.toContain("ba_details");
  });
});

describe("pageValuesSchema", () => {
  it("takes the page's fields, each optional and nullable", () => {
    const schema = pageValuesSchema("personal");
    expect(schema.parse({ gender: "female" })).toEqual({ gender: "female" });
    expect(schema.parse({ gender: null, maritalStatus: "single" })).toEqual({
      gender: null,
      maritalStatus: "single",
    });
  });

  it("refuses another page's field and every sensitive field as unknown", () => {
    const result = pageValuesSchema("contact").safeParse({ nationality: "DE", gender: "male" });
    expect(result.error?.issues).toMatchObject([
      { code: "unrecognized_keys", keys: ["nationality", "gender"] },
    ]);
  });

  it("validates the custom fields of the final page with the chain's validators", () => {
    const validators = new Map<string, z.ZodType>([["custom.nr", z.string().max(3)]]);
    const schema = pageValuesSchema("further", validators);
    expect(schema.parse({ "custom.nr": "A1" })).toEqual({ "custom.nr": "A1" });
    expect(schema.safeParse({ "custom.nr": "ABCD" }).success).toBe(false);
    expect(schema.safeParse({ "custom.other": "x" }).success).toBe(false);
    expect(pageValuesSchema("further").parse({})).toEqual({});
  });

  it("names the confidential fields of each catalog page", () => {
    expect(confidentialFieldsOf("languages_mobility")).toEqual([
      "languageSkills",
      "drivingLicence",
      "vehicleAvailable",
    ]);
  });
});

describe("completePageValues", () => {
  it("saves the page whole: absent fields are empty", () => {
    expect(completePageValues("contact", { phone: "0301234567" })).toEqual({
      address: null,
      phone: "0301234567",
      mobile: null,
      privateEmail: null,
    });
    expect(completePageValues("further", { "custom.a": 1 }, ["custom.a", "custom.b"])).toEqual({
      "custom.a": 1,
      "custom.b": null,
    });
    expect(completePageValues("further", {})).toEqual({});
  });
});

const rules: RulesByStep = {
  data_collection: [
    required("address", { basis: "operational_default" }),
    required("personnelNumber"),
    required("custom.nr"),
  ],
  profiling: [
    required("gender"),
    required("nationality"),
    required("workHistory", { projectTypes: ["ta_only"] }),
    {
      id: "r-hours",
      kind: "requiredIf",
      field: "jobWishes",
      when: { field: "maritalStatus", equals: "married" },
    },
    { id: "r-doc", kind: "documentPresent", documentType: "asu_proof" },
  ],
  dsv: [required("phone")],
};

const input = (overrides: Partial<WizardInput> = {}): WizardInput => ({
  projectType: "ta_tg",
  rules,
  customFields: {},
  helpTexts: { de: {}, en: {} },
  fields: {},
  documents: {},
  ...overrides,
});

const custom = { label: { de: "Nr." }, schema: { type: "string", maxLength: 3 } };

describe("selfServiceWizard", () => {
  it("requires what the chain's data-collection and profiling rules name, for this project type", () => {
    const { pages } = selfServiceWizard(input());
    const requiredKeys = pages.flatMap((p) => p.fields.filter((f) => f.required).map((f) => f.key));
    // not phone (a DSV rule), not workHistory (ta_only), not jobWishes (its condition fails)
    expect(requiredKeys).toEqual(["gender", "address", "nationality"]);
  });

  it("requires nothing without rules, and every page is complete", () => {
    const { pages, missing } = selfServiceWizard(input({ rules: {} }));
    expect(pages.every((p) => p.complete && p.fields.every((f) => !f.required))).toBe(true);
    expect(missing).toEqual([]);
  });

  it("requires a requiredIf field while its condition holds", () => {
    const { pages } = selfServiceWizard(input({ fields: { maritalStatus: "married" } }));
    const jobWish = pages.find((p) => p.page === "job_wish")!;
    expect(jobWish.fields.find((f) => f.key === "jobWishes")!.required).toBe(true);
    expect(jobWish.complete).toBe(false);
  });

  it("lists the missing fields a participant can fix, codes only", () => {
    const { missing, pages } = selfServiceWizard(
      input({ fields: { gender: "male", address: null } }),
    );
    expect(missing).toEqual([
      {
        step: "data_collection",
        ruleId: "r-address",
        kind: "field",
        key: "address",
        reason: "missing",
      },
      {
        step: "profiling",
        ruleId: "r-nationality",
        kind: "field",
        key: "nationality",
        reason: "missing",
      },
    ]);
    expect(pages.map((p) => [p.page, p.complete, p.sensitive])).toEqual([
      ["personal", true, false],
      ["contact", false, false],
      ["ba_details", false, true],
      ["education", true, false],
      ["work_history", true, false],
      ["languages_mobility", true, false],
      ["job_wish", true, false],
      ["health", true, true],
    ]);
  });

  it("counts a sensitive field present by its presence flag", () => {
    const { missing } = selfServiceWizard(
      input({ fields: { gender: "male", address: { street: "x" }, nationality: true } }),
    );
    expect(missing).toEqual([]);
  });

  it("adds the final page for custom fields, with their definition", () => {
    const { pages, missing } = selfServiceWizard(
      input({ customFields: { "custom.nr": custom, "custom.a": custom } }),
    );
    expect(pages.at(-1)).toEqual({
      page: "further",
      sensitive: false,
      complete: false,
      fields: [
        { key: "custom.a", required: false, custom },
        { key: "custom.nr", required: true, custom },
      ],
    });
    expect(missing.map((item) => item.key)).toContain("custom.nr");
  });

  it("supplies the help texts of the chain by self_service.<field>", () => {
    const { pages } = selfServiceWizard(
      input({
        helpTexts: {
          de: { "self_service.gender": "Wie im Ausweis", "agentur_submission.intro": "x" },
          en: { "self_service.gender": "As in your ID", "self_service.phone": "Landline" },
        },
      }),
    );
    const fields = pages.flatMap((p) => p.fields);
    expect(fields.find((f) => f.key === "gender")!.helpText).toEqual({
      de: "Wie im Ausweis",
      en: "As in your ID",
    });
    expect(fields.find((f) => f.key === "phone")!.helpText).toEqual({ en: "Landline" });
    expect(fields.find((f) => f.key === "mobile")).toEqual({ key: "mobile", required: false });
  });
});

const missingDoc = (documents: WizardInput["documents"]) =>
  selfServiceMissing(input({ documents })).filter((item) => item.kind === "document");

describe("selfServiceMissing", () => {
  it("reports every missing item of the two steps, for staff", () => {
    expect(selfServiceMissing(input()).map((item) => item.ruleId)).toEqual([
      "r-address",
      "r-personnelNumber",
      "r-custom.nr",
      "r-gender",
      "r-nationality",
      "r-doc",
    ]);
  });

  it("counts the live documents' states (process-and-lifecycle.md, document review)", () => {
    expect(missingDoc({ asu_proof: ["uploaded"] })).toEqual([]);
    expect(missingDoc({ asu_proof: ["rejected"] })).toEqual([
      {
        step: "profiling",
        ruleId: "r-doc",
        kind: "document",
        key: "asu_proof",
        reason: "not_accepted",
      },
    ]);
  });
});
