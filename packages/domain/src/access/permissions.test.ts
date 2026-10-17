import { describe, expect, it } from "vitest";
import { DocumentType } from "../documents/catalog";
import { fieldCatalog } from "../fields/catalog";
import { fieldCorrectionAuthority } from "./corrections";
import type { OrgRole, ProjectRole } from "../enums";
import { edges, type Edge } from "../lifecycle/edges";
import type { Subject } from "./decide";
import {
  mayPerformOperation,
  mayPerformTransition,
  OperationKind,
  type Actor,
  type Operation,
  type PermissionTarget,
} from "./permissions";
import type { EvidenceCorrectionTarget } from "./corrections";
import { sample } from "./profiles";

const target: PermissionTarget = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};

function staff(
  projectRoles: ProjectRole[],
  options: { org?: OrgRole; regions?: string[] | "all"; assigned?: boolean; id?: string } = {},
): Actor {
  const regionIds =
    options.regions === "all" ? "all" : new Set(options.regions ?? [sample.regionId]);
  return {
    kind: "staff",
    staffUserId: options.id ?? "staff-a",
    orgRoles: new Map(options.org ? [[options.org, { regionIds }]] : []),
    projectRoles: { [sample.projectId]: new Set(projectRoles) },
    assignedParticipationIds: new Set(options.assigned ? [sample.participationId] : []),
  };
}

const participant: Subject = {
  kind: "participant",
  participationId: sample.participationId,
  knowledgeCheckPassed: true,
};

/** The actors of the tables below, by column key. */
const actors: Record<string, Actor> = {
  PL: staff(["project_lead"]),
  C: staff(["consultant"], { assigned: true }),
  BO: staff(["back_office"]),
  ROM: staff([], { org: "regional_operations_manager" }),
  RA: staff([], { org: "regional_admin" }),
  AD: staff([], { org: "admin", regions: "all" }),
  P: participant,
  SYS: { kind: "system" },
};

const result = (p: { ok: boolean; because?: string }) => (p.ok ? "ok" : p.because);
const allowed = (check: (actor: Actor) => { ok: boolean }) =>
  Object.entries(actors)
    .filter(([, actor]) => check(actor).ok)
    .map(([key]) => key)
    .join(" ");

// Q60, Q80, plan 5.6: track from to actor kind → who may take it. Restated by hand.
const transitions = `
main - imported user manual: PL
main - self_registered participant anonymous_self_registration:
main self_registered imported user manual: PL
main self_registered rejected user manual: PL
main self_registered rejected system system: SYS
main imported contacted user manual: PL C
main contacted informed user manual: PL C
main contacted unreachable user manual: PL C
main unreachable contacted user manual: PL C
main informed active_in_tg system scheduled_entry: SYS
main informed active_in_tg system scheduled_entry_catchup: SYS
main informed active_in_tg user reconciliation: PL
main informed ta_completed user manual: PL
main active_in_tg exited user manual: PL C
main imported withdrawn user manual: PL
main imported withdrawn system system: SYS
main contacted withdrawn user manual: PL
main contacted withdrawn system system: SYS
main unreachable withdrawn user manual: PL
main unreachable withdrawn system system: SYS
main informed withdrawn user manual: PL
main informed withdrawn system system: SYS
profiling not_started profiling_accepted user manual: PL C
profiling not_started profiling_declined user manual: PL C
profiling profiling_accepted profiling_in_progress user manual: PL C
profiling profiling_accepted profiling_declined user manual: PL C
profiling profiling_in_progress profiling_done user manual: PL C
profiling profiling_in_progress profiling_declined user manual: PL C
profiling profiling_declined profiling_accepted user manual: PL C
dsv not_offered dsv_offered user manual: PL BO
dsv dsv_offered dsv_signed user manual: PL BO
dsv dsv_offered dsv_declined user manual: PL BO
dsv dsv_offered dsv_expired system system: SYS
dsv dsv_declined dsv_offered user manual: PL BO
dsv dsv_expired dsv_offered user manual: PL BO`
  .trim()
  .split("\n")
  .map((line) => line.split(":").map((part) => part.trim()) as [string, string]);

const edgeKey = (e: Edge) => [e.track, e.from ?? "-", e.to, e.actor, e.kind].join(" ");

