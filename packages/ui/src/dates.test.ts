import { describe, expect, it } from "vitest";
import { formatDate, formatTimestamp, parseDisplayDate } from "./dates";

describe("formatDate", () => {
  it("shows an ISO date as TT.MM.JJJJ", () => {
    expect(formatDate("2028-02-29")).toBe("29.02.2028");
  });

  it("shows nothing for a missing date", () => {
    expect(formatDate(null)).toBe("");
  });
});

describe("parseDisplayDate", () => {
  it.each([
    ["01.03.2027", "2027-03-01"],
    ["1.3.2027", "2027-03-01"],
    [" 29.02.2028 ", "2028-02-29"],
  ])("parses %j as %s", (text, iso) => {
    expect(parseDisplayDate(text)).toEqual({ ok: true, value: iso });
  });

  it("treats an empty field as no date", () => {
    expect(parseDisplayDate("  ")).toEqual({ ok: true, value: undefined });
  });

  it.each(["31.02.2027", "29.02.2027", "03.14.1998", "2027-03-01", "1.3.27", "01.03.2027x"])(
    "rejects %j",
    (text) => {
      expect(parseDisplayDate(text)).toEqual({ ok: false });
    },
  );
});

describe("formatTimestamp", () => {
  it("shows a UTC timestamp in Europe/Berlin", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Berlin (UTC+1 in winter).
    expect(formatTimestamp("2026-12-31T23:30:00Z")).toBe("01.01.2027, 00:30");
    // Summer time: UTC+2.
    expect(formatTimestamp("2026-07-01T10:00:00.123456Z")).toBe("01.07.2026, 12:00");
  });
});
