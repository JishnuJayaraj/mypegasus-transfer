import { z } from "zod";
import type { OrgRole, ProjectRole } from "../enums";
import type { Edge } from "../lifecycle/edges";
import { correctionRequesters, needsEntry, type EvidenceCorrectionTarget } from "./corrections";
import type { RegionScope, Subject } from "./decide";

/**
 * Who may take a lifecycle edge or perform an operation (data-protection.md, access matrix; Q60
 * confirmed, Q80 *assumed*, round 10 §6, rounds 11–13). The status service checks this and
 * the lifecycle rules (`canTransition`, the operations) before it calls a status function; nothing
 * callable from outside bypasses either.
 */
export type Actor = Subject | { kind: "system" };

export type PermissionTarget = {
  projectId: string;
  regionId: string | null;
  /** `null` when a participation is created. */
  participationId: string | null;
};

export type PermissionDenial =
  | "actor_not_allowed"
  | "not_member"
  | "not_assigned"
  | "out_of_region"
  | "role_not_allowed"
  | "four_eyes"
  /** Nobody grants themselves a project role as a replacement PL (Q126). */
  | "own_account"
  /** A correction of a collection field names the entry it corrects. */
  | "entry_required";
export type Permission = { ok: true } | { ok: false; because: PermissionDenial };

export const OperationKind = z.enum([
  "assignEntryWave",
  "requestProfilingException",
  "decideProfilingException",
  "revokeProfilingException",
  "supersedeStaleException",
  "correctEndReason",
  "reviewReconciliation",
  "reviewBreakGlass",
  "requestClarification",
  "requestEvidenceCorrection",
  "approveEvidenceCorrection",
  // Slice 2: project setup (regional-variation.md)
  "editProject",
  "activateProject",
  "editEntryWaves",
  "pinTemplate",
  "changeOverride",
  "migrateTemplate",
  "requestRelaxation",
  "decideRelaxation",
  "withdrawRelaxation",
  // Slice 2: the import and individual TG dates (process-and-lifecycle.md)
  "importParticipations",
  "setParticipationDates",
  // Slice 3: teams, assignments and the project's region (Q62, Q126)
  "manageMembers",
  "addReplacementLead",
  "assignParticipations",
  "setProjectRegion",
  // Slice 3: participant activation and the Art. 14 notice (ADR-0007)
  "issueActivationCode",
  "recordHandover",
  "revokeActivationCode",
  "providePrivacyNotice",
  // Slice 4a: the placement Agentur (Q139)
  "setPlacementAgentur",
  // Slice 4a: the wizard on the participant's behalf (Q136, ADR-0007)
  "startAssistedMode",
]);
export type OperationKind = z.infer<typeof OperationKind>;

/** An operation, with the other person of a four-eyes check where there is one. */
export type Operation =
  | {
      kind: Exclude<
        OperationKind,
        | "decideProfilingException"
        | "approveEvidenceCorrection"
        | "decideRelaxation"
        | "reviewReconciliation"
        | "reviewBreakGlass"
        | "requestEvidenceCorrection"
        | "addReplacementLead"
      >;
    }
  | {
      kind: "decideProfilingException" | "approveEvidenceCorrection" | "decideRelaxation";
      requestedBy: string;
    }
  | { kind: "reviewReconciliation" | "reviewBreakGlass"; actorStaffUserId: string }
  | { kind: "requestEvidenceCorrection"; target: EvidenceCorrectionTarget }
  /** The staff user who becomes PL. */
  | { kind: "addReplacementLead"; staffUserId: string };

type Role = ProjectRole | OrgRole;

const ok: Permission = { ok: true };
const no = (because: PermissionDenial): Permission => ({ ok: false, because });

/** Q60: the assigned consultant contacts, informs, runs profiling and records the exit. */
function consultantEdge(edge: Edge): boolean {
  if (edge.track === "profiling") return true;
  return (
    edge.track === "main" && ["contacted", "unreachable", "informed", "exited"].includes(edge.to)
  );
}

const transitionRoles: Partial<Record<Role, (edge: Edge) => boolean>> = {
  project_lead: () => true, // every manual edge of the project (Q60)
  consultant: consultantEdge,
  back_office: (edge) => edge.track === "dsv", // offer, re-offer, signed, declined (Q60)
};

