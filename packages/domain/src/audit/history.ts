import { decideAccess, type AuditStream, type Subject } from "../access/decide";
import { ProjectRole } from "../enums";
import { AccessCategory, fieldCatalog, fieldEntry } from "../fields/catalog";
import { matrixField } from "../self-service/assisted";
import { AuditEventType, StatusField } from "./events";

// A participation's audit history in the staff app (data-protection.md, audit metadata; Q87 A,
// Q157; the per-type readings Q161). Pure: the database function `audit_history` applies these
// tables (`audit_event_projection`, `role_field_knowledge`, `field_access_category`, held equal
// to them by drift tests) and is the authorization boundary; the API localizes and validates.

/** What a history shows of one event type. */
export type AuditProjection = {
  /** `null`: a project-level event, in no participation's history. */
  stream: AuditStream | null;
  /** `field`, `from` and `to`. */
  showsChange: boolean;
  showsReason: boolean;
  /** The `details` keys shown; `fields` holds field keys, kept per role (`roleFieldKnowledge`). */
  detailKeys: readonly string[];
};

type Shown = { change?: boolean; reason?: boolean; details?: readonly string[] };

const shown = (stream: AuditStream, { change = false, reason = false, details = [] }: Shown = {}) =>
  ({ stream, showsChange: change, showsReason: reason, detailKeys: details }) as const;
const nothing = (stream: AuditStream | null): AuditProjection => ({
  stream,
  showsChange: false,
  showsReason: false,
  detailKeys: [],
});
const projectLevel = nothing(null);
const security = nothing("security");
const review = nothing("review");

/**
 * Every event type's projection, and for `status_changed` one per status field (the track's
 * stream). Logins, one-time codes, step-ups, sensitive reads and writes, document openings,
 * break-glass, exports and session events are `security`; reviews and clarifications `review`
 * (the regional review is a view of its own); neither is ever in a history (Q157).
 */
