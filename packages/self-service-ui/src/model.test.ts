import { ApiProblemError } from "@transfer/api-client";
import { describe, expect, it } from "vitest";
import {
  currentStep,
  nextStep,
  pageDraft,
  pageSubmission,
  previousStep,
  progress,
  resumeStep,
  type Draft,
} from "./model";
import { failureOf } from "./source";
import { customPage, page, wizardState } from "./testing/fixtures";

// The wizard's form model (regional-variation.md, "Self-service wizard"): text in, the API's
// values out, checked with the domain schema the API applies. Synthetic values only.

const submit = (fields: string[], draft: Draft) => {
  const name = fields.includes("drivingLicence") ? "languages_mobility" : "job_wish";
  return pageSubmission(page(name, fields), draft);
};

describe("form state from the wizard state", () => {
  it("shows ISO dates as TT.MM.JJJJ and empty values as empty inputs", () => {
    const state = wizardState({
      values: {
        ...wizardState().values,
        earliestStartDate: "2027-03-01",
        educationHistory: [
          {
            from: "1986-09-01",
            to: null,
            institution: "Schule",
            qualification: "Abitur",
            completed: null,
          },
        ],
        drivingLicence: ["B", "BE"],
        maxCommuteDistance: { kind: "km", km: 50 },
        vehicleAvailable: false,
      },
    });
    const draft = pageDraft(
      page("job_wish", [
        "earliestStartDate",
        "educationHistory",
        "drivingLicence",
        "maxCommuteDistance",
        "vehicleAvailable",
        "address",
        "languageSkills",
        "workingTimePreferences",
        "jobWishes",
        "workHistory",
        "gender",
      ]),
      state,
    );
    expect(draft.earliestStartDate).toBe("01.03.2027");
    expect(draft.educationHistory).toEqual([
      expect.objectContaining({ from: "01.09.1986", to: "", completed: "running" }),
    ]);
    expect(draft.drivingLicence).toEqual({ none: false, classes: ["B", "BE"] });
    expect(draft.maxCommuteDistance).toEqual({ kind: "km", km: "50" });
    expect(draft.vehicleAvailable).toBe("no");
    expect(draft.address).toEqual({ street: "", postalCode: "", city: "" });
    expect(draft.languageSkills).toEqual({ german: "", others: [] });
    expect(draft.workingTimePreferences).toEqual({
      employmentType: "",
      weeklyHours: "",
      distribution: "",
    });
    expect(draft.jobWishes).toEqual({ desired: "", alternative: "" });
    expect(draft.workHistory).toEqual([]);
    expect(draft.gender).toBe("");
  });

  it("keeps the other forms of saved values", () => {
    const state = wizardState({
      values: {
        ...wizardState().values,
        drivingLicence: "none",
        maxCommuteDistance: { kind: "nationwide" },
        workingTimePreferences: {
          employmentType: "part_time",
          weeklyHours: 20,
          distribution: null,
        },
        jobWishes: { desired: "Lagerlogistik", alternative: null },
        languageSkills: {
          german: "business_fluent",
          others: [{ language: "Englisch", level: "basic" }],
        },
        workHistory: [
          { from: "2001-01-01", to: "2026-06-30", employer: "Werk", activity: "Montage" },
        ],
        educationHistory: [
          {
            from: "1986-09-01",
            to: "1989-06-30",
            institution: "Betrieb",
            qualification: "Lehre",
            completed: true,
          },
        ],
      },
      customValues: { "custom.beispiel_nr": "123", "custom.beispiel_ja": true },
    });
    const draft = pageDraft(
      page("job_wish", [
        "drivingLicence",
        "maxCommuteDistance",
        "workingTimePreferences",
        "jobWishes",
        "languageSkills",
        "workHistory",
        "educationHistory",
      ]),
      state,
    );
    expect(draft.drivingLicence).toEqual({ none: true, classes: [] });
    expect(draft.maxCommuteDistance).toEqual({ kind: "nationwide", km: "" });
    expect(draft.workingTimePreferences).toEqual({
      employmentType: "part_time",
      weeklyHours: "20",
      distribution: "",
    });
    expect(draft.jobWishes).toEqual({ desired: "Lagerlogistik", alternative: "" });
    expect(draft.languageSkills).toEqual({
      german: "business_fluent",
      others: [expect.objectContaining({ language: "Englisch", level: "basic" })],
    });
    expect(draft.workHistory).toEqual([
      expect.objectContaining({ from: "01.01.2001", to: "30.06.2026", employer: "Werk" }),
    ]);
    expect(draft.educationHistory).toEqual([expect.objectContaining({ completed: "yes" })]);
    expect(pageDraft(customPage(), state)).toEqual({
      "custom.beispiel_nr": "123",
      "custom.beispiel_ja": "yes",
    });
  });
});

