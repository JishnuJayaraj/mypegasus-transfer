import type { OrgRole, ProjectRole } from "../enums";
import { fieldEntry, type AccessCategory } from "../fields/catalog";

/**
 * The field-level access matrix (plan 5.6, data-protection.md; *assumed*, Q28, Q49, Q51,
 * Q61–Q65, Q80). Pure: the API (Slice 3) passes the subject, the resource and the mode, and
 * writes the audit entry the decision names. Unknown access is denied (D10).
 */
export type RegionScope = { regionIds: ReadonlySet<string> | "all" };

export type Subject =
  | {
      kind: "staff";
      staffUserId: string;
      orgRoles: ReadonlyMap<OrgRole, RegionScope>;
      /** Zero or more roles per project; permissions are the union (D6, Q61). */
      projectRoles: Readonly<Record<string, ReadonlySet<ProjectRole>>>;
      /** As profiler/consultant (Q62). */
      assignedParticipationIds: ReadonlySet<string>;
    }
  | { kind: "participant"; participationId: string; knowledgeCheckPassed: boolean };

export type AccessPhase = "active" | "evidence_set";

export type Resource = {
  projectId: string;
  regionId: string | null;
  /** `null` for project-wide resources (lists, aggregates). */
  participationId: string | null;
  category: AccessCategory;
  /** The evidence set starts after the first deletion stage (Q64). */
  phase: AccessPhase;
  /** The field concerned; participants write only `selfService` fields (Q65). */
  field?: string;
};

export type AccessAction = "read" | "list" | "open_document" | "write";

export type AccessMode =
  | { kind: "normal" }
  | { kind: "assisted"; onBehalfOf: string }
  | { kind: "break_glass"; reasonCode: string };

export type AccessView = "full" | "metadata_only" | "absence_only" | "type_and_dates";

/** The question behind an `undecided` cell (D10). */
export type AccessQuestion = "Q65" | "Q87";

export type DenyReason =
  | "not_member"
  | "not_assigned"
  | "never"
  | "needs_break_glass"
  | "needs_assisted_mode"
  | "needs_knowledge_check"
  | "not_in_list_payloads"
  | "immutable"
  | "via_status_functions"
  | "out_of_region"
  | "undecided";

export type Decision =
  | {
      effect: "allow";
      view: AccessView;
      audit: null | "sensitive_read" | "sensitive_write" | "document_opened" | "break_glass_access";
      flagForReview: boolean;
      /** Break-glass covers one participant, one category and one action (Q63). */
      grant?: { participationId: string; category: AccessCategory; action: AccessAction };
    }
  | { effect: "deny"; because: DenyReason; question?: AccessQuestion };

type Role = "participant" | ProjectRole | OrgRole;
type ReadRight = AccessView | "assisted_or_break_glass" | "never" | AccessQuestion;
type WriteRight =
  | "yes"
  | "self_service"
  | "assisted_only"
  | "assisted_else_Q65"
  | "via_status_functions"
  | "immutable"
  | "never"
  | AccessQuestion;

/** Read/write per role and category in the active phase; a missing cell is never/never. */
const rights: Record<Role, Partial<Record<AccessCategory, `${ReadRight}/${WriteRight}`>>> = {
  participant: {
    case_internal: "full/never",
    confidential: "full/self_service",
    health: "full/self_service",
    disability: "full/self_service",
    identifiers: "full/self_service",
    residence_social: "full/self_service",
    absence: "type_and_dates/never",
    audit_metadata: "Q87/never",
  },
  consultant: {
    case_internal: "full/via_status_functions",
    confidential: "full/yes",
    health: "full/yes",
    disability: "full/yes",
    identifiers: "full/Q65",
    residence_social: "full/Q65",
    profiling_assessment: "full/yes",
    signed_tl407: "metadata_only/immutable",
    signed_kug200b: "metadata_only/immutable",
    absence: "absence_only/never",
    audit_metadata: "Q87/never",
    aggregated: "full/never",
  },
  project_lead: {
    case_internal: "full/via_status_functions",
    confidential: "full/assisted_else_Q65",
    health: "assisted_or_break_glass/assisted_only",
    disability: "assisted_or_break_glass/assisted_only",
    signed_tl407: "metadata_only/immutable",
    signed_kug200b: "metadata_only/immutable",
    absence: "absence_only/never",
    audit_metadata: "Q87/never",
    aggregated: "full/never",
  },
  back_office: {
    case_internal: "full/via_status_functions",
    confidential: "full/Q65",
    disability: "full/yes",
    identifiers: "full/yes",
    residence_social: "full/Q65",
    signed_tl407: "never/immutable",
    signed_kug200b: "never/immutable",
    absence: "type_and_dates/yes",
    audit_metadata: "Q87/never",
    aggregated: "full/never",
  },
  regional_operations_manager: { audit_metadata: "full/never", aggregated: "full/never" },
  regional_admin: { aggregated: "full/never" },
  admin: { aggregated: "full/never" },
};

const sensitive = new Set<AccessCategory>([
  "health",
  "disability",
  "identifiers",
  "residence_social",
  "profiling_assessment",
  "signed_tl407",
  "signed_kug200b",
]);
/** Never in list payloads; absence periods until Q85 is answered. */
const unlisted = new Set<AccessCategory>([...sensitive, "absence"]);
const knowledgeChecked = new Set<AccessCategory>(["health", "disability"]);
const documents = new Set<AccessCategory>(["signed_tl407", "signed_kug200b"]);
const personLevel = (c: AccessCategory) => c !== "audit_metadata" && c !== "aggregated";

const deny = (because: DenyReason, question?: AccessQuestion): Decision =>
  question ? { effect: "deny", because, question } : { effect: "deny", because };
