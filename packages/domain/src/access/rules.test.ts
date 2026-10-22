import { describe, expect, it } from "vitest";
import { DocumentType, documentTypeEntry } from "../documents/catalog";
import type { OrgRole, ProjectRole } from "../enums";
import { fieldEntry, type AccessCategory } from "../fields/catalog";
import {
  AuditStream,
  decideAccess,
  type AccessAction,
  type AccessMode,
  type AccessPhase,
  type Resource,
  type Subject,
} from "./decide";
import {
  accessModes,
  accessProfiles,
  fieldCategories,
  sample,
  sampleAggregate,
  sampleAudit,
  sampleDocument,
  sampleField,
} from "./profiles";
import { cell } from "./testing/cell";

const actions: AccessAction[] = ["read", "list", "open_document", "write"];
const modes = Object.values(accessModes);
const phases: AccessPhase[] = ["active", "evidence_set"];
const breakGlass = accessModes.break_glass;
const profile = (key: string) => accessProfiles.find((p) => p.key === key)!.subject;

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
  resource: Resource,
  action: AccessAction,
  mode: AccessMode = accessModes.normal,
) => cell(decideAccess(subject, resource, action, mode));
const field = (category: AccessCategory, phase: AccessPhase = "active") =>
  sampleField(category, phase);
const doc = (type: DocumentType, phase: AccessPhase = "active") => sampleDocument(type, phase);
/** Every person-level resource (one field per category, every document type) in a phase. */
const personResources = (phase: AccessPhase) => [
  ...fieldCategories.map((c) => field(c, phase)),
  ...DocumentType.options.map((t) => doc(t, phase)),
];
const categoryOf = (r: ReturnType<typeof personResources>[number]) =>
  r.kind === "field"
    ? fieldEntry(r.field).accessCategory
    : documentTypeEntry(r.documentType).accessCategory;
const identifiers = (key: string) => ({ ...field("identifiers"), field: key });
const evidenceAudit = (stream: AuditStream, actor: string | null = "staff-other") =>
  sampleAudit(stream, actor, "evidence_set");
const rom = (regions: string[] | "all") =>
  staff([], { org: [["regional_operations_manager", regions]] });
const evidence = (
  key: string,
  resource: Resource,
  action: AccessAction,
  mode: AccessMode = breakGlass,
) => decide(profile(key), resource, action, mode);

describe("resource kinds (round 11)", () => {
  it("returns not_applicable for actions a resource kind doesn't have, for everyone", () => {
    const invalid: [Resource, AccessAction][] = [
      [field("confidential"), "open_document"],
      [sampleAudit("case", null), "open_document"],
      [sampleAggregate(), "open_document"],
      [sampleAggregate(), "write"],
    ];
    for (const { subject } of accessProfiles) {
      for (const mode of modes) {
        for (const [resource, action] of invalid) {
          expect(decide(subject, resource, action, mode)).toBe("deny not_applicable");
        }
      }
    }
  });

  it("never writes audit metadata (append-only)", () => {
    for (const { key, subject } of accessProfiles) {
      const expected = key === "consultant_unassigned" ? "deny not_assigned" : "deny never";
      expect(decide(subject, sampleAudit("case", "staff-a"), "write")).toBe(expected);
    }
  });
});

describe("list payloads (data-protection.md, CLAUDE.md rule 9)", () => {
  it("never lists special-category, highly confidential or absence data (Q85)", () => {
    const unlisted = [...personResources("active"), ...personResources("evidence_set")].filter(
      (r) => !["case_internal", "confidential"].includes(categoryOf(r)),
    );
    expect(unlisted.length).toBeGreaterThan(0);
    for (const { subject } of accessProfiles) {
      for (const resource of unlisted) {
        for (const mode of modes) {
          expect(decideAccess(subject, resource, "list", mode)).toMatchObject({ effect: "deny" });
        }
      }
    }
    const pl = profile("project_lead");
    expect(decide(pl, field("health"), "list")).toBe("deny not_in_list_payloads");
    expect(decide(pl, doc("tl407_signed_scan"), "list")).toBe("deny not_in_list_payloads");
  });

  it("lists other data as it is read", () => {
    const pl = profile("project_lead");
    expect(decide(pl, field("confidential"), "list")).toBe("allow full");
    expect(decide(pl, doc("participant_upload"), "list")).toBe("allow metadata_only");
    expect(decide(profile("consultant_unassigned"), sampleAggregate(), "list")).toBe("allow full");
    expect(decide(rom([sample.regionId]), sampleAudit("review", null), "list")).toBe("allow full");
  });
});