describe("mayPerformTransition (AC-28, Q60)", () => {
  it("restates every edge", () => {
    expect(transitions.map(([key]) => key)).toEqual(edges.map(edgeKey));
  });

  it.each(transitions)("%s: %s", (key, who) => {
    const edge = edges.find((e) => edgeKey(e) === key)!;
    expect(allowed((actor) => mayPerformTransition(actor, edge, target))).toBe(who);
  });

  const contact = edges.find((e) => edgeKey(e) === "main imported contacted user manual")!;
  const create = edges.find((e) => edgeKey(e) === "main - imported user manual")!;
  const expiry = edges.find((e) => e.to === "dsv_expired")!;

  it("needs the assignment for a consultant, and a role in the project for everyone", () => {
    expect(result(mayPerformTransition(staff(["consultant"]), contact, target))).toBe(
      "not_assigned",
    );
    const projectWide = { ...target, participationId: null };
    expect(result(mayPerformTransition(actors.C!, contact, projectWide))).toBe("not_assigned");
    expect(result(mayPerformTransition(actors.C!, create, projectWide))).toBe("role_not_allowed");
    const otherProject = { ...target, projectId: "project-b" };
    expect(result(mayPerformTransition(actors.PL!, contact, otherProject))).toBe("not_member");
  });

  it("keeps system edges for the system and staff edges for staff", () => {
    expect(result(mayPerformTransition(actors.PL!, expiry, target))).toBe("actor_not_allowed");
    expect(result(mayPerformTransition(actors.SYS!, contact, target))).toBe("actor_not_allowed");
    expect(result(mayPerformTransition(participant, create, target))).toBe("actor_not_allowed");
    const selfRegistration = edges.find((e) => e.kind === "anonymous_self_registration")!;
    for (const actor of Object.values(actors)) {
      expect(result(mayPerformTransition(actor, selfRegistration, target))).toBe(
        "anonymous_registration_only",
      );
    }
    expect(result(mayPerformTransition(actors.ROM!, contact, target))).toBe("role_not_allowed");
  });
});

// Q60, Q80, round 10 §6, round 11: who may perform each operation (another person's request).
const operations: Record<OperationKind, string> = {
  assignEntryWave: "PL",
  requestProfilingException: "PL",
  decideProfilingException: "ROM",
  revokeProfilingException: "PL",
  supersedeStaleException: "SYS",
  correctEndReason: "PL",
  reviewReconciliation: "ROM",
  reviewBreakGlass: "ROM",
  requestClarification: "ROM",
  requestEvidenceCorrection: "PL BO",
  approveEvidenceCorrection: "ROM",
  editProject: "PL",
  editEntryWaves: "PL",
  pinTemplate: "PL",
  changeOverride: "PL",
  requestRelaxation: "PL",
  decideRelaxation: "ROM",
  withdrawRelaxation: "PL",
};

const operation = (kind: OperationKind, other = "staff-other"): Operation => {
  switch (kind) {
    case "decideProfilingException":
    case "approveEvidenceCorrection":
    case "decideRelaxation":
      return { kind, requestedBy: other };
    case "reviewReconciliation":
    case "reviewBreakGlass":
      return { kind, actorStaffUserId: other };
    case "requestEvidenceCorrection":
      return {
        kind,
        target: { kind: "document", documentType: "dsv_signed_scan", documentId: "d" },
      };
    default:
      return { kind };
  }
};

const correction = (correctionTarget: EvidenceCorrectionTarget) =>
  allowed((actor) =>
    mayPerformOperation(
      actor,
      { kind: "requestEvidenceCorrection", target: correctionTarget },
      target,
    ),
  );
const correctedField = (fieldKey: string, entryId?: string) =>
  correction({ kind: "field", fieldKey, ...(entryId && { entryId }) });

