import { z } from "zod";
import {
  documentTypeEntry,
  type AccessRole,
  type DocumentRight,
  type DocumentType,
} from "../documents/catalog";
import { ProjectRole, type OrgRole } from "../enums";
import { fieldEntry, type AccessCategory } from "../fields/catalog";

/**
 * The field-level access matrix (plan 5.6, data-protection.md, round 11; *assumed*, Q28, Q49,
 * Q51, Q61–Q65, Q80, Q87). Pure: the API (Slice 3) passes the subject, the resource and the
 * mode, and writes the audit entry the decision names. Unknown access is denied (D10).
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

/** The evidence set starts after the first deletion stage (Q64). */
export type AccessPhase = "active" | "evidence_set";

/**
 * Filtered audit projections (Q87 A): Slice 3 maps each event type to a stream. `review` holds
 * the events awaiting or recording a regional operations manager's approval or review;
 * `security` sensitive reads, document openings, break-glass and exports.
 */
export const AuditStream = z.enum(["case", "profiling", "dsv", "payroll", "security", "review"]);
export type AuditStream = z.infer<typeof AuditStream>;

type Scope = { projectId: string; regionId: string | null };
type Person = Scope & { participationId: string | null; phase: AccessPhase };

/** One participant field; its category comes from the field catalog. */
export type FieldResource = Person & { kind: "field"; field: string };
export type DocumentResource = Person & { kind: "document"; documentType: DocumentType };
export type AuditResource = Scope & {
  kind: "audit";
  participationId: string | null;
  stream: AuditStream;
  actorStaffUserId: string | null;
};
export type AggregateResource = Scope & { kind: "aggregate" };
export type Resource = FieldResource | DocumentResource | AuditResource | AggregateResource;

export type AccessAction = "read" | "list" | "open_document" | "write";

export type AccessMode =
  | { kind: "normal" }
  | { kind: "assisted"; onBehalfOf: string }
  | { kind: "break_glass"; reasonCode: string };

export type AccessView = "full" | "metadata_only" | "absence_only" | "type_and_dates";

/** The question behind an `undecided` cell (D10). */
export type AccessQuestion = "Q65";

export type DenyReason =
  | "not_member"
  | "not_assigned"
  | "never"
  | "needs_break_glass"
  | "needs_assisted_mode"
  | "needs_knowledge_check"
  | "not_in_list_payloads"
  | "immutable"
  | "via_domain_operation"
  | "out_of_region"
  | "not_applicable"
  | "undecided";

type Allow = {
  effect: "allow";
  view: AccessView;
  audit: null | "sensitive_read" | "sensitive_write" | "document_opened" | "break_glass_access";
  flagForReview: boolean;
  /** Break-glass covers one participant, one category or document type, one action (Q63). */
  grant?: {
    participationId: string;
    category: AccessCategory;
    documentType?: DocumentType;
    action: AccessAction;
  };
};
export type Decision =
  | Allow
  | { effect: "deny"; because: Exclude<DenyReason, "undecided"> }
  | { effect: "deny"; because: "undecided"; question: AccessQuestion };

type ReadRight = AccessView | "assisted_or_break_glass" | "never";
type WriteRight =
  | "yes"
  | "self_service"
  | "assisted_only"
  | "assisted_else_Q65"
  | "via_domain_operation"
  | "never"
  | AccessQuestion;

/** Field read/write per role and category in the active phase; a missing cell is never/never. */
const fieldRights: Record<
  AccessRole,
  Partial<Record<AccessCategory, `${ReadRight}/${WriteRight}`>>
> = {
  participant: {
    case_internal: "full/never",
    confidential: "full/self_service",
    health: "full/self_service",
    disability: "full/self_service",
    identifiers: "full/self_service",
    residence_social: "full/self_service",
    absence: "type_and_dates/never",
  },
  consultant: {
    case_internal: "full/via_domain_operation",
    confidential: "full/yes",
    health: "full/yes",
    disability: "full/yes",
    identifiers: "full/Q65",
    residence_social: "full/Q65",
    profiling_assessment: "full/yes",
    absence: "absence_only/never",
  },
  project_lead: {
    case_internal: "full/via_domain_operation",
    confidential: "full/assisted_else_Q65",
    health: "assisted_or_break_glass/assisted_only",
    disability: "assisted_or_break_glass/assisted_only",
    absence: "absence_only/never",
  },
  back_office: {
    case_internal: "full/via_domain_operation",
    confidential: "full/Q65",
    disability: "full/yes",
    identifiers: "full/yes",
    residence_social: "full/Q65",
    absence: "type_and_dates/yes",
  },
  regional_operations_manager: {},
  regional_admin: {},
  admin: {},
};

