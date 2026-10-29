import { describe, expect, it } from "vitest";
import {
  Kug200bBulkInput,
  kug200bBulkMax,
  Tl407GenerationInput,
  Tl407Readiness,
  Tl407ReadinessSummary,
} from "./api";

describe("the TL 407 generation API (ADR-0010)", () => {
  it("takes the readiness's source token and each confirmation by its code, once", () => {
    const sourceToken = "0".repeat(64);
    expect(
      Tl407GenerationInput.safeParse({
        sourceToken,
        confirmWarnings: ["school_qualification_none"],
      }).success,
    ).toBe(true);
    for (const confirmWarnings of [["unknown"], ["range_reversed", "range_reversed"]]) {
      expect(Tl407GenerationInput.safeParse({ sourceToken, confirmWarnings }).success).toBe(false);
    }
    // Without the token, the confirmations would apply to whatever the sources are now.
    expect(Tl407GenerationInput.safeParse({ confirmWarnings: [] }).success).toBe(false);
    expect(Tl407GenerationInput.safeParse({ sourceToken: "x", confirmWarnings: [] }).success).toBe(
      false,
    );
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

const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

describe("Kug200bBulkInput (Q179)", () => {
  it("takes 1–100 participations, each once", () => {
    expect(Kug200bBulkInput.safeParse({ participationIds: [id(1), id(2)] }).success).toBe(true);
    expect(Kug200bBulkInput.safeParse({ participationIds: [] }).success).toBe(false);
    expect(Kug200bBulkInput.safeParse({ participationIds: [id(1), id(1)] }).success).toBe(false);
    const many = Array.from({ length: kug200bBulkMax + 1 }, (_, n) => id(n));
    expect(Kug200bBulkInput.safeParse({ participationIds: many }).success).toBe(false);
  });
});
