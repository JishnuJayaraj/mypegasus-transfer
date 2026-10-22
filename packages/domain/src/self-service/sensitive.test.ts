import { describe, expect, it } from "vitest";
import {
  completeSensitiveValues,
  countryCodes,
  groupNeedsStepUp,
  ResidenceStatus,
  sensitiveFields,
  sensitiveFieldsOf,
  sensitiveValueSchemas as schemas,
  sensitiveValuesSchema,
} from "./sensitive";
import { valueIssueCode } from "./values";

const codes = (schema: { safeParse: (v: unknown) => { error?: { issues: unknown[] } } }) => {
  return (value: unknown) =>
    (schema.safeParse(value).error?.issues ?? []).map((issue) =>
      valueIssueCode(issue as Parameters<typeof valueIssueCode>[0]),
    );
};
const issues = (group: "ba_details" | "health", values: unknown) =>
  (sensitiveValuesSchema(group).safeParse(values).error?.issues ?? []).map((issue) => ({
    code: valueIssueCode(issue),
    path: issue.path,
  }));

describe("the sensitive groups (data-protection.md, self-service)", () => {
  it("are the two sensitive wizard pages with their fields", () => {
    expect(sensitiveFieldsOf("ba_details")).toEqual([
      "pensionInsuranceNumber",
      "nationality",
      "entryToGermanyDate",
      "residenceStatus",
      "buergergeld",
    ]);
    expect(sensitiveFieldsOf("health")).toEqual(["healthRestrictions", "severeDisability"]);
    expect(sensitiveFields).toEqual([
      ...sensitiveFieldsOf("ba_details"),
      ...sensitiveFieldsOf("health"),
    ]);
  });

  it("gate only the special-category page behind the step-up (Q137)", () => {
    expect(groupNeedsStepUp("health")).toBe(true);
    expect(groupNeedsStepUp("ba_details")).toBe(false);
  });
});

describe("the TL 407 value sets of the sensitive fields", () => {
  it("takes the RV-Nummer in its 12-character format, never a value in the code", () => {
    expect(schemas.pensionInsuranceNumber.parse("65170839J003")).toBe("65170839J003");
    const check = codes(schemas.pensionInsuranceNumber);
    for (const bad of ["65170839j003", "65 170839 J 003", "6517083J0003", "65170839J0031", ""]) {
      expect(check(bad)).toEqual(["pension_insurance_number_invalid"]);
    }
  });

  it("takes the nationality as German or another ISO 3166-1 alpha-2 country", () => {
    expect(schemas.nationality.parse({ kind: "german" })).toEqual({ kind: "german" });
    expect(schemas.nationality.parse({ kind: "other", country: "PL" })).toEqual({
      kind: "other",
      country: "PL",
    });
    const check = codes(schemas.nationality);
    expect(check({ kind: "other", country: "DE" })).toEqual(["value_not_allowed"]);
    expect(check({ kind: "other", country: "XX" })).toEqual(["value_not_allowed"]);
    expect(check({ kind: "other", country: "pl" })).toEqual(["value_not_allowed"]);
    expect(check({ kind: "german", country: "PL" })).toEqual(["unknown_field"]);
    expect(check("german")).toEqual(["invalid_type"]);
  });

  it("knows the officially assigned country codes", () => {
    expect(countryCodes).toHaveLength(249);
    expect(new Set(countryCodes).size).toBe(249);
    expect(countryCodes).toEqual(countryCodes.toSorted());
    expect(countryCodes).toEqual(expect.arrayContaining(["DE", "AT", "PL", "TR", "UA", "SY"]));
  });

  it("takes the residence statuses of the form", () => {
    expect(ResidenceStatus.options).toEqual([
      "blue_card",
      "residence_permit",
      "visa",
      "settlement_permit",
      "permission_to_reside",
      "toleration",
    ]);
    expect(codes(schemas.residenceStatus)("asylum")).toEqual(["value_not_allowed"]);
  });

  it("takes an ISO entry date, refusing an impossible one", () => {
    expect(schemas.entryToGermanyDate.parse("2015-09-05")).toBe("2015-09-05");
    expect(codes(schemas.entryToGermanyDate)("2015-02-30")).toHaveLength(1);
  });

  it.each(["buergergeld", "healthRestrictions", "severeDisability"] as const)(
    "takes %s as yes/no only",
    (field) => {
      expect(schemas[field].parse(true)).toBe(true);
      expect(schemas[field].parse(false)).toBe(false);
      expect(codes(schemas[field])("Rückenleiden")).toEqual(["invalid_type"]);
    },
  );
});

describe("a group write", () => {
  const baDetails = {
    pensionInsuranceNumber: "65170839J003",
    nationality: { kind: "other", country: "PL" },
    entryToGermanyDate: "2015-09-05",
    residenceStatus: "settlement_permit",
    buergergeld: false,
  };

  it("takes the group's fields, null or absent for empty", () => {
    expect(issues("ba_details", baDetails)).toEqual([]);
    expect(issues("ba_details", {})).toEqual([]);
    expect(issues("health", { healthRestrictions: null, severeDisability: true })).toEqual([]);
  });

  it("refuses another group's or an unknown key, so nothing passes into the wrong table", () => {
    expect(issues("ba_details", { healthRestrictions: true })).toEqual([
      { code: "unknown_field", path: [] },
    ]);
    expect(issues("health", { gender: "male" })).toEqual([{ code: "unknown_field", path: [] }]);
  });

  it("takes entry date and residence status only with another nationality, never required", () => {
    expect(issues("ba_details", { nationality: { kind: "other", country: "PL" } })).toEqual([]);
    for (const nationality of [{ kind: "german" }, null, undefined]) {
      expect(
        issues("ba_details", {
          nationality,
          entryToGermanyDate: "2015-09-05",
          residenceStatus: "visa",
        }),
      ).toEqual([
        { code: "not_applicable", path: ["entryToGermanyDate"] },
        { code: "not_applicable", path: ["residenceStatus"] },
      ]);
    }
  });

  it("is completed with null for every field of the group", () => {
    expect(completeSensitiveValues("health", { severeDisability: false })).toEqual({
      healthRestrictions: null,
      severeDisability: false,
    });
    expect(completeSensitiveValues("ba_details", baDetails)).toEqual(baDetails);
  });

  it("takes only the fields a role sees in assisted mode (Q136)", () => {
    const disability = ["severeDisability"] as const;
    expect(
      sensitiveValuesSchema("health", disability).safeParse({ severeDisability: true }),
    ).toEqual({ success: true, data: { severeDisability: true } });
    expect(
      sensitiveValuesSchema("health", disability).safeParse({ healthRestrictions: true }).success,
    ).toBe(false);
    expect(completeSensitiveValues("health", {}, disability)).toEqual({ severeDisability: null });
  });
});