export const auditProjection: {
  [T in Exclude<AuditEventType, "status_changed">]: AuditProjection;
} & { status_changed: Readonly<Record<StatusField, AuditProjection>> } = {
  participation_created: shown("case", { change: true }),
  status_changed: {
    status: shown("case", {
      change: true,
      reason: true,
      details: ["entryKind", "secondaryReasons"],
    }),
    profiling_status: shown("profiling", { change: true }),
    dsv_status: shown("dsv", { change: true, details: ["offerDeadline"] }),
  },
  entry_wave_assigned: shown("case", { details: ["waveId", "previousWaveId"] }),
  profiling_exception_requested: shown("profiling", { reason: true }),
  profiling_exception_approved: shown("profiling"),
  profiling_exception_rejected: shown("profiling"),
  profiling_exception_revoked: shown("profiling"),
  profiling_exception_superseded: shown("profiling", { reason: true }),
  end_reason_corrected: shown("case", { change: true, details: ["secondaryReasons"] }),
  sensitive_read: security,
  sensitive_write: security,
  break_glass_access: security,
  document_opened: security,
  warning_confirmed: shown("case", { reason: true }),
  export_created: security,
  config_override_changed: projectLevel,
  review_recorded: review,
  clarification_requested: review,
  project_created: projectLevel,
  project_changed: projectLevel,
  entry_wave_created: projectLevel,
  entry_wave_changed: projectLevel,
  config_template_pinned: projectLevel,
  rule_relaxation_requested: projectLevel,
  rule_relaxation_approved: projectLevel,
  rule_relaxation_rejected: projectLevel,
  rule_relaxation_withdrawn: projectLevel,
  project_activated: projectLevel,
  participant_data_changed: shown("case", { details: ["fields"] }),
  import_confirmed: projectLevel,
  participation_created_manually: shown("case"),
  // The contractual dates and the amendment of a signed DSV (Q161).
  participation_dates_changed: shown("dsv", {
    details: ["oldTgStart", "newTgStart", "oldTgEnd", "newTgEnd", "reportingKinds"],
  }),
  project_member_added: projectLevel,
  project_member_removed: projectLevel,
  participant_assigned: shown("case"),
  participant_unassigned: shown("case", { reason: true }),
  activation_code_issued: shown("case", { details: ["purpose", "channel", "deliveryKind"] }),
  activation_code_delivery: shown("case", { details: ["outcome"] }),
  activation_code_handed_over: shown("case", { details: ["method"] }),
  activation_code_revoked: shown("case", { reason: true }),
  privacy_notice_provided: shown("case", { details: ["method"] }),
  participant_activated: shown("case"),
  consent_given: shown("case", { details: ["purpose", "textVersion"] }),
  contact_channel_added: shown("case", { details: ["kind"] }),
  activation_code_locked: security,
  one_time_code_exhausted: security,
  participant_logout: security,
  participant_login: security,
  contact_channel_removed: shown("case", { reason: true, details: ["kind"] }),
  consent_ended: shown("case", { reason: true, details: ["purpose"] }),
  contact_channels_suspended: security,
  placement_agentur_set: shown("case", { details: ["agenturKey", "previousAgenturKey"] }),
  self_service_notice_acknowledged: shown("case", { details: ["noticeVersion"] }),
  step_up_completed: security,
  step_up_failed: security,
  assisted_mode_started: security,
  assisted_mode_ended: security,
  document_added: shown("case", { details: ["documentType", "source"] }),
  document_reviewed: shown("case", { reason: true, details: ["documentType", "decision"] }),
  document_deleted: shown("case", { reason: true, details: ["documentType"] }),
  document_upload_rejected: security,
  // Messages (Q168): the kind and, for an appointment's message, the appointment and its start
  // as written then, in both the queued and the delivery projection.
  reminder_queued: shown("case", {
    details: ["kind", "channelKind", "appointmentId", "startsAt"],
  }),
  reminder_delivery: shown("case", { reason: true, details: ["outcome", "kind", "appointmentId"] }),
  audit_history_opened: security,
  // Appointments (Q168): the appointment's own events are project-level; a booking shows its
  // appointment, kind, start as written and origin, a cancellation its reason too.
  appointment_created: projectLevel,
  appointment_changed: projectLevel,
  appointment_cancelled: projectLevel,
  appointment_booked: shown("case", {
    details: ["appointmentId", "appointmentKind", "startsAt", "origin"],
  }),
  appointment_booking_cancelled: shown("case", {
    reason: true,
    details: ["appointmentId", "appointmentKind", "startsAt"],
  }),
  // Attendance (Q163, Q168): the value with the previous one, the closed-case flow's reason; the
  // confirmation whether it changed the status; a conflict's handling and its resolution.
  attendance_recorded: shown("case", {
    reason: true,
    details: [
      "appointmentId",
      "appointmentKind",
      "startsAt",
      "attendance",
      "previousAttendance",
      "afterClose",
    ],
  }),
  attendance_superseded: shown("case", {
    details: ["appointmentId", "appointmentKind", "startsAt", "previousAttendance"],
  }),
  information_delivery_confirmed: shown("case", {
    details: ["appointmentId", "appointmentKind", "startsAt", "statusChanged"],
  }),
  attendance_conflict_escalated: shown("case", {
    details: ["appointmentId", "appointmentKind", "startsAt"],
  }),
  attendance_conflict_resolved: shown("case", {
    reason: true,
    details: ["appointmentId", "appointmentKind", "startsAt"],
  }),
  appointment_notice_followed_up: shown("case", { details: ["method", "appointmentId"] }),
};

/** One event type's projection; `status_changed` needs its field. */
export function projectionOf(type: AuditEventType, field: StatusField | null): AuditProjection {
  if (type !== "status_changed") return auditProjection[type];
  if (!field) throw new Error("status_changed needs its field");
  return auditProjection.status_changed[field];
}

export type AuditProjectionRow = AuditProjection & {
  eventType: AuditEventType;
  field: StatusField | null;
};

/** The rows of `audit_event_projection`, in the order of the event types. */
export function auditProjectionRows(): AuditProjectionRow[] {
  return AuditEventType.options.flatMap((eventType): AuditProjectionRow[] =>
    eventType === "status_changed"
      ? StatusField.options.map((field) => ({
          eventType,
          field,
          ...projectionOf(eventType, field),
        }))
      : [{ eventType, field: null, ...projectionOf(eventType, null) }],
  );
}

/** The operational streams a history may hold; never `security` or `review` (Q157). */
const historyStreamOrder = ["case", "profiling", "dsv", "payroll"] as const satisfies AuditStream[];
export type HistoryStream = (typeof historyStreamOrder)[number];

/** The event types a history can show. */
export const historyEventTypes: readonly AuditEventType[] = AuditEventType.options.filter(
  (type) =>
    type === "status_changed" ||
    (historyStreamOrder as readonly (AuditStream | null)[]).includes(
      projectionOf(type, null).stream,
    ),
);

