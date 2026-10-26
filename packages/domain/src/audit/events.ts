import { z } from "zod";
import { DocumentType } from "../documents/catalog";
import { AccessCategory, ParticipantDataField, valueDataClass } from "../fields/catalog";
import { AuditStream } from "../access/decide";
import { isoDate } from "../iso-date";
import { ProjectType } from "../project";
import { ProjectRole } from "../enums";
import { AssignmentEndReason, MemberRemovalReason } from "../projects/team";
import {
  AgenturKey as agenturKey,
  AgenturSettingSource,
  OverrideChange,
} from "../projects/agentur-settings";
import { BaReportingKind } from "../projects/participation-dates";
import { RelaxationReasonCode, RuleId } from "../projects/relaxations";
import { SettingKey } from "../projects/migration";
import { waveDateFields } from "../projects/waves";
import { AssistedModeEndReason, AssistedModeHow } from "../self-service/assisted";
import { DocumentSource } from "../documents/api";
import { DocumentDeleteReason, DocumentReviewReason } from "../documents/state";
import {
  ActivationChannel,
  ActivationDeliveryKind,
  ActivationRevokeReason,
  IdentityCheck,
  IdentityCheckMethod,
  NoticeMethod,
  ActivationPurpose,
  ChannelVerification,
  ConsentPurpose,
  type ConsentPurpose as ConsentPurposeValue,
  OneTimeCodePurpose,
  ChannelRemovalReason,
  ChannelSuspensionReason,
  ConsentEndReason,
  LoginMethod,
} from "../activation/model";
import { IdentityAssurance } from "../activation/steps";
import {
  noticeKinds,
  NoticeFollowUpMethod,
  ReminderCancelReason,
  ReminderKind,
} from "../reminders/model";
import {
  AppointmentCancelReason,
  AppointmentKind,
  BookingCancelReason,
  BookingOrigin,
} from "../appointments/model";
import {
  Attendance,
  AttendanceAfterCloseReason,
  AttendanceConflictResolution,
} from "../appointments/attendance";
import { NoticeLanguage } from "../notices/catalog";
import { MissedResolution } from "../worklist/appointments";
import {
  contactFields,
  selfServiceValueSchemas,
  type SelfServiceField,
} from "../self-service/values";
import {
  DsvStatus,
  EndReason,
  MainStatus,
  ProfilingExceptionReason,
  ProfilingExceptionSupersededReason,
  ProfilingStatus,
  TgEntryKind,
  type Track,
} from "../lifecycle/enums";

/**
 * The audit event model (ADR-0002, table `audit_event`). Events are append-only and written only
 * by the status functions (ADR-0002). They carry IDs, codes and dates, never free text and
 * never sensitive values (Q66, round 11): every string is a closed enum or an id/code pattern,
 * and every `details` object is strict. The table's `CHECK`s enforce the same in the database.
 */
