import { describe, expect, it } from "vitest";
import {
  DrivingLicenceClass,
  rowLimits,
  selfServiceValueSchemas as schemas,
  text,
  valueIssueCode,
  valueWarnings,
} from "./values";

const codes = (schema: { safeParse: (v: unknown) => { error?: { issues: unknown[] } } }) => {
  return (value: unknown) =>
    (schema.safeParse(value).error?.issues ?? []).map((issue) =>
      valueIssueCode(issue as Parameters<typeof valueIssueCode>[0]),
    );
};

const education = {
  from: "2005-09-01",
  to: "2008-07-15",
  institution: "Berufsschule Beispielstadt",
  qualification: "Industriemechaniker",
  completed: true,
};
const work = { from: "2023-01-01", to: null, employer: "Beispiel GmbH", activity: "Monteur" };

describe("the TL 407 08/2025 value sets", () => {
  it.each([
    ["gender", ["male", "female", "diverse", "not_specified"], "other"],
    ["maritalStatus", ["single", "married"], "divorced"],
  ] as const)("%s", (field, valid, invalid) => {
    for (const value of valid) expect(schemas[field].parse(value)).toBe(value);
    expect(codes(schemas[field])(invalid)).toEqual(["value_not_allowed"]);
  });

  it("knows the EU driving licence classes, or none", () => {
    expect(DrivingLicenceClass.options).toEqual([
      "AM",
      "A1",
      "A2",
      "A",
      "B",
      "BE",
      "C1",
      "C1E",
      "C",
      "CE",
      "D1",
      "D1E",
      "D",
      "DE",
      "L",
      "T",
    ]);
    expect(schemas.drivingLicence.parse("none")).toBe("none");
    expect(schemas.drivingLicence.parse(["B", "BE"])).toEqual(["B", "BE"]);
    const check = codes(schemas.drivingLicence);
    expect(check(["B", "B"])).toEqual(["duplicate_value"]);
    expect(check(["X"])).toEqual(["value_not_allowed"]);
    expect(check([])).toEqual(["required_missing"]);
  });

  it("puts German first and bounds the further languages", () => {
    const skills = {
      german: "business_fluent",
      others: [{ language: "Englisch", level: "extended" }],
    };
    expect(schemas.languageSkills.parse(skills)).toEqual(skills);
    const others = Array.from({ length: rowLimits.languages }, () => skills.others[0]);
    expect(codes(schemas.languageSkills)({ german: "basic", others })).toEqual(["too_many_rows"]);
    expect(codes(schemas.languageSkills)({ others: [] })).toEqual(["value_not_allowed"]);
  });

  it("takes the working time pair of fields 44 and 45", () => {
    const value = { employmentType: "part_time", weeklyHours: 20, distribution: "vormittags" };
    expect(schemas.workingTimePreferences.parse(value)).toEqual(value);
    expect(
      codes(schemas.workingTimePreferences)({ ...value, weeklyHours: 61, distribution: null }),
    ).toEqual(["out_of_range"]);
  });

  it("takes the desired job and an alternative", () => {
    expect(schemas.jobWishes.parse({ desired: " Monteur ", alternative: null })).toEqual({
      desired: "Monteur",
      alternative: null,
    });
    expect(codes(schemas.jobWishes)({ desired: "", alternative: null })).toEqual([
      "required_missing",
    ]);
  });

  it("takes a distance in km, nationwide or international", () => {
    expect(schemas.maxCommuteDistance.parse({ kind: "km", km: 50 })).toEqual({
      kind: "km",
      km: 50,
    });
    expect(schemas.maxCommuteDistance.parse({ kind: "nationwide" })).toEqual({
      kind: "nationwide",
    });
    expect(codes(schemas.maxCommuteDistance)({ kind: "km", km: 0 })).toEqual(["out_of_range"]);
    expect(codes(schemas.maxCommuteDistance)({ kind: "km", km: 1.5 })).toEqual(["invalid_type"]);
  });

  it("refuses an impossible date and dates other than ISO", () => {
    expect(schemas.earliestStartDate.parse("2027-02-28")).toBe("2027-02-28");
    expect(codes(schemas.earliestStartDate)("2027-02-29")).toEqual(["invalid_date"]);
    expect(codes(schemas.earliestStartDate)("14.03.1998")).toEqual(["invalid_date"]);
    expect(codes(schemas.educationHistory)([{ ...education, from: "1998-14-03" }])).toEqual([
      "invalid_date",
    ]);
  });

  it("bounds the row tables at 20 rows and needs one", () => {
    expect(schemas.educationHistory.parse([education])).toEqual([education]);
    const many = Array.from({ length: rowLimits.educationHistory + 1 }, () => work);
    expect(codes(schemas.workHistory)(many)).toEqual(["too_many_rows"]);
    expect(codes(schemas.workHistory)([])).toEqual(["required_missing"]);
  });

  it("checks contact values as the tables hold them", () => {
    const address = { street: "Musterweg 1", postalCode: "12345", city: "Beispielstadt" };
    expect(schemas.address.parse({ ...address, country: "DE" })).toEqual({
      ...address,
      country: "DE",
    });
    expect(codes(schemas.address)({ ...address, postalCode: "1234", country: "AT" })).toEqual([
      "postal_code_invalid",
      "value_not_allowed",
    ]);
    expect(schemas.mobile.parse(" +49 170 1234567 ")).toBe("+49 170 1234567");
    expect(codes(schemas.phone)("abc")).toEqual(["phone_invalid"]);
    expect(codes(schemas.privateEmail)("not-an-email")).toEqual(["email_invalid"]);
  });

  it("refuses long text, control characters and unknown keys, with codes only", () => {
    expect(codes(text(5))("abcdef")).toEqual(["too_long"]);
    expect(codes(text(5))("a\u0007b")).toEqual(["control_characters"]);
    expect(codes(schemas.desiredWorkLocations)("x".repeat(501))).toEqual(["too_long"]);
    expect(codes(schemas.jobWishes)({ desired: "x", alternative: null, salary: 1 })).toEqual([
      "unknown_field",
    ]);
    expect(codes(schemas.vehicleAvailable)("yes")).toEqual(["invalid_type"]);
  });
});

describe("valueWarnings", () => {
  it("warns of von > bis per row, by path", () => {
    expect(
      valueWarnings({
        educationHistory: [education, { ...education, from: "2009-01-01", to: "2008-12-31" }],
        workHistory: [{ ...work, to: "2022-12-31" }],
      }),
    ).toEqual([
      { code: "from_after_to", path: ["educationHistory", 1] },
      { code: "from_after_to", path: ["workHistory", 0] },
    ]);
  });

  it("has nothing to say about open, equal or empty rows", () => {
    expect(
      valueWarnings({
        educationHistory: [{ ...education, to: education.from }],
        workHistory: null,
      }),
    ).toEqual([]);
  });
});
