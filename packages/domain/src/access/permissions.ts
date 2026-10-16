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
  /** The anonymous self-registration of Slice 4c, never through the transition service. */
  | "anonymous_registration_only"
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
]);
export type OperationKind = z.infer<typeof OperationKind>;

/** An operation, with the other person of a four-eyes check where there is one. */
export type Operation =
  | {
      kind: Exclude<
        OperationKind,
        | "decideProfilingException"
        | "approveEvidenceCorrection"
        | "reviewReconciliation"
        | "reviewBreakGlass"
        | "requestEvidenceCorrection"
      >;
    }
  | { kind: "decideProfilingException" | "approveEvidenceCorrection"; requestedBy: string }
  | { kind: "reviewReconciliation" | "reviewBreakGlass"; actorStaffUserId: string }
  | { kind: "requestEvidenceCorrection"; target: EvidenceCorrectionTarget };

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
  if (edge.kind === "anonymous_self_registration") return no("anonymous_registration_only");
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