const custom = (key: string, schema: Record<string, unknown>) => ({
  page: "further" as const,
  sensitive: false,
  complete: true,
  fields: [{ key, required: false, custom: { label: { de: key }, schema } }],
});

describe("the page's values for its write", () => {
  it("sends TT.MM.JJJJ as ISO and empty inputs as null", () => {
    const result = submit(
      [
        "earliestStartDate",
        "desiredWorkLocations",
        "jobWishes",
        "maxCommuteDistance",
        "workingTimePreferences",
      ],
      {
        earliestStartDate: "1.3.2027",
        desiredWorkLocations: "  ",
        jobWishes: { desired: "", alternative: "" },
        maxCommuteDistance: { kind: "", km: "" },
        workingTimePreferences: { employmentType: "", weeklyHours: "", distribution: "" },
      },
    );
    expect(result).toEqual({
      values: {
        earliestStartDate: "2027-03-01",
        desiredWorkLocations: null,
        jobWishes: null,
        maxCommuteDistance: null,
        workingTimePreferences: null,
      },
      issues: [],
      warnings: [],
    });
  });

  it("refuses an impossible date instead of rolling it over", () => {
    const result = submit(["earliestStartDate"], { earliestStartDate: "31.02.2027" });
    expect(result.issues).toEqual([{ path: "earliestStartDate", code: "date_invalid" }]);
  });

  it("converts the composite fields", () => {
    const result = submit(["maxCommuteDistance", "workingTimePreferences", "jobWishes"], {
      maxCommuteDistance: { kind: "km", km: "30" },
      workingTimePreferences: {
        employmentType: "part_time",
        weeklyHours: "19,5",
        distribution: "",
      },
      jobWishes: { desired: "Montage", alternative: "" },
    });
    expect(result.issues).toEqual([]);
    expect(result.values).toEqual({
      maxCommuteDistance: { kind: "km", km: 30 },
      workingTimePreferences: {
        employmentType: "part_time",
        weeklyHours: 19.5,
        distribution: null,
      },
      jobWishes: { desired: "Montage", alternative: null },
    });
    expect(
      pageSubmission(page("languages_mobility", ["drivingLicence", "vehicleAvailable"]), {
        drivingLicence: { none: false, classes: ["B"] },
        vehicleAvailable: "yes",
      }),
    ).toEqual({
      values: { drivingLicence: ["B"], vehicleAvailable: true },
      issues: [],
      warnings: [],
    });
    expect(
      submit(["maxCommuteDistance"], { maxCommuteDistance: { kind: "international", km: "" } })
        .values,
    ).toEqual({
      maxCommuteDistance: { kind: "international" },
    });
    expect(
      submit(["drivingLicence"], { drivingLicence: { none: true, classes: [] } }).values,
    ).toEqual({
      drivingLicence: "none",
    });
    expect(
      submit(["drivingLicence"], { drivingLicence: { none: false, classes: [] } }).values,
    ).toEqual({
      drivingLicence: null,
    });
  });

  it("names what is missing or not a number, at its path", () => {
    const result = submit(["maxCommuteDistance", "workingTimePreferences", "jobWishes"], {
      maxCommuteDistance: { kind: "km", km: "" },
      workingTimePreferences: { employmentType: "", weeklyHours: "viele", distribution: "" },
      jobWishes: { desired: "", alternative: "Lager" },
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "maxCommuteDistance/km", code: "required_missing" },
        { path: "workingTimePreferences/employmentType", code: "required_missing" },
        { path: "workingTimePreferences/weeklyHours", code: "number_invalid" },
        { path: "jobWishes/desired", code: "required_missing" },
      ]),
    );
    expect(
      submit(["maxCommuteDistance"], { maxCommuteDistance: { kind: "km", km: "x" } }).issues,
    ).toEqual([{ path: "maxCommuteDistance/km", code: "number_invalid" }]);
    expect(
      submit(["maxCommuteDistance"], { maxCommuteDistance: { kind: "km", km: "5000" } }).issues,
    ).toEqual([{ path: "maxCommuteDistance/km", code: "out_of_range" }]);
  });

  it("converts the row tables and warns about von > bis", () => {
    const result = pageSubmission(
      page("education", ["educationHistory", "workHistory", "languageSkills"]),
      {
        educationHistory: [
          {
            id: 1,
            from: "01.09.1990",
            to: "30.06.1986",
            institution: "Schule",
            qualification: "Abitur",
            completed: "yes",
          },
          {
            id: 2,
            from: "01.09.1990",
            to: "",
            institution: "Hochschule",
            qualification: "Studium",
            completed: "running",
          },
          {
            id: 3,
            from: "",
            to: "31.13.1990",
            institution: "",
            qualification: "",
            completed: "no",
          },
        ],
        workHistory: [],
        languageSkills: { german: "", others: [{ id: 4, language: "Englisch", level: "" }] },
      },
    );
    expect(result.values.educationHistory).toEqual([
      {
        from: "1990-09-01",
        to: "1986-06-30",
        institution: "Schule",
        qualification: "Abitur",
        completed: true,
      },
      {
        from: "1990-09-01",
        to: null,
        institution: "Hochschule",
        qualification: "Studium",
        completed: null,
      },
      { from: null, to: "31.13.1990", institution: "", qualification: "", completed: false },
    ]);
    expect(result.values.workHistory).toBeNull();
    expect(result.warnings).toEqual(["educationHistory/0"]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "educationHistory/2/from", code: "required_missing" },
        { path: "educationHistory/2/to", code: "date_invalid" },
        { path: "educationHistory/2/institution", code: "required_missing" },
        { path: "languageSkills/german", code: "required_missing" },
        { path: "languageSkills/others/0/level", code: "required_missing" },
      ]),
    );
    expect(
      pageSubmission(page("work_history", ["workHistory"]), {
        workHistory: [
          { id: 5, from: "01.01.2020", to: "01.01.2019", employer: "A", activity: "B" },
        ],
      }).warnings,
    ).toEqual(["workHistory/0"]);
    expect(
      pageSubmission(page("languages_mobility", ["languageSkills"]), {
        languageSkills: { german: "", others: [] },
      }).values,
    ).toEqual({ languageSkills: null });
  });

  it("checks the contact page like the API does", () => {
    const result = pageSubmission(page("contact", ["address", "phone", "mobile", "privateEmail"]), {
      address: { street: "Musterweg 1", postalCode: "1011", city: "Berlin" },
      phone: "",
      mobile: "0171 3920000",
      privateEmail: "kein-at-zeichen",
    });
    expect(result.values).toEqual({
      address: { street: "Musterweg 1", postalCode: "1011", city: "Berlin", country: "DE" },
      phone: null,
      mobile: "0171 3920000",
      privateEmail: "kein-at-zeichen",
    });
    expect(result.issues).toEqual([
      { path: "address/postalCode", code: "postal_code_invalid" },
      { path: "privateEmail", code: "email_invalid" },
    ]);
    expect(
      pageSubmission(page("contact", ["address"]), {
        address: { street: "", postalCode: "", city: "" },
      }).values,
    ).toEqual({ address: null });
    expect(pageSubmission(page("personal", ["gender"]), { gender: "female" }).values).toEqual({
      gender: "female",
    });
  });

  it("validates custom fields with their compiled field schema", () => {
    expect(
      pageSubmission(customPage(), { "custom.beispiel_nr": "12a", "custom.beispiel_ja": "" }),
    ).toEqual({
      values: { "custom.beispiel_nr": "12a", "custom.beispiel_ja": null },
      issues: [{ path: "custom.beispiel_nr", code: "invalid_format" }],
      warnings: [],
    });
    expect(
      pageSubmission(customPage(), { "custom.beispiel_nr": "", "custom.beispiel_ja": "no" }).values,
    ).toEqual({
      "custom.beispiel_nr": null,
      "custom.beispiel_ja": false,
    });
  });

  it("converts each kind of custom field and leaves an uncompilable schema to the API", () => {
    const meta = {
      "x-dataClass": "confidential",
      "x-retentionClass": "personnel_file",
      "x-label": { de: "x" },
    };
    expect(
      pageSubmission(custom("custom.n", { type: "integer", maximum: 9, ...meta }), {
        "custom.n": "12",
      }).issues,
    ).toEqual([{ path: "custom.n", code: "out_of_range" }]);
    expect(
      pageSubmission(custom("custom.d", { type: "string", format: "date", ...meta }), {
        "custom.d": "29.02.2028",
      }).values,
    ).toEqual({
      "custom.d": "2028-02-29",
    });
    expect(
      pageSubmission(custom("custom.e", { enum: [1, 2], ...meta }), { "custom.e": "2" }).values,
    ).toEqual({
      "custom.e": 2,
    });
    expect(
      pageSubmission(custom("custom.e", { enum: [1, 2], ...meta }), { "custom.e": "" }).values,
    ).toEqual({
      "custom.e": null,
    });
    expect(
      pageSubmission(custom("custom.x", { type: "string", pattern: "(", ...meta }), {
        "custom.x": "a",
      }).issues,
    ).toEqual([]);
  });
});

