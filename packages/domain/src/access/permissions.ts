import { z } from "zod";
import type { OrgRole, ProjectRole } from "../enums";
import type { Edge } from "../lifecycle/edges";
import { correctionRequesters, needsEntry, type EvidenceCorrectionTarget } from "./corrections";
import type { RegionScope, Subject } from "./decide";

/**
 * Who may take a lifecycle edge or perform an operation (plan 5.6; Q60 confirmed, Q80
 * *assumed*, round 10 §6, rounds 11–13). The status service (PR 1g) checks this and the lifecycle
 * rules (`canTransition`, the operations) before it calls a status function; nothing callable
 * from outside bypasses either.
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
  // Slice 2: project setup (plan 5.4)
  "editProject",
  "activateProject",
  "editEntryWaves",
  "pinTemplate",
  "changeOverride",
  "migrateTemplate",
  "requestRelaxation",
  "decideRelaxation",
  "withdrawRelaxation",
  // Slice 2: the import (plan 5.4, 5.11); individual TG dates (5.7, PR 2h-3)
  "importParticipations",
  "setParticipationDates",
  // Slice 3: teams, assignments and the project's region (Q62, Q126)
  "manageMembers",
  "addReplacementLead",
  "assignParticipations",
  "setProjectRegion",
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
  // Rule relaxations (Slice 2 plan 5.9, R2): the PL asks or withdraws, another person decides.
  requestRelaxation: ["project_lead"],
  decideRelaxation: ["regional_operations_manager"],
  withdrawRelaxation: ["project_lead"],
  // The import is a domain operation of the PL (R17, Q60); preview and confirm alike.
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

/** Allowed if any role the staff member holds allows it (D6); else the most telling denial. */
function staffPermission(
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
  // An authenticated participant takes no transition (Q60, round 12).
  if (actor.kind === "participant" || edge.actor !== "user") return no("actor_not_allowed");
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
