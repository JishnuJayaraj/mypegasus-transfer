import { describe, expect, it } from "vitest";
import type { OrgRole, ProjectRole } from "../enums";
import { AccessCategory } from "../fields/catalog";
import { decideAccess, type AccessAction, type AccessMode, type Subject } from "./decide";
import { accessModes, accessProfiles, sample, sampleResource } from "./profiles";
import { cell } from "./testing/cell";

const actions: AccessAction[] = ["read", "list", "open_document", "write"];
const sensitive = [
  "health",
  "disability",
  "identifiers",
  "residence_social",
  "profiling_assessment",
  "signed_tl407",
  "signed_kug200b",
] as const;
const personLevel = AccessCategory.options.filter(
  (c) => c !== "audit_metadata" && c !== "aggregated",
);
const profile = (key: string) => accessProfiles.find((p) => p.key === key)!.subject;
const breakGlass = accessModes.break_glass;

function staff(
  projectRoles: ProjectRole[],
  options: { org?: [OrgRole, string[] | "all"][]; assigned?: string[] } = {},
): Subject {
  return {
    kind: "staff",
    staffUserId: "staff-b",
    orgRoles: new Map(
      (options.org ?? []).map(([role, ids]) => [
        role,
        { regionIds: ids === "all" ? "all" : new Set(ids) },
      ]),
    ),
    projectRoles: { [sample.projectId]: new Set(projectRoles) },
    assignedParticipationIds: new Set(options.assigned ?? []),
  };
}

const decide = (
  subject: Subject,
  category: AccessCategory,
  action: AccessAction,
  mode: AccessMode = accessModes.normal,
  resource: Partial<ReturnType<typeof sampleResource>> = {},
) =>
  cell(decideAccess(subject, { ...sampleResource(category, "active"), ...resource }, action, mode));

const evidence = (
  key: string,
  category: AccessCategory,
  action: AccessAction,
  mode: AccessMode = breakGlass,
) => cell(decideAccess(profile(key), sampleResource(category, "evidence_set"), action, mode));
const rom = (regions: string[] | "all") =>
  staff([], { org: [["regional_operations_manager", regions]] });
const participantWrite = (field?: string) => {
  const resource = { ...sampleResource("identifiers", "active"), field };
  return cell(decideAccess(profile("participant"), resource, "write", accessModes.normal));
};

describe("list payloads (AC-26)", () => {
  it("never lists special-category, highly confidential or absence data (Q85)", () => {
    for (const { subject } of accessProfiles) {
      for (const category of [...sensitive, "absence" as const]) {
        for (const mode of Object.values(accessModes)) {
          for (const phase of ["active", "evidence_set"] as const) {
            const resource = sampleResource(category, phase);
            expect(decideAccess(subject, resource, "list", mode)).toMatchObject({
              effect: "deny",
            });
          }
        }
      }
    }
    expect(decide(profile("project_lead"), "health", "list")).toBe("deny not_in_list_payloads");
  });

  it("lists other categories as they are read", () => {
    expect(decide(profile("project_lead"), "confidential", "list")).toBe("allow full");
    expect(decide(profile("consultant_unassigned"), "aggregated", "list")).toBe("allow full");
    expect(decide(profile("regional_operations_manager"), "audit_metadata", "list")).toBe(
      "allow full",
    );
  });
});

describe("documents", () => {
  it("opens signed forms only for the assigned profiler and the PL, audited", () => {
    for (const category of ["signed_tl407", "signed_kug200b"] as const) {
      const open = (key: string) => decide(profile(key), category, "open_document");
      expect(open("consultant")).toBe("allow full document_opened");
      expect(open("project_lead")).toBe("allow full document_opened");
      expect(open("back_office")).toBe("deny never");
      expect(open("participant")).toBe("deny never");
      expect(open("consultant_unassigned")).toBe("deny not_assigned");
    }
  });

  it("leaves documents of other categories undecided (Q87), behind the read rule", () => {
    expect(decide(profile("back_office"), "identifiers", "open_document")).toBe(
      "deny undecided Q87",
    );
    expect(decide(profile("project_lead"), "identifiers", "open_document")).toBe("deny never");
  });
});

