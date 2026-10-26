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
  mayBookFor,
  mayManageAppointment,
  mayRecordAttendance,
  mayResolveAppointmentItem,
  mayRemind,
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

// Q60, Q80 (data-protection.md, access matrix): track from to actor kind → who may take it.
// Restated by hand.
const transitions = `
main - imported user manual: PL
main imported contacted user manual: PL C
main contacted informed user manual: PL C
main contacted unreachable user manual: PL C
main unreachable contacted user manual: PL C
main imported contacted participant activation: P
main unreachable contacted participant activation: P
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

describe("mayPerformTransition (Q60)", () => {
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
    expect(result(mayPerformTransition(actors.ROM!, contact, target))).toBe("role_not_allowed");
  });

  it("lets a participant take only the activation edges of their own participation (ADR-0007)", () => {
    const activation = edges.find((e) => e.kind === "activation")!;
    expect(result(mayPerformTransition(participant, activation, target))).toBe("ok");
    const other = { ...target, participationId: "participation-b" };
    expect(result(mayPerformTransition(participant, activation, other))).toBe("actor_not_allowed");
    expect(result(mayPerformTransition(participant, contact, target))).toBe("actor_not_allowed");
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
  activateProject: "PL",
  editEntryWaves: "PL",
  pinTemplate: "PL",
  changeOverride: "PL",
  migrateTemplate: "PL",
  requestRelaxation: "PL",
  decideRelaxation: "ROM",
  withdrawRelaxation: "PL",
  importParticipations: "PL",
  setParticipationDates: "PL",
  manageMembers: "PL",
  addReplacementLead: "PL AD",
  assignParticipations: "PL",
  setProjectRegion: "PL AD",
  issueActivationCode: "PL BO",
  recordHandover: "PL BO",
  revokeActivationCode: "PL BO",
  providePrivacyNotice: "PL BO",
  setPlacementAgentur: "PL BO",
  startAssistedMode: "PL C BO",
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
    case "addReplacementLead":
      return { kind, staffUserId: other };
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

describe("mayPerformOperation (Q60, Q80)", () => {
  it("lists every operation", () => {
    expect(Object.keys(operations)).toEqual(OperationKind.options);
  });

  it.each(Object.entries(operations))("%s: %s", (kind, who) => {
    const op = operation(kind as OperationKind);
    expect(allowed((actor) => mayPerformOperation(actor, op, target))).toBe(who);
  });

  it("lets only the assigned consultant open assisted mode among consultants (Q136)", () => {
    const unassigned = staff(["consultant"]);
    expect(result(mayPerformOperation(unassigned, operation("startAssistedMode"), target))).toBe(
      "not_assigned",
    );
  });

  it("never lets the regional operations manager decide or review their own case (four eyes)", () => {
    const rom = staff(["project_lead"], { org: "regional_operations_manager", id: "staff-r" });
    for (const kind of [
      "decideProfilingException",
      "reviewReconciliation",
      "reviewBreakGlass",
      "approveEvidenceCorrection",
      "decideRelaxation", // never the requester (regional-variation.md, rule relaxations)
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
      cv: "PL",
      participant_upload: "PL",
      qualification_certificate: "PL",
      tl407_form: "",
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

const addLead = (staffUserId: string): Operation => ({ kind: "addReplacementLead", staffUserId });

describe("team and region operations (Q126)", () => {
  it("lets a global admin add a replacement PL, never themselves; regional admins can't", () => {
    const admin = staff([], { org: "admin", regions: "all", id: "staff-admin" });
    expect(result(mayPerformOperation(admin, addLead("staff-other"), target))).toBe("ok");
    expect(result(mayPerformOperation(admin, addLead("staff-admin"), target))).toBe("own_account");
    expect(result(mayPerformOperation(actors.RA!, addLead("staff-other"), target))).toBe(
      "role_not_allowed",
    );
    // A global admin gains no team management or assignment right by the replacement
    const manage = operation("manageMembers");
    expect(result(mayPerformOperation(admin, manage, target))).toBe("role_not_allowed");
    const assign = operation("assignParticipations");
    expect(result(mayPerformOperation(admin, assign, target))).toBe("role_not_allowed");
  });

  it("scopes a project's region change to its PL and the global admin, in any region", () => {
    const region = operation("setProjectRegion");
    const noRegion = { ...target, regionId: null };
    expect(result(mayPerformOperation(actors.AD!, region, noRegion))).toBe("ok");
    expect(result(mayPerformOperation(actors.RA!, region, target))).toBe("role_not_allowed");
    expect(result(mayPerformOperation(actors.PL!, region, { ...target, projectId: "x" }))).toBe(
      "not_member",
    );
  });
});

describe("mayRemind (Q153)", () => {
  it("lets the PL and the assigned consultant remind, nobody else", () => {
    expect(allowed((actor) => mayRemind(actor, target))).toBe("PL C");
  });

  it("refuses an unassigned consultant and anyone outside the project", () => {
    expect(result(mayRemind(staff(["consultant"]), target))).toBe("not_assigned");
    expect(result(mayRemind(staff(["back_office"]), target))).toBe("role_not_allowed");
    expect(result(mayRemind(staff([]), target))).toBe("not_member");
    expect(result(mayRemind({ kind: "system" }, target))).toBe("actor_not_allowed");
  });
});

describe("mayManageAppointment (Q162)", () => {
  const event = { kind: "info_event", hostStaffUserId: null } as const;
  const ownSlot = { kind: "consultation", hostStaffUserId: "staff-a" } as const;
  const otherSlot = { kind: "consultation", hostStaffUserId: "staff-b" } as const;

  it("lets the PL manage every appointment and change any host", () => {
    for (const appointment of [event, ownSlot, otherSlot]) {
      expect(allowed((actor) => mayManageAppointment(actor, appointment, target))).toContain("PL");
      expect(allowed((actor) => mayManageAppointment(actor, appointment, target, "host"))).toBe(
        "PL",
      );
    }
  });

  it("lets a consultant manage their own slots only, never an info event or a host", () => {
    // Assignment plays no part: a slot isn't a participation.
    const consultant = staff(["consultant"]);
    expect(result(mayManageAppointment(consultant, ownSlot, target))).toBe("ok");
    expect(result(mayManageAppointment(consultant, otherSlot, target))).toBe("role_not_allowed");
    expect(result(mayManageAppointment(consultant, event, target))).toBe("role_not_allowed");
    expect(result(mayManageAppointment(consultant, ownSlot, target, "host"))).toBe(
      "role_not_allowed",
    );
  });

  it("refuses back office, org roles, non-members, participants and the system", () => {
    expect(allowed((actor) => mayManageAppointment(actor, event, target))).toBe("PL");
    expect(result(mayManageAppointment(staff(["back_office"]), event, target))).toBe(
      "role_not_allowed",
    );
    expect(
      result(mayManageAppointment(staff([], { org: "admin", regions: "all" }), event, target)),
    ).toBe("role_not_allowed");
    expect(result(mayManageAppointment(staff([]), ownSlot, target))).toBe("not_member");
    const elsewhere: Actor = {
      ...(staff(["project_lead"]) as Subject & { kind: "staff" }),
      projectRoles: {},
    };
    expect(result(mayManageAppointment(elsewhere, event, target))).toBe("not_member");
    expect(result(mayManageAppointment(participant, event, target))).toBe("actor_not_allowed");
  });
});

describe("mayBookFor (Q62, Q162)", () => {
  it("lets the PL and the assigned consultant book, nobody else", () => {
    expect(allowed((actor) => mayBookFor(actor, target))).toBe("PL C");
  });

  it("refuses an unassigned consultant, back office and anyone outside the project", () => {
    expect(result(mayBookFor(staff(["consultant"]), target))).toBe("not_assigned");
    expect(result(mayBookFor(staff(["back_office"]), target))).toBe("role_not_allowed");
    expect(result(mayBookFor(staff([], { org: "regional_admin" }), target))).toBe(
      "role_not_allowed",
    );
    expect(result(mayBookFor(staff([]), target))).toBe("not_member");
    expect(result(mayBookFor({ kind: "system" }, target))).toBe("actor_not_allowed");
  });
});

describe("mayRecordAttendance (Q62, Q163)", () => {
  it("lets the PL and the assigned consultant record, after the close the PL only", () => {
    expect(allowed((actor) => mayRecordAttendance(actor, target))).toBe("PL C");
    expect(allowed((actor) => mayRecordAttendance(actor, target, true))).toBe("PL");
    expect(result(mayRecordAttendance(staff(["consultant"]), target))).toBe("not_assigned");
    expect(result(mayRecordAttendance(staff(["back_office"]), target))).toBe("role_not_allowed");
    expect(result(mayRecordAttendance(staff([]), target))).toBe("not_member");
  });
});

describe("mayResolveAppointmentItem (Q163)", () => {
  it("leaves an attendance conflict to the PL", () => {
    expect(
      allowed((actor) => mayResolveAppointmentItem(actor, target, "attendance_conflict")),
    ).toBe("PL");
    expect(
      result(
        mayResolveAppointmentItem(
          staff(["consultant"], { assigned: true }),
          target,
          "attendance_conflict",
        ),
      ),
    ).toBe("role_not_allowed");
  });

  it("leaves an undelivered notice to the PL and the assigned consultant (data-protection.md, messages)", () => {
    expect(allowed((actor) => mayResolveAppointmentItem(actor, target, "notice_undelivered"))).toBe(
      "PL C",
    );
    expect(
      result(mayResolveAppointmentItem(staff(["consultant"]), target, "notice_undelivered")),
    ).toBe("not_assigned");
    expect(
      result(mayResolveAppointmentItem(staff(["back_office"]), target, "notice_undelivered")),
    ).toBe("role_not_allowed");
  });

  it("leaves a missed appointment to the PL and the assigned consultant (process-and-lifecycle.md, appointments)", () => {
    expect(allowed((actor) => mayResolveAppointmentItem(actor, target, "missed"))).toBe("PL C");
    expect(result(mayResolveAppointmentItem(staff(["consultant"]), target, "missed"))).toBe(
      "not_assigned",
    );
    expect(result(mayResolveAppointmentItem(staff(["back_office"]), target, "missed"))).toBe(
      "role_not_allowed",
    );
  });
});
