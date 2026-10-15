import { describe, expect, it } from "vitest";
import { DataClass, StaffRole } from "./enums";

describe("DataClass", () => {
  it("has the classes from data-protection.md, most sensitive first", () => {
    expect(DataClass.options).toEqual([
      "special_category",
      "highly_confidential",
      "confidential",
      "internal",
      "aggregated",
    ]);
  });
});

describe("StaffRole", () => {
  it("has the five provisional staff roles", () => {
    expect(StaffRole.options).toEqual([
      "admin",
      "regional_admin",
      "project_lead",
      "consultant",
      "back_office",
    ]);
  });

  it("has no customer or participant role (Q47, ADR-0007)", () => {
    expect(StaffRole.safeParse("customer").success).toBe(false);
    expect(StaffRole.safeParse("participant").success).toBe(false);
  });
});
