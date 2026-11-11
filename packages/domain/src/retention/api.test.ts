import { describe, expect, it } from "vitest";
import { FundingRequest, SettlementDatesRequest } from "./api";

describe("retention's API inputs", () => {
  const expected = { funded110: "unknown", source: null } as const;

  it("takes a trimmed source without control characters", () => {
    expect(
      FundingRequest.safeParse({ funded110: "known_yes", source: "Bescheid 1", expected }).success,
    ).toBe(true);
    for (const source of ["", " Bescheid", "Bescheid\u0007", "x".repeat(201)]) {
      expect(FundingRequest.safeParse({ funded110: "known_yes", source, expected }).success).toBe(
        false,
      );
    }
  });

  it("takes real dates or null, and the dates as read", () => {
    const dates = { kugFinalSettlementDate: "2027-06-30", measure110SettlementDate: null };
    expect(SettlementDatesRequest.safeParse({ ...dates, expected: dates }).success).toBe(true);
    expect(
      SettlementDatesRequest.safeParse({
        ...dates,
        kugFinalSettlementDate: "2027-02-30",
        expected: dates,
      }).success,
    ).toBe(false);
  });
});