/** Audit projections per role (Q87 A); participants and admins see none. */
const auditRights: Partial<Record<AccessRole, readonly AuditStream[]>> = {
  project_lead: ["case", "profiling", "dsv"],
  consultant: ["case", "profiling"],
  back_office: ["dsv", "payroll"],
  regional_operations_manager: ["review"],
};
/** An assigned consultant also sees their own actions, but no security or review events. */
const ownActionStreams: readonly AuditStream[] = ["case", "profiling", "dsv", "payroll"];

const sensitive = new Set<AccessCategory>([
  "health",
  "disability",
  "identifiers",
  "residence_social",
  "profiling_assessment",
  "signed_tl407",
  "signed_kug200b",
  "employment_contract",
]);
/** Never in list payloads; absence periods until Q85 is answered. */
const unlisted = new Set<AccessCategory>([...sensitive, "absence"]);
const knowledgeChecked = new Set<AccessCategory>(["health", "disability"]);
const notApplicable: Record<Resource["kind"], readonly AccessAction[]> = {
  field: ["open_document"],
  document: [],
  audit: ["open_document"],
  aggregate: ["open_document", "write"],
};

function deny(because: Exclude<DenyReason, "undecided">): Decision;
function deny(because: "undecided", question: AccessQuestion): Decision;
function deny(because: DenyReason, question?: AccessQuestion): Decision {
  return (
    question ? { effect: "deny", because, question } : { effect: "deny", because }
  ) as Decision;
}
const allow = (view: AccessView, audit: Allow["audit"] = null): Allow => ({
  effect: "allow",
  view,
  audit,
  flagForReview: false,
});

type PersonResource = FieldResource | DocumentResource;
type Request<R extends Resource = Resource> = {
  resource: R;
  action: AccessAction;
  mode: AccessMode;
};

const categoryOf = (r: PersonResource) =>
  r.kind === "field"
    ? fieldEntry(r.field).accessCategory
    : documentTypeEntry(r.documentType).accessCategory;

/** Break-glass needs a reason code and one participant (Q63); it never grants list or write. */
function breakGlass({ resource, action, mode }: Request<PersonResource>, view: AccessView) {
  if (mode.kind !== "break_glass" || !mode.reasonCode.trim() || !resource.participationId) {
    return null;
  }
  const grant = {
    participationId: resource.participationId,
    category: categoryOf(resource),
    ...(resource.kind === "document" && { documentType: resource.documentType }),
    action,
  };
  return { ...allow(view, "break_glass_access"), flagForReview: true, grant };
}

const isAssisted = ({ resource, mode }: Request<PersonResource>) =>
  mode.kind === "assisted" && mode.onBehalfOf === resource.participationId;

function fieldDecision(role: AccessRole, request: Request<FieldResource>): Decision {
  const { resource, action } = request;
  const category = categoryOf(resource);
  const [read, write] = (fieldRights[role][category] ?? "never/never").split("/") as [
    ReadRight,
    WriteRight,
  ];
  const assisted = isAssisted(request);
  if (action === "write") {
    const allowed = allow("full", sensitive.has(category) ? "sensitive_write" : null);
    if (write === "yes") return allowed;
    if (write === "self_service") {
      return fieldEntry(resource.field).selfService ? allowed : deny("never");
    }
    if (write === "assisted_only") return assisted ? allowed : deny("needs_assisted_mode");
    if (write === "assisted_else_Q65") return assisted ? allowed : deny("undecided", "Q65");
    return write === "Q65" ? deny("undecided", write) : deny(write);
  }
  if (read === "never") return deny("never");
  if (read !== "assisted_or_break_glass") {
    return allow(read, sensitive.has(category) && read === "full" ? "sensitive_read" : null);
  }
  if (assisted) return allow("full", "sensitive_read");
  return breakGlass(request, "full") ?? deny("needs_assisted_mode");
}

function documentDecision(role: AccessRole, request: Request<DocumentResource>): Decision {
  const entry = documentTypeEntry(request.resource.documentType);
  const right: DocumentRight | undefined = entry.roles[role];
  if (!right) return deny("never");
  if (request.action === "write") {
    if (right === "metadata") return deny("never");
    // Documents never change; adding one or a new version is a document operation.
    return deny(entry.signed ? "immutable" : "via_domain_operation");
  }
  const open = request.action === "open_document";
  const opened = open ? allow("full", "document_opened") : allow("metadata_only");
  if (right === "open" || (right === "metadata_break_glass_open" && !open)) return opened;
  if (right === "metadata") return open ? deny("never") : opened;
  const view = open ? "full" : "metadata_only";
  if (right === "metadata_break_glass_open") {
    return breakGlass(request, view) ?? deny("needs_break_glass");
  }
  if (isAssisted(request)) return opened;
  return breakGlass(request, view) ?? deny("needs_assisted_mode");
}

function activeDecision(role: AccessRole, request: Request<PersonResource>): Decision {
  return request.resource.kind === "field"
    ? fieldDecision(role, request as Request<FieldResource>)
    : documentDecision(role, request as Request<DocumentResource>);
}