/** The category's self-service field (the sampled one), or another field of the category. */
const selfService = (category: AccessCategory) => field(category);
const keyed = (category: AccessCategory, key: string) => ({ ...field(category), field: key });

describe("assisted mode (Q136)", () => {
  const assisted = accessModes.assisted;
  const other = { kind: "assisted", onBehalfOf: "participation-b" } as const;
  const pl = profile("project_lead");
  const backOffice = profile("back_office");
  const consultant = profile("consultant");

  it("lets the PL read and write health and disability for that participant only", () => {
    for (const category of ["health", "disability"] as const) {
      expect(decide(pl, field(category), "read", assisted)).toBe("allow full sensitive_read");
      expect(decide(pl, field(category), "write", assisted)).toBe("allow full sensitive_write");
      expect(decide(pl, field(category), "read", other)).toBe("deny needs_assisted_mode");
    }
    const evidenceDoc = doc("profiling_exception_evidence");
    expect(decide(pl, evidenceDoc, "open_document", assisted)).toBe("allow full document_opened");
    expect(decide(pl, evidenceDoc, "read", assisted)).toBe("allow metadata_only");
  });

  it("lets the PL write confidential self-service fields, never identifiers or residence_social", () => {
    expect(decide(pl, selfService("confidential"), "write", assisted)).toBe("allow full");
    expect(decide(pl, selfService("confidential"), "write")).toBe("deny needs_assisted_mode");
    expect(decide(pl, selfService("confidential"), "write", other)).toBe(
      "deny needs_assisted_mode",
    );
    for (const category of ["identifiers", "residence_social"] as const) {
      for (const action of ["read", "write"] as const) {
        expect(decide(pl, selfService(category), action, assisted)).toBe("deny never");
      }
    }
  });

  it("lets the assigned consultant write every self-service field", () => {
    for (const category of fieldCategories) {
      const resource = selfService(category);
      if (!fieldEntry(resource.field).selfService) continue;
      expect(decide(consultant, resource, "read", assisted)).toMatch(/^allow full/);
      expect(decide(consultant, resource, "write", assisted)).toMatch(/^allow full/);
    }
    expect(decide(consultant, identifiers("pensionInsuranceNumber"), "write", assisted)).toBe(
      "allow full sensitive_write",
    );
    expect(decide(consultant, selfService("residence_social"), "write")).toBe(
      "deny needs_assisted_mode",
    );
  });

  it("lets back office write confidential, disability, identifiers and residence_social, never health", () => {
    expect(decide(backOffice, selfService("confidential"), "write", assisted)).toBe("allow full");
    expect(decide(backOffice, selfService("residence_social"), "write", assisted)).toBe(
      "allow full sensitive_write",
    );
    expect(decide(backOffice, selfService("residence_social"), "write")).toBe(
      "deny needs_assisted_mode",
    );
    for (const category of ["disability", "identifiers"] as const) {
      expect(decide(backOffice, selfService(category), "write", assisted)).toBe(
        "allow full sensitive_write",
      );
    }
    expect(decide(backOffice, field("health"), "read", assisted)).toBe("deny never");
    expect(decide(backOffice, field("health"), "write", assisted)).toBe("deny never");
  });

  it("leaves staff writes of fields the participant doesn't answer to Q65", () => {
    expect(decide(consultant, identifiers("iban"), "write", assisted)).toBe("deny undecided Q65");
    expect(decide(consultant, identifiers("iban"), "write")).toBe("deny undecided Q65");
    expect(decide(backOffice, keyed("confidential", "birthDate"), "write", assisted)).toBe(
      "deny undecided Q65",
    );
    expect(decide(pl, keyed("confidential", "birthDate"), "write", assisted)).toBe(
      "deny undecided Q65",
    );
  });

  it("widens nothing else", () => {
    expect(decide(pl, doc("asu_proof"), "open_document", assisted)).toBe("deny needs_break_glass");
    expect(decide(profile("consultant_unassigned"), field("confidential"), "write", assisted)).toBe(
      "deny not_assigned",
    );
    expect(decide(profile("admin"), field("confidential"), "write", assisted)).toBe("deny never");
  });
});