export const AuditEventType = z.enum([
  // Slice 1, written only by their own functions (`lifecycleEventTypes`)
  "participation_created",
  "status_changed",
  "entry_wave_assigned",
  "profiling_exception_requested",
  "profiling_exception_approved",
  "profiling_exception_rejected",
  "profiling_exception_revoked",
  "profiling_exception_superseded", // round 10: "all closures are audited"
  "end_reason_corrected",
  // Slices 3–9, through `record_audit_event` (`config_override_changed`: its function)
  "sensitive_read",
  "sensitive_write",
  "break_glass_access",
  "document_opened",
  "warning_confirmed",
  "export_created",
  "config_override_changed",
  "review_recorded",
  "clarification_requested",
  // Slice 2, written only by their own setup functions (`setupEventTypes`)
  "project_created",
  "project_changed",
  "entry_wave_created",
  "entry_wave_changed",
  "config_template_pinned",
  "rule_relaxation_requested",
  "rule_relaxation_approved",
  "rule_relaxation_rejected",
  "rule_relaxation_withdrawn",
  "project_activated",
  // Slice 2, written only by `write_participant_data` (PR 2f)
  "participant_data_changed",
  // Slice 2, through `record_audit_event` (the import and manual creation)
  "import_confirmed",
  "participation_created_manually",
  // Slice 2, written only by `set_participation_dates`
  "participation_dates_changed",
  // Slice 3, written only by the team and assignment functions (Q62, Q126)
  "project_member_added",
  "project_member_removed",
  "participant_assigned",
  "participant_unassigned",
  // Slice 3, activation issuance and Art. 14 evidence (ADR-0007)
  "activation_code_issued",
  "activation_code_delivery",
  "activation_code_handed_over",
  "activation_code_revoked",
  "privacy_notice_provided",
  // Slice 3, portal activation (ADR-0007): written only by the activation functions
  "participant_activated",
  "consent_given",
  "contact_channel_added",
  "activation_code_locked",
  "one_time_code_exhausted",
  "participant_logout",
  // Slice 3, portal login, channels and recovery (Q130, ADR-0007, Q123): only their functions write them
  "participant_login",
  "contact_channel_removed",
  "consent_ended",
  "contact_channels_suspended",
  // Slice 4a, written only by `set_placement_agentur` (Q139)
  "placement_agentur_set",
  // Slice 4a, written only by `acknowledge_self_service_notice` (Q138)
  "self_service_notice_acknowledged",
  // Slice 4a, the step-up before special-category data, written only by its functions (Q137)
  "step_up_completed",
  "step_up_failed",
  // Slice 4a, assisted mode (ADR-0007; Q136), written only by its functions
  "assisted_mode_started",
  "assisted_mode_ended",
  // Slice 4b, documents (data-protection.md, uploads; Q144, Q146), written only by their functions
  "document_added",
  "document_reviewed",
  "document_deleted",
  "document_upload_rejected",
  // Slice 5, reminders (data-protection.md, reminders), written only by their functions
  "reminder_queued",
  "reminder_delivery",
  // Slice 5, opening a participation's audit history (data-protection.md, audit metadata; Q157),
  // written only by `audit_history`
  "audit_history_opened",
  // Slice 5b, appointments (data-protection.md, appointments), written only by their functions
  "appointment_created",
  "appointment_changed",
  "appointment_cancelled",
  "appointment_booked",
  "appointment_booking_cancelled",
  // Slice 5b, attendance and `informed` (process-and-lifecycle.md, appointments), written only by
  // their functions
  "attendance_recorded",
  "attendance_superseded",
  "information_delivery_confirmed",
  "attendance_conflict_escalated",
  "attendance_conflict_resolved",
  // Slice 5b, messages (data-protection.md, messages: follow-up), written only by its function
  "appointment_notice_followed_up",
  // Slice 5b, the work list's missed appointments (process-and-lifecycle.md, appointment items),
  // written only by its function
  "missed_appointment_resolved",
  // Slice 6, the profiling record (process-and-lifecycle.md, the profiling record), written only
  // by its functions
  "profiling_session_changed",
  "profiling_declarations_recorded",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

/** `record_audit_event` refuses these: only the lifecycle functions write them. */
export const lifecycleEventTypes: ReadonlySet<AuditEventType> = new Set(
  AuditEventType.options.slice(0, AuditEventType.options.indexOf("end_reason_corrected") + 1),
);

/** Project setup events, written only by their functions (ADR-0002, project setup). */
export const setupEventTypes: ReadonlySet<AuditEventType> = new Set([
  "project_created",
  "project_changed",
  "entry_wave_created",
  "entry_wave_changed",
  "config_template_pinned",
  "config_override_changed",
  "rule_relaxation_requested",
  "rule_relaxation_approved",
  "rule_relaxation_rejected",
  "rule_relaxation_withdrawn",
  "project_activated",
]);

/**
 * The events whose result depends on the release's base defaults carry their `version` as
 * `baseDefaultsVersion` (regional-variation.md, base defaults; round 23: `project_activated`,
 * `config_template_pinned`, `config_override_changed`, `rule_relaxation_requested`,
 * `rule_relaxation_approved`, `import_confirmed`; round 33: `participation_created_manually`; Q139:
 * `placement_agentur_set`); each joins this list with the PR that adds its type.
 */
export const configurationDependentEventTypes: ReadonlySet<AuditEventType> = new Set([
  "config_override_changed",
  "config_template_pinned",
  "rule_relaxation_requested",
  "rule_relaxation_approved",
  "project_activated",
  "import_confirmed",
  "participation_created_manually",
  "placement_agentur_set",
]);

/** `record_audit_event` refuses these: each is written only by its own function. */
export const reservedEventTypes: ReadonlySet<AuditEventType> = new Set([
  ...lifecycleEventTypes,
  ...setupEventTypes,
  "participant_data_changed",
  "participation_dates_changed",
  "project_member_added",
  "project_member_removed",
  "participant_assigned",
  "participant_unassigned",
  "activation_code_issued",
  "activation_code_delivery",
  "activation_code_handed_over",
  "activation_code_revoked",
  "privacy_notice_provided",
  "participant_activated",
  "consent_given",
  "contact_channel_added",
  "activation_code_locked",
  "one_time_code_exhausted",
  "participant_logout",
  "participant_login",
  "contact_channel_removed",
  "consent_ended",
  "contact_channels_suspended",
  "placement_agentur_set",
  "self_service_notice_acknowledged",
  "step_up_completed",
  "step_up_failed",
  "assisted_mode_started",
  "assisted_mode_ended",
  // Slice 4b: `open_document` writes the opening, the document functions the rest.
  "document_opened",
  "document_added",
  "document_reviewed",
  "document_deleted",
  "document_upload_rejected",
  "reminder_queued",
  "reminder_delivery",
  "audit_history_opened",
  "appointment_created",
  "appointment_changed",
  "appointment_cancelled",
  "appointment_booked",
  "appointment_booking_cancelled",
  "attendance_recorded",
  "attendance_superseded",
  "information_delivery_confirmed",
  "attendance_conflict_escalated",
  "attendance_conflict_resolved",
  "appointment_notice_followed_up",
  "missed_appointment_resolved",
  "profiling_session_changed",
  "profiling_declarations_recorded",
]);

/** The participation column a `status_changed` event changes. */
export const StatusField = z.enum(["status", "profiling_status", "dsv_status"]);
export type StatusField = z.infer<typeof StatusField>;

export const statusFieldOfTrack: Readonly<Record<Track, StatusField>> = {
  main: "status",
  profiling: "profiling_status",
  dsv: "dsv_status",
};

/** A snake_case code (reason codes, warning codes); never a sentence. */
const code = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
/** A versioned text (`art14-activation:v1`), as `privacy_notice_delivery` holds it. */
const textVersion = z.string().regex(/^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$/);
/** Request and job ids: id characters only. */
const correlationId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
/** A job name such as `lifecycle.evaluate-project` or `seed`. */
const systemJob = z.string().regex(/^[a-z][a-z0-9_.-]{0,62}$/);
/** The base-defaults version of a configuration-dependent event (Q107). */
const baseDefaultsVersion = z.int().min(1);
/** The profile fields a self-service write names (self-service/values.ts). */
const ProfileField = z.enum(
  (Object.keys(selfServiceValueSchemas) as SelfServiceField[]).filter(
    (key) => !(contactFields as readonly string[]).includes(key),
  ) as [SelfServiceField, ...SelfServiceField[]],
);
/** A custom field's key (regional-variation.md, custom fields). */
const CustomFieldKey = z.string().regex(/^custom\.[a-z][a-z0-9_]{0,62}$/);

/** A channel exactly for the portal contact purpose (data-protection.md, consents). */
const channelOfPurpose = (
  details: { purpose: ConsentPurposeValue; channelId?: string | undefined },
  ctx: Issue,
) => {
  if ((details.purpose === "portal_contact") !== (details.channelId !== undefined)) {
    issue(ctx, "channel_mismatch");
  }
};

/** A field key (`healthRestrictions`, `custom.…`) or document type. */
const resourceKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,99}$/);

