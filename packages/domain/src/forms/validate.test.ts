import { describe, expect, it } from "vitest";
import type { FormInput } from "./input";
import { testMap } from "./testing/maps";
import { validateFormInput } from "./validate";

const today = "2091-03-01";
const valid: FormInput = {
  formCode: "tl407",
  projectType: "ta_tg",
  values: {
    tg: true,
    firstName: "Łucja",
    lastName: "Doğan",
    birthDate: "2051-07-29",
    beeFrom: "2091-04-01",
    beeTo: "2092-03-31",
    rvNumber: "12290751D123",
    gender: "female",
    scope: "nationwide",
  },
  tables: { work: [{ from: "2090-01-01", to: null }] },
};
const check = (change: Partial<FormInput> & { values?: FormInput["values"] }) =>
  validateFormInput({ ...valid, ...change }, testMap, today);
const withValues = (values: FormInput["values"]) =>
  check({ values: { ...valid.values, ...values } });
const at = (birthDate: string, beeFrom: string | null = "2091-04-01") =>
  withValues({ birthDate, beeFrom }).warnings.map(({ code }) => code);

describe("validateFormInput (ba-forms.md, validation before rendering)", () => {
  it("accepts a complete input", () => {
    expect(check({})).toEqual({ errors: [], warnings: [], blanks: [] });
  });

  it("requires the beE dates in ta_tg and neither requires nor allows them in ta_only (Q181)", () => {
    expect(withValues({ beeFrom: null, beeTo: "" }).errors).toEqual([
      { code: "required_missing", key: "beeFrom" },
      { code: "required_missing", key: "beeTo" },
    ]);
    const taOnly = { projectType: "ta_only" as const, values: { ...valid.values, tg: false } };
    expect(check({ ...taOnly, values: { ...taOnly.values, beeFrom: null, beeTo: null } })).toEqual({
      errors: [],
      warnings: [],
      blanks: [],
    });
    expect(check(taOnly).errors).toEqual([
      { code: "value_not_applicable", key: "beeFrom" },
      { code: "value_not_applicable", key: "beeTo" },
    ]);
  });

  it("refuses an identifier longer than its field, never cutting it (Q180)", () => {
    expect(withValues({ rvNumber: "12290751D1234" }).errors).toEqual([
      { code: "identifier_too_long", key: "rvNumber" },
    ]);
  });

  it("refuses impossible dates and times: 29.02. only in a leap year, no month 14", () => {
    expect(withValues({ birthDate: "2052-02-29" }).errors).toEqual([]);
    expect(withValues({ birthDate: "2051-02-29" }).errors).toEqual([
      { code: "date_invalid", key: "birthDate" },
    ]);
    expect(withValues({ birthDate: "1998-14-03" }).errors).toEqual([
      { code: "date_invalid", key: "birthDate" },
    ]);
    expect(withValues({ start: "24:00" }).errors).toEqual([{ code: "time_invalid", key: "start" }]);
  });

  it("refuses a session whose end isn't after its start, equal included", () => {
    const sessions = [
      { date: "2091-02-20", from: "09:00", to: "09:01" },
      { date: "2091-02-21", from: "09:00", to: "09:00" },
      { date: "2091-02-22", from: "10:00", to: "09:00" },
      { date: "2091-02-23", from: "9:00", to: "10:00" },
      { date: "2091-02-24", from: null, to: "10:00" },
    ];
    expect(check({ tables: { ...valid.tables, sessions } }).errors).toEqual([
      { code: "time_range_reversed", key: "sessions.to", row: 1 },
      { code: "time_range_reversed", key: "sessions.to", row: 2 },
      { code: "time_invalid", key: "sessions.from", row: 3 },
    ]);
  });

  it("refuses unknown keys, wrong kinds, unknown options and unprintable characters", () => {
    expect(
      withValues({
        nope: "x",
        tg: "yes",
        gender: true,
        attached: "maybe",
        birthDate: false,
        start: 9,
        firstName: "Иван",
        lastName: 1,
      } as unknown as FormInput["values"]).errors,
    ).toEqual([
      { code: "value_kind_invalid", key: "tg" },
      { code: "character_unsupported", key: "firstName" },
      { code: "value_kind_invalid", key: "lastName" },
      { code: "value_kind_invalid", key: "birthDate" },
      { code: "value_kind_invalid", key: "gender" },
      { code: "unknown_key", key: "nope" },
      { code: "option_invalid", key: "attached" },
      { code: "value_kind_invalid", key: "start" },
      { code: "required_missing", key: "birthDate" },
    ]);
    expect(
      check({ tables: { work: [{ from: "2090-01-01", to: null, extra: "x" }], other: [] } }).errors,
    ).toEqual([
      { code: "unknown_key", key: "work.extra", row: 0 },
      { code: "unknown_key", key: "other" },
    ]);
  });

  it("requires one field of a group and a required table", () => {
    expect(check({ values: { ...valid.values, scope: null }, tables: {} }).errors).toEqual([
      { code: "required_missing", key: "distance" },
      { code: "required_missing", key: "work" },
    ]);
    expect(withValues({ scope: null, km: "50" }).errors).toEqual([]);
  });

  it("lists missing required fields as blanks on a form completed by hand", () => {
    const handwritten = { ...testMap, missingRequired: "blank" as const };
    expect(
      validateFormInput(
        { ...valid, values: { ...valid.values, lastName: null } },
        handwritten,
        today,
      ),
    ).toEqual({ errors: [], warnings: [], blanks: [{ code: "required_blank", key: "lastName" }] });
  });

  it("warns on an age outside 15–67 at the TG start, at 15 and 67 exactly not", () => {
    expect(at("2076-04-01")).toEqual([]);
    expect(at("2076-04-02")).toEqual(["age_implausible"]);
    expect(at("2023-04-02")).toEqual([]);
    expect(at("2023-04-01")).toEqual(["age_implausible"]);
    // without a TG start, at today
    expect(at("2076-03-01", null)).toEqual([]);
    expect(at("2076-03-02", null)).toEqual(["age_implausible"]);
  });

  it("warns on entry before birth and on a date range with von > bis, equal dates not", () => {
    expect(withValues({ entryDate: "2051-07-28" }).warnings).toEqual([
      { code: "entry_before_birth", key: "entryDate" },
    ]);
    expect(withValues({ entryDate: "2051-07-29" }).warnings).toEqual([]);
    expect(withValues({ beeTo: "2091-03-31" }).warnings).toEqual([
      { code: "range_reversed", key: "beeTo" },
    ]);
    expect(withValues({ beeTo: "2091-04-01" }).warnings).toEqual([]);
    const work = [
      { from: "2090-01-02", to: "2090-01-01" },
      { from: "2090-01-01", to: "2090-01-01" },
    ];
    expect(check({ tables: { work } }).warnings).toEqual([
      { code: "range_reversed", key: "work.to", row: 0 },
    ]);
  });

  it("checks no plausibility without a valid birth date or a map without it", () => {
    expect(withValues({ birthDate: null }).warnings).toEqual([]);
    const { plausibility: _, ...withoutPlausibility } = testMap;
    expect(
      validateFormInput(
        { ...valid, values: { ...valid.values, beeTo: "2091-01-01" } },
        withoutPlausibility,
        today,
      ).warnings,
    ).toEqual([{ code: "range_reversed", key: "beeTo" }]);
    const noEntry = { ...testMap, plausibility: { birthDate: "birthDate" } };
    expect(
      validateFormInput(
        { ...valid, values: { ...valid.values, entryDate: "2000-01-01" } },
        noEntry,
        today,
      ).warnings,
    ).toEqual([]);
  });

  it("refuses an input for another form", () => {
    expect(() => validateFormInput({ ...valid, formCode: "kug200b" }, testMap, today)).toThrow(
      RangeError,
    );
  });
});