describe("break-glass (Q63)", () => {
  const pl = profile("project_lead");

  it("gives the PL health and disability reads as one audited, flagged grant", () => {
    expect(decideAccess(pl, field("health"), "read", breakGlass)).toEqual({
      effect: "allow",
      view: "full",
      audit: "break_glass_access",
      flagForReview: true,
      grant: {
        participationId: sample.participationId,
        action: "read",
        target: { kind: "field", category: "health" },
      },
    });
    expect(decide(pl, field("disability"), "read", breakGlass)).toBe(
      "allow full break_glass_access review grant",
    );
  });

  it("opens the documents the catalog allows through break-glass", () => {
    expect(decideAccess(pl, doc("asu_proof"), "open_document", breakGlass)).toMatchObject({
      view: "full",
      audit: "break_glass_access",
      grant: {
        action: "open_document",
        target: { kind: "document", documentType: "asu_proof", category: "identifiers" },
      },
    });
    expect(decide(pl, doc("profiling_exception_evidence"), "read", breakGlass)).toBe(
      "allow metadata_only break_glass_access review grant",
    );
    expect(decide(pl, doc("asu_proof"), "read", breakGlass)).toBe("allow metadata_only");
  });

  it("never grants writes, lists or more than the documented scope", () => {
    expect(decide(pl, field("health"), "write", breakGlass)).toBe("deny needs_assisted_mode");
    expect(decide(pl, field("health"), "list", breakGlass)).toBe("deny not_in_list_payloads");
    expect(decide(pl, field("profiling_assessment"), "read", breakGlass)).toBe("deny never");
    expect(decide(pl, doc("asu_proof"), "write", breakGlass)).toBe("deny via_domain_operation");
    expect(decide(profile("back_office"), field("health"), "read", breakGlass)).toBe("deny never");
    expect(decide(profile("admin"), field("health"), "read", breakGlass)).toBe("deny never");
    expect(decide(profile("consultant"), field("health"), "read", breakGlass)).toBe(
      "allow full sensitive_read",
    );
  });

  it("needs a reason code and one participant", () => {
    const blank = { kind: "break_glass", reasonCode: " " } as const;
    expect(decide(pl, field("health"), "read", blank)).toBe("deny needs_assisted_mode");
    const projectWide = { ...field("health"), participationId: null };
    expect(decide(pl, projectWide, "read", breakGlass)).toBe("deny needs_assisted_mode");
  });

  it("is never available to participants, who have no modes", () => {
    const participant = profile("participant");
    expect(decide(participant, field("health"), "read", breakGlass)).toBe("deny never");
    expect(decide(participant, field("confidential"), "read", accessModes.assisted)).toBe(
      "deny never",
    );
  });
});

describe("evidence-set phase (Q64, rounds 11–12)", () => {
  it("needs break-glass for what the role has in the active phase, with its view", () => {
    const granted = "allow full break_glass_access review grant";
    const confidential = field("confidential", "evidence_set");
    expect(evidence("consultant", confidential, "read", accessModes.normal)).toBe(
      "deny needs_break_glass",
    );
    expect(evidence("consultant", field("profiling_assessment", "evidence_set"), "read")).toBe(
      granted,
    );
    const tl407 = doc("tl407_signed_scan", "evidence_set");
    expect(evidence("project_lead", tl407, "open_document")).toBe(granted);
    expect(evidence("project_lead", tl407, "read")).toBe(
      "allow metadata_only break_glass_access review grant",
    );
    expect(evidence("back_office", doc("dsv_signed_scan", "evidence_set"), "open_document")).toBe(
      granted,
    );
    expect(evidence("back_office", tl407, "open_document")).toBe("deny never");
    // the intersection of the active entitlement (any mode) and break-glass (round 12)
    const health = field("health", "evidence_set");
    expect(evidence("project_lead", health, "read")).toBe(granted);
    expect(evidence("project_lead", health, "read", accessModes.assisted)).toBe(
      "deny needs_break_glass",
    );
    const exceptionEvidence = doc("profiling_exception_evidence", "evidence_set");
    expect(evidence("project_lead", exceptionEvidence, "open_document")).toBe(granted);
    expect(evidence("project_lead", exceptionEvidence, "open_document", accessModes.normal)).toBe(
      "deny needs_break_glass",
    );
    expect(evidence("project_lead", field("identifiers", "evidence_set"), "read")).toBe(
      "deny never",
    );
    const asuProof = doc("asu_proof", "evidence_set");
    expect(evidence("project_lead", asuProof, "open_document")).toBe(granted);
    expect(evidence("project_lead", asuProof, "open_document", accessModes.normal)).toBe(
      "deny needs_break_glass",
    );
    expect(evidence("consultant_unassigned", confidential, "read")).toBe("deny not_assigned");
    const projectWide = { ...confidential, participationId: null };
    expect(evidence("project_lead", projectWide, "read")).toBe("deny needs_break_glass");
  });

  it("never lists and never writes; signed documents stay immutable", () => {
    for (const key of ["consultant", "project_lead", "back_office", "admin"]) {
      for (const resource of personResources("evidence_set")) {
        const signed =
          resource.kind === "document" && documentTypeEntry(resource.documentType).signed;
        for (const mode of modes) {
          expect(evidence(key, resource, "write", mode)).toMatch(
            signed ? /^deny (immutable|never)$/ : /^deny never$/,
          );
          expect(evidence(key, resource, "list", mode)).toBe("deny never");
        }
      }
    }
    const tl407 = doc("tl407_signed_scan", "evidence_set");
    expect(evidence("consultant", tl407, "write")).toBe("deny immutable");
    expect(evidence("back_office", tl407, "write")).toBe("deny never");
    for (const phase of phases) {
      expect(
        evidence("participant", field("confidential", phase), "read", accessModes.normal),
      ).toBe(phase === "active" ? "allow full" : "deny never");
    }
  });
});

