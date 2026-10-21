import {
  DrivingLicenceClass,
  EmploymentType,
  Gender,
  LanguageLevel,
  MaritalStatus,
  SelfServicePage,
  wizardPages,
} from "@transfer/domain";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import de from "./locales/de.json";
import en from "./locales/en.json";

// The wizard's catalogs: de and en have the same keys, every key the code names exists, and every
// page, catalog field and value the domain offers has its text (UI text through i18n only).

function flatten(object: object, prefix = ""): string[] {
  return Object.entries(object).flatMap(([key, value]) =>
    typeof value === "object" ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

const keys = flatten(de);
// i18next plurals: `overview.missing` is `overview.missing_one` and `_other`.
const has = (key: string) => keys.includes(key) || keys.includes(`${key}_other`);

const used = readdirSync(import.meta.dirname, { withFileTypes: true })
  .filter((entry) => /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
  .flatMap((entry) =>
    [
      ...readFileSync(join(import.meta.dirname, entry.name), "utf8").matchAll(/\bt\("([^"]+)"/g),
    ].map((match) => match[1]!),
  );

const values = (catalog: object): unknown[] =>
  Object.values(catalog).flatMap((v) => (typeof v === "object" ? values(v) : [v]));

describe("self-service catalogs", () => {
  it("have identical key sets in de and en", () => {
    expect(flatten(en).toSorted()).toEqual(keys.toSorted());
  });

  it("have every key the code uses", () => {
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((key) => !has(key))).toEqual([]);
  });

  it("name every page, catalog field and offered value", () => {
    const expected = [
      ...SelfServicePage.options.map((page) => `pages.${page}`),
      ...wizardPages.flatMap(({ fields }) => fields.map((field) => `fields.${field}.label`)),
      ...Gender.options.map((value) => `fields.gender.${value}`),
      ...MaritalStatus.options.map((value) => `fields.maritalStatus.${value}`),
      ...LanguageLevel.options.map((value) => `fields.languageSkills.${value}`),
      ...EmploymentType.options.map((value) => `fields.workingTimePreferences.${value}`),
      ...["km", "nationwide", "international"].map((kind) => `fields.maxCommuteDistance.${kind}`),
    ];
    expect(expected.filter((key) => !has(key))).toEqual([]);
    // The licence classes are their EU codes, the same in every language.
    expect(DrivingLicenceClass.options).toContain("BE");
  });

  it("have no empty texts", () => {
    expect(values(de).filter((v) => v === "")).toEqual([]);
    expect(values(en).filter((v) => v === "")).toEqual([]);
  });
});
