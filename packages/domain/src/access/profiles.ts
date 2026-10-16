import type { OrgRole, ProjectRole } from "../enums";
import { fieldCatalog, type AccessCategory } from "../fields/catalog";
import type { AccessMode, AccessPhase, Resource, Subject } from "./decide";

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

/** The sample participation's data of one category, named by a self-service field if any. */
export function sampleResource(category: AccessCategory, phase: AccessPhase): Resource {
  const field = fieldCatalog.find((f) => f.accessCategory === category && f.selfService)?.key;
  return { ...sample, category, phase, ...(field && { field }) };
}
