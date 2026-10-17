import { DocumentType } from "../documents/catalog";
import { fieldCatalog } from "../fields/catalog";
import type { Edge } from "../lifecycle/edges";
import type { EvidenceCorrectionTarget } from "./corrections";
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

const document = (documentType: DocumentType): EvidenceCorrectionTarget => ({
  kind: "document",
  documentType,
  documentId: "document-a",
});

/** An operation on another person's request or action (four eyes). */
function sampleOperation(kind: OperationKind, correction: EvidenceCorrectionTarget): Operation {
  switch (kind) {
    case "decideProfilingException":
    case "approveEvidenceCorrection":
    case "decideRelaxation":
      return { kind, requestedBy: "staff-other" };
    case "reviewReconciliation":
    case "reviewBreakGlass":
      return { kind, actorStaffUserId: "staff-other" };
    case "requestEvidenceCorrection":
      return { kind, target: correction };
    default:
      return { kind };
  }
}

export const transitionWho = (edge: Edge) =>
  names((actor) => mayPerformTransition(actor, edge, target));

export const operationWho = (
  kind: OperationKind,
  correction: EvidenceCorrectionTarget = document("tl407_signed_scan"),
) => names((actor) => mayPerformOperation(actor, sampleOperation(kind, correction), target));

/** `requestEvidenceCorrection` per document type and per field (rounds 12–13, Q88). */
export const evidenceCorrectionWho = () => [
  ...DocumentType.options.map(
    (type) =>
      [`document ${type}`, operationWho("requestEvidenceCorrection", document(type))] as const,
  ),
  ...fieldCatalog.map(
    ({ key }) =>
      [
        `field ${key}`,
        operationWho("requestEvidenceCorrection", {
          kind: "field",
          fieldKey: key,
          entryId: "entry-a",
        }),
      ] as const,
  ),
];