describe("assisted mode", () => {
  const assisted = accessModes.assisted;

  it("lets the PL read and write health and disability for that participant only", () => {
    const pl = profile("project_lead");
    for (const category of ["health", "disability"] as const) {
      expect(decide(pl, category, "read", assisted)).toBe("allow full sensitive_read");
      expect(decide(pl, category, "write", assisted)).toBe("allow full sensitive_write");
      const other = { onBehalfOf: "participation-b", kind: "assisted" } as const;
      expect(decide(pl, category, "read", other)).toBe("deny needs_assisted_mode");
    }
    expect(decide(pl, "confidential", "write", assisted)).toBe("allow full");
  });

  it("widens nothing else", () => {
    expect(decide(profile("back_office"), "health", "read", assisted)).toBe("deny never");
    expect(decide(profile("project_lead"), "identifiers", "write", assisted)).toBe("deny never");
    expect(decide(profile("project_lead"), "health", "open_document", assisted)).toBe(
      "deny undecided Q87",
    );
  });
});

describe("break-glass (AC-27, Q63)", () => {
  it("gives the PL health and disability as one audited, flagged grant", () => {
    const decision = decideAccess(
      profile("project_lead"),
      sampleResource("health", "active"),
      "read",
      breakGlass,
    );
    expect(decision).toEqual({
      effect: "allow",
      view: "full",
      audit: "break_glass_access",
      flagForReview: true,
      grant: { participationId: sample.participationId, category: "health", action: "read" },
    });
    expect(decide(profile("project_lead"), "disability", "read", breakGlass)).toBe(
      "allow full break_glass_access review grant",
    );
  });

  it("grants nothing elsewhere in the active phase", () => {
    expect(decide(profile("project_lead"), "health", "write", breakGlass)).toBe(
      "deny needs_assisted_mode",
    );
    expect(decide(profile("project_lead"), "profiling_assessment", "read", breakGlass)).toBe(
      "deny never",
    );
    expect(decide(profile("back_office"), "health", "read", breakGlass)).toBe("deny never");
    expect(decide(profile("consultant"), "health", "read", breakGlass)).toBe(
      "allow full sensitive_read",
    );
    expect(decide(profile("admin"), "health", "read", breakGlass)).toBe("deny never");
  });

  it("needs a reason code and one participant", () => {
    const pl = profile("project_lead");
    const blank = { kind: "break_glass", reasonCode: " " } as const;
    expect(decide(pl, "health", "read", blank)).toBe("deny needs_assisted_mode");
    expect(decide(pl, "health", "read", breakGlass, { participationId: null })).toBe(
      "deny needs_assisted_mode",
    );
  });

  it("is never available to participants", () => {
    expect(decide(profile("participant"), "health", "read", breakGlass)).toBe("deny never");
    expect(decide(profile("participant"), "confidential", "read", accessModes.assisted)).toBe(
      "deny never",
    );
  });
});

describe("evidence-set phase (Q64)", () => {
  it("needs break-glass for what the role has in the active phase, and grants no more", () => {
    expect(evidence("consultant", "confidential", "read", accessModes.normal)).toBe(
      "deny needs_break_glass",
    );
    expect(evidence("consultant", "profiling_assessment", "read")).toBe(
      "allow full break_glass_access review grant",
    );
    expect(evidence("project_lead", "signed_tl407", "open_document")).toBe(
      "allow full break_glass_access review grant",
    );
    expect(evidence("project_lead", "signed_tl407", "read")).toBe(
      "allow metadata_only break_glass_access review grant",
    );
    expect(evidence("back_office", "confidential", "read")).toBe(
      "allow full break_glass_access review grant",
    );
    expect(evidence("back_office", "signed_tl407", "open_document")).toBe("deny never");
    expect(evidence("project_lead", "health", "read")).toBe("deny never");
    expect(evidence("consultant_unassigned", "confidential", "read")).toBe("deny not_assigned");
    expect(evidence("admin", "confidential", "read")).toBe("deny never");
  });

  it("never lists, leaves writes undecided (Q87) and keeps participants out", () => {
    expect(evidence("project_lead", "confidential", "list")).toBe("deny never");
    expect(evidence("consultant", "confidential", "write")).toBe("deny undecided Q87");
    expect(evidence("project_lead", "case_internal", "write")).toBe("deny via_status_functions");
    expect(evidence("participant", "confidential", "read", accessModes.normal)).toBe("deny never");
  });

  it("doesn't change audit metadata or aggregates", () => {
    expect(evidence("regional_operations_manager", "audit_metadata", "read")).toBe("allow full");
    expect(evidence("admin", "aggregated", "read", accessModes.normal)).toBe("allow full");
  });
});

