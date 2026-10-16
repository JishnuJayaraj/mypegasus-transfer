import { describe, expect, it } from "vitest";
import {
  checkProjectUpdate,
  CreateProjectInput,
  mayCreateProject,
  ProjectStatus,
  ProjectType,
  UpdateProjectInput,
} from "./project";

const validTaTg = {
  name: "Restrukturierung Werk Nord",
  customerName: "Beispiel Maschinenbau GmbH",
  type: "ta_tg",
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

describe("ProjectType and ProjectStatus", () => {
  it("has exactly the two project types", () => {
    expect(ProjectType.options).toEqual(["ta_only", "ta_tg"]);
  });

  it("rejects unknown types", () => {
    expect(ProjectType.safeParse("tg_only").success).toBe(false);
  });

  it("has exactly draft and active (Q98)", () => {
    expect(ProjectStatus.options).toEqual(["draft", "active"]);
  });
});

describe("CreateProjectInput", () => {
  it.each([validTaTg, validTaOnly])("accepts a %s project", (input) => {
    expect(CreateProjectInput.parse(input)).toEqual(input);
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

  it("does not echo the submitted values in issue messages", () => {
    const secretLookingName = "Zzyzx-Unverwechselbar-4711";
    const result = CreateProjectInput.safeParse({
      ...validTaOnly,
      name: secretLookingName.repeat(20),
      customerName: "",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues.map((i) => i.message))).not.toContain("Zzyzx");
  });

  it("rejects unknown keys, the Slice 0 dates included, instead of dropping them (round 23)", () => {
    const result = CreateProjectInput.safeParse({
      ...validTaTg,
      signingDeadline: "2027-02-15",
      projectAgenturKey: "beispielstadt-nord",
    });
    expect(result.error?.issues.map((i) => [i.code, (i as { keys?: string[] }).keys])).toEqual([
      ["unrecognized_keys", ["signingDeadline", "projectAgenturKey"]],
    ]);
  });
});

describe("UpdateProjectInput", () => {
  it("accepts any non-empty subset of name, customer and type", () => {
    expect(UpdateProjectInput.parse({ name: " Neu " })).toEqual({ name: "Neu" });
    expect(UpdateProjectInput.parse({ type: "ta_only" })).toEqual({ type: "ta_only" });
  });

  it("refuses an empty change with a stable code", () => {
    const result = UpdateProjectInput.safeParse({});
    expect(result.error?.issues.map((i) => (i as { params?: object }).params)).toEqual([
      { code: "nothing_to_change" },
    ]);
  });

  it("rejects unknown keys, e.g. a premature projectAgenturKey (round 23)", () => {
    expect(UpdateProjectInput.safeParse({ projectAgenturKey: "beispielstadt-nord" }).success).toBe(
      false,
    );
  });

  it("validates the fields like creation", () => {
    expect(UpdateProjectInput.safeParse({ name: "  " }).success).toBe(false);
    expect(UpdateProjectInput.safeParse({ type: "tg_only" }).success).toBe(false);
  });
});

describe("checkProjectUpdate (Q98, round 22)", () => {
  const draft = { status: "draft", type: "ta_tg" } as const;
  const unused = { participations: 0, waves: 0 };

  it("allows a type change of a draft project without participations or waves", () => {
    expect(checkProjectUpdate(draft, unused, { type: "ta_only" })).toEqual([]);
  });

  it("ignores changes that don't touch the type, or set it to the current one", () => {
    const used = { participations: 3, waves: 1 };
    const active = { status: "active", type: "ta_tg" } as const;
    expect(checkProjectUpdate(active, used, {})).toEqual([]);
    expect(checkProjectUpdate(active, used, { type: "ta_tg" })).toEqual([]);
  });

  it("refuses a type change once active, with participations or with waves, giving every reason", () => {
    expect(checkProjectUpdate(draft, { participations: 1, waves: 0 }, { type: "ta_only" })).toEqual(
      ["project_has_participations"],
    );
    expect(checkProjectUpdate(draft, { participations: 0, waves: 1 }, { type: "ta_only" })).toEqual(
      ["project_has_waves"],
    );
    expect(
      checkProjectUpdate(
        { status: "active", type: "ta_only" },
        { participations: 2, waves: 1 },
        { type: "ta_tg" },
      ),
    ).toEqual(["project_not_draft", "project_has_participations", "project_has_waves"]);
  });
});

describe("mayCreateProject (Q106)", () => {
  it("allows only the flat project_lead role until Slice 3", () => {
    expect(mayCreateProject("project_lead")).toBe(true);
    for (const role of [
      "admin",
      "regional_admin",
      "consultant",
      "back_office",
      "regional_operations_manager",
    ]) {
      expect(mayCreateProject(role)).toBe(false);
    }
  });
});