export type HistoryStreams = {
  /** Every event of these streams. */
  streams: HistoryStream[];
  /** Only the viewer's own events of these (the assigned consultant's DSV and payroll actions). */
  ownStreams: HistoryStream[];
};

const sample = {
  projectId: "00000000-0000-4000-9000-000000000000",
  participationId: "00000000-0000-4000-a000-000000000000",
  viewer: "00000000-0000-4000-8000-000000000000",
  other: "00000000-0000-4000-8000-000000000001",
};

/**
 * The streams of a participation's history for a viewer with these project roles (Q157), from
 * the audit projections of `decideAccess` (Q87 A): the PL `case`, `profiling`, `dsv`; the
 * assigned consultant `case`, `profiling` and their own `dsv` and `payroll` events; back office
 * `dsv`, `payroll`; the union of the roles (Q61).
 */
export function historyStreams(roles: ReadonlySet<ProjectRole>, assigned: boolean): HistoryStreams {
  const subject: Subject = {
    kind: "staff",
    staffUserId: sample.viewer,
    orgRoles: new Map(),
    projectRoles: { [sample.projectId]: roles },
    assignedParticipationIds: new Set(assigned ? [sample.participationId] : []),
  };
  const lists = (stream: AuditStream, actorStaffUserId: string) =>
    decideAccess(
      subject,
      {
        kind: "audit",
        projectId: sample.projectId,
        regionId: null,
        participationId: sample.participationId,
        phase: "active",
        stream,
        actorStaffUserId,
      },
      "list",
      { kind: "normal" },
    ).effect === "allow";
  const streams = historyStreamOrder.filter((stream) => lists(stream, sample.other));
  const ownStreams = historyStreamOrder.filter(
    (stream) => !streams.includes(stream) && lists(stream, sample.viewer),
  );
  return { streams, ownStreams };
}

/** A subject's history streams for one participation: its project roles there, nothing else. */
export function historyStreamsOf(
  subject: Subject,
  target: { projectId: string; participationId: string },
): HistoryStreams {
  if (subject.kind !== "staff") return { streams: [], ownStreams: [] };
  return historyStreams(
    subject.projectRoles[target.projectId] ?? new Set(),
    subject.assignedParticipationIds.has(target.participationId),
  );
}

/**
 * Per project role the access categories whose field keys a history keeps in `fields`: those it
 * may know of a field, in normal or assisted mode (the "Selbstauskunft" tab's `knows`;
 * data-protection.md, access matrix). A consultant is decided as assigned: the history needs it.
 */
export const roleFieldKnowledge: Readonly<Record<ProjectRole, readonly AccessCategory[]>> =
  Object.fromEntries(
    ProjectRole.options.map((role) => {
      const subject: Subject = {
        kind: "staff",
        staffUserId: sample.viewer,
        orgRoles: new Map(),
        projectRoles: { [sample.projectId]: new Set([role]) },
        assignedParticipationIds: new Set([sample.participationId]),
      };
      const knows = (field: string) =>
        (
          [{ kind: "normal" }, { kind: "assisted", onBehalfOf: sample.participationId }] as const
        ).some(
          (mode) =>
            decideAccess(
              subject,
              {
                kind: "field",
                projectId: sample.projectId,
                regionId: null,
                participationId: sample.participationId,
                phase: "active",
                field,
              },
              "read",
              mode,
            ).effect === "allow",
        );
      const categories = AccessCategory.options.filter((category) =>
        fieldCatalog.some((entry) => entry.accessCategory === category && knows(entry.key)),
      );
      return [role, categories];
    }),
  ) as Record<ProjectRole, AccessCategory[]>;

/** The rows of `role_field_knowledge`. */
export function roleFieldKnowledgeRows(): {
  projectRole: ProjectRole;
  accessCategory: AccessCategory;
}[] {
  return ProjectRole.options.flatMap((projectRole) =>
    roleFieldKnowledge[projectRole].map((accessCategory) => ({ projectRole, accessCategory })),
  );
}

/**
 * The rows of `field_access_category`: each catalog field's category, and `custom.*` for every
 * custom field (decided as a confidential self-service field, regional-variation.md).
 */
export function fieldCategoryRows(): { fieldKey: string; accessCategory: AccessCategory }[] {
  return [
    ...fieldCatalog.map((entry) => ({ fieldKey: entry.key, accessCategory: entry.accessCategory })),
    { fieldKey: "custom.*", accessCategory: fieldEntry(matrixField("custom.x")).accessCategory },
  ];
}
