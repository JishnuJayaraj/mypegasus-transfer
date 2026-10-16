import { DocumentType } from "../documents/catalog";
import type { Edge } from "../lifecycle/edges";
import {
  mayPerformOperation,
  mayPerformTransition,
  type Actor,
  type Operation,
  type OperationKind,
  type Permission,
} from "./permissions";
import { accessProfiles, sample } from "./profiles";

// Who may take an edge or perform an operation, as names for the generated tables.

const target = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};
const actors: { label: string; actor: Actor }[] = [
  ...accessProfiles.map(({ label, subject }) => ({ label, actor: subject })),
  { label: "system", actor: { kind: "system" } },
];
const names = (check: (actor: Actor) => Permission) =>
  actors.filter(({ actor }) => check(actor).ok).map(({ label }) => label);

/** An operation on another person's request or action (four eyes). */
function sampleOperation(kind: OperationKind, documentType: DocumentType): Operation {
  switch (kind) {
    case "decideProfilingException":
    case "approveEvidenceCorrection":
      return { kind, requestedBy: "staff-other" };
    case "reviewReconciliation":
    case "reviewBreakGlass":
      return { kind, actorStaffUserId: "staff-other" };
    case "requestEvidenceCorrection":
      return { kind, documentType };
    default:
      return { kind };
  }
}

export const transitionWho = (edge: Edge) =>
  names((actor) => mayPerformTransition(actor, edge, target));

export const operationWho = (
  kind: OperationKind,
  documentType: DocumentType = "tl407_signed_scan",
) => names((actor) => mayPerformOperation(actor, sampleOperation(kind, documentType), target));

/** `requestEvidenceCorrection` per document type (round 11). */
export const evidenceCorrectionWho = () =>
  DocumentType.options.map(
    (type) => [type, operationWho("requestEvidenceCorrection", type)] as const,
  );
