import { describe, expect, it } from "vitest";
import { CreateProjectInput, ProjectType, projectRuleCodes } from "./project";

const validTaTg = {
  name: "Restrukturierung Werk Nord",
  customerName: "Beispiel Maschinenbau GmbH",
  type: "ta_tg",
  signingDeadline: "2027-02-15",
  defaultTgStart: "2027-03-01",
  defaultTgEnd: "2028-02-29",
} as const;

const validTaOnly = {
  name: "Transferagentur Standort Süd",
  customerName: "Musterfirma Logistik AG",
  type: "ta_only",
} as const;

/** The paths of all issues, as dotted strings, for compact assertions. */
function issuePaths(input: unknown): string[] {
  const result = CreateProjectInput.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

/** The `params.code` of all issues. */
function issueCodes(input: unknown): (string | undefined)[] | undefined {
  return CreateProjectInput.safeParse(input).error?.issues.map(
    (issue) => (issue as { params?: { code?: string } }).params?.code,
  );
}

describe("ProjectType", () => {
  it("has exactly the two project types", () => {
    expect(ProjectType.options).toEqual(["ta_only", "ta_tg"]);
  });

  it("rejects unknown types", () => {
    expect(ProjectType.safeParse("tg_only").success).toBe(false);
  });
});

describe("CreateProjectInput", () => {
  it("accepts a complete ta_tg project", () => {
    expect(CreateProjectInput.parse(validTaTg)).toEqual(validTaTg);
  });

  it("accepts a ta_only project without dates", () => {
    expect(CreateProjectInput.parse(validTaOnly)).toEqual(validTaOnly);
  });

  it("accepts a ta_tg project without any dates (they are required at activation, not at creation)", () => {
    const { signingDeadline, defaultTgStart, defaultTgEnd, ...withoutDates } = validTaTg;
    expect(CreateProjectInput.safeParse(withoutDates).success).toBe(true);
  });

  it("accepts a ta_tg project where TG start and end are the same day", () => {
    const input = { ...validTaTg, defaultTgStart: "2027-03-01", defaultTgEnd: "2027-03-01" };
    expect(CreateProjectInput.safeParse(input).success).toBe(true);
  });

  it("trims name and customer name", () => {
    const parsed = CreateProjectInput.parse({
      ...validTaOnly,
      name: "  Projekt Ost  ",
      customerName: "\tBeispiel GmbH\n",
    });
    expect(parsed.name).toBe("Projekt Ost");
    expect(parsed.customerName).toBe("Beispiel GmbH");
  });

  describe("name and customer name", () => {
    it.each(["name", "customerName"])("rejects an empty %s", (field) => {
      expect(issuePaths({ ...validTaOnly, [field]: "" })).toEqual([field]);
    });

    it.each(["name", "customerName"])("rejects a whitespace-only %s", (field) => {
      expect(issuePaths({ ...validTaOnly, [field]: "   " })).toEqual([field]);
    });

    it.each(["name", "customerName"])("accepts 200 characters and rejects 201 for %s", (field) => {
      expect(issuePaths({ ...validTaOnly, [field]: "x".repeat(200) })).toEqual([]);
      expect(issuePaths({ ...validTaOnly, [field]: "x".repeat(201) })).toEqual([field]);
    });

    it("measures the length after trimming", () => {
      expect(issuePaths({ ...validTaOnly, name: ` ${"x".repeat(200)} ` })).toEqual([]);
    });

    it.each(["name", "customerName", "type"])("requires %s", (field) => {
      const input: Record<string, unknown> = { ...validTaOnly };
      delete input[field];
      expect(issuePaths(input)).toEqual([field]);
    });
  });

  describe("dates", () => {
    it.each(["signingDeadline", "defaultTgStart", "defaultTgEnd"])(
      "rejects an impossible %s",
      (field) => {
        expect(issuePaths({ ...validTaTg, [field]: "2027-02-31" })).toContain(field);
      },
    );

    it("rejects a TG end before the TG start, on the end date", () => {
      const input = { ...validTaTg, defaultTgStart: "2027-03-01", defaultTgEnd: "2027-02-28" };
      expect(issuePaths(input)).toEqual(["defaultTgEnd"]);
    });

    it("allows only one of TG start and TG end", () => {
      const { defaultTgEnd, ...onlyStart } = validTaTg;
      const { defaultTgStart, ...onlyEnd } = validTaTg;
      expect(issuePaths(onlyStart)).toEqual([]);
      expect(issuePaths(onlyEnd)).toEqual([]);
    });
  });

  describe("ta_only projects have no DSV track and no beE", () => {
    it.each(["signingDeadline", "defaultTgStart", "defaultTgEnd"])(
      "rejects %s on a ta_only project",
      (field) => {
        expect(issuePaths({ ...validTaOnly, [field]: "2027-03-01" })).toEqual([field]);
      },
    );

    it("reports every date set on a ta_only project", () => {
      const input = {
        ...validTaOnly,
        signingDeadline: "2027-02-15",
        defaultTgStart: "2027-03-01",
        defaultTgEnd: "2028-02-29",
      };
      expect(issuePaths(input)).toEqual(["signingDeadline", "defaultTgStart", "defaultTgEnd"]);
    });
  });

  it("reports field errors and cross-field errors together", () => {
    const input = { ...validTaOnly, name: "", defaultTgStart: "2027-03-01" };
    expect(issuePaths(input)).toEqual(["name", "defaultTgStart"]);
  });

  it("does not echo the submitted values in issue messages", () => {
    const secretLookingName = "Zzyzx-Unverwechselbar-4711";
    const result = CreateProjectInput.safeParse({
      ...validTaOnly,
      name: secretLookingName.repeat(20),
      customerName: "",
      defaultTgEnd: "2027-02-31",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues.map((i) => i.message))).not.toContain("Zzyzx");
    expect(JSON.stringify(result.error?.issues.map((i) => i.message))).not.toContain("2027-02-31");
  });

  it("carries stable codes for the cross-field rules", () => {
    expect(issueCodes({ ...validTaTg, defaultTgEnd: "2027-01-01" })).toEqual([
      projectRuleCodes.tgEndBeforeStart,
    ]);
    expect(issueCodes({ ...validTaOnly, defaultTgStart: "2027-03-01" })).toEqual([
      projectRuleCodes.notAllowedForTaOnly,
    ]);
  });

  it("strips unknown keys", () => {
    const parsed = CreateProjectInput.parse({ ...validTaOnly, createdBy: "someone" });
    expect(parsed).not.toHaveProperty("createdBy");
  });
});