/**
 * The canonical fingerprint of an evidence record (Q94, round 17): `sha256:v1:` and 64 lowercase
 * hex digits; the version names the canonicalisation, so a new one (v2) never looks like changed
 * evidence. Slice 4b computes it over the domain-separated payload
 * `profiling-exception-evidence:v1`, the participation id and the canonical evidence (the sorted,
 * de-duplicated content digests of accepted document versions, or the normalised BA facts).
 * Confidential evidence metadata: only on the request record, never in audit details, logs or
 * client responses.
 */
export const EvidenceFingerprint = z.string().regex(/^sha256:v1:[0-9a-f]{64}$/);

/** Who acted (ADR-0002): `onBehalfOf` only for staff in assisted mode. */
export const AuditActor = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("user"),
    staffUserId: z.uuid(),
    onBehalfOf: z.uuid().nullable(),
  }),
  z.strictObject({ type: z.literal("participant"), participationId: z.uuid() }),
  z.strictObject({ type: z.literal("system"), job: systemJob }),
]);
export type AuditActor = z.infer<typeof AuditActor>;

/** A staff user acting for themselves. */
const staffActor = z.strictObject({
  type: z.literal("user"),
  staffUserId: z.uuid(),
  onBehalfOf: z.null(),
});

const common = {
  projectId: z.uuid(),
  actor: AuditActor,
  requestId: correlationId.nullable(),
  jobId: correlationId.nullable(),
};
/** No FK to the participation: retention deletes it and pseudonymises the trail (ADR-0008). */
const ofParticipation = { ...common, participationId: z.uuid() };
const ofProjectOrParticipation = { ...common, participationId: z.uuid().nullable() };
const ofProject = { ...common, participationId: z.null() };

const event = <T extends AuditEventType, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape });

type Issue = { addIssue: (issue: { code: "custom"; message: string; params: object }) => void };
const issue = (ctx: Issue, reason: string) =>
  ctx.addIssue({ code: "custom", message: reason, params: { code: reason } });

/** The health-related end reason isn't storable until encrypted storage exists (Q66). */
const notStorable = (reason: EndReason) =>
  valueDataClass("endReason", reason) === "special_category";

const StatusChange = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("status"), from: MainStatus, to: MainStatus }),
  z.strictObject({
    field: z.literal("profiling_status"),
    from: ProfilingStatus,
    to: ProfilingStatus,
  }),
  z.strictObject({ field: z.literal("dsv_status"), from: DsvStatus, to: DsvStatus }),
]);

const endingStatuses = new Set(["withdrawn", "exited"]);

const statusChanged = event("status_changed", {
  ...ofParticipation,
  change: StatusChange,
  /** The end reason of `→ withdrawn` / `→ exited`. */
  reasonCode: EndReason.nullable(),
  /** The business date: TG entry, deadline + 1, `withdrawnOn`, … */
  effectiveDate: isoDate.nullable(),
  flaggedForReview: z.boolean(),
  details: z.strictObject({
    entryKind: TgEntryKind.optional(),
    /** The scheduled run time the automatic kinds took their snapshot at (round 9). */
    scheduledAt: z.iso.datetime().optional(),
    secondaryReasons: z.array(EndReason).optional(),
    offerDeadline: isoDate.optional(),
  }),
}).superRefine((e, ctx) => {
  const { change, reasonCode, details } = e;
  const ending = change.field === "status" && endingStatuses.has(change.to);
  const reasons = [...(reasonCode ? [reasonCode] : []), ...(details.secondaryReasons ?? [])];
  if (ending && !reasonCode) issue(ctx, "reason_required");
  if (!ending && reasons.length > 0) issue(ctx, "reason_unexpected");
  if (reasons.some(notStorable)) issue(ctx, "reason_not_storable");
  const entry = change.field === "status" && change.to === "active_in_tg";
  if (entry && !details.entryKind) issue(ctx, "entry_kind_required");
  if (!entry && details.entryKind) issue(ctx, "entry_kind_unexpected");
  if (e.flaggedForReview !== (details.entryKind === "reconciliation")) issue(ctx, "flag_mismatch");
});

const endReasonCorrected = event("end_reason_corrected", {
  ...ofParticipation,
  from: EndReason,
  to: EndReason,
  details: z.strictObject({
    previousSource: z.enum(["system", "user"]),
    secondaryReasons: z.array(EndReason),
  }),
}).superRefine((e, ctx) => {
  if (e.from === e.to) issue(ctx, "reason_unchanged");
  if ([e.to, ...e.details.secondaryReasons].some(notStorable)) issue(ctx, "reason_not_storable");
});

const noDetails = z.strictObject({});

const waveDates = Object.fromEntries(waveDateFields.map((f) => [f, isoDate.optional()])) as Record<
  (typeof waveDateFields)[number],
  z.ZodOptional<typeof isoDate>
>;

/** The changed keys of a wave, and old and new value of each changed date; never the name. */
const entryWaveChanged = event("entry_wave_changed", {
  ...ofProject,
  details: z.strictObject({
    waveId: z.uuid(),
    fields: z.array(z.enum(["code", "name", ...waveDateFields])).min(1),
    dates: z
      .partialRecord(
        z.enum(waveDateFields),
        z.strictObject({ from: isoDate.nullable(), to: isoDate.nullable() }),
      )
      .optional(),
  }),
}).superRefine(({ details }, ctx) => {
  const changedDates = details.fields.filter((field) => field !== "code" && field !== "name");
  const withValues = Object.keys(details.dates ?? {});
  const same = withValues.every((field) => changedDates.includes(field as never));
  if (!same || withValues.length !== changedDates.length) issue(ctx, "dates_mismatch");
});
/**
 * A new override version (regional-variation.md, Agentur-scoped settings): its number, what
 * changed, and either the Agentur key, the setting keys (`step.key`) and, when set, the source, or
 * the relaxed rule's id; never a value or free text (round 8). A migration's review
 * (`agentur_setting_reviewed`) names the removed keys as `settingKeys` and the kept ones, if any,
 * as `keptSettingKeys`. Q107: the base-defaults version it was validated with.
 */