describe("steps", () => {
  it("starts with the notice until it is acknowledged", () => {
    const state = wizardState({
      notice: { version: "self-service-purposes:v1", acknowledged: false },
    });
    expect(resumeStep(state)).toBe("notice");
    expect(currentStep(state, "contact")).toBe("notice");
  });

  it("resumes at the first page with missing items, else the overview", () => {
    expect(resumeStep(wizardState())).toBe("personal");
    const pages = wizardState().pages.map((p) => ({ ...p, complete: p.page !== "education" }));
    expect(resumeStep(wizardState({ pages }))).toBe("education");
    const sensitiveOpen = wizardState().pages.map((p) => ({ ...p, complete: p.page !== "health" }));
    expect(resumeStep(wizardState({ pages: sensitiveOpen }))).toBe("health");
    const done = wizardState().pages.map((p) => ({ ...p, complete: true }));
    expect(resumeStep(wizardState({ pages: done }))).toBe("overview");
  });

  it("shows a requested page or the overview, and resumes for anything else", () => {
    const state = wizardState();
    expect(currentStep(state, "contact")).toBe("contact");
    expect(currentStep(state, "overview")).toBe("overview");
    expect(currentStep(state, "further")).toBe("personal");
    expect(currentStep(state, undefined)).toBe("personal");
  });

  it("moves through every page in TL 407 order, the special-category page last (Q140)", () => {
    const state = wizardState();
    expect(nextStep(state, "contact")).toBe("ba_details");
    expect(nextStep(state, "ba_details")).toBe("education");
    expect(nextStep(state, "job_wish")).toBe("health");
    expect(nextStep(state, "health")).toBe("overview");
    expect(previousStep(state, "education")).toBe("ba_details");
    expect(previousStep(state, "personal")).toBeUndefined();
    // The progress bar counts the sensitive pages too, by their fields' presence.
    expect(progress(state)).toEqual({ complete: 4, total: 8 });
  });
});

