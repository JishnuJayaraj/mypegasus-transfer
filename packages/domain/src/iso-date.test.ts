import { describe, expect, it } from "vitest";
import { isoDate, isValidIsoDate } from "./iso-date";

describe("isValidIsoDate", () => {
  it.each(["2026-10-15", "2028-02-29", "2000-02-29", "2027-12-31", "2027-01-01", "2027-04-30"])(
    "accepts the real calendar date %s",
    (value) => {
      expect(isValidIsoDate(value)).toBe(true);
    },
  );

  it.each([
    ["2027-02-29", "29 February in a common year"],
    ["1900-02-29", "29 February in a century year that is not a leap year"],
    ["2027-02-31", "31 February"],
    ["2027-04-31", "31 April"],
    ["2026-14-03", "month 14"],
    ["2026-00-10", "month 0"],
    ["2026-10-00", "day 0"],
    ["2026-10-32", "day 32"],
  ])("rejects the impossible date %s (%s)", (value) => {
    expect(isValidIsoDate(value)).toBe(false);
  });

  it.each([
    ["", "empty"],
    ["03.14.1998", "German display format"],
    ["15.10.2026", "TT.MM.JJJJ is a display format, not the wire format"],
    ["2026-1-5", "missing zero padding"],
    ["20261015", "no separators"],
    ["2026-10-15T00:00:00Z", "a timestamp, not a date"],
    [" 2026-10-15", "leading whitespace"],
    ["+02026-10-15", "expanded year"],
  ])("rejects the malformed value %j (%s)", (value) => {
    expect(isValidIsoDate(value)).toBe(false);
  });
});

describe("isoDate schema", () => {
  it("accepts and returns a valid date unchanged", () => {
    expect(isoDate.parse("2028-02-29")).toBe("2028-02-29");
  });

  it.each(["2027-02-29", "2026-14-03", "03.14.1998"])("rejects %s with one issue", (value) => {
    const result = isoDate.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
  });

  it("marks an impossible date with the invalid_date code", () => {
    const issue = isoDate.safeParse("2027-02-31").error?.issues[0];
    expect((issue as { params?: { code?: string } }).params?.code).toBe("invalid_date");
  });

  it("rejects non-strings", () => {
    expect(isoDate.safeParse(20261015).success).toBe(false);
    expect(isoDate.safeParse(new Date("2026-10-15")).success).toBe(false);
  });
});