type Allow = Extract<Decision, { effect: "allow" }>;
const allow = (view: AccessView, audit: Allow["audit"] = null): Allow => ({
  effect: "allow",
  view,
  audit,
  flagForReview: false,
});
const isQuestion = (v: string): v is AccessQuestion => v === "Q65" || v === "Q87";

type Request = { resource: Resource; action: AccessAction; mode: AccessMode };

/** Break-glass needs a reason code and one participant (Q63); free text waits for Slice 3. */
function breakGlassGrant({ resource, action, mode }: Request): Allow | null {
  if (mode.kind !== "break_glass" || !mode.reasonCode.trim() || !resource.participationId) {
    return null;
  }
  const grant = { participationId: resource.participationId, category: resource.category, action };
  return { effect: "allow", view: "full", audit: "break_glass_access", flagForReview: true, grant };
}

/** One role, active phase. */
function activeDecision(role: Role, request: Request): Decision {
  const { resource, action, mode } = request;
  const { category } = resource;
  const [read, write] = (rights[role][category] ?? "never/never").split("/") as [
    ReadRight,
    WriteRight,
  ];
  const assisted = mode.kind === "assisted" && mode.onBehalfOf === resource.participationId;

  if (action === "write") {
    const allowed = allow("full", sensitive.has(category) ? "sensitive_write" : null);
    if (write === "yes") return allowed;
    if (write === "self_service") {
      return resource.field && fieldEntry(resource.field).selfService ? allowed : deny("never");
    }
    if (write === "assisted_only") return assisted ? allowed : deny("needs_assisted_mode");
    if (write === "assisted_else_Q65") return assisted ? allowed : deny("undecided", "Q65");
    return isQuestion(write) ? deny("undecided", write) : deny(write);
  }

  let decision: Decision;
  if (read === "assisted_or_break_glass") {
    decision = assisted
      ? allow("full", "sensitive_read")
      : (breakGlassGrant(request) ?? deny("needs_assisted_mode"));
  } else if (read === "never") decision = deny("never");
  else if (isQuestion(read)) decision = deny("undecided", read);
  else decision = allow(read, sensitive.has(category) && read === "full" ? "sensitive_read" : null);

  if (action !== "open_document" || decision.effect === "deny") return decision;
  // Only the signed forms are documents of a category so far (Q87).
  return documents.has(category) ? allow("full", "document_opened") : deny("undecided", "Q87");
}

/** Evidence set: break-glass only, never more than the role has in the active phase (Q64). */
function evidenceSetDecision(role: Role, request: Request): Decision {
  const base = activeDecision(role, { ...request, mode: { kind: "normal" } });
  if (base.effect === "deny") return base.because === "needs_assisted_mode" ? deny("never") : base;
  if (request.action === "write") return deny("undecided", "Q87");
  if (request.action === "list") return deny("never");
  const grant = breakGlassGrant(request);
  return grant ? { ...grant, view: base.view } : deny("needs_break_glass");
}

function roleDecision(role: Role, request: Request): Decision {
  const { category, phase } = request.resource;
  if (request.action === "list" && unlisted.has(category)) return deny("not_in_list_payloads");
  if (phase === "evidence_set" && personLevel(category)) return evidenceSetDecision(role, request);
  return activeDecision(role, request);
}

const viewRank: AccessView[] = ["full", "type_and_dates", "absence_only", "metadata_only"];
const denyRank: DenyReason[] = [
  "undecided",
  "needs_break_glass",
  "needs_assisted_mode",
  "needs_knowledge_check",
  "via_status_functions",
  "immutable",
  "not_in_list_payloads",
  "not_assigned",
  "out_of_region",
  "never",
  "not_member",
];

/** The union of the roles (D6): the most permissive allow, else the most telling denial. */
function union(decisions: Decision[]): Decision {
  const rank = (d: Decision) =>
    d.effect === "allow"
      ? viewRank.indexOf(d.view) * 2 + Number(d.flagForReview)
      : 100 + denyRank.indexOf(d.because);
  return decisions.toSorted((a, b) => rank(a) - rank(b))[0] ?? deny("not_member");
}

const inRegion = ({ regionIds }: RegionScope, regionId: string | null) =>
  regionIds === "all" || (regionId !== null && regionIds.has(regionId));

export function decideAccess(
  subject: Subject,
  resource: Resource,
  action: AccessAction,
  mode: AccessMode,
): Decision {
  const { category, field } = resource;
  if (field !== undefined && fieldEntry(field).accessCategory !== category) {
    throw new Error(`Field ${field} is not in category ${category}`);
  }
  const request = { resource, action, mode };

  if (subject.kind === "participant") {
    if (resource.participationId !== subject.participationId || mode.kind !== "normal") {
      return deny("never");
    }
    if (action === "list" && unlisted.has(category)) return deny("not_in_list_payloads");
    // Break-glass only, which participants don't have (Q64).
    if (resource.phase === "evidence_set" && personLevel(category)) return deny("never");
    if (knowledgeChecked.has(category) && !subject.knowledgeCheckPassed) {
      return deny("needs_knowledge_check");
    }
    return activeDecision("participant", request);
  }

  const decisions = [...subject.orgRoles].map(([role, scope]) =>
    inRegion(scope, resource.regionId) ? roleDecision(role, request) : deny("out_of_region"),
  );
  const assigned =
    resource.participationId !== null &&
    subject.assignedParticipationIds.has(resource.participationId);
  for (const role of subject.projectRoles[resource.projectId] ?? []) {
    const unassigned = role === "consultant" && personLevel(category) && !assigned;
    decisions.push(unassigned ? deny("not_assigned") : roleDecision(role, request));
  }
  return union(decisions);
}
