import { describe, expect, it } from "vitest";
import { addDays, addMonths, asuDueDate, compareIsoDates, laterIsoDate } from "./dates";

describe("addDays", () => {
  it.each([
    ["2027-01-31", 1, "2027-02-01"],
    ["2027-02-28", 1, "2027-03-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2028-02-29", 1, "2028-03-01"],
    ["2027-12-31", 1, "2028-01-01"],
    ["2027-03-01", -1, "2027-02-28"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2027-01-01", -1, "2026-12-31"],
    ["2027-01-01", 0, "2027-01-01"],
    ["2027-01-01", 365, "2028-01-01"],
    ["2028-01-01", 366, "2029-01-01"],
    ["2099-12-31", 1, "2100-01-01"],
    ["2100-02-28", 1, "2100-03-01"],
  ])("%s %+d days = %s", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it("rejects an impossible date, a fractional day count and a result after 9999", () => {
    expect(() => addDays("2027-02-29", 1)).toThrow(RangeError);
    expect(() => addDays("2027-01-01", 0.5)).toThrow(RangeError);
    expect(() => addDays("9999-12-31", 1)).toThrow(RangeError);
  });
});

describe("addMonths (month end clamped)", () => {
  it.each([
    ["2027-01-15", 1, "2027-02-15"],
    ["2027-01-31", 1, "2027-02-28"],
    ["2028-01-31", 1, "2028-02-29"],
    ["2027-03-31", 1, "2027-04-30"],
    ["2027-12-31", 1, "2028-01-31"],
    ["2027-11-30", 3, "2028-02-29"],
    // the docs' examples (process-and-lifecycle.md, Dates)
    ["2027-05-31", -3, "2027-02-28"],
    ["2028-05-31", -3, "2028-02-29"],
    ["2027-12-31", -3, "2027-09-30"],
    ["2027-03-31", -1, "2027-02-28"],
    ["2027-01-15", -1, "2026-12-15"],
    ["2027-02-28", -12, "2026-02-28"],
    ["2028-02-29", 12, "2029-02-28"],
    ["2027-06-30", 0, "2027-06-30"],
  ])("%s %+d months = %s", (date, months, expected) => {
    expect(addMonths(date, months)).toBe(expected);
  });

  it("rejects an impossible date and a fractional month count", () => {
    expect(() => addMonths("2027-04-31", 1)).toThrow(RangeError);
    expect(() => addMonths("2027-01-01", 1.5)).toThrow(RangeError);
  });
});

describe("comparing", () => {
  it("orders ISO dates", () => {
    expect(compareIsoDates("2027-01-01", "2027-01-02")).toBeLessThan(0);
    expect(compareIsoDates("2027-01-02", "2027-01-01")).toBeGreaterThan(0);
    expect(compareIsoDates("2027-01-01", "2027-01-01")).toBe(0);
    expect(laterIsoDate("2027-03-01", "2026-12-31")).toBe("2027-03-01");
    expect(laterIsoDate("2026-12-31", "2027-03-01")).toBe("2027-03-01");
  });
});

// verify Q1: asuDueDate = max(endDate − 3 months, knowledgeDate + 3 days)
describe("asuDueDate (verify Q1)", () => {
  it.each([
    ["early knowledge: 3 months before the end", "2027-06-30", "2027-01-10", "2027-03-30"],
    ["late knowledge: 3 days after it", "2027-06-30", "2027-05-20", "2027-05-23"],
    ["both on the same day", "2027-06-30", "2027-03-27", "2027-03-30"],
    ["month end clamped", "2027-05-31", "2027-01-04", "2027-02-28"],
    ["month end clamped, leap year", "2028-05-31", "2028-01-04", "2028-02-29"],
    ["31.12. gives 30.09.", "2027-12-31", "2027-06-01", "2027-09-30"],
    ["knowledge across the year end", "2027-01-15", "2026-12-30", "2027-01-02"],
    ["knowledge after the end", "2027-03-31", "2027-04-02", "2027-04-05"],
  ])("%s", (_, endDate, knowledgeDate, expected) => {
    expect(asuDueDate({ endDate, knowledgeDate })).toBe(expected);
  });

  it("takes the formula's parameters as data (base defaults, plan 5.7)", () => {
    const params = { monthsBeforeEnd: 2, daysAfterKnowledge: 7 };
    expect(asuDueDate({ endDate: "2027-06-30", knowledgeDate: "2027-01-10" }, params)).toBe(
      "2027-04-30",
    );
  });
});
