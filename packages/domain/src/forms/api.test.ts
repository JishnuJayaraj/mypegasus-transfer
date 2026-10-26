import { describe, expect, it } from "vitest";
import { Tl407GenerationInput, Tl407Readiness, Tl407ReadinessSummary } from "./api";

describe("the TL 407 generation API (ADR-0010)", () => {
  it("takes each confirmation by its code, once", () => {
    expect(
      Tl407GenerationInput.safeParse({ confirmWarnings: ["school_qualification_none"] }).success,
    ).toBe(true);
    for (const confirmWarnings of [["unknown"], ["range_reversed", "range_reversed"]]) {
      expect(Tl407GenerationInput.safeParse({ confirmWarnings }).success).toBe(false);
    }
    expect(Tl407GenerationInput.safeParse({}).success).toBe(false);
  });

  it("gives the PL's summary no warning and no overflow property (data-protection.md)", () => {
    const summary = { view: "project_lead", ready: true, missing: [] };
    expect(Tl407ReadinessSummary.safeParse(summary).success).toBe(true);
    for (const extra of [{ warnings: [] }, { overflow: [] }, { errors: [] }]) {
      expect(Tl407ReadinessSummary.safeParse({ ...summary, ...extra }).success).toBe(false);
      expect(Tl407Readiness.safeParse({ ...summary, ...extra }).success).toBe(false);
    }
  });
});