describe("role union and assignment (Q61, Q62)", () => {
  it("shows section C to a PL who is also profiler only for assigned participants", () => {
    const both = staff(["project_lead", "consultant"], { assigned: [sample.participationId] });
    expect(decide(both, field("profiling_assessment"), "read")).toBe("allow full sensitive_read");
    const other = { ...field("profiling_assessment"), participationId: "participation-b" };
    expect(decide(both, other, "read")).toBe("deny not_assigned");
    const projectWide = { ...field("confidential"), participationId: null };
    expect(decide(both, projectWide, "read")).toBe("allow full");
  });

  it("gives an unassigned consultant aggregates only", () => {
    const consultant = profile("consultant_unassigned");
    const audits = AuditStream.options.map((s) => sampleAudit(s, "staff-a"));
    for (const resource of [...personResources("active"), ...audits]) {
      for (const action of actions) {
        if (action === "open_document" && resource.kind !== "document") continue;
        for (const mode of modes) {
          expect(decide(consultant, resource, action, mode)).toBe("deny not_assigned");
        }
      }
    }
    expect(decide(consultant, sampleAggregate(), "read")).toBe("allow full");
  });

  it("takes the most permissive allow, normal before break-glass, else the most actionable denial", () => {
    const plAndBackOffice = staff(["project_lead", "back_office"]);
    expect(decide(plAndBackOffice, field("absence"), "read")).toBe("allow type_and_dates");
    expect(decide(plAndBackOffice, field("health"), "read")).toBe("deny needs_assisted_mode");
    expect(decide(plAndBackOffice, field("identifiers"), "write")).toBe(
      "allow full sensitive_write",
    );
    const plAndProfiler = staff(["project_lead", "consultant"], {
      assigned: [sample.participationId],
    });
    expect(decide(plAndProfiler, field("health"), "read", breakGlass)).toBe(
      "allow full sensitive_read",
    );
    expect(decide(staff(["consultant", "back_office"]), field("residence_social"), "write")).toBe(
      "deny needs_assisted_mode",
    );
    expect(decide(staff(["consultant", "back_office"]), identifiers("iban"), "write")).toBe(
      "allow full sensitive_write",
    );
  });

  it("denies staff without a role in the project", () => {
    expect(decide(staff([]), field("confidential"), "read")).toBe("deny not_member");
    expect(decide(staff([]), sampleAggregate(), "read")).toBe("deny not_member");
    const otherProject = { ...field("confidential"), projectId: "project-b" };
    expect(decide(profile("project_lead"), otherProject, "read")).toBe("deny not_member");
  });
});