const configOverrideChanged = event("config_override_changed", {
  ...ofProject,
  details: z.strictObject({
    version: z.int().min(1),
    change: OverrideChange,
    agenturKey: agenturKey.optional(),
    settingKeys: z.array(SettingKey).min(1).optional(),
    keptSettingKeys: z.array(SettingKey).min(1).optional(),
    source: AgenturSettingSource.optional(),
    ruleId: RuleId.optional(),
    baseDefaultsVersion,
  }),
}).superRefine(({ details }, ctx) => {
  const setting = details.change.startsWith("agentur_setting_");
  const named = [details.agenturKey, details.settingKeys].map((value) => value !== undefined);
  if (named.some((present) => present !== setting) || setting === (details.ruleId !== undefined)) {
    issue(ctx, "change_mismatch");
  }
  if ((details.change === "agentur_setting_set") !== (details.source !== undefined)) {
    issue(ctx, "source_mismatch");
  }
  if (details.keptSettingKeys && details.change !== "agentur_setting_reviewed") {
    issue(ctx, "change_mismatch");
  }
});
/** Free text (name, customer) never enters the trail: the changed keys, the new region's id. */
const projectChanged = event("project_changed", {
  ...ofProject,
  details: z.strictObject({
    fields: z
      .array(z.enum(["name", "customerName", "type", "projectAgenturKey", "regionId"]))
      .min(1),
    type: ProjectType.optional(),
    projectAgenturKey: agenturKey.optional(),
    regionId: z.uuid().optional(),
  }),
}).superRefine(({ details }, ctx) => {
  if (details.fields.includes("regionId") !== (details.regionId !== undefined)) {
    issue(ctx, "region_mismatch");
  }
});

/** A member and the project role, by id and code (Q126). */
const ofMember = { staffUserId: z.uuid(), role: ProjectRole };
/** An assignment row and its consultant (Q62). */
const ofAssignment = { staffUserId: z.uuid(), assignmentId: z.uuid() };

/** Every relaxation event names its request and the rule; the reason code is its column. */
const ofRelaxation = { relaxationRequestId: z.uuid(), ruleId: RuleId };
/** Every profiling-exception event identifies its request record (Q94). */
const ofRequest = { profilingExceptionRequestId: z.uuid() };
const reviewOf = z.strictObject({ reviewedEventId: z.uuid() });

/** One break-glass grant: one participant, one category, document type or stream (Q63). */
const BreakGlassTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("field"), category: AccessCategory }),
  z.strictObject({
    kind: z.literal("document"),
    documentType: DocumentType,
    category: AccessCategory,
  }),
  z.strictObject({ kind: z.literal("audit"), stream: AuditStream }),
]);

/** Every document event names its row and type, never its name or content. */
const ofDocument = { documentId: z.uuid(), documentType: DocumentType };

const documentReviewed = event("document_reviewed", {
  ...ofParticipation,
  actor: staffActor,
  reasonCode: DocumentReviewReason.nullable(),
  details: z.strictObject({ ...ofDocument, decision: z.enum(["accepted", "rejected"]) }),
}).superRefine(({ reasonCode, details }, ctx) => {
  if ((details.decision === "rejected") !== (reasonCode !== null)) issue(ctx, "reason_mismatch");
});

const documentDeleted = event("document_deleted", {
  ...ofParticipation,
  reasonCode: DocumentDeleteReason.nullable(),
  details: z.strictObject(ofDocument),
}).superRefine(({ actor, reasonCode }, ctx) => {
  const staff = actor.type === "user" && actor.onBehalfOf === null;
  if (!staff && actor.type !== "participant") issue(ctx, "actor_mismatch");
  if (staff !== (reasonCode !== null)) issue(ctx, "reason_mismatch");
});

/**
 * A participant's login (ADR-0007): by a one-time code to a channel, or by completing a recovery
 * (Q130), which names its code. Logouts are `participant_logout`.
 */
const participantLogin = event("participant_login", {
  ...ofParticipation,
  details: z.strictObject({
    method: LoginMethod,
    channelId: z.uuid().optional(),
    activationCodeId: z.uuid().optional(),
  }),
}).superRefine(({ details }, ctx) => {
  const byCode = details.method === "one_time_code";
  if (
    byCode !== (details.channelId !== undefined) ||
    byCode === (details.activationCodeId !== undefined)
  ) {
    issue(ctx, "method_mismatch");
  }
});

/**
 * An appointment event names the appointment and, for a booking, its kind and start as written
 * then (Q168: the history never depends on the current appointment row); never the title or the
 * venue (Q166).
 */
const ofBooking = {
  bookingId: z.uuid(),
  appointmentId: z.uuid(),
  appointmentKind: AppointmentKind,
  startsAt: z.iso.datetime(),
};

/** The fields an appointment change names; never their text (Q166). */
const AppointmentField = z.enum([
  "startsAt",
  "endsAt",
  "bookingClosesAt",
  "capacity",
  "title",
  "venue",
  "audienceWaveId",
  "hostStaffUserId",
]);

const appointmentChanged = event("appointment_changed", {
  ...ofProject,
  actor: staffActor,
  details: z.strictObject({
    appointmentId: z.uuid(),
    version: z.int().min(2),
    fields: z.array(AppointmentField).min(1),
    hostStaffUserId: z.uuid().optional(),
  }),
}).superRefine(({ details }, ctx) => {
  if (details.fields.includes("hostStaffUserId") !== (details.hostStaffUserId !== undefined)) {
    issue(ctx, "host_mismatch");
  }
});

