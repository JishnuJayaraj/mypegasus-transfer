import { describe, expect, it } from "vitest";
import { DataClass, OrgRole, ProjectRole } from "./enums";

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

describe("staff roles (D8, Q126)", () => {
  it("has org roles and project roles, and no flat role any more", () => {
    expect(OrgRole.options).toEqual(["admin", "regional_admin", "regional_operations_manager"]);
    expect(ProjectRole.options).toEqual(["project_lead", "consultant", "back_office"]);
  });

  it("has no customer or participant role (Q47, ADR-0007)", () => {
    for (const role of ["customer", "participant"]) {
      expect(OrgRole.safeParse(role).success).toBe(false);
      expect(ProjectRole.safeParse(role).success).toBe(false);
    }
  });
});