describe("mayPerformOperation (AC-25, AC-28, Q60, Q80)", () => {
  it("lists every operation", () => {
    expect(Object.keys(operations)).toEqual(OperationKind.options);
  });

  it.each(Object.entries(operations))("%s: %s", (kind, who) => {
    const op = operation(kind as OperationKind);
    expect(allowed((actor) => mayPerformOperation(actor, op, target))).toBe(who);
  });

  it("never lets the regional operations manager decide or review their own case (four eyes)", () => {
    const rom = staff(["project_lead"], { org: "regional_operations_manager", id: "staff-r" });
    for (const kind of [
      "decideProfilingException",
      "reviewReconciliation",
      "reviewBreakGlass",
      "approveEvidenceCorrection",
      "decideRelaxation", // AC-15: never the requester (R2)
    ] as const) {
      expect([kind, result(mayPerformOperation(rom, operation(kind, "staff-r"), target))]).toEqual([
        kind,
        "four_eyes",
      ]);
      expect(result(mayPerformOperation(rom, operation(kind), target))).toBe("ok");
    }
    // the same person may still request as PL
    expect(result(mayPerformOperation(rom, operation("requestProfilingException"), target))).toBe(
      "ok",
    );
    expect(result(mayPerformOperation(rom, operation("requestRelaxation"), target))).toBe("ok");
  });

  it("keeps the regional operations manager to its region", () => {
    const decide = operation("decideProfilingException");
    const elsewhere = staff([], { org: "regional_operations_manager", regions: ["region-b"] });
    expect(result(mayPerformOperation(elsewhere, decide, target))).toBe("out_of_region");
    const noRegion = { ...target, regionId: null };
    expect(result(mayPerformOperation(actors.ROM!, decide, noRegion))).toBe("out_of_region");
    const all = staff([], { org: "regional_operations_manager", regions: "all" });
    expect(result(mayPerformOperation(all, decide, noRegion))).toBe("ok");
  });

  it("takes evidence-correction requesters from the authority table, not open rights (round 12)", () => {
    const byType = Object.fromEntries(
      DocumentType.options.map((documentType) => [
        documentType,
        correction({ kind: "document", documentType, documentId: "d" }),
      ]),
    );
    expect(byType).toEqual({
      tl407_signed_scan: "PL",
      kug200b_signed_scan: "PL",
      dsv_signed_scan: "PL BO",
      dsv_cancellation: "PL BO",
      asu_proof: "PL",
      profiling_exception_evidence: "PL",
      participant_upload: "PL",
      qualification_certificate: "PL",
    });
  });

  it("corrects evidence-set fields by responsibility, nothing else (Q88, round 13)", () => {
    expect(correctedField("lastName")).toBe("PL");
    expect(correctedField("personnelNumber")).toBe("PL");
    expect(correctedField("pensionInsuranceNumber")).toBe("BO");
    expect(correctedField("baCustomerNumber")).toBe("BO");
    expect(correctedField("tgEntryDate")).toBe("PL BO");
    // not evidence-set data: corrected by the active/payroll operations while retained
    for (const key of [
      "address",
      "taxId",
      "iban",
      "absencePeriods",
      "status",
      "healthRestrictions",
    ]) {
      expect([key, correctedField(key)]).toEqual([key, ""]);
    }
    expect(() => correctedField("custom.unknown")).toThrow("Unknown field custom.unknown");
    // a profiling-session correction names the session, never the whole collection
    expect(correctedField("profilingSessions", "session-1")).toBe("PL");
    expect(correctedField("profilingSessions")).toBe("");
    const pl = actors.PL!;
    const whole = {
      kind: "requestEvidenceCorrection",
      target: { kind: "field", fieldKey: "profilingSessions" },
    } as const;
    expect(result(mayPerformOperation(pl, whole, target))).toBe("entry_required");
    const keys = new Set(fieldCatalog.map((f) => f.key));
    for (const key of Object.keys(fieldCorrectionAuthority)) expect(keys.has(key)).toBe(true);
  });

  it("keeps staff operations from the system and participants, and the system's from staff", () => {
    const assign = operation("assignEntryWave");
    expect(result(mayPerformOperation(actors.SYS!, assign, target))).toBe("actor_not_allowed");
    expect(result(mayPerformOperation(participant, assign, target))).toBe("actor_not_allowed");
    const supersede = operation("supersedeStaleException");
    expect(result(mayPerformOperation(actors.PL!, supersede, target))).toBe("actor_not_allowed");
    expect(result(mayPerformOperation(actors.C!, assign, target))).toBe("role_not_allowed");
    expect(result(mayPerformOperation(staff([]), assign, target))).toBe("not_member");
  });
});