/** The roles an operation needs; evidence corrections also by the authority table (round 12). */
const operationRoles: Record<Exclude<OperationKind, "supersedeStaleException">, Role[]> = {
  assignEntryWave: ["project_lead"],
  requestProfilingException: ["project_lead"],
  revokeProfilingException: ["project_lead"],
  correctEndReason: ["project_lead"],
  decideProfilingException: ["regional_operations_manager"],
  reviewReconciliation: ["regional_operations_manager"],
  reviewBreakGlass: ["regional_operations_manager"],
  requestClarification: ["regional_operations_manager"],
  requestEvidenceCorrection: ["project_lead", "back_office"],
  approveEvidenceCorrection: ["regional_operations_manager"],
  editProject: ["project_lead"],
  activateProject: ["project_lead"],
  editEntryWaves: ["project_lead"],
  pinTemplate: ["project_lead"],
  changeOverride: ["project_lead"],
  migrateTemplate: ["project_lead"],
  // Rule relaxations (regional-variation.md): the PL asks or withdraws, another person decides.
  requestRelaxation: ["project_lead"],
  decideRelaxation: ["regional_operations_manager"],
  withdrawRelaxation: ["project_lead"],
  // The import is a domain operation of the PL (Q60); preview and confirm alike.
  importParticipations: ["project_lead"],
  // Contractual dates (5.7; Q102, round 32): the PL only, back office none.
  setParticipationDates: ["project_lead"],
  // Teams (Q126): the PL manages members and assigns participations (Q62); a global admin adds a
  // replacement PL for recovery, never themselves, and gains no case access by it. A regional
  // admin manages no team. The region: the PL (while draft, `regionChangeRefusal`), the admin.
  manageMembers: ["project_lead"],
  addReplacementLead: ["project_lead", "admin"],
  assignParticipations: ["project_lead"],
  setProjectRegion: ["project_lead", "admin"],
  issueActivationCode: ["project_lead", "back_office"],
  recordHandover: ["project_lead", "back_office"],
  revokeActivationCode: ["project_lead", "back_office"],
  providePrivacyNotice: ["project_lead", "back_office"],
  // The placement Agentur (Q139): the PL or back office of the project; never a consultant.
  setPlacementAgentur: ["project_lead", "back_office"],
  // Assisted mode (Q136): the PL, the assigned consultant and back office of the project.
  startAssistedMode: ["project_lead", "consultant", "back_office"],
};

const inRegion = ({ regionIds }: RegionScope, regionId: string | null) =>
  regionIds === "all" || (regionId !== null && regionIds.has(regionId));

const denialRank: PermissionDenial[] = [
  "four_eyes",
  "not_assigned",
  "out_of_region",
  "role_not_allowed",
  "not_member",
];

/** Allowed if any role the staff member holds allows it; else the most telling denial. */
export function staffPermission(
  subject: Extract<Subject, { kind: "staff" }>,
  target: PermissionTarget,
  allows: (role: Role) => boolean,
  otherParty?: string,
): Permission {
  // One denial per role, or null where that role allows it.
  const check = (role: Role, scoped: PermissionDenial | null): PermissionDenial | null => {
    if (!allows(role)) return "role_not_allowed";
    if (scoped) return scoped;
    return otherParty === subject.staffUserId ? "four_eyes" : null;
  };
  const assigned =
    target.participationId !== null && subject.assignedParticipationIds.has(target.participationId);
  const denials = [
    ...[...subject.orgRoles].map(([role, scope]) =>
      check(role, inRegion(scope, target.regionId) ? null : "out_of_region"),
    ),
    ...[...(subject.projectRoles[target.projectId] ?? [])].map((role) =>
      check(role, role === "consultant" && !assigned ? "not_assigned" : null),
    ),
  ];
  if (denials.includes(null)) return ok;
  const best = denialRank.find((d) => denials.includes(d));
  return no(best ?? "not_member");
}

export function mayPerformTransition(
  actor: Actor,
  edge: Edge,
  target: PermissionTarget,
): Permission {
  if (actor.kind === "system") return edge.actor === "system" ? ok : no("actor_not_allowed");
  // A participant takes exactly the activation edges of their own participation (ADR-0007),
  // never a staff edge (Q60, round 12).
  if (actor.kind === "participant") {
    return edge.kind === "activation" && actor.participationId === target.participationId
      ? ok
      : no("actor_not_allowed");
  }
  if (edge.actor !== "user") return no("actor_not_allowed");
  return staffPermission(actor, target, (role) => transitionRoles[role]?.(edge) ?? false);
}