/**
 * Staff book as themselves (origin `staff`), the participant in the portal; staff may link a
 * consultation as the follow-up of a missed one (`followUpOf`, its booking; absent in older events).
 */
const appointmentBooked = event("appointment_booked", {
  ...ofParticipation,
  details: z.strictObject({
    ...ofBooking,
    origin: BookingOrigin,
    followUpOf: z.uuid().nullable().optional(),
  }),
}).superRefine(({ actor, details }, ctx) => {
  const staff = actor.type === "user" && actor.onBehalfOf === null;
  const expected = actor.type === "participant" ? "participant" : staff ? "staff" : null;
  if (expected === null || (details.origin === "participant") !== (expected === "participant")) {
    issue(ctx, "origin_mismatch");
  }
  if (details.followUpOf && details.origin !== "staff") issue(ctx, "follow_up_mismatch");
});

/**
 * A booking cancelled: by the participant, by staff, with its appointment (the organizer), or by
 * the system when the participation became terminal.
 */
const appointmentBookingCancelled = event("appointment_booking_cancelled", {
  ...ofParticipation,
  reasonCode: BookingCancelReason,
  details: z.strictObject(ofBooking),
}).superRefine(({ actor, reasonCode }, ctx) => {
  const by =
    actor.type === "participant"
      ? ["participant_cancelled"]
      : actor.type === "system"
        ? ["participation_closed"]
        : actor.onBehalfOf === null
          ? ["staff_cancelled", "appointment_cancelled"]
          : [];
  if (!by.includes(reasonCode)) issue(ctx, "reason_mismatch");
});

/**
 * Attendance recorded or corrected by staff (Q163), with the previous value; `afterClose` exactly
 * when the PL recorded it after the participation closed, with the closed reason.
 */
const attendanceRecorded = event("attendance_recorded", {
  ...ofParticipation,
  actor: staffActor,
  reasonCode: AttendanceAfterCloseReason.nullable(),
  details: z.strictObject({
    ...ofBooking,
    attendance: Attendance,
    previousAttendance: Attendance.nullable(),
    afterClose: z.boolean(),
  }),
}).superRefine(({ reasonCode, details }, ctx) => {
  if (details.afterClose !== (reasonCode !== null)) issue(ctx, "reason_mismatch");
  if (details.attendance === details.previousAttendance) issue(ctx, "attendance_unchanged");
});

/** A conflict ended: by a replacement basis (which it names) or the PL's attestation. */
const attendanceConflictResolved = event("attendance_conflict_resolved", {
  ...ofParticipation,
  actor: staffActor,
  reasonCode: AttendanceConflictResolution,
  details: z.strictObject({ ...ofBooking, basisBookingId: z.uuid().optional() }),
}).superRefine(({ reasonCode, details }, ctx) => {
  if ((reasonCode === "replacement_basis") !== (details.basisBookingId !== undefined)) {
    issue(ctx, "basis_mismatch");
  }
});

/** The system queues the organizer's notices (`appointments.notify`), staff everything else. */
const systemNotice = z.strictObject({
  type: z.literal("system"),
  job: z.literal("appointments.notify"),
});

/**
 * A message queued (data-protection.md, messages): a reminder or an invitation by a PL or the
 * assigned consultant, an organizer's notice by the system; an appointment's message names the
 * appointment and its start as written then (Q168). Without a usable channel (an invitation or a
 * notice only) no channel kind, and the row is cancelled at once. Ids and codes only, never the
 * address or the text.
 */
const reminderQueued = event("reminder_queued", {
  ...ofParticipation,
  actor: z.union([staffActor, systemNotice]),
  details: z.strictObject({
    reminderId: z.uuid(),
    batchId: z.uuid(),
    kind: ReminderKind,
    channelKind: ActivationDeliveryKind.nullable(),
    appointmentId: z.uuid().optional(),
    startsAt: z.iso.datetime().optional(),
  }),
}).superRefine(({ actor, details }, ctx) => {
  if (noticeKinds.has(details.kind) !== (actor.type === "system")) issue(ctx, "actor_mismatch");
  const ofAppointment = details.kind !== "open_items";
  if (
    ofAppointment !== (details.appointmentId !== undefined) ||
    ofAppointment !== (details.startsAt !== undefined) ||
    (!ofAppointment && details.channelKind === null)
  ) {
    issue(ctx, "kind_mismatch");
  }
});

/** Cancelled at the request: no usable channel, before any job. */
const atRequest: ReadonlySet<ReminderCancelReason> = new Set(["no_channel", "consent_required"]);

/**
 * A message's final state: recorded by its job, or at the request when no channel was usable (as
 * whoever queued it); a cancellation names its reason (the reason code), nothing else does; never
 * a provider response or error.
 */
const reminderDelivery = event("reminder_delivery", {
  ...ofParticipation,
  actor: z.union([z.strictObject({ type: z.literal("system"), job: systemJob }), staffActor]),
  reasonCode: ReminderCancelReason.nullable(),
  details: z.strictObject({
    reminderId: z.uuid(),
    outcome: z.enum(["sent", "failed", "delivery_unknown", "cancelled"]),
    kind: ReminderKind.optional(),
    appointmentId: z.uuid().optional(),
  }),
}).superRefine(({ actor, reasonCode, details }, ctx) => {
  if ((details.outcome === "cancelled") !== (reasonCode !== null)) {
    issue(ctx, "reason_mismatch");
  }
  if (actor.type === "user" && !(reasonCode !== null && atRequest.has(reasonCode))) {
    issue(ctx, "actor_mismatch");
  }
  if (details.appointmentId !== undefined && (details.kind ?? "open_items") === "open_items") {
    issue(ctx, "kind_mismatch");
  }
});