const refused = (status: number, ...errors: { code: string; pointer?: string }[]) =>
  new ApiProblemError({
    type: "urn:x",
    title: "x",
    status,
    errors: errors.map((e) => ({ ...e, detail: "x" })),
  });

describe("refusals", () => {
  it("maps the API's problems", () => {
    expect(failureOf(refused(401))).toEqual({ kind: "expired" });
    // Staff whose assisted mode ended (ADR-0007, assisted mode).
    expect(failureOf(refused(403, { code: "assisted_mode_required" }))).toEqual({
      kind: "expired",
    });
    expect(failureOf(refused(403, { code: "other" }))).toEqual({ kind: "failed" });
    expect(failureOf(refused(409, { code: "stale_revision", pointer: "" }))).toEqual({
      kind: "stale",
    });
    expect(failureOf(refused(409, { code: "notice_required" }))).toEqual({
      kind: "notice_required",
    });
    expect(failureOf(refused(409))).toEqual({ kind: "failed" });
    expect(failureOf(refused(422, { code: "participation_closed", pointer: "" }))).toEqual({
      kind: "closed",
    });
    expect(
      failureOf(
        refused(422, { code: "too_long", pointer: "/values/jobWishes/desired" }, { code: "x" }),
      ),
    ).toEqual({
      kind: "invalid",
      issues: [
        { path: "jobWishes/desired", code: "too_long" },
        { path: "", code: "x" },
      ],
    });
    expect(failureOf(new Error("network"))).toEqual({ kind: "failed" });
    expect(failureOf(refused(500))).toEqual({ kind: "failed" });
  });
});