describe("audit projections (Q87 A)", () => {
  it("adds an assigned consultant's own actions, without security or review events", () => {
    for (const stream of AuditStream.options) {
      const own = ["security", "review"].includes(stream) ? "deny never" : "allow full";
      const decision = decide(profile("consultant"), sampleAudit(stream, "staff-a"), "read");
      expect([stream, decision]).toEqual([stream, own]);
    }
  });

  it("doesn't depend on mode in the active phase", () => {
    for (const { subject } of accessProfiles) {
      for (const stream of AuditStream.options) {
        const resource = sampleAudit(stream, null);
        const normal = decide(subject, resource, "read");
        for (const mode of modes) expect(decide(subject, resource, "read", mode)).toBe(normal);
      }
    }
  });

  it("needs break-glass for operational streams once only the evidence set is left (round 12)", () => {
    const pl = profile("project_lead");
    expect(decide(pl, evidenceAudit("case"), "read")).toBe("deny needs_break_glass");
    expect(decideAccess(pl, evidenceAudit("case"), "read", breakGlass)).toMatchObject({
      audit: "break_glass_access",
      flagForReview: true,
      grant: { action: "read", target: { kind: "audit", stream: "case" } },
    });
    expect(decide(pl, evidenceAudit("case"), "list", breakGlass)).toBe("deny never");
    expect(decide(pl, evidenceAudit("security"), "read", breakGlass)).toBe("deny never");
    expect(decide(profile("consultant"), evidenceAudit("dsv", "staff-a"), "read")).toBe(
      "deny needs_break_glass",
    );
    // the review queue stays open, so the break-glass actions can be reviewed
    const romProfile = profile("regional_operations_manager");
    expect(decide(romProfile, evidenceAudit("review"), "read")).toBe("allow full");
    expect(decide(romProfile, evidenceAudit("review"), "list")).toBe("allow full");
    expect(decide(profile("admin"), evidenceAudit("case"), "read", breakGlass)).toBe("deny never");
  });
});

describe("org roles (Q57, Q80)", () => {
  it("shows the regional operations manager its review events and aggregates, in its region", () => {
    const own = rom([sample.regionId]);
    expect(decide(own, sampleAudit("review", null), "read")).toBe("allow full");
    expect(decide(own, sampleAggregate(), "read")).toBe("allow full");
    expect(decide(rom(["region-b"]), sampleAudit("review", null), "read")).toBe(
      "deny out_of_region",
    );
    expect(decide(own, { ...sampleAggregate(), regionId: null }, "read")).toBe(
      "deny out_of_region",
    );
  });

  it("gives it no participant data beyond 'evidence present' for exception evidence", () => {
    for (const phase of phases) {
      for (const resource of personResources(phase)) {
        for (const action of actions) {
          if (action === "open_document" && resource.kind !== "document") continue;
          for (const mode of modes) {
            const evidencePresent =
              resource.kind === "document" &&
              resource.documentType === "profiling_exception_evidence" &&
              action === "read" &&
              phase === "active";
            expect(decide(rom("all"), resource, action, mode)).toMatch(
              evidencePresent
                ? /^allow metadata_only$/
                : /^deny (never|not_in_list_payloads|needs_break_glass)$/,
            );
          }
        }
      }
    }
  });

  it("gives admins aggregates only, everywhere", () => {
    const admin = staff([], { org: [["admin", "all"]] });
    expect(decide(admin, { ...sampleAggregate(), regionId: null }, "read")).toBe("allow full");
    expect(decide(admin, sampleAudit("case", null), "read")).toBe("deny never");
  });
});

describe("participants (Q65, Q67)", () => {
  const participant = profile("participant");

  it("reach only their own participation", () => {
    const other = { ...field("confidential"), participationId: "participation-b" };
    expect(decide(participant, other, "read")).toBe("deny never");
  });

  it("write only self-service fields", () => {
    expect(decide(participant, identifiers("pensionInsuranceNumber"), "write")).toBe(
      "allow full sensitive_write",
    );
    expect(decide(participant, identifiers("iban"), "write")).toBe("deny never");
  });

  it("need the birth-date check only where they would otherwise be allowed", () => {
    const unchecked = profile("participant_unchecked");
    expect(decide(unchecked, field("health"), "read")).toBe("deny needs_knowledge_check");
    expect(decide(unchecked, field("health"), "list")).toBe("deny not_in_list_payloads");
    expect(decide(unchecked, doc("profiling_exception_evidence"), "read")).toBe("deny never");
  });
});