/**
 * Evidence set (Q64, round 11): reads only through break-glass, with what the role has in the
 * active phase in normal mode; no lists; no writes (signed documents stay immutable). The
 * exceptional `append_evidence_correction` is an operation of its own.
 */
function evidenceSetDecision(role: AccessRole, request: Request<PersonResource>): Decision {
  const { action } = request;
  // Break-glass on the evidence set: consultant, PL and back office only (matrix, Q63).
  if (!ProjectRole.safeParse(role).success) return deny("never");
  const base = activeDecision(role, { ...request, mode: { kind: "normal" } });
  if (action === "write") {
    return deny(base.effect === "deny" && base.because === "immutable" ? "immutable" : "never");
  }
  if (base.effect === "deny") {
    const lifted = base.because === "needs_assisted_mode" || base.because === "needs_break_glass";
    return lifted ? deny("never") : base;
  }
  if (action === "list") return deny("never");
  return breakGlass(request, base.view) ?? deny("needs_break_glass");
}

function personDecision(role: AccessRole, request: Request<PersonResource>): Decision {
  if (request.action === "list" && unlisted.has(categoryOf(request.resource))) {
    return deny("not_in_list_payloads");
  }
  return request.resource.phase === "evidence_set"
    ? evidenceSetDecision(role, request)
    : activeDecision(role, request);
}

function auditDecision(
  role: AccessRole,
  resource: AuditResource,
  action: AccessAction,
  staffUserId: string,
) {
  if (action === "write") return deny("never"); // append-only, written by the operations
  const own = role === "consultant" && resource.actorStaffUserId === staffUserId;
  const streams = own ? ownActionStreams : (auditRights[role] ?? []);
  return streams.includes(resource.stream) ? allow("full") : deny("never");
}

function staffDecision(role: AccessRole, request: Request, staffUserId: string): Decision {
  const { resource } = request;
  if (resource.kind === "aggregate") return allow("full");
  if (resource.kind === "audit") return auditDecision(role, resource, request.action, staffUserId);
  return personDecision(role, request as Request<PersonResource>);
}

const viewRank: AccessView[] = ["full", "type_and_dates", "absence_only", "metadata_only"];
const denyRank: DenyReason[] = [
  "undecided",
  "needs_break_glass",
  "needs_assisted_mode",
  "needs_knowledge_check",
  "via_domain_operation",
  "immutable",
  "not_in_list_payloads",
  "not_assigned",
  "out_of_region",
  "never",
  "not_member",
  "not_applicable",
];

/** The union of the roles (D6): the most permissive allow, else the most actionable denial. */
function union(decisions: Decision[]): Decision {
  const rank = (d: Decision) =>
    d.effect === "allow"
      ? viewRank.indexOf(d.view) * 2 + Number(d.flagForReview)
      : 100 + denyRank.indexOf(d.because);
  return decisions.toSorted((a, b) => rank(a) - rank(b))[0] ?? deny("not_member");
}

const inRegion = ({ regionIds }: RegionScope, regionId: string | null) =>
  regionIds === "all" || (regionId !== null && regionIds.has(regionId));

function participantDecision(
  subject: Extract<Subject, { kind: "participant" }>,
  request: Request,
): Decision {
  const { resource, mode } = request;
  // No audit-log UI in the MVP (Q87 A); an aggregate is no participation of theirs.
  if (resource.kind === "audit" || resource.kind === "aggregate") return deny("never");
  if (resource.participationId !== subject.participationId || mode.kind !== "normal") {
    return deny("never");
  }
  // Break-glass only, which participants don't have (Q64).
  if (resource.phase === "evidence_set") return deny("never");
  const decision = personDecision("participant", request as Request<PersonResource>);
  const checked = knowledgeChecked.has(categoryOf(resource)) && !subject.knowledgeCheckPassed;
  return checked && decision.effect === "allow" ? deny("needs_knowledge_check") : decision;
}

export function decideAccess(
  subject: Subject,
  resource: Resource,
  action: AccessAction,
  mode: AccessMode,
): Decision {
  if (notApplicable[resource.kind].includes(action)) return deny("not_applicable");
  const request = { resource, action, mode };
  if (subject.kind === "participant") return participantDecision(subject, request);

  const decisions = [...subject.orgRoles].map(([role, scope]) =>
    inRegion(scope, resource.regionId)
      ? staffDecision(role, request, subject.staffUserId)
      : deny("out_of_region"),
  );
  const assigned =
    "participationId" in resource &&
    resource.participationId !== null &&
    subject.assignedParticipationIds.has(resource.participationId);
  for (const role of subject.projectRoles[resource.projectId] ?? []) {
    const unassigned = role === "consultant" && resource.kind !== "aggregate" && !assigned;
    decisions.push(
      unassigned ? deny("not_assigned") : staffDecision(role, request, subject.staffUserId),
    );
  }
  return union(decisions);
}
