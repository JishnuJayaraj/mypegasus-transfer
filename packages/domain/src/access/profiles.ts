import type { DocumentType } from "../documents/catalog";
import type { OrgRole, ProjectRole } from "../enums";
import { AccessCategory, fieldCatalog } from "../fields/catalog";
import type {
  AccessMode,
  AccessPhase,
  AggregateResource,
  AuditResource,
  AuditStream,
  DocumentResource,
  FieldResource,
  Subject,
} from "./decide";

/** Synthetic ids for the generated matrix and the tests. */
export const sample = {
  projectId: "project-a",
  regionId: "region-a",
  participationId: "participation-a",
} as const;

function staff(projectRoles: ProjectRole[], orgRole?: OrgRole, assigned = false): Subject {
  const regionIds = orgRole === "admin" ? "all" : new Set([sample.regionId]);
  return {
    kind: "staff",
    staffUserId: "staff-a",
    orgRoles: new Map(orgRole ? [[orgRole, { regionIds }]] : []),
    projectRoles: { [sample.projectId]: new Set(projectRoles) },
    assignedParticipationIds: new Set(assigned ? [sample.participationId] : []),
  };
}

const participant = (knowledgeCheckPassed: boolean): Subject => ({
  kind: "participant",
  participationId: sample.participationId,
  knowledgeCheckPassed,
});

/** One subject per column of the generated matrix; org roles act in their own region. */
export const accessProfiles: readonly { key: string; label: string; subject: Subject }[] = [
  { key: "participant", label: "Participant (own)", subject: participant(true) },
  {
    key: "participant_unchecked",
    label: "Participant (own, no birth-date check)",
    subject: participant(false),
  },
  {
    key: "consultant",
    label: "Consultant/profiler (assigned)",
    subject: staff(["consultant"], undefined, true),
  },
  {
    key: "consultant_unassigned",
    label: "Consultant/profiler (not assigned)",
    subject: staff(["consultant"]),
  },
  { key: "project_lead", label: "PL", subject: staff(["project_lead"]) },
  { key: "back_office", label: "Back office", subject: staff(["back_office"]) },
  {
    key: "regional_operations_manager",
    label: "Regional operations manager",
    subject: staff([], "regional_operations_manager"),
  },
  { key: "regional_admin", label: "Regional admin", subject: staff([], "regional_admin") },
  { key: "admin", label: "Admin", subject: staff([], "admin") },
];

export const accessModes = {
  normal: { kind: "normal" },
  assisted: { kind: "assisted", onBehalfOf: sample.participationId },
  break_glass: { kind: "break_glass", reasonCode: "sample_reason" },
} as const satisfies Record<AccessMode["kind"], AccessMode>;

const scope = { projectId: sample.projectId, regionId: sample.regionId };
const person = (phase: AccessPhase) => ({
  ...scope,
  participationId: sample.participationId,
  phase,
});

/** The categories that hold fields, in catalog order. */
export const fieldCategories = AccessCategory.options.filter((c) =>
  fieldCatalog.some((f) => f.accessCategory === c),
);

/** One field of the category, a self-service one where there is one (participant writes). */
export function sampleField(category: AccessCategory, phase: AccessPhase): FieldResource {
  const inCategory = fieldCatalog.filter((f) => f.accessCategory === category);
  const field = (inCategory.find((f) => f.selfService) ?? inCategory[0])!.key;
  return { kind: "field", ...person(phase), field };
}

export const sampleDocument = (
  documentType: DocumentType,
  phase: AccessPhase,
): DocumentResource => ({
  kind: "document",
  ...person(phase),
  documentType,
});

export const sampleAudit = (
  stream: AuditStream,
  actorStaffUserId: string | null,
): AuditResource => ({
  kind: "audit",
  ...scope,
  participationId: sample.participationId,
  stream,
  actorStaffUserId,
});

export const sampleAggregate = (): AggregateResource => ({ kind: "aggregate", ...scope });