describe("role union and assignment (AC-24, D6, Q61, Q62)", () => {
  it("shows section C to a PL who is also profiler only for assigned participants", () => {
    const both = staff(["project_lead", "consultant"], { assigned: [sample.participationId] });
    expect(decide(both, "profiling_assessment", "read")).toBe("allow full sensitive_read");
    expect(
      decide(both, "profiling_assessment", "read", accessModes.normal, {
        participationId: "participation-b",
      }),
    ).toBe("deny not_assigned");
    expect(
      decide(both, "confidential", "read", accessModes.normal, { participationId: null }),
    ).toBe("allow full");
  });

  it("gives an unassigned consultant nothing person-level, only aggregates", () => {
    const consultant = profile("consultant_unassigned");
    for (const category of personLevel) {
      for (const action of actions) {
        for (const mode of Object.values(accessModes)) {
          expect(decide(consultant, category, action, mode)).toBe("deny not_assigned");
        }
      }
    }
    expect(decide(consultant, "aggregated", "read")).toBe("allow full");
  });

  it("takes the most permissive allow, else the most telling denial", () => {
    const plAndBackOffice = staff(["project_lead", "back_office"]);
    expect(decide(plAndBackOffice, "absence", "read")).toBe("allow type_and_dates");
    expect(decide(plAndBackOffice, "health", "read")).toBe("deny needs_assisted_mode");
    expect(decide(plAndBackOffice, "identifiers", "write")).toBe("allow full sensitive_write");
    expect(decide(staff(["consultant", "back_office"]), "residence_social", "write")).toBe(
      "deny undecided Q65",
    );
  });

  it("denies staff without a role in the project or region", () => {
    const outsider = staff([]);
    expect(decide(outsider, "confidential", "read")).toBe("deny not_member");
    expect(decide(outsider, "aggregated", "read")).toBe("deny not_member");
    const otherProject = { projectId: "project-b" };
    expect(
      decide(profile("project_lead"), "confidential", "read", accessModes.normal, otherProject),
    ).toBe("deny not_member");
  });
});

describe("org roles (AC-25, Q57, Q80)", () => {
  it("shows the regional operations manager audit metadata and aggregates of their region", () => {
    expect(decide(rom([sample.regionId]), "audit_metadata", "read")).toBe("allow full");
    expect(decide(rom([sample.regionId]), "aggregated", "read")).toBe("allow full");
    expect(decide(rom(["region-b"]), "audit_metadata", "read")).toBe("deny out_of_region");
    expect(
      decide(rom([sample.regionId]), "audit_metadata", "read", accessModes.normal, {
        regionId: null,
      }),
    ).toBe("deny out_of_region");
    for (const category of personLevel) {
      for (const action of actions) {
        for (const mode of Object.values(accessModes)) {
          expect(decide(rom("all"), category, action, mode)).toMatch(/^deny (never|not_in_list)/);
        }
      }
    }
  });

  it("gives admins aggregates only, everywhere", () => {
    const admin = staff([], { org: [["admin", "all"]] });
    expect(decide(admin, "aggregated", "read", accessModes.normal, { regionId: null })).toBe(
      "allow full",
    );
    expect(decide(admin, "audit_metadata", "read")).toBe("deny never");
  });
});

describe("participants (Q65, Q67)", () => {
  const participant = profile("participant");

  it("reach only their own participation, in normal mode", () => {
    const other = { participationId: "participation-b" };
    expect(decide(participant, "confidential", "read", accessModes.normal, other)).toBe(
      "deny never",
    );
  });

  it("write only self-service fields", () => {
    expect(participantWrite("pensionInsuranceNumber")).toBe("allow full sensitive_write");
    expect(participantWrite("iban")).toBe("deny never");
    expect(participantWrite(undefined)).toBe("deny never");
  });

  it("rejects a field of another category", () => {
    const resource = { ...sampleResource("confidential", "active"), field: "iban" };
    expect(() => decideAccess(participant, resource, "read", accessModes.normal)).toThrow(
      "Field iban is not in category confidential",
    );
  });
});