/**
 * Every audit event, discriminated by `type`. The types of Slices 3–9 that the plan gives no
 * shape for (`warning_confirmed`, `export_created`) carry a code and no details until their
 * slices define them.
 */
export const AuditEvent = z.discriminatedUnion("type", [
  event("participation_created", {
    ...ofParticipation,
    to: z.literal("imported"),
    details: z.strictObject({ entryWaveId: z.uuid().optional() }),
  }),
  statusChanged,
  event("entry_wave_assigned", {
    ...ofParticipation,
    details: z.strictObject({ waveId: z.uuid(), previousWaveId: z.uuid().nullable() }),
  }),
  /** The request names its opaque evidence record; never the fingerprint or contents (Q94). */
  event("profiling_exception_requested", {
    ...ofParticipation,
    reasonCode: ProfilingExceptionReason,
    details: z.strictObject({ ...ofRequest, evidenceRecordId: z.uuid() }),
  }),
  event("profiling_exception_approved", { ...ofParticipation, details: z.strictObject(ofRequest) }),
  event("profiling_exception_rejected", { ...ofParticipation, details: z.strictObject(ofRequest) }),
  event("profiling_exception_revoked", { ...ofParticipation, details: z.strictObject(ofRequest) }),
  event("profiling_exception_superseded", {
    ...ofParticipation,
    reasonCode: ProfilingExceptionSupersededReason,
    /** `statusChangeId`: the `status_changed` event that made the request stale. */
    details: z.strictObject({ ...ofRequest, statusChangeId: z.uuid() }),
  }),
  endReasonCorrected,
  /** Key, actor, subject and time; never the value (round 11). */
  event("sensitive_read", { ...ofParticipation, details: z.strictObject({ key: resourceKey }) }),
  event("sensitive_write", { ...ofParticipation, details: z.strictObject({ key: resourceKey }) }),
  event("break_glass_access", {
    ...ofParticipation,
    reasonCode: code,
    flaggedForReview: z.literal(true),
    details: z.strictObject({
      action: z.enum(["read", "open_document"]),
      target: BreakGlassTarget,
    }),
  }),
  event("document_opened", {
    ...ofParticipation,
    details: z.strictObject({ documentType: DocumentType, documentId: z.uuid() }),
  }),
  event("warning_confirmed", { ...ofProjectOrParticipation, reasonCode: code, details: noDetails }),
  event("export_created", { ...ofProjectOrParticipation, reasonCode: code, details: noDetails }),
  configOverrideChanged,
  /** Reviews and clarification requests are new events pointing at the reviewed one (ADR-0002). */
  event("review_recorded", { ...ofProjectOrParticipation, reasonCode: code, details: reviewOf }),
  event("clarification_requested", { ...ofProjectOrParticipation, details: reviewOf }),
  /** Free text (name, customer) never enters the trail: the type, and the changed keys. */
  event("project_created", { ...ofProject, details: z.strictObject({ type: ProjectType }) }),
  projectChanged,
  /** The wave's dates as created; the code and name stay on the row. */
  event("entry_wave_created", {
    ...ofProject,
    details: z.strictObject({ waveId: z.uuid(), ...waveDates }),
  }),
  entryWaveChanged,
  /**
   * A pin of a template version (regional-variation.md); `previousVersion` when a migration
   * replaces one.
   */
  event("config_template_pinned", {
    ...ofProject,
    details: z.strictObject({
      agenturKey,
      version: z.int().min(1),
      previousVersion: z.int().min(1).optional(),
      baseDefaultsVersion,
    }),
  }),
  /** Requested against the snapshot of this release (Q107); approved as override `version`. */
  event("rule_relaxation_requested", {
    ...ofProject,
    reasonCode: RelaxationReasonCode,
    details: z.strictObject({ ...ofRelaxation, baseDefaultsVersion }),
  }),
  event("rule_relaxation_approved", {
    ...ofProject,
    reasonCode: RelaxationReasonCode,
    details: z.strictObject({ ...ofRelaxation, version: z.int().min(1), baseDefaultsVersion }),
  }),
  event("rule_relaxation_rejected", { ...ofProject, details: z.strictObject(ofRelaxation) }),
  event("rule_relaxation_withdrawn", { ...ofProject, details: z.strictObject(ofRelaxation) }),
  /**
   * Draft → active (process-and-lifecycle.md, Dates): the Project Agentur and the version of its
   * pinned template the activation was checked against, and the base-defaults version (Q107).
   */
  event("project_activated", {
    ...ofProject,
    details: z.strictObject({
      projectAgenturKey: agenturKey,
      projectAgenturVersion: z.int().min(1),
      baseDefaultsVersion,
    }),
  }),
  /**
   * Person data written (data-protection.md, person-data writes): the changed fields, never a value
   * (Q66).
   */
  event("participant_data_changed", {
    ...ofParticipation,
    details: z.strictObject({
      fields: z.array(z.union([ParticipantDataField, ProfileField, CustomFieldKey])).min(1),
    }),
  }),
  /**
   * A confirmed import (process-and-lifecycle.md, Import): the counts and the base-defaults
   * version its required targets were resolved with (Q107). Correlated with the rows' own events by
   * the request id.
   */
  event("import_confirmed", {
    ...ofProject,
    details: z.strictObject({
      created: z.int().min(0),
      updated: z.int().min(0),
      unchanged: z.int().min(0),
      skipped: z.int().min(0),
      baseDefaultsVersion,
    }),
  }),
  /**
   * A participation the PL created by hand (process-and-lifecycle.md, "Import and manual
   * creation"): one import row, so its required targets were resolved with this base-defaults
   * version (Q107, round 33). The creation and the person
   * data have their own events; correlated by the request id.
   */
  /**
   * A change of the contractual dates (process-and-lifecycle.md, "BA reporting"): the effective
   * dates that changed, old and new, the amendment of a signed DSV, and the BA reporting tasks it
   * created.
   */
  event("participation_dates_changed", {
    ...ofParticipation,
    details: z.strictObject({
      oldTgStart: isoDate.optional(),
      newTgStart: isoDate.optional(),
      oldTgEnd: isoDate.optional(),
      newTgEnd: isoDate.optional(),
      amendmentId: z.uuid().optional(),
      reportingKinds: z.array(BaReportingKind).min(1),
    }),
  }),
  event("participation_created_manually", {
    ...ofParticipation,
    details: z.strictObject({ baseDefaultsVersion }),
  }),
  /** Team changes (Q126): who, in which project role; a removal says why. */
  event("project_member_added", { ...ofProject, details: z.strictObject(ofMember) }),
  event("project_member_removed", {
    ...ofProject,
    reasonCode: MemberRemovalReason,
    details: z.strictObject(ofMember),
  }),
  /** Assignments (Q62): one event per participation and consultant; a closure says why. */
  event("participant_assigned", { ...ofParticipation, details: z.strictObject(ofAssignment) }),
  event("participant_unassigned", {
    ...ofParticipation,
    reasonCode: AssignmentEndReason,
    details: z.strictObject(ofAssignment),
  }),
  event("activation_code_issued", {
    ...ofParticipation,
    details: z.strictObject({
      activationCodeId: z.uuid(),
      purpose: ActivationPurpose,
      channel: ActivationChannel,
      identityCheck: IdentityCheck,
      deliveryKind: ActivationDeliveryKind.optional(),
      noticeVersion: textVersion,
      language: NoticeLanguage,
    }),
  }),
  event("activation_code_delivery", {
    ...ofParticipation,
    details: z.strictObject({
      activationCodeId: z.uuid(),
      outcome: z.enum(["sent", "failed", "delivery_unknown"]),
    }),
  }),
  event("activation_code_handed_over", {
    ...ofParticipation,
    details: z.strictObject({
      activationCodeId: z.uuid(),
      method: IdentityCheckMethod,
    }),
  }),
  event("activation_code_revoked", {
    ...ofParticipation,
    reasonCode: ActivationRevokeReason,
    details: z.strictObject({ activationCodeId: z.uuid() }),
  }),
  event("privacy_notice_provided", {
    ...ofParticipation,
    details: z.strictObject({
      noticeDeliveryId: z.uuid(),
      activationCodeId: z.uuid().optional(),
      noticeVersion: textVersion,
      language: NoticeLanguage,
      method: NoticeMethod,
    }),
  }),
  /**
   * The participant's own activation (ADR-0007, portal activation): the code used, how the identity
   * was assured, the notice version shown in the portal (never a first delivery) and the account's
   * language.
   */
  event("participant_activated", {
    ...ofParticipation,
    details: z.strictObject({
      activationCodeId: z.uuid(),
      identityAssurance: IdentityAssurance,
      noticeVersion: textVersion,
      language: NoticeLanguage,
    }),
  }),
  /**
   * A consent record (Q123): its purpose, channel, text version and language; never the address.
   */
  event("consent_given", {
    ...ofParticipation,
    details: z
      .strictObject({
        consentId: z.uuid(),
        channelId: z.uuid().optional(),
        purpose: ConsentPurpose,
        textVersion,
        language: NoticeLanguage,
      })
      .superRefine(channelOfPurpose),
  }),
  event("contact_channel_added", {
    ...ofParticipation,
    details: z.strictObject({
      channelId: z.uuid(),
      kind: ActivationDeliveryKind,
      verifiedBy: ChannelVerification,
    }),
  }),
  /**
   * The fifth failure locked the code (ADR-0007); the system records it (job `portal-activation`).
   */
  event("activation_code_locked", {
    ...ofParticipation,
    details: z.strictObject({ activationCodeId: z.uuid() }),
  }),
  /** The fifth wrong entry ended a one-time code (ADR-0007). */
  event("one_time_code_exhausted", {
    ...ofParticipation,
    details: z.strictObject({ challengeId: z.uuid(), purpose: OneTimeCodePurpose }),
  }),
  event("participant_logout", { ...ofParticipation, details: noDetails }),
  participantLogin,
  /** A channel ended (Q123, Q130): the participant removed it, or a completed recovery replaced it. */
  event("contact_channel_removed", {
    ...ofParticipation,
    reasonCode: ChannelRemovalReason,
    details: z.strictObject({ channelId: z.uuid(), kind: ActivationDeliveryKind }),
  }),
  /** A consent's use ended with its channel; `lost_access_replaced` is never a withdrawal (Q130). */
  event("consent_ended", {
    ...ofParticipation,
    reasonCode: ConsentEndReason,
    details: z
      .strictObject({
        consentId: z.uuid(),
        channelId: z.uuid().optional(),
        purpose: ConsentPurpose,
      })
      .superRefine(channelOfPurpose),
  }),
  /** A recovery code was issued (Q130): the sessions ended and these channels were suspended. */
  event("contact_channels_suspended", {
    ...ofParticipation,
    reasonCode: ChannelSuspensionReason,
    details: z.strictObject({ activationCodeId: z.uuid(), channelIds: z.array(z.uuid()) }),
  }),
  /**
   * The placement Agentur set or changed (Q139): the new key and the one it replaced, both keys
   * (not free text), and the base-defaults version the override was checked with (Q107). A pin it
   * made has its own `config_template_pinned`; correlated by the request id.
   */
  event("placement_agentur_set", {
    ...ofParticipation,
    details: z.strictObject({
      agenturKey,
      previousAgenturKey: agenturKey.optional(),
      baseDefaultsVersion,
    }),
  }),
  /**
   * The participant (or staff on their behalf) acknowledged the purposes notice (Q138): its
   * version and language; not a consent.
   */
  event("self_service_notice_acknowledged", {
    ...ofParticipation,
    details: z.strictObject({
      acknowledgementId: z.uuid(),
      noticeVersion: textVersion,
      language: NoticeLanguage,
    }),
  }),
  /**
   * A participant session stepped up before special-category data (Q137): by birth date, or by a
   * step-up code (its challenge). Never the date or the code.
   */
  event("step_up_completed", {
    ...ofParticipation,
    details: z.union([
      z.strictObject({ method: z.literal("birth_date") }),
      z.strictObject({ method: z.literal("photo_id_and_code"), challengeId: z.uuid() }),
    ]),
  }),
  /** The fifth wrong birth date of a step-up ended the session (Q137). */
  event("step_up_failed", {
    ...ofParticipation,
    details: z.strictObject({ method: z.literal("birth_date") }),
  }),
  /**
   * A staff user opened assisted mode for the participant after the confirmation (Q136): how, as
   * a code; the staff user's own action, so not on behalf of anyone. What they then read and write
   * is audited as actor and `onBehalfOf`.
   */
  event("assisted_mode_started", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject({ assistedModeId: z.uuid(), how: AssistedModeHow }),
  }),
  /** It ended: "Beenden", or with the staff session it was bound to. */
  event("assisted_mode_ended", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject({ assistedModeId: z.uuid(), endReason: AssistedModeEndReason }),
  }),
  /**
   * A document stored (data-protection.md, uploads): its id, type and where it came from; never
   * the file name, the content or its hash. In assisted mode as actor and `onBehalfOf`.
   */
  event("document_added", {
    ...ofParticipation,
    details: z.strictObject({ ...ofDocument, source: DocumentSource }),
  }).superRefine(({ actor, details }, ctx) => {
    const expected =
      actor.type === "participant"
        ? "portal"
        : actor.type === "user" && actor.onBehalfOf
          ? "assisted"
          : "staff";
    if (actor.type === "system" || details.source !== expected) issue(ctx, "source_mismatch");
  }),
  /** Reviewed once and finally by staff in normal mode; a rejection names its reason. */
  documentReviewed,
  /** Deleted (the row kept as a tombstone): by staff with a reason, by the participant without. */
  documentDeleted,
  /** An upload the scan refused (Q144): nothing was stored; the type and the code only. */
  event("document_upload_rejected", {
    ...ofParticipation,
    reasonCode: z.enum(["file_infected", "file_unscannable"]),
    details: z.strictObject({ documentType: DocumentType }),
  }),
  /**
   * A reminder queued by a PL or the assigned consultant (data-protection.md, reminders): ids and
   * codes only, never the address or the text.
   */
  reminderQueued,
  /**
   * A reminder's final state, recorded by its job: a cancellation names its reason (the reason
   * code), nothing else does; never a provider response or error.
   */
  reminderDelivery,
  /**
   * A staff user opened the participation's audit history (data-protection.md, audit metadata;
   * Q157): who, which participation and when, nothing else. A security event, never shown in a
   * history itself.
   */
  event("audit_history_opened", { ...ofParticipation, actor: staffActor, details: noDetails }),
  /**
   * An appointment created by the PL or a consultant (their own slot): its id, kind, times,
   * capacity and, where set, host and wave; project-level, in no participation's history.
   */
  event("appointment_created", {
    ...ofProject,
    actor: staffActor,
    details: z.strictObject({
      appointmentId: z.uuid(),
      kind: AppointmentKind,
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      bookingClosesAt: z.iso.datetime(),
      capacity: z.int().min(1).max(500),
      hostStaffUserId: z.uuid().optional(),
      audienceWaveId: z.uuid().optional(),
    }),
  }),
  /** The changed keys and the new version; a new host by id. */
  appointmentChanged,
  /** Cancelled by the organizer with a closed reason; `correction` is the PL's later correction. */
  event("appointment_cancelled", {
    ...ofProject,
    actor: staffActor,
    reasonCode: AppointmentCancelReason,
    details: z.strictObject({ appointmentId: z.uuid(), correction: z.boolean() }),
  }),
  appointmentBooked,
  appointmentBookingCancelled,
  attendanceRecorded,
  /** An absence superseded by the PL's `did_not_take_place` correction, kept in the history. */
  event("attendance_superseded", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject({ ...ofBooking, previousAttendance: z.literal("absent") }),
  }),
  /**
   * The confirmation that the necessary information was delivered, on the attendance it rests on:
   * with the status changes to `informed`, or a replacement basis without one.
   */
  event("information_delivery_confirmed", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject({ ...ofBooking, statusChanged: z.boolean() }),
  }),
  /** The PL's open handling state of a conflict. */
  event("attendance_conflict_escalated", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject(ofBooking),
  }),
  attendanceConflictResolved,
  /** How staff told a person whose notice wasn't delivered, or that it isn't needed. */
  event("appointment_notice_followed_up", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject({
      reminderId: z.uuid(),
      appointmentId: z.uuid(),
      method: NoticeFollowUpMethod,
    }),
  }),
  /** No further follow-up of a missed appointment, with the closed reason (Q167). */
  event("missed_appointment_resolved", {
    ...ofParticipation,
    actor: staffActor,
    reasonCode: MissedResolution,
    details: z.strictObject(ofBooking),
  }),
  /** One profiling session added, changed or removed by a whole write (Q193): its id and date. */
  event("profiling_session_changed", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject({
      action: z.enum(["added", "changed", "removed"]),
      sessionId: z.uuid(),
      date: isoDate,
    }),
  }),
  /** The pending declarations to the BA changed: the keys, never the values (Q193). */
  event("profiling_declarations_recorded", {
    ...ofParticipation,
    actor: staffActor,
    details: z.strictObject({
      fields: z.array(z.enum(["jobboerseChoice", "baContactConsent"])).min(1),
    }),
  }),
]);
export type AuditEvent = z.infer<typeof AuditEvent>;
