import { describe, expect, it } from "vitest";
import { formVersionInUse, FormVersionManifest, isFormVersionInUse } from "./version";

const manifest = {
  formCode: "tl407",
  version: "08-2025",
  validFrom: null,
  validUntil: null,
  validitySource: null,
  sha256: "d17a8087b5fba1803a491c66987b00b7cd73b25ba91f540f18f1482022b50968",
};
const codes = (value: object) => {
  const result = FormVersionManifest.safeParse({ ...manifest, ...value });
  return result.success
    ? []
    : result.error.issues.map(
        (issue) => (issue as { params?: { code?: string } }).params?.code ?? issue.code,
      );
};

describe("FormVersionManifest (ADR-0009; Q188)", () => {
  it("takes effective dates only with the source that reviewed them", () => {
    expect(codes({})).toEqual([]);
    expect(codes({ validUntil: "2026-12-31" })).toEqual(["validity_source"]);
    expect(codes({ validitySource: "BA download page" })).toEqual(["validity_source"]);
    expect(
      codes({
        validFrom: "2025-08-01",
        validUntil: "2026-12-31",
        validitySource: "BA download page",
      }),
    ).toEqual([]);
    expect(
      codes({ validFrom: "2027-01-01", validUntil: "2026-12-31", validitySource: "x" }),
    ).toEqual(["range_reversed"]);
    expect(codes({ version: "8/2025" })).toEqual(["invalid_format"]);
  });
});

describe("formVersionInUse (regional-variation.md, forms are versioned)", () => {
  const old = {
    formCode: "tl407" as const,
    version: "01-2020",
    validFrom: null,
    validUntil: "2025-07-31",
  };
  const current = {
    formCode: "tl407" as const,
    version: "08-2025",
    validFrom: "2025-08-01",
    validUntil: null,
  };
  const kug = {
    formCode: "kug200b" as const,
    version: "09-2021",
    validFrom: null,
    validUntil: null,
  };

  it("is in use from validFrom through validUntil, inclusive", () => {
    expect(isFormVersionInUse(old, "2025-07-31")).toBe(true);
    expect(isFormVersionInUse(old, "2025-08-01")).toBe(false);
    expect(isFormVersionInUse(current, "2025-07-31")).toBe(false);
    expect(isFormVersionInUse(current, "2025-08-01")).toBe(true);
  });

  it("picks the one version in use, or none", () => {
    expect(formVersionInUse([old, current, kug], "tl407", "2025-07-31")).toBe(old);
    expect(formVersionInUse([old, current, kug], "tl407", "2026-10-24")).toBe(current);
    expect(formVersionInUse([old, kug], "tl407", "2026-10-24")).toBeNull();
  });

  it("refuses two versions in use at once", () => {
    expect(() =>
      formVersionInUse([current, { ...current, version: "09-2025" }], "tl407", "2026-10-24"),
    ).toThrow(RangeError);
  });
});