export function mayPerformOperation(
  actor: Actor,
  operation: Operation,
  target: PermissionTarget,
): Permission {
  if (operation.kind === "supersedeStaleException") {
    return actor.kind === "system" ? ok : no("actor_not_allowed");
  }
  if (actor.kind !== "staff") return no("actor_not_allowed");
  if (operation.kind === "requestEvidenceCorrection" && needsEntry(operation.target)) {
    return no("entry_required");
  }
  if (operation.kind === "addReplacementLead" && operation.staffUserId === actor.staffUserId) {
    return no("own_account");
  }
  const roles: Role[] = operationRoles[operation.kind];
  const allows = (role: Role) =>
    roles.includes(role) &&
    (operation.kind !== "requestEvidenceCorrection" ||
      (correctionRequesters(operation.target) as readonly Role[]).includes(role));
  const otherParty =
    "requestedBy" in operation
      ? operation.requestedBy
      : "actorStaffUserId" in operation
        ? operation.actorStaffUserId
        : undefined;
  return staffPermission(actor, target, allows, otherParty);
}

/**
 * Who may request a reminder (data-protection.md, reminders; Q153): a current PL of the project,
 * or the consultant currently assigned to the participation. No other role, never the system or a
 * participant; assisted mode and break-glass grant nothing here (the API refuses them before).
 */
export function mayRemind(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return no("actor_not_allowed");
  return staffPermission(actor, target, (role) => role === "project_lead" || role === "consultant");
}

/** An appointment as the permissions see it (process-and-lifecycle.md, appointments). */
export type AppointmentScope = {
  kind: "info_event" | "consultation";
  hostStaffUserId: string | null;
};

/**
 * Who creates, changes and cancels an appointment (data-protection.md, appointments; Q162): a
 * current PL of the project any appointment, a consultant of the project only their own slots
 * (a consultation they host). Changing the host is the PL's alone (`"host"`). Org roles, back
 * office, participants and the system none; assisted mode and break-glass grant nothing (the
 * staff routes have neither).
 */
export function mayManageAppointment(
  actor: Actor,
  appointment: AppointmentScope,
  target: Pick<PermissionTarget, "projectId">,
  change: "manage" | "host" = "manage",
): Permission {
  if (actor.kind !== "staff") return no("actor_not_allowed");
  const roles = actor.projectRoles[target.projectId] ?? new Set<ProjectRole>();
  const ownSlot =
    change === "manage" &&
    appointment.kind === "consultation" &&
    appointment.hostStaffUserId === actor.staffUserId;
  if (roles.has("project_lead") || (ownSlot && roles.has("consultant"))) return ok;
  return no(roles.size > 0 || actor.orgRoles.size > 0 ? "role_not_allowed" : "not_member");
}

/**
 * Who books or cancels a booking for a participation (data-protection.md, appointments; Q62,
 * Q162): a current PL of the project, or the consultant currently assigned to it. Back office
 * reads bookings and books none; org roles, participants and the system nothing here.
 */
export function mayBookFor(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return no("actor_not_allowed");
  return staffPermission(actor, target, (role) => role === "project_lead" || role === "consultant");
}

/**
 * Who records or corrects attendance and confirms what it rests on (data-protection.md,
 * appointments; Q62, Q163): a current PL of the project, or the consultant currently assigned to
 * the participation; after the participation closed (`afterClose`) the PL only. Back office reads
 * attendance and records none; org roles, participants and the system nothing here.
 */
export function mayRecordAttendance(
  actor: Actor,
  target: PermissionTarget,
  afterClose = false,
): Permission {
  if (actor.kind !== "staff") return no("actor_not_allowed");
  return staffPermission(
    actor,
    target,
    (role) => role === "project_lead" || (!afterClose && role === "consultant"),
  );
}

export type ResolvableAppointmentItem = "attendance_conflict" | "notice_undelivered" | "missed";
const itemRoles: Record<ResolvableAppointmentItem, readonly Role[]> = {
  attendance_conflict: ["project_lead"],
  notice_undelivered: ["project_lead", "consultant"],
  missed: ["project_lead", "consultant"],
};

/**
 * Who resolves a participation's appointment item (data-protection.md, appointments; Q163): an
 * `attendance_conflict` (escalating it or attesting the information was delivered otherwise) is
 * the PL's alone, also after the participation closed; a `notice_undelivered` (recording how the
 * person was told, data-protection.md, messages) and a `missed` appointment (no further follow-up,
 * process-and-lifecycle.md, appointments: the work list) the PL's or the assigned consultant's.
 */
export function mayResolveAppointmentItem(
  actor: Actor,
  target: PermissionTarget,
  item: ResolvableAppointmentItem,
): Permission {
  if (actor.kind !== "staff") return no("actor_not_allowed");
  return staffPermission(actor, target, (role) => itemRoles[item].includes(role));
}
