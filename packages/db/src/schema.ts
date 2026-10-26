import {
  AccessCategory,
  ActorType,
  AmendmentOriginalLocation,
  AssistedModeEndReason,
  AssistedModeHow,
  AuditEventType,
  AuditStream,
  BaReportingKind,
  BaReportingStatus,
  DsvAmendmentKind,
  DsvStatus,
  EndReason,
  ImportTarget,
  MainStatus,
  ProfilingExceptionReason,
  ProfilingExceptionStatus,
  ProfilingExceptionSupersededReason,
  ProfilingStatus,
  ProjectRole,
  ProjectStatus,
  ProjectType,
  RelaxationReasonCode,
  RelaxationRequestStatus,
  StaffAuditEventType,
  OrgRole,
  AssignmentEndReason,
  StaffSessionEndReason,
  STAFF_SESSION_HOURS,
  StatusField,
  TgEntryKind,
  Track,
  ActivationChannel,
  ActivationDeliveryKind,
  ActivationDeliveryStatus,
  ActivationPurpose,
  ActivationRevokeReason,
  IdentityCheck,
  NoticeLanguage,
  NoticeMethod,
  ChannelVerification,
  ConsentPurpose,
  ConsentSource,
  contactFields,
  DrivingLicenceClass,
  Gender,
  MaritalStatus,
  rowLimits,
  IdentityAssurance,
  OneTimeCodePurpose,
  ParticipantSessionState,
  StepUpMethod,
  ChannelSuspensionReason,
  ChannelRemovalReason,
  ConsentEndReason,
  ParticipantSessionEndReason,
  SensitiveStepUpMethod,
  edgeKinds,
  portalLimits,
  DocumentType,
  DocumentMediaType,
  DocumentReviewState,
  DocumentReviewReason,
  DocumentDeleteReason,
  documentLimits,
  ReminderKind,
  ReminderStatus,
  ReminderCancelReason,
  NoticeFollowUpMethod,
  AppointmentKind,
  AppointmentStatus,
  AppointmentCancelReason,
  BookingOrigin,
  BookingStatus,
  BookingCancelReason,
  MissedResolution,
  Attendance,
  AttendanceAfterCloseReason,
  AttendanceConflictResolution,
  appointmentPolicy,
  JobboerseChoice,
} from "@transfer/domain";
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

// Every table here needs an entry in data-catalog.ts (CLAUDE.md rule 10); a test enforces it.

// The Postgres enums take their values from the domain's Zod enums.
const values = <T extends string>(e: { options: T[] }) => e.options as [T, ...T[]];

export const orgRole = pgEnum("org_role", values(OrgRole));
export const projectType = pgEnum("project_type", values(ProjectType));
export const projectStatus = pgEnum("project_status", values(ProjectStatus));
export const projectRole = pgEnum("project_role", values(ProjectRole));

/**
 * Staff accounts, created in the app by a global admin (Q7, Q126) through `create_staff_user`;
 * synthetic ones from the seed. Never hard-deleted (Q59): `deactivate_staff_user` sets
 * `deactivated_at`. The first OIDC login binds `(oidc_issuer, oidc_subject)` through
 * `bind_staff_identity` (ADR-0007, staff sessions); a deactivated account can't log in. No flat
 * role: org roles are `staff_org_role` rows, project roles `project_membership` rows, and
 * `may_create_projects` lets its holder create projects (and become their first PL).
 */
export const staffUser = pgTable(
  "staff_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull().unique(),
    mayCreateProjects: boolean("may_create_projects").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    oidcIssuer: text("oidc_issuer"),
    oidcSubject: text("oidc_subject"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    unique("staff_user_oidc_identity_key").on(t.oidcIssuer, t.oidcSubject),
    // The first login matches the email case-insensitively (ADR-0007), so one address is one
    // account.
    uniqueIndex("staff_user_email_lower_key").on(sql`lower(${t.email})`),
    check(
      "staff_user_oidc_identity_complete",
      sql`(${t.oidcIssuer} is null) = (${t.oidcSubject} is null)`,
    ),
    check(
      "staff_user_oidc_issuer_format",
      sql`${t.oidcIssuer} ~ '^https?://[!-~]{1,255}$' and length(${t.oidcIssuer}) <= 263`,
    ),
    check("staff_user_oidc_subject_format", sql`${t.oidcSubject} ~ '^[!-~]{1,255}$'`),
    // The domain's StaffAccount inputs: a trimmed name, an address with one @, no control
    // characters.
    check(
      "staff_user_display_name",
      sql`${t.displayName} = btrim(${t.displayName}) and length(${t.displayName}) between 1 and 100 and ${t.displayName} !~ '[[:cntrl:]]'`,
    ),
    check(
      "staff_user_email_format",
      sql`${t.email} ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$' and length(${t.email}) <= 254`,
    ),
  ],
);

/**
 * Regions (Niederlassungen, Q35, Q126): reference data the global admin maintains through
 * `create_region` and `update_region`; `transfer_app` only reads it.
 */
export const region = pgTable(
  "region",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("region_code_format", sql`${t.code} ~ '^[A-Z0-9]([A-Z0-9-]{0,18}[A-Z0-9])?$'`),
    check(
      "region_name",
      sql`${t.name} = btrim(${t.name}) and length(${t.name}) between 1 and 100 and ${t.name} !~ '[[:cntrl:]]'`,
    ),
  ],
);

/**
 * Org roles (Q80, Q126): `admin` is global (no region), `regional_admin` and
 * `regional_operations_manager` are granted per region. Granted and revoked only by the global
 * admin through `grant_org_role` and `revoke_org_role`; a revoked role's row is deleted (its
 * `org_role_revoked` event stays). `granted_by` is null only for roles migrated from the flat role.
 */
export const staffOrgRole = pgTable(
  "staff_org_role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUser.id),
    role: orgRole("role").notNull(),
    regionId: uuid("region_id").references(() => region.id),
    grantedBy: uuid("granted_by").references(() => staffUser.id),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("staff_org_role_unique").on(t.staffUserId, t.role, t.regionId).nullsNotDistinct(),
    check("staff_org_role_region_scope", sql`(${t.role} = 'admin') = (${t.regionId} is null)`),
  ],
);

export const staffSessionEndReason = pgEnum(
  "staff_session_end_reason",
  values(StaffSessionEndReason),
);

/**
 * Server-side staff sessions for both login modes (ADR-0007, staff sessions): the cookie holds 32
 * random bytes, the row only their SHA-256, so reading the table gives no live session. 8 hours
 * absolute; the API checks expiry against database time. Written only by `start_staff_session` and
 * `end_staff_session`; `transfer_app` only reads it.
 */
export const staffSession = pgTable(
  "staff_session",
  {
    tokenHash: text("token_hash").primaryKey(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUser.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
    endReason: staffSessionEndReason("end_reason"),
  },
  (t) => [
    index("staff_session_staff_user_idx").on(t.staffUserId),
    check("staff_session_token_hash", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "staff_session_lifetime",
      sql`${t.expiresAt} = ${t.createdAt} + ${sql.raw(`interval '${STAFF_SESSION_HOURS} hours'`)}`,
    ),
    check("staff_session_ended", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
  ],
);

/**
 * The root of project scoping, so it has no project_id itself (ADR-0002). Written only by the
 * setup functions (ADR-0002, project setup); `transfer_app` only reads it.
 */
export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    customerName: text("customer_name").notNull(),
    type: projectType("type").notNull(),
    // The contractual dates live on the entry waves (Q79); Slice 2 dropped the Slice 0 columns.
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => staffUser.id),
    /** Draft until activated (Q98); one-way in Slice 2. Written only by the setup functions. */
    status: projectStatus("status").notNull().default("draft"),
    /** The Project Agentur (Q90); chosen with its pinned template (regional-variation.md). */
    projectAgenturKey: text("project_agentur_key"),
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }),
    activatedBy: uuid("activated_by").references(() => staffUser.id),
    /**
     * The region (Q126): chosen by the creator; the PL changes it while draft, a global admin at
     * any time. Null only for projects created before regions; only global roles see those.
     */
    regionId: uuid("region_id").references(() => region.id),
  },
  (t) => [
    check(
      "project_activated",
      sql`(${t.status} = 'active') = (${t.activatedAt} is not null) and (${t.activatedAt} is null) = (${t.activatedBy} is null)`,
    ),
    check("project_agentur_key_format", sql`${t.projectAgenturKey} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    index("project_created_at_id_idx").on(t.createdAt.desc(), t.id.desc()),
    index("project_region_idx").on(t.regionId),
  ],
);

/**
 * Project roles of staff (Q61; data-protection.md, access matrix): zero or more per person and
 * project; permissions are their union. Written by `create_project` (the creator's PL row),
 * `add_project_member` and `remove_project_member` (the PL; a global admin adds a replacement PL,
 * Q126) and `deactivate_staff_user`; a removed role's row is deleted, its audit events stay.
 */
export const projectMembership = pgTable(
  "project_membership",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUser.id),
    role: projectRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "project_membership_pkey", columns: [t.projectId, t.staffUserId, t.role] }),
    index("project_membership_staff_user_idx").on(t.staffUserId),
  ],
);

export const mainStatus = pgEnum("main_status", values(MainStatus));
export const profilingStatus = pgEnum("profiling_status", values(ProfilingStatus));
export const dsvStatus = pgEnum("dsv_status", values(DsvStatus));
export const lifecycleTrack = pgEnum("lifecycle_track", values(Track));
export const statusField = pgEnum("status_field", values(StatusField));
export const endReason = pgEnum("end_reason", values(EndReason));
export const tgEntryKind = pgEnum("tg_entry_kind", values(TgEntryKind));
export const edgeKind = pgEnum("edge_kind", edgeKinds);
export const actorType = pgEnum("actor_type", values(ActorType));
export const profilingExceptionStatus = pgEnum(
  "profiling_exception_status",
  values(ProfilingExceptionStatus),
);
export const profilingExceptionReason = pgEnum(
  "profiling_exception_reason",
  values(ProfilingExceptionReason),
);
export const profilingExceptionSupersededReason = pgEnum(
  "profiling_exception_superseded_reason",
  values(ProfilingExceptionSupersededReason),
);
export const auditEventType = pgEnum("audit_event_type", values(AuditEventType));
export const auditStream = pgEnum("audit_stream", values(AuditStream));
export const accessCategory = pgEnum("access_category", values(AccessCategory));
export const assignmentEndReason = pgEnum("assignment_end_reason", values(AssignmentEndReason));
export const staffAuditEventType = pgEnum("staff_audit_event_type", values(StaffAuditEventType));
export const relaxationReasonCode = pgEnum("relaxation_reason_code", values(RelaxationReasonCode));
export const importTarget = pgEnum("import_target", values(ImportTarget));
export const dsvAmendmentKind = pgEnum("dsv_amendment_kind", values(DsvAmendmentKind));
export const amendmentOriginalLocation = pgEnum(
  "amendment_original_location",
  values(AmendmentOriginalLocation),
);
export const baReportingKind = pgEnum("ba_reporting_kind", values(BaReportingKind));
export const baReportingStatus = pgEnum("ba_reporting_status", values(BaReportingStatus));
export const relaxationRequestStatus = pgEnum(
  "relaxation_request_status",
  values(RelaxationRequestStatus),
);
export const activationPurpose = pgEnum("activation_purpose", values(ActivationPurpose));
export const activationChannel = pgEnum("activation_channel", values(ActivationChannel));
export const identityCheck = pgEnum("identity_check", values(IdentityCheck));
export const activationDeliveryKind = pgEnum(
  "activation_delivery_kind",
  values(ActivationDeliveryKind),
);
export const activationDeliveryStatus = pgEnum(
  "activation_delivery_status",
  values(ActivationDeliveryStatus),
);
export const activationRevokeReason = pgEnum(
  "activation_revoke_reason",
  values(ActivationRevokeReason),
);
export const noticeLanguage = pgEnum("notice_language", values(NoticeLanguage));
export const noticeMethod = pgEnum("notice_method", values(NoticeMethod));
export const identityAssurance = pgEnum("identity_assurance", values(IdentityAssurance));
export const contactChannelKind = pgEnum("contact_channel_kind", values(ActivationDeliveryKind));
export const channelVerification = pgEnum("channel_verification", values(ChannelVerification));
export const channelSuspensionReason = pgEnum(
  "channel_suspension_reason",
  values(ChannelSuspensionReason),
);
export const channelRemovalReason = pgEnum("channel_removal_reason", values(ChannelRemovalReason));
export const consentPurpose = pgEnum("consent_purpose", values(ConsentPurpose));
export const consentSource = pgEnum("consent_source", values(ConsentSource));
export const gender = pgEnum("gender", values(Gender));
export const maritalStatus = pgEnum("marital_status", values(MaritalStatus));
export const drivingLicenceClass = pgEnum("driving_licence_class", values(DrivingLicenceClass));
export const consentEndReason = pgEnum("consent_end_reason", values(ConsentEndReason));
export const oneTimeCodePurpose = pgEnum("one_time_code_purpose", values(OneTimeCodePurpose));
export const challengeInvalidation = pgEnum("challenge_invalidation", [
  "superseded",
  "delivery_failed",
]);
export const participantSessionState = pgEnum(
  "participant_session_state",
  values(ParticipantSessionState),
);
export const participantSessionEndReason = pgEnum(
  "participant_session_end_reason",
  values(ParticipantSessionEndReason),
);
export const stepUpMethod = pgEnum("step_up_method", values(StepUpMethod));
export const sensitiveStepUpMethod = pgEnum(
  "sensitive_step_up_method",
  values(SensitiveStepUpMethod),
);
export const assistedModeHow = pgEnum("assisted_mode_how", values(AssistedModeHow));
export const documentType = pgEnum("document_type", values(DocumentType));
export const documentMediaType = pgEnum("document_media_type", values(DocumentMediaType));
export const documentReviewState = pgEnum("document_review_state", values(DocumentReviewState));
export const documentReviewReason = pgEnum("document_review_reason", values(DocumentReviewReason));
export const documentDeleteReason = pgEnum("document_delete_reason", values(DocumentDeleteReason));
export const documentSessionKind = pgEnum("document_session_kind", ["staff", "participant"]);
export const reminderKind = pgEnum("reminder_kind", values(ReminderKind));
export const reminderStatus = pgEnum("reminder_status", values(ReminderStatus));
export const reminderCancelReason = pgEnum("reminder_cancel_reason", values(ReminderCancelReason));
export const noticeFollowUpMethod = pgEnum("notice_follow_up_method", values(NoticeFollowUpMethod));
export const appointmentKind = pgEnum("appointment_kind", values(AppointmentKind));
export const appointmentStatus = pgEnum("appointment_status", values(AppointmentStatus));
export const appointmentCancelReason = pgEnum(
  "appointment_cancel_reason",
  values(AppointmentCancelReason),
);
export const bookingOrigin = pgEnum("booking_origin", values(BookingOrigin));
export const bookingStatus = pgEnum("booking_status", values(BookingStatus));
export const bookingCancelReason = pgEnum("booking_cancel_reason", values(BookingCancelReason));
export const attendance = pgEnum("attendance", values(Attendance));
export const attendanceAfterCloseReason = pgEnum(
  "attendance_after_close_reason",
  values(AttendanceAfterCloseReason),
);
export const attendanceConflictResolution = pgEnum(
  "attendance_conflict_resolution",
  values(AttendanceConflictResolution),
);
export const missedResolution = pgEnum("missed_resolution", values(MissedResolution));
export const jobboerseChoice = pgEnum("jobboerse_choice", values(JobboerseChoice));
export const assistedModeEndReason = pgEnum(
  "assisted_mode_end_reason",
  values(AssistedModeEndReason),
);

const dateColumn = (name: string) => date(name, { mode: "string" });
const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

/**
 * An entry wave of a `ta_tg` project (Q79): a timing cohort with its contractual dates, nullable
 * while draft. Written only by `create_entry_wave` and `update_entry_wave`
 * (process-and-lifecycle.md, Dates); `transfer_app` only reads it. The CHECKs hold the ordering the
 * offer and entry guards need.
 */
export const projectEntryWave = pgTable(
  "project_entry_wave",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    signingDeadline: dateColumn("signing_deadline"),
    defaultTgStart: dateColumn("default_tg_start"),
    defaultTgEnd: dateColumn("default_tg_end"),
    latestEntryDate: dateColumn("latest_entry_date"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("project_entry_wave_project_code_unique").on(t.projectId, t.code),
    // Target of participation's composite FK: a participation's wave is of its own project.
    unique("project_entry_wave_id_project_unique").on(t.id, t.projectId),
    check("project_entry_wave_tg_dates_ordered", sql`${t.defaultTgStart} <= ${t.defaultTgEnd}`),
    check(
      "project_entry_wave_signing_before_start",
      sql`${t.signingDeadline} <= ${t.defaultTgStart}`,
    ),
    check(
      "project_entry_wave_signing_before_latest_entry",
      sql`${t.signingDeadline} <= ${t.latestEntryDate}`,
    ),
    check(
      "project_entry_wave_start_before_latest_entry",
      sql`${t.defaultTgStart} <= ${t.latestEntryDate}`,
    ),
  ],
);

/** `"participation"."<column>" in (…)`, for the participation CHECKs. */
const participationIn = (column: string, list: string[]) =>
  sql.raw(`"participation"."${column}" in (${list.map((v) => `'${v}'`).join(", ")})`);

const statusIn = (...list: string[]) => participationIn("status", list);

/** A CHECK that `column` is set exactly when `condition` holds. */
const iff = (name: string, condition: SQL, column: { name: string }) =>
  check(name, sql`(${condition}) = (${sql.identifier(column.name)} is not null)`);

/**
 * One person in one project. Written only by the status functions (ADR-0002):
 * `transfer_app` may only select. Personal data comes with Slice 2.
 */
export const participation = pgTable(
  "participation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    entryWaveId: uuid("entry_wave_id"),
    status: mainStatus("status").notNull(),
    profilingStatus: profilingStatus("profiling_status").notNull(),
    dsvStatus: dsvStatus("dsv_status").notNull(),
    // Contractual overrides of the wave defaults (null = the wave's), and a re-offer's deadline.
    offerDeadline: dateColumn("offer_deadline"),
    tgStart: dateColumn("tg_start"),
    tgEnd: dateColumn("tg_end"),
    // Effective dates, set by the status function.
    tgEntryDate: dateColumn("tg_entry_date"),
    exitDate: dateColumn("exit_date"),
    withdrawnOn: dateColumn("withdrawn_on"),
    profilingDoneOn: dateColumn("profiling_done_on"),
    endReason: endReason("end_reason"),
    /** Who set the primary reason: a system-derived one moves to the secondary list (Q72). */
    endReasonSource: actorType("end_reason_source"),
    endReasonSecondary: endReason("end_reason_secondary")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The current (latest) profiling-exception request; every request is its own row (Q94). */
    profilingExceptionRequestId: uuid("profiling_exception_request_id"),
    statusVersion: integer("status_version").notNull().default(0),
    /** The Agentur the participant is placed with (Q139), set only by `set_placement_agentur`. */
    placementAgenturKey: text("placement_agentur_key"),
    placementAgenturSetAt: timestamp("placement_agentur_set_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "participation_entry_wave_same_project_fk",
      columns: [t.entryWaveId, t.projectId],
      foreignColumns: [projectEntryWave.id, projectEntryWave.projectId],
    }),
    index("participation_project_id_idx").on(t.projectId),
    check("participation_tg_dates_ordered", sql`${t.tgStart} <= ${t.tgEnd}`),
    check(
      "participation_placement_agentur_key_format",
      sql`${t.placementAgenturKey} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    iff(
      "participation_placement_agentur_set_at_with_key",
      sql.raw("placement_agentur_key is not null"),
      t.placementAgenturSetAt,
    ),
    check("participation_offer_deadline_before_tg_start", sql`${t.offerDeadline} <= ${t.tgStart}`),
    check(
      "participation_offer_needs_wave",
      sql`${t.dsvStatus} = 'not_offered' or ${t.entryWaveId} is not null`,
    ),
    iff("participation_end_reason_when_ended", statusIn("withdrawn", "exited"), t.endReason),
    iff(
      "participation_end_reason_source_with_reason",
      sql.raw("end_reason is not null"),
      t.endReasonSource,
    ),
    check(
      "participation_secondary_reasons_with_reason",
      sql`${t.endReason} is not null or cardinality(${t.endReasonSecondary}) = 0`,
    ),
    // Q66: not storable until encrypted storage exists (Slice 8).
    check(
      "participation_end_reason_storable",
      sql`${t.endReason} is distinct from 'long_term_illness_reduced_earning_capacity' and not ('long_term_illness_reduced_earning_capacity' = any(${t.endReasonSecondary}))`,
    ),
    iff("participation_withdrawn_on_when_withdrawn", statusIn("withdrawn"), t.withdrawnOn),
    iff("participation_tg_entry_date_in_tg", statusIn("active_in_tg", "exited"), t.tgEntryDate),
    iff("participation_exit_date_when_exited", statusIn("exited"), t.exitDate),
    // Round 18: no exit before the TG entry.
    check("participation_exit_after_entry", sql`${t.exitDate} >= ${t.tgEntryDate}`),
    iff(
      "participation_profiling_done_on_when_done",
      sql.raw(`"participation"."profiling_status" = 'profiling_done'`),
      t.profilingDoneOn,
    ),
    // isConsistentState (process-and-lifecycle.md): the tracks start at `informed`, the TG needs
    // a signed DSV.
    check(
      "participation_tracks_start_at_informed",
      sql`not (${statusIn("imported", "contacted", "unreachable")}) or (${t.profilingStatus} = 'not_started' and ${t.dsvStatus} = 'not_offered')`,
    ),
    check(
      "participation_tg_needs_signed_dsv",
      sql`not (${statusIn("active_in_tg", "exited")}) or ${t.dsvStatus} = 'dsv_signed'`,
    ),
    // Target of the request's composite FK: a request is of its participation's project.
    unique("participation_id_project_unique").on(t.id, t.projectId),
    // The current request is one of this participation's own.
    foreignKey({
      name: "participation_current_exception_request_fk",
      columns: [t.profilingExceptionRequestId, t.id],
      foreignColumns: [profilingExceptionRequest.id, profilingExceptionRequest.participationId],
    }),
  ],
);

const requestStatusIn = (...list: string[]) =>
  sql.raw(`"profiling_exception_request"."status" in (${list.map((v) => `'${v}'`).join(", ")})`);

/**
 * One profiling-exception request (Q81, Q94, round 16): a first-class, authoritative record. Its
 * reason and evidence identity never change; status and decision progress on the row (a trigger
 * enforces both), and every progression is audited. A later attempt is a new row. Written only
 * by the status functions; `transfer_app` may only select.
 */
export const profilingExceptionRequest = pgTable(
  "profiling_exception_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    reasonCode: profilingExceptionReason("reason_code").notNull(),
    status: profilingExceptionStatus("status").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => staffUser.id),
    /** The Berlin business date, from the caller's Clock. */
    requestedOn: dateColumn("requested_on").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    /** The immutable evidence record (Slice 4b); no FK until it exists. */
    evidenceRecordId: uuid("evidence_record_id").notNull(),
    /**
     * Its versioned canonical fingerprint (`sha256:v1:…`, round 17): changed evidence means a
     * different fingerprint (Q94). Confidential evidence metadata: never in audit details, logs
     * or client responses.
     */
    evidenceFingerprint: text("evidence_fingerprint").notNull(),
    decidedBy: uuid("decided_by").references(() => staffUser.id),
    decidedOn: dateColumn("decided_on"),
    /** The instant of the decision: an approval counts only once recorded (round 9). */
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    supersededReason: profilingExceptionSupersededReason("superseded_reason"),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "profiling_exception_request_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    // Target of the participation's current-request FK.
    unique("profiling_exception_request_id_participation_unique").on(t.id, t.participationId),
    // At most one open (pending or approved) request per participation (round 10).
    uniqueIndex("profiling_exception_request_one_open_idx")
      .on(t.participationId)
      .where(sql`${t.status} in ('requested', 'approved')`),
    check("profiling_exception_request_status_not_none", sql`${t.status} <> 'none'`),
    check(
      "profiling_exception_request_fingerprint",
      sql`${t.evidenceFingerprint} ~ '^sha256:v1:[0-9a-f]{64}$'`,
    ),
    // A decision has its decider, date and instant; only approvals and rejections are decided,
    // and a revoked request keeps the decision it had (approved) or none (pending).
    check(
      "profiling_exception_request_decision",
      sql`(${t.decidedBy} is null) = (${t.decidedOn} is null) and (${t.decidedBy} is null) = (${t.decidedAt} is null) and (not (${requestStatusIn("approved", "rejected")}) or ${t.decidedBy} is not null) and (not (${requestStatusIn("requested", "superseded")}) or ${t.decidedBy} is null)`,
    ),
    iff(
      "profiling_exception_request_superseded_reason",
      requestStatusIn("superseded"),
      t.supersededReason,
    ),
    // Four eyes (Q80): the decider is never the requester.
    check("profiling_exception_request_four_eyes", sql`${t.decidedBy} <> ${t.requestedBy}`),
  ],
);

/**
 * Trimmed text of 1 to `max` characters without control characters (process-and-lifecycle.md,
 * Import).
 */
const personText = (name: string, column: SQL, max: number) =>
  check(
    name,
    sql`${column} = btrim(${column}) and length(${column}) between 1 and ${sql.raw(String(max))} and ${column} !~ '[[:cntrl:]]'`,
  );

/** The person-data tables' keys: one row per participation, of its own project. */
const personKeys = () => ({
  participationId: uuid("participation_id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id),
});
const personTimes = () => ({
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/**
 * Who a participation is (data-protection.md, person-data writes): the import's match key and the
 * minimal identity, class `participation_record`. Written only by `write_participant_data`
 * (ADR-0002); the Personalnummer never changes and is unique in the project.
 */
export const participantIdentity = pgTable(
  "participant_identity",
  {
    ...personKeys(),
    personnelNumber: text("personnel_number").notNull(),
    lastName: text("last_name").notNull(),
    firstName: text("first_name").notNull(),
    birthDate: dateColumn("birth_date"),
    ...personTimes(),
  },
  (t) => [
    foreignKey({
      name: "participant_identity_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    unique("participant_identity_project_personnel_number_unique").on(
      t.projectId,
      t.personnelNumber,
    ),
    personText("participant_identity_personnel_number_text", sql`${t.personnelNumber}`, 50),
    personText("participant_identity_last_name_text", sql`${t.lastName}`, 100),
    personText("participant_identity_first_name_text", sql`${t.firstName}`, 100),
  ],
);

/**
 * The personnel-file data of a participation (data-protection.md, retention; round 32): the
 * structured address with its country (ISO 3166-1 alpha-2, only `DE` in the MVP; all four parts or
 * none), phone, mobile, emails and the Austrittsdatum; class `personnel_file`. Written only by
 * `write_participant_data` (ADR-0002).
 */
export const participantDetails = pgTable(
  "participant_details",
  {
    ...personKeys(),
    addressStreet: text("address_street"),
    addressPostalCode: text("address_postal_code"),
    addressCity: text("address_city"),
    addressCountry: text("address_country"),
    phone: text("phone"),
    mobile: text("mobile"),
    privateEmail: text("private_email"),
    workEmail: text("work_email"),
    oldEmploymentEndDate: dateColumn("old_employment_end_date"),
    /** The contact fields the participant wrote, also assisted; the import never overwrites them. */
    participantMaintained: text("participant_maintained")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** When the participant last wrote the address ("Vermittlungs-Agentur prüfen", Q139). */
    participantAddressWrittenAt: timestamp("participant_address_written_at", {
      withTimezone: true,
      mode: "string",
    }),
    ...personTimes(),
  },
  (t) => [
    foreignKey({
      name: "participant_details_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    check(
      "participant_details_address_whole",
      sql`num_nulls(${t.addressStreet}, ${t.addressPostalCode}, ${t.addressCity}, ${t.addressCountry}) in (0, 4)`,
    ),
    personText("participant_details_address_street_text", sql`${t.addressStreet}`, 200),
    personText("participant_details_address_city_text", sql`${t.addressCity}`, 200),
    check("participant_details_address_country_code", sql`${t.addressCountry} ~ '^[A-Z]{2}$'`),
    check("participant_details_address_country_de", sql`${t.addressCountry} = 'DE'`),
    check(
      "participant_details_postal_code_de",
      sql`${t.addressCountry} <> 'DE' or ${t.addressPostalCode} ~ '^[0-9]{5}$'`,
    ),
    personText("participant_details_phone_text", sql`${t.phone}`, 30),
    personText("participant_details_mobile_text", sql`${t.mobile}`, 30),
    personText("participant_details_private_email_text", sql`${t.privateEmail}`, 254),
    personText("participant_details_work_email_text", sql`${t.workEmail}`, 254),
    check(
      "participant_details_participant_maintained",
      sql`${t.participantMaintained} <@ ${sql.raw(`'{${contactFields.join(",")}}'::text[]`)} and array_position(${t.participantMaintained}, null) is null`,
    ),
    check(
      "participant_details_address_written",
      sql`${t.participantAddressWrittenAt} is null or 'address' = any(${t.participantMaintained})`,
    ),
  ],
);

const jsonType = (column: SQL, type: "array" | "object") =>
  sql`jsonb_typeof(${column}) = ${sql.raw(`'${type}'`)}`;
const rowsUpTo = (column: SQL, max: number) =>
  sql`${jsonType(column, "array")} and jsonb_array_length(${column}) between 1 and ${sql.raw(String(max))}`;

/**
 * The participant's profile, TL 407 section B (data-protection.md, self-service; Q140, Q141):
 * one row per participation, class `personnel_file`. The structured values are `jsonb` held to
 * their domain schema (`packages/domain/src/self-service/values.ts`) by the write function, here
 * to their JSON type and row limits; custom fields are validated against the participation's
 * resolved chain. `revision` is the optimistic-concurrency token of every page write. Written
 * only by `write_self_service_data` (ADR-0002).
 */
export const participantProfile = pgTable(
  "participant_profile",
  {
    ...personKeys(),
    gender: gender("gender"),
    maritalStatus: maritalStatus("marital_status"),
    educationHistory: jsonb("education_history"),
    workHistory: jsonb("work_history"),
    languageSkills: jsonb("language_skills"),
    drivingLicence: drivingLicenceClass("driving_licence").array(),
    vehicleAvailable: boolean("vehicle_available"),
    workingTimePreferences: jsonb("working_time_preferences"),
    jobWishes: jsonb("job_wishes"),
    desiredWorkLocations: text("desired_work_locations"),
    maxCommuteDistance: jsonb("max_commute_distance"),
    earliestStartDate: dateColumn("earliest_start_date"),
    customFields: jsonb("custom_fields")
      .notNull()
      .default(sql`'{}'::jsonb`),
    revision: integer("revision").notNull(),
    ...personTimes(),
  },
  (t) => [
    foreignKey({
      name: "participant_profile_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    check("participant_profile_revision", sql`${t.revision} >= 1`),
    check(
      "participant_profile_education_history",
      rowsUpTo(sql`${t.educationHistory}`, rowLimits.educationHistory),
    ),
    check(
      "participant_profile_work_history",
      rowsUpTo(sql`${t.workHistory}`, rowLimits.workHistory),
    ),
    check("participant_profile_language_skills", jsonType(sql`${t.languageSkills}`, "object")),
    check("participant_profile_working_time", jsonType(sql`${t.workingTimePreferences}`, "object")),
    check("participant_profile_job_wishes", jsonType(sql`${t.jobWishes}`, "object")),
    check(
      "participant_profile_max_commute_distance",
      jsonType(sql`${t.maxCommuteDistance}`, "object"),
    ),
    check("participant_profile_custom_fields", jsonType(sql`${t.customFields}`, "object")),
    // An empty array is the answer "no licence" (TL 407 field 42).
    check(
      "participant_profile_driving_licence",
      sql`array_position(${t.drivingLicence}, null) is null`,
    ),
    personText(
      "participant_profile_desired_work_locations_text",
      sql`${t.desiredWorkLocations}`,
      500,
    ),
  ],
);

/** A `pgp_sym_encrypt` ciphertext (ADR-0002, encryption); the runtime role can't select it. */
const ciphertext = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * The columns of encrypted fields (ADR-0002, encryption; data-protection.md, self-service): each
 * field's ciphertext and its unencrypted presence (completeness needs only that), the key the row
 * was written with and when.
 */
function encryptedFields<K extends string>(fields: Record<K, string>) {
  const columns = Object.fromEntries(
    Object.entries<string>(fields).flatMap(([key, column]) => [
      [key, ciphertext(column)],
      [`${key}Present`, boolean(`${column}_present`).notNull().default(false)],
    ]),
  ) as { [P in K]: ReturnType<typeof ciphertext> } & {
    [P in K as `${P}Present`]: ReturnType<typeof boolean>;
  };
  return {
    ...personKeys(),
    ...columns,
    keyId: text("key_id").notNull(),
    createdAt: createdAt(),
    writtenAt: timestamp("written_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  };
}

/** Each ciphertext is present exactly when its presence says so; the key id is a fingerprint. */
function encryptedChecks(
  table: string,
  t: Record<string, unknown> & { participationId: unknown; projectId: unknown; keyId: unknown },
  fields: readonly string[],
): PgTableExtraConfigValue[] {
  return [
    foreignKey({
      name: `${table}_participation_fk`,
      columns: [t.participationId, t.projectId] as never,
      foreignColumns: [participation.id, participation.projectId] as never,
    }),
    check(`${table}_key_id`, sql`${t.keyId} ~ '^[0-9a-f]{16}$'`),
    ...fields.map((key) =>
      check(
        `${table}_${key.replaceAll(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_present`,
        sql`(${t[key]} is not null) = ${t[`${key}Present`]}`,
      ),
    ),
  ];
}

/** The section C lines and p. 7 (ba-forms.md, section C), each its own ciphertext column. */
const assessmentColumns = {
  schoolQualification: "school_qualification",
  vocationalQualification: "vocational_qualification",
  workExperience: "work_experience",
  languageSkills: "language_skills",
  otherQualification: "other_qualification",
  intellectualCapacity: "intellectual_capacity",
  workAndSocialBehaviour: "work_and_social_behaviour",
  otherPerformance: "other_performance",
  initiative: "initiative",
  learningReadiness: "learning_readiness",
  otherMotivation: "other_motivation",
  localMobility: "local_mobility",
  otherConditions: "other_conditions",
  overallAssessment: "overall_assessment",
  nextSteps: "next_steps",
} as const;

/**
 * The RV-Nummer (TL 407 field 25), highly confidential, `identifiers`, class
 * `participation_record` (Q88, Q141). Written and read only by `write_sensitive_fields` and
 * `read_sensitive_fields` (ADR-0002, encryption).
 */
export const participantIdentifierData = pgTable(
  "participant_identifier_data",
  encryptedFields({ pensionInsuranceNumber: "pension_insurance_number" }),
  (t) => encryptedChecks("participant_identifier_data", t, ["pensionInsuranceNumber"]),
);

/**
 * Nationality, entry date, residence status and Bürgergeld (TL 407 fields 31–34), highly
 * confidential, `residence_social`, class `personnel_file` (Q141); like the RV-Nummer. Beside
 * them "arbeitslos seit / bis" (fields 34, 35; Q85 open, fail safe; Q192), which the profiler
 * records through `write_unemployment_period`.
 */
export const participantResidenceSocialData = pgTable(
  "participant_residence_social_data",
  {
    ...encryptedFields({
      nationality: "nationality",
      entryToGermanyDate: "entry_to_germany_date",
      residenceStatus: "residence_status",
      buergergeld: "buergergeld",
      unemploymentPeriod: "unemployment_period",
    }),
    /** The unemployment period's revision, which its write compares (409), clearing included. */
    unemploymentRevision: integer("unemployment_revision").notNull().default(0),
  },
  (t) =>
    encryptedChecks("participant_residence_social_data", t, [
      "nationality",
      "entryToGermanyDate",
      "residenceStatus",
      "buergergeld",
      "unemploymentPeriod",
    ]).concat(
      check(
        "participant_residence_social_data_unemployment_revision",
        sql`${t.unemploymentRevision} >= 0`,
      ),
    ),
);

/**
 * The health restrictions and Schwerbehinderung/Gleichstellung yes/no answers (TL 407 fields 36,
 * 37), special category, `health` and `disability`, class `health_record` (Q141); like the
 * RV-Nummer, behind the participant's step-up (Q137).
 */
export const participantHealthData = pgTable(
  "participant_health_data",
  encryptedFields({
    healthRestrictions: "health_restrictions",
    severeDisability: "severe_disability",
  }),
  (t) => encryptedChecks("participant_health_data", t, ["healthRestrictions", "severeDisability"]),
);

/** `hh:mm`, as the profiling sessions hold their times (ba-forms.md, validation). */
const hhmm = (column: SQL) => sql`${column} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`;

/**
 * The profiling record (data-protection.md, the profiling record; Q193): per participation the
 * pending declarations to the BA (TL 407 field 50 and the BA contact declaration, `null` while
 * undecided; never the portal consent), who recorded them last and when, and the `revision` every
 * sessions or declarations write compares. Confidential, class `personnel_file`. Written only by
 * `write_profiling_sessions` and `write_profiling_declarations` (ADR-0002).
 */
export const participantProfiling = pgTable(
  "participant_profiling",
  {
    ...personKeys(),
    jobboerseChoice: jobboerseChoice("jobboerse_choice"),
    baContactConsent: boolean("ba_contact_consent"),
    declarationsRecordedBy: uuid("declarations_recorded_by").references(() => staffUser.id),
    declarationsRecordedAt: timestamp("declarations_recorded_at", {
      withTimezone: true,
      mode: "string",
    }),
    revision: integer("revision").notNull(),
    ...personTimes(),
  },
  (t) => [
    foreignKey({
      name: "participant_profiling_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    check("participant_profiling_revision", sql`${t.revision} >= 1`),
    check(
      "participant_profiling_declarations_recorded",
      sql`(${t.declarationsRecordedBy} is null) = (${t.declarationsRecordedAt} is null)`,
    ),
  ],
);

/**
 * One profiling session (TL 407 section A; process-and-lifecycle.md, the profiling record; Q193):
 * its date and times, who recorded it last and when. Evidence-set data, class
 * `participation_record` (Q88); never a booked appointment. Written only by
 * `write_profiling_sessions`, which checks the times, the date and the overlaps again.
 */
export const profilingSession = pgTable(
  "profiling_session",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    sessionDate: dateColumn("session_date").notNull(),
    timeFrom: text("time_from").notNull(),
    timeTo: text("time_to").notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => staffUser.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "profiling_session_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    index("profiling_session_participation_idx").on(t.participationId, t.sessionDate),
    check("profiling_session_time_from", hhmm(sql`${t.timeFrom}`)),
    check("profiling_session_time_to", hhmm(sql`${t.timeTo}`)),
    check("profiling_session_times_ordered", sql`${t.timeFrom} < ${t.timeTo}`),
  ],
);

/**
 * TL 407 section C and p. 7 but the health line (data-protection.md, the profiling record; Q192):
 * each line's rating and text as one ciphertext (an "andere" line with its label), Gesamteinschätzung
 * and weiteres Vorgehen; highly confidential, `profiling_assessment`, class `personnel_file`, with
 * the assessment's `revision`. Written and read only by `write_profiling_assessment` and
 * `read_profiling_assessment`, the assigned consultant's (ADR-0002, encryption).
 */
export const participantProfilingAssessment = pgTable(
  "participant_profiling_assessment",
  {
    ...encryptedFields(assessmentColumns),
    revision: integer("revision").notNull(),
  },
  (t) => [
    ...encryptedChecks("participant_profiling_assessment", t, Object.keys(assessmentColumns)),
    check("participant_profiling_assessment_revision", sql`${t.revision} >= 1`),
  ],
);

/**
 * The health line's rating of section C, no text (Q192: health detail beyond yes/no needs the
 * explicit consent of data-protection.md, legal basis, which doesn't exist yet): special
 * category, `profiling_assessment`, class `health_record` (Q40). Written with the assessment.
 */
export const participantProfilingHealthAssessment = pgTable(
  "participant_profiling_health_assessment",
  encryptedFields({ healthRating: "health_rating" }),
  (t) => encryptedChecks("participant_profiling_health_assessment", t, ["healthRating"]),
);

/**
 * Assisted mode (ADR-0007, assisted mode; Q136): a staff user opened the participant's wizard
 * after confirming the person is present or on the phone and asked for help, and how. Bound to the
 * staff session (its hash, never the token): no expiry of its own, it ends with "Beenden" or with
 * the session (ending a session ends its assisted modes; an expired one has none live). At most
 * one live per session and participation. Internal, `case_internal`, class `access_credential`.
 * Written only by `start_assisted_mode`, `end_assisted_mode` and the staff session's end.
 */
export const assistedMode = pgTable(
  "assisted_mode",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUser.id),
    staffSessionHash: text("staff_session_hash")
      .notNull()
      .references(() => staffSession.tokenHash),
    how: assistedModeHow("how").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
    endReason: assistedModeEndReason("end_reason"),
  },
  (t) => [
    foreignKey({
      name: "assisted_mode_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    index("assisted_mode_staff_session_idx").on(t.staffSessionHash),
    uniqueIndex("assisted_mode_live_unique")
      .on(t.staffSessionHash, t.participationId)
      .where(sql`${t.endedAt} is null`),
    check("assisted_mode_ended", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check("assisted_mode_ended_after_start", sql`${t.endedAt} >= ${t.startedAt}`),
  ],
);

/**
 * The purposes notice acknowledged (data-protection.md, self-service; Q138): version, language,
 * who (the participant, or staff on their behalf) and when; an acknowledgement, not a consent.
 * One per version; written only by `acknowledge_self_service_notice`, never changed.
 */
export const selfServiceNoticeAcknowledgement = pgTable(
  "self_service_notice_acknowledgement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    noticeVersion: text("notice_version").notNull(),
    language: noticeLanguage("language").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(() => staffUser.id),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "self_service_notice_acknowledgement_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    unique("self_service_notice_acknowledgement_version_unique").on(
      t.participationId,
      t.noticeVersion,
    ),
    check(
      "self_service_notice_acknowledgement_version",
      sql`${t.noticeVersion} ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'`,
    ),
    check(
      "self_service_notice_acknowledgement_actor",
      sql`${t.actorType} in ('participant', 'user') and (${t.actorType} = 'user') = (${t.actorStaffUserId} is not null)`,
    ),
  ],
);

/**
 * A personal activation code (ADR-0007, activation-code issuance). The code and an in-person
 * destination are never stored: only HMAC-SHA256 values under separately derived keys. All writes
 * go through the Slice 3d functions; the runtime role reads only the non-secret projection it
 * needs.
 */
export const activationCode = pgTable(
  "activation_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    purpose: activationPurpose("purpose").notNull().default("activation"),
    codeHash: text("code_hash").notNull().unique(),
    channel: activationChannel("channel").notNull(),
    noticeLanguage: noticeLanguage("notice_language").notNull(),
    identityCheck: identityCheck("identity_check").notNull().default("none"),
    identityCheckedBy: uuid("identity_checked_by").references(() => staffUser.id),
    identityCheckedAt: timestamp("identity_checked_at", { withTimezone: true, mode: "string" }),
    printedAt: timestamp("printed_at", { withTimezone: true, mode: "string" }),
    handedOverBy: uuid("handed_over_by").references(() => staffUser.id),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true, mode: "string" }),
    deliveryKind: activationDeliveryKind("delivery_kind"),
    deliveryAddressHash: text("delivery_address_hash"),
    deliveryStatus: activationDeliveryStatus("delivery_status"),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => staffUser.id),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    revokedBy: uuid("revoked_by").references(() => staffUser.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    revokeReason: activationRevokeReason("revoke_reason"),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    foreignKey({
      name: "activation_code_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    unique("activation_code_id_project_unique").on(t.id, t.projectId),
    uniqueIndex("activation_code_one_open_idx")
      .on(t.participationId)
      .where(sql`${t.revokedAt} is null and ${t.usedAt} is null and ${t.lockedAt} is null`),
    index("activation_code_participation_issued_idx").on(t.participationId, t.issuedAt.desc()),
    check("activation_code_code_hash", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "activation_code_delivery_address_hash",
      sql`${t.deliveryAddressHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("activation_code_lifetime", sql`${t.expiresAt} = ${t.issuedAt} + interval '30 days'`),
    check("activation_code_attempts", sql`${t.failedAttempts} between 0 and 5`),
    check(
      "activation_code_identity_check",
      sql`(${t.identityCheck} = 'photo_id') = (${t.identityCheckedBy} is not null) and (${t.identityCheckedBy} is null) = (${t.identityCheckedAt} is null)`,
    ),
    check(
      "activation_code_in_person_delivery",
      sql`(${t.channel} = 'in_person') = (${t.deliveryKind} is not null) and (${t.deliveryKind} is null) = (${t.deliveryAddressHash} is null) and (${t.deliveryKind} is null) = (${t.deliveryStatus} is null)`,
    ),
    check(
      "activation_code_printed",
      sql`(${t.channel} in ('letter', 'sheet')) = (${t.printedAt} is not null)`,
    ),
    check(
      "activation_code_handover",
      sql`(${t.handedOverAt} is null) = (${t.handedOverBy} is null) and (${t.handedOverAt} is null or ${t.channel} = 'sheet')`,
    ),
    check(
      "activation_code_revoked",
      sql`(${t.revokedAt} is null) = (${t.revokeReason} is null) and (${t.revokedAt} is null or ${t.revokedBy} is not null or ${t.revokeReason} = 'participation_closed')`,
    ),
    check(
      "activation_code_one_terminal",
      sql`num_nonnulls(${t.lockedAt}, ${t.revokedAt}, ${t.usedAt}) <= 1`,
    ),
  ],
);

/** Immutable evidence that an Art. 14 version was sent or handed over (Q124). */
export const privacyNoticeDelivery = pgTable(
  "privacy_notice_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    noticeVersion: text("notice_version").notNull(),
    language: noticeLanguage("language").notNull(),
    method: noticeMethod("method").notNull(),
    activationCodeId: uuid("activation_code_id"),
    providedBy: uuid("provided_by")
      .notNull()
      .references(() => staffUser.id),
    providedAt: timestamp("provided_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "privacy_notice_delivery_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    foreignKey({
      name: "privacy_notice_delivery_activation_code_fk",
      columns: [t.activationCodeId, t.projectId],
      foreignColumns: [activationCode.id, activationCode.projectId],
    }),
    index("privacy_notice_delivery_participation_idx").on(t.participationId, t.providedAt),
    check(
      "privacy_notice_delivery_version",
      sql`${t.noticeVersion} ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'`,
    ),
  ],
);

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const minutes = (value: number) => sql.raw(`interval '${value} minutes'`);

/**
 * An activated participant account (ADR-0007, portal activation): one per participation, with the
 * code it was activated by and how the identity was assured (`photo_id` with the staff confirmer of
 * the code's ID check, only when the birth-date step was skipped, Q129). Written only by
 * `complete_activation`.
 */
export const participantAccount = pgTable(
  "participant_account",
  {
    participationId: uuid("participation_id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    activatedAt: instant("activated_at").notNull().defaultNow(),
    activationCodeId: uuid("activation_code_id").notNull(),
    identityAssurance: identityAssurance("identity_assurance").notNull(),
    identityAssuredBy: uuid("identity_assured_by").references(() => staffUser.id),
    identityAssuredAt: instant("identity_assured_at"),
    language: noticeLanguage("language").notNull(),
  },
  (t) => [
    foreignKey({
      name: "participant_account_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    foreignKey({
      name: "participant_account_activation_code_fk",
      columns: [t.activationCodeId, t.projectId],
      foreignColumns: [activationCode.id, activationCode.projectId],
    }),
    check(
      "participant_account_photo_id",
      sql`(${t.identityAssurance} = 'photo_id') = (${t.identityAssuredBy} is not null) and (${t.identityAssuredBy} is null) = (${t.identityAssuredAt} is null)`,
    ),
  ],
);

/**
 * One of our consents (data-protection.md, legal basis; Q123, Q138): its purpose and where it was
 * given (the portal, or a signed paper form staff record), the channel of a portal contact
 * consent, the text version and language shown, who gave it and when; never the address. Written
 * only by the activation and channel functions.
 */
export const consentRecord = pgTable(
  "consent_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    purpose: consentPurpose("purpose").notNull(),
    source: consentSource("source").notNull().default("portal"),
    channelId: uuid("channel_id"),
    textVersion: text("text_version").notNull(),
    language: noticeLanguage("language").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(() => staffUser.id),
    givenAt: instant("given_at").notNull().defaultNow(),
    endedAt: instant("ended_at"),
    endReason: consentEndReason("end_reason"),
  },
  (t) => [
    foreignKey({
      name: "consent_record_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    index("consent_record_participation_idx").on(t.participationId),
    check(
      "consent_record_text_version",
      sql`${t.textVersion} ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'`,
    ),
    check("consent_record_ended", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check(
      "consent_record_actor",
      sql`${t.actorType} in ('participant', 'user') and (${t.actorType} = 'user') = (${t.actorStaffUserId} is not null)`,
    ),
    // A channel exactly for the portal contact purpose, which is given in the portal (Q138).
    check(
      "consent_record_channel",
      sql`(${t.purpose} = 'portal_contact') = (${t.channelId} is not null) and (${t.purpose} <> 'portal_contact' or ${t.source} = 'portal')`,
    ),
  ],
);

/**
 * A verified private email or mobile of an activated participant (ADR-0007, Q123): the
 * normalised address, how it was verified, its consent and when the activation notice went to it.
 * One address belongs to at most one channel that isn't removed. Staff never read the address
 * (Q123).
 */
export const participantChannel = pgTable(
  "participant_channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    kind: contactChannelKind("kind").notNull(),
    address: text("address").notNull(),
    verifiedAt: instant("verified_at").notNull().defaultNow(),
    verifiedBy: channelVerification("verified_by").notNull(),
    consentId: uuid("consent_id")
      .notNull()
      .references(() => consentRecord.id),
    noticeSentAt: instant("notice_sent_at"),
    suspendedAt: instant("suspended_at"),
    suspensionReason: channelSuspensionReason("suspension_reason"),
    removedAt: instant("removed_at"),
    removedReason: channelRemovalReason("removed_reason"),
  },
  (t) => [
    foreignKey({
      name: "participant_channel_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    uniqueIndex("participant_channel_address_idx")
      .on(t.kind, t.address)
      .where(sql`${t.removedAt} is null`),
    index("participant_channel_participation_idx").on(t.participationId),
    check(
      "participant_channel_address",
      sql`case ${t.kind} when 'email' then ${t.address} ~ '^[^@[:space:]A-Z]+@[^@[:space:]A-Z]+[.][^@[:space:]A-Z]+$' and length(${t.address}) <= 254 else ${t.address} ~ '^[+][1-9][0-9]{7,14}$' end`,
    ),
    check(
      "participant_channel_suspended",
      sql`(${t.suspendedAt} is null) = (${t.suspensionReason} is null)`,
    ),
    check(
      "participant_channel_removed",
      sql`(${t.removedAt} is null) = (${t.removedReason} is null)`,
    ),
  ],
);

/**
 * A one-time code sent to an address (ADR-0007): only its keyed hash; the normalised address it
 * went to, the delivery outcome, 15 minutes, its own counter of 5 wrong entries. Written only by
 * the one-time-code functions; never served.
 */
export const oneTimeCodeChallenge = pgTable(
  "one_time_code_challenge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    purpose: oneTimeCodePurpose("purpose").notNull(),
    kind: contactChannelKind("kind").notNull(),
    address: text("address").notNull(),
    codeHash: text("code_hash").notNull(),
    deliveryStatus: activationDeliveryStatus("delivery_status").notNull().default("pending"),
    createdAt: createdAt(),
    expiresAt: instant("expires_at").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    consumedAt: instant("consumed_at"),
    invalidatedAt: instant("invalidated_at"),
    invalidationReason: challengeInvalidation("invalidation_reason"),
  },
  (t) => [
    foreignKey({
      name: "one_time_code_challenge_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    index("one_time_code_challenge_address_idx").on(t.kind, t.address, t.createdAt),
    index("one_time_code_challenge_participation_idx").on(t.participationId, t.createdAt),
    check("one_time_code_challenge_code_hash", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "one_time_code_challenge_lifetime",
      sql`${t.expiresAt} = ${t.createdAt} + ${minutes(portalLimits.oneTimeCode.validityMinutes)}`,
    ),
    check(
      "one_time_code_challenge_attempts",
      sql`${t.failedAttempts} between 0 and ${sql.raw(String(portalLimits.oneTimeCode.failures))}`,
    ),
    check(
      "one_time_code_challenge_invalidated",
      sql`(${t.invalidatedAt} is null) = (${t.invalidationReason} is null)`,
    ),
    check(
      "one_time_code_challenge_one_end",
      sql`num_nonnulls(${t.consumedAt}, ${t.invalidatedAt}) <= 1`,
    ),
  ],
);

/**
 * Participant sessions (ADR-0007, participant sessions): the cookie holds 32 random bytes, the row
 * their SHA-256. An `activating` session (code accepted) opens only the activation steps and
 * records them; an `active` one starts with a new token at completion. 30 minutes idle, 12 hours
 * absolute, checked against database time. `transfer_app` may update `last_seen_at` only;
 * everything else goes through the activation functions.
 */
export const participantSession = pgTable(
  "participant_session",
  {
    tokenHash: text("token_hash").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    state: participantSessionState("state").notNull(),
    activationCodeId: uuid("activation_code_id"),
    createdAt: createdAt(),
    lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
    endedAt: instant("ended_at"),
    endReason: participantSessionEndReason("end_reason"),
    birthDateCheckedAt: instant("birth_date_checked_at"),
    deliveryAddressCheckedAt: instant("delivery_address_checked_at"),
    stepUpMethod: stepUpMethod("step_up_method"),
    stepUpAt: instant("step_up_at"),
    // The step-up before special-category data (ADR-0007, step-up; Q137) and its wrong birth dates.
    sensitiveStepUpMethod: sensitiveStepUpMethod("sensitive_step_up_method"),
    sensitiveStepUpAt: instant("sensitive_step_up_at"),
    stepUpFailures: integer("step_up_failures").notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: "participant_session_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    foreignKey({
      name: "participant_session_activation_code_fk",
      columns: [t.activationCodeId, t.projectId],
      foreignColumns: [activationCode.id, activationCode.projectId],
    }),
    index("participant_session_participation_idx").on(t.participationId),
    check("participant_session_token_hash", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("participant_session_ended", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check(
      "participant_session_step_up",
      sql`(${t.stepUpMethod} is null) = (${t.stepUpAt} is null)`,
    ),
    check(
      "participant_session_sensitive_step_up",
      sql`(${t.sensitiveStepUpMethod} is null) = (${t.sensitiveStepUpAt} is null) and (${t.state} = 'active' or ${t.sensitiveStepUpMethod} is null)`,
    ),
    check(
      "participant_session_step_up_failures",
      sql`${t.stepUpFailures} between 0 and ${sql.raw(String(portalLimits.stepUp.birthDateFailures))}`,
    ),
    check(
      "participant_session_activating",
      sql`(${t.state} = 'activating') = (${t.activationCodeId} is not null) and (${t.state} = 'activating' or ${t.birthDateCheckedAt} is null and ${t.deliveryAddressCheckedAt} is null)`,
    ),
  ],
);

/**
 * The document-type catalog per version as the functions apply it (data-protection.md, documents;
 * Q142, Q145, Q146, Q148): retention class, whether the file name is kept, signed, and who may add,
 * review, delete and open (`participant` and project roles; empty while the type's operations are
 * undecided, Q65). Reference data written only by the migrations; a drift test holds it equal to
 * the domain's `documentTypeCatalog`.
 */
export const documentTypePolicy = pgTable(
  "document_type_policy",
  {
    type: documentType("type").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    retentionClass: text("retention_class").notNull(),
    fileName: boolean("file_name").notNull(),
    signed: boolean("signed").notNull(),
    addRoles: text("add_roles").array().notNull(),
    reviewRoles: text("review_roles").array().notNull(),
    deleteRoles: text("delete_roles").array().notNull(),
    openRoles: text("open_roles").array().notNull(),
  },
  (t) => [
    primaryKey({ name: "document_type_policy_pkey", columns: [t.type, t.catalogVersion] }),
    unique("document_type_policy_retention_unique").on(t.type, t.catalogVersion, t.retentionClass),
  ],
);

/**
 * What a participation's audit history shows of each event type (data-protection.md, audit
 * metadata; Q157): its stream (null: project-level), whether `field`/`from`/`to` and the reason
 * code are shown, and the detail keys; one row per status field for `status_changed`. Reference
 * data written only by the migrations; a drift test holds it equal to the domain's
 * `auditProjection`. `event_type` is text: a type added in the same migration can't be inserted as
 * the enum (ADR-0002, migrations).
 */
export const auditEventProjection = pgTable(
  "audit_event_projection",
  {
    eventType: text("event_type").notNull(),
    field: statusField("field"),
    stream: auditStream("stream"),
    showsChange: boolean("shows_change").notNull(),
    showsReason: boolean("shows_reason").notNull(),
    detailKeys: text("detail_keys").array().notNull(),
  },
  (t) => [
    unique("audit_event_projection_unique").on(t.eventType, t.field).nullsNotDistinct(),
    check("audit_event_projection_event_type", sql`${t.eventType} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check(
      "audit_event_projection_field",
      sql`(${t.field} is null) = (${t.eventType} <> 'status_changed')`,
    ),
  ],
);

/**
 * Per project role the access categories whose field keys an audit history keeps (the field
 * names of `participant_data_changed`; data-protection.md, audit metadata). Reference data written
 * only by the migrations; a drift test holds it equal to the domain's `roleFieldKnowledge`.
 */
export const roleFieldKnowledge = pgTable(
  "role_field_knowledge",
  {
    projectRole: projectRole("project_role").notNull(),
    accessCategory: accessCategory("access_category").notNull(),
  },
  (t) => [
    primaryKey({ name: "role_field_knowledge_pkey", columns: [t.projectRole, t.accessCategory] }),
  ],
);

/**
 * Each participant field's access category (the field catalog), and `custom.*` for the custom
 * fields, so `audit_history` can keep a field key per role. Reference data written only by the
 * migrations; a drift test holds it equal to the domain's field catalog.
 */
export const fieldAccessCategory = pgTable(
  "field_access_category",
  {
    fieldKey: text("field_key").primaryKey(),
    accessCategory: accessCategory("access_category").notNull(),
  },
  (t) => [
    check(
      "field_access_category_key",
      sql`${t.fieldKey} ~ '^[a-z][A-Za-z0-9]{0,62}$' or ${t.fieldKey} = 'custom.*'`,
    ),
  ],
);

/**
 * A document (data-protection.md, uploads and documents; Q143–Q148): the metadata of one encrypted
 * file in the store under `documents/<id>`, never its content. Its retention class is its type's
 * (a composite FK to the policy of its catalog version), so retention is per row (ADR-0008).
 * `content_sha256` (integrity; the evidence fingerprint later) and `wrapped_key` are never
 * selected by the runtime role, only returned by `document_link_content`. Reviewed once; a
 * deletion keeps the row as a tombstone (type, dates, who by kind, reason; the file name erased)
 * and the purge job records `purged_at`. Written only by the document functions.
 */
export const document = pgTable(
  "document",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    type: documentType("type").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    retentionClass: text("retention_class").notNull(),
    mediaType: documentMediaType("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentSha256: text("content_sha256").notNull(),
    fileName: text("file_name"),
    keyId: text("key_id").notNull(),
    wrappedKey: ciphertext("wrapped_key").notNull(),
    addedBy: actorType("added_by").notNull(),
    addedByStaffUserId: uuid("added_by_staff_user_id").references(() => staffUser.id),
    addedOnBehalf: boolean("added_on_behalf").notNull(),
    addedAt: instant("added_at").notNull().defaultNow(),
    reviewState: documentReviewState("review_state").notNull().default("unreviewed"),
    reviewReason: documentReviewReason("review_reason"),
    reviewedBy: uuid("reviewed_by").references(() => staffUser.id),
    reviewedAt: instant("reviewed_at"),
    deletedAt: instant("deleted_at"),
    deletedBy: actorType("deleted_by"),
    deletedByStaffUserId: uuid("deleted_by_staff_user_id").references(() => staffUser.id),
    deleteReason: documentDeleteReason("delete_reason"),
    purgedAt: instant("purged_at"),
  },
  (t) => [
    foreignKey({
      name: "document_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    foreignKey({
      name: "document_policy_fk",
      columns: [t.type, t.catalogVersion, t.retentionClass],
      foreignColumns: [
        documentTypePolicy.type,
        documentTypePolicy.catalogVersion,
        documentTypePolicy.retentionClass,
      ],
    }),
    index("document_participation_idx").on(t.participationId, t.addedAt),
    check(
      "document_size",
      sql`${t.sizeBytes} between 1 and ${sql.raw(String(documentLimits.maxBytes))}`,
    ),
    check("document_content_sha256", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("document_key_id", sql`${t.keyId} ~ '^[0-9a-f]{16}$'`),
    // nonce | data key | tag (document-encryption.ts)
    check("document_wrapped_key", sql`octet_length(${t.wrappedKey}) = 60`),
    check("document_file_name", sql`char_length(${t.fileName}) between 1 and 200`),
    check(
      "document_added_by",
      sql`${t.addedBy} in ('participant', 'user') and (${t.addedBy} = 'user') = (${t.addedByStaffUserId} is not null) and (${t.addedBy} = 'user' or not ${t.addedOnBehalf})`,
    ),
    check(
      "document_review",
      sql`(${t.reviewState} = 'rejected') = (${t.reviewReason} is not null) and (${t.reviewState} = 'unreviewed') = (${t.reviewedAt} is null) and (${t.reviewedAt} is null) = (${t.reviewedBy} is null)`,
    ),
    check(
      "document_deleted",
      sql`(${t.deletedAt} is null) = (${t.deletedBy} is null) and (${t.deletedBy} is null or ${t.deletedBy} in ('participant', 'user')) and coalesce(${t.deletedBy} = 'user', false) = (${t.deletedByStaffUserId} is not null) and coalesce(${t.deletedBy} = 'user', false) = (${t.deleteReason} is not null) and (${t.deletedAt} is null or ${t.fileName} is null)`,
    ),
    check("document_purged", sql`${t.purgedAt} is null or ${t.deletedAt} is not null`),
  ],
);

/**
 * An opening's link (Q147): the SHA-256 of 32 random bytes, never the token; bound to the session
 * that asked (kind and hash), valid 60 s, reusable within them. Internal, class
 * `access_credential` (Q122). Written only by `open_document`, read only by
 * `document_link_content`: the runtime role has no privilege on it.
 */
export const documentLink = pgTable(
  "document_link",
  {
    tokenHash: text("token_hash").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    sessionKind: documentSessionKind("session_kind").notNull(),
    sessionHash: text("session_hash").notNull(),
    expiresAt: instant("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "document_link_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    index("document_link_document_idx").on(t.documentId),
    check("document_link_token_hash", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("document_link_session_hash", sql`${t.sessionHash} ~ '^[0-9a-f]{64}$'`),
    check("document_link_expires", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

const { capacity, bookingCutoffDays, titleMax, venueMax } = appointmentPolicy;

/**
 * An appointment of a project (process-and-lifecycle.md, appointments; Q164, Q166): an info event
 * (optionally for one wave) or a consultation slot with one host. Project data (`project_master`);
 * the host and creator are staff ids. Written only by the appointment functions; never deleted
 * operationally. Kind, times, cutoff and audience are frozen once it has a booking (Q168).
 */
export const appointment = pgTable(
  "appointment",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    kind: appointmentKind("kind").notNull(),
    hostStaffUserId: uuid("host_staff_user_id").references(() => staffUser.id),
    audienceWaveId: uuid("audience_wave_id"),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    bookingClosesAt: instant("booking_closes_at").notNull(),
    capacity: integer("capacity").notNull(),
    title: text("title"),
    venue: text("venue").notNull(),
    status: appointmentStatus("status").notNull().default("scheduled"),
    cancelReason: appointmentCancelReason("cancel_reason"),
    cancelledAt: instant("cancelled_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => staffUser.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    unique("appointment_id_project_unique").on(t.id, t.projectId),
    foreignKey({
      name: "appointment_audience_wave_fk",
      columns: [t.audienceWaveId, t.projectId],
      foreignColumns: [projectEntryWave.id, projectEntryWave.projectId],
    }),
    index("appointment_project_idx").on(t.projectId, t.startsAt),
    index("appointment_host_idx").on(t.hostStaffUserId, t.startsAt),
    check("appointment_times", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "appointment_booking_closes",
      sql`${t.bookingClosesAt} <= ${t.startsAt} and ${t.bookingClosesAt} >= ${t.startsAt} - interval '${sql.raw(String(bookingCutoffDays.max))} days'`,
    ),
    check(
      "appointment_capacity",
      sql`${t.capacity} between ${sql.raw(String(capacity.min))} and ${sql.raw(String(capacity.max))}`,
    ),
    check(
      "appointment_title",
      sql`${t.title} is null or (char_length(${t.title}) between 1 and ${sql.raw(String(titleMax))} and ${t.title} = btrim(${t.title}) and ${t.title} !~ '[[:cntrl:]]')`,
    ),
    check(
      "appointment_venue",
      sql`char_length(${t.venue}) between 1 and ${sql.raw(String(venueMax))} and ${t.venue} = btrim(${t.venue}) and ${t.venue} !~ '[[:cntrl:]]'`,
    ),
    check(
      "appointment_host",
      sql`(${t.kind} = 'consultation') = (${t.hostStaffUserId} is not null)`,
    ),
    check("appointment_audience", sql`${t.kind} = 'info_event' or ${t.audienceWaveId} is null`),
    check(
      "appointment_cancelled",
      sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
  ],
);

/**
 * A participation's booking of an appointment (data-protection.md, appointments; Q163, Q164,
 * Q166) with its attendance, the basis of `informed` and its conflict: `case_internal` (field
 * `appointmentBookings`), `personnel_file`. At most one live booking per appointment and
 * participation. Written only by the appointment functions and the terminal status trigger.
 */
export const appointmentBooking = pgTable(
  "appointment_booking",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    appointmentId: uuid("appointment_id").notNull(),
    origin: bookingOrigin("origin").notNull(),
    status: bookingStatus("status").notNull().default("booked"),
    cancelReason: bookingCancelReason("cancel_reason"),
    /** The staff user who booked; null when the participant booked. */
    bookedBy: uuid("booked_by").references(() => staffUser.id),
    bookedAt: instant("booked_at").notNull().defaultNow(),
    cancelledBy: uuid("cancelled_by").references(() => staffUser.id),
    cancelledAt: instant("cancelled_at"),
    // Attendance (Q163): the value, who recorded it and when; the closed-case flow's reason.
    attendance: attendance("attendance"),
    attendanceRecordedBy: uuid("attendance_recorded_by").references(() => staffUser.id),
    attendanceRecordedAt: instant("attendance_recorded_at"),
    afterCloseReason: attendanceAfterCloseReason("after_close_reason"),
    /** Marked as the basis of `informed` (or of a replacement) with the delivery confirmed. */
    informedBasisBy: uuid("informed_basis_by").references(() => staffUser.id),
    informedBasisAt: instant("informed_basis_at"),
    /** A basis in conflict: the PL's open handling state and the resolution. */
    conflictEscalatedBy: uuid("conflict_escalated_by").references(() => staffUser.id),
    conflictEscalatedAt: instant("conflict_escalated_at"),
    conflictResolution: attendanceConflictResolution("conflict_resolution"),
    conflictResolvedBy: uuid("conflict_resolved_by").references(() => staffUser.id),
    conflictResolvedAt: instant("conflict_resolved_at"),
    /** An absence superseded by the PL's `did_not_take_place` correction (Q164). */
    attendanceSupersededBy: uuid("attendance_superseded_by").references(() => staffUser.id),
    attendanceSupersededAt: instant("attendance_superseded_at"),
    /** A consultation staff link as the follow-up of the participation's missed one (Q167). */
    followUpOf: uuid("follow_up_of"),
    /** No further follow-up of a missed appointment: the closed reason, who, when (Q167). */
    missedResolution: missedResolution("missed_resolution"),
    missedResolvedBy: uuid("missed_resolved_by").references(() => staffUser.id),
    missedResolvedAt: instant("missed_resolved_at"),
  },
  (t) => [
    foreignKey({
      name: "appointment_booking_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    foreignKey({
      name: "appointment_booking_appointment_fk",
      columns: [t.appointmentId, t.projectId],
      foreignColumns: [appointment.id, appointment.projectId],
    }),
    uniqueIndex("appointment_booking_live_unique")
      .on(t.appointmentId, t.participationId)
      .where(sql`${t.status} = 'booked'`),
    index("appointment_booking_participation_idx").on(t.participationId),
    index("appointment_booking_appointment_idx").on(t.appointmentId),
    // A follow-up is of the same participation: the composite key makes it so.
    unique("appointment_booking_id_participation_unique").on(t.id, t.participationId),
    foreignKey({
      name: "appointment_booking_follow_up_fk",
      columns: [t.followUpOf, t.participationId],
      foreignColumns: [t.id, t.participationId],
    }),
    index("appointment_booking_follow_up_idx").on(t.followUpOf),
    check(
      "appointment_booking_follow_up",
      sql`${t.followUpOf} is null or (${t.followUpOf} <> ${t.id} and ${t.origin} = 'staff')`,
    ),
    check(
      "appointment_booking_missed",
      sql`(${t.missedResolution} is null) = (${t.missedResolvedBy} is null) and (${t.missedResolution} is null) = (${t.missedResolvedAt} is null) and (${t.missedResolution} is null or ${t.attendance} = 'absent')`,
    ),
    check(
      "appointment_booking_cancelled",
      sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    check(
      "appointment_booking_booked_by",
      sql`(${t.origin} = 'participant') = (${t.bookedBy} is null)`,
    ),
    check(
      "appointment_booking_cancelled_by",
      sql`(${t.cancelledBy} is not null) = coalesce(${t.cancelReason} in ('staff_cancelled', 'appointment_cancelled'), false)`,
    ),
    check(
      "appointment_booking_attendance",
      sql`(${t.attendance} is null) = (${t.attendanceRecordedBy} is null) and (${t.attendance} is null) = (${t.attendanceRecordedAt} is null) and (${t.afterCloseReason} is null or ${t.attendance} is not null) and (${t.origin} <> 'walk_in' or ${t.attendance} is not null)`,
    ),
    check(
      "appointment_booking_basis",
      sql`(${t.informedBasisBy} is null) = (${t.informedBasisAt} is null) and (${t.informedBasisAt} is null or ${t.attendance} is not null)`,
    ),
    check(
      "appointment_booking_conflict",
      sql`(${t.conflictEscalatedBy} is null) = (${t.conflictEscalatedAt} is null) and (${t.conflictResolution} is null) = (${t.conflictResolvedBy} is null) and (${t.conflictResolution} is null) = (${t.conflictResolvedAt} is null) and (${t.informedBasisAt} is not null or (${t.conflictEscalatedAt} is null and ${t.conflictResolution} is null))`,
    ),
    check(
      "appointment_booking_superseded",
      sql`(${t.attendanceSupersededBy} is null) = (${t.attendanceSupersededAt} is null) and (${t.attendanceSupersededAt} is null or (${t.attendance} = 'absent' and ${t.cancelReason} = 'appointment_cancelled'))`,
    ),
  ],
);

/**
 * A message (data-protection.md, reminders and messages; Q156, Q165): a reminder, an invitation to
 * an appointment or the organizer's notice about a booked one. Ids, kind, the text version and
 * language, the channel's id and kind and the consent it was queued under (none for a row written
 * without a usable channel, cancelled at once), who requested it (nobody for a notice: the system)
 * and when (the Berlin date counts a reminder's window), the appointment and booking it is about,
 * its status, a closed cancel reason, a notice's follow-up and times. Never an address, a rendered
 * text, a provider response or an error. Written only by the message functions; read by whoever
 * reads the participation's `case_internal` data.
 */
export const participantReminder = pgTable(
  "participant_reminder",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    kind: reminderKind("kind").notNull(),
    messageVersion: text("message_version").notNull(),
    language: noticeLanguage("language").notNull(),
    channelId: uuid("channel_id").references(() => participantChannel.id),
    channelKind: contactChannelKind("channel_kind"),
    consentId: uuid("consent_id").references(() => consentRecord.id),
    requestedBy: uuid("requested_by").references(() => staffUser.id),
    requestedAt: instant("requested_at").notNull().defaultNow(),
    requestedOn: dateColumn("requested_on").notNull(),
    status: reminderStatus("status").notNull().default("queued"),
    cancelReason: reminderCancelReason("cancel_reason"),
    claimedAt: instant("claimed_at"),
    outcomeAt: instant("outcome_at"),
    appointmentId: uuid("appointment_id"),
    bookingId: uuid("booking_id").references(() => appointmentBooking.id),
    followedUpMethod: noticeFollowUpMethod("followed_up_method"),
    followedUpBy: uuid("followed_up_by").references(() => staffUser.id),
    followedUpAt: instant("followed_up_at"),
  },
  (t) => [
    foreignKey({
      name: "participant_reminder_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    foreignKey({
      name: "participant_reminder_appointment_fk",
      columns: [t.appointmentId, t.projectId],
      foreignColumns: [appointment.id, appointment.projectId],
    }),
    index("participant_reminder_participation_idx").on(t.participationId, t.requestedAt),
    index("participant_reminder_appointment_idx").on(t.appointmentId, t.participationId),
    check(
      "participant_reminder_message_version",
      sql`${t.messageVersion} ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'`,
    ),
    check(
      "participant_reminder_cancelled",
      sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null)`,
    ),
    check(
      "participant_reminder_outcome",
      sql`(${t.status} in ('queued', 'dispatching')) = (${t.outcomeAt} is null) and (${t.status} <> 'dispatching' or ${t.claimedAt} is not null)`,
    ),
    // Enum values added with this check are compared as text (one migration transaction).
    check(
      "participant_reminder_kind",
      sql`(${t.kind}::text = 'open_items') = (${t.appointmentId} is null) and (${t.kind}::text in ('appointment_changed', 'appointment_cancelled')) = (${t.bookingId} is not null) and (${t.kind}::text in ('appointment_changed', 'appointment_cancelled')) = (${t.requestedBy} is null)`,
    ),
    check(
      "participant_reminder_channel",
      sql`(${t.channelId} is null) = coalesce(${t.cancelReason}::text in ('no_channel', 'consent_required'), false) and (${t.channelId} is null) = (${t.channelKind} is null) and (${t.channelId} is null) = (${t.consentId} is null) and (${t.channelId} is not null or (${t.kind}::text <> 'open_items' and ${t.claimedAt} is null))`,
    ),
    check(
      "participant_reminder_follow_up",
      sql`(${t.followedUpMethod} is null) = (${t.followedUpBy} is null) and (${t.followedUpMethod} is null) = (${t.followedUpAt} is null) and (${t.followedUpMethod} is null or (${t.kind}::text in ('appointment_changed', 'appointment_cancelled') and (${t.status} in ('failed', 'delivery_unknown') or ${t.status} = 'cancelled' and ${t.cancelReason} <> 'participation_closed')))`,
    ),
  ],
);

/**
 * A fully executed DSV amendment of a contractual date change (process-and-lifecycle.md, "DSV
 * amendment"; round 32): operational evidence, not the contract (the signed original stays on
 * paper). Written only by `set_participation_dates`; a trigger refuses every update and deletion.
 */
export const participationDsvAmendment = pgTable(
  "participation_dsv_amendment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    participationId: uuid("participation_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    kind: dsvAmendmentKind("kind").notNull(),
    fullyExecutedOn: dateColumn("fully_executed_on").notNull(),
    // The effective dates before and after; null where the wave had none.
    oldTgStart: dateColumn("old_tg_start"),
    newTgStart: dateColumn("new_tg_start"),
    oldTgEnd: dateColumn("old_tg_end"),
    newTgEnd: dateColumn("new_tg_end"),
    /** The PL who confirmed the original was inspected, signed by all parties and retrievable. */
    confirmedBy: uuid("confirmed_by")
      .notNull()
      .references(() => staffUser.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    originalLocation: amendmentOriginalLocation("original_location").notNull(),
    documentReference: text("document_reference"),
  },
  (t) => [
    foreignKey({
      name: "participation_dsv_amendment_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    unique("participation_dsv_amendment_id_project").on(t.id, t.projectId),
    index("participation_dsv_amendment_participation_idx").on(t.participationId),
    check(
      "participation_dsv_amendment_reference",
      sql`${t.documentReference} ~ '^[A-Za-z0-9_./-]{1,40}$'`,
    ),
  ],
);

/**
 * A BA reporting task (process-and-lifecycle.md, "BA reporting"; round 32): created by
 * `set_participation_dates` for each changed effective date and by the early-exit trigger,
 * always `pending` in Slice 2; its status only moves forward (a trigger), it is never deleted.
 */
export const baReportingTask = pgTable(
  "ba_reporting_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    participationId: uuid("participation_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    reportingKind: baReportingKind("reporting_kind").notNull(),
    /** The date the report is about: the new start, the new end or the exit date. */
    subjectDate: dateColumn("subject_date").notNull(),
    amendmentId: uuid("amendment_id"),
    status: baReportingStatus("status").notNull().default("pending"),
    createdAt: createdAt(),
    // Recorded by the Agentur-submission slice; their controlled values come with it.
    reportedOn: dateColumn("reported_on"),
    channel: text("channel"),
    reference: text("reference"),
  },
  (t) => [
    foreignKey({
      name: "ba_reporting_task_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    foreignKey({
      name: "ba_reporting_task_amendment_fk",
      columns: [t.amendmentId, t.projectId],
      foreignColumns: [participationDsvAmendment.id, participationDsvAmendment.projectId],
    }),
    index("ba_reporting_task_participation_idx").on(t.participationId),
    // Reported tasks carry their date; channel and reference only once reported.
    check(
      "ba_reporting_task_reported_fields",
      sql`(${t.status} = 'reported') = (${t.reportedOn} is not null) and (${t.status} = 'reported' or (${t.channel} is null and ${t.reference} is null))`,
    ),
  ],
);

/**
 * The lifecycle edges (process-and-lifecycle.md, generated transitions) as reference data for the
 * status functions; a drift test keeps them equal to the domain's `edges`. Creation edges have no
 * `from_value`.
 */
export const lifecycleEdge = pgTable(
  "lifecycle_edge",
  {
    track: lifecycleTrack("track").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value").notNull(),
    kind: edgeKind("kind").notNull(),
    actors: actorType("actors").array().notNull(),
    /** Only in these project types; all when null. */
    projectTypes: projectType("project_types").array(),
  },
  (t) => [
    unique("lifecycle_edge_unique").on(t.track, t.fromValue, t.toValue, t.kind).nullsNotDistinct(),
    check(
      "lifecycle_edge_values_of_track",
      sql.raw(
        ["main_status", "profiling_status", "dsv_status"]
          .map(
            (type, i) =>
              `("lifecycle_edge"."track" = '${["main", "profiling", "dsv"][i]}' and "lifecycle_edge"."to_value" = any(enum_range(null::${type})::text[]) and ("lifecycle_edge"."from_value" is null or "lifecycle_edge"."from_value" = any(enum_range(null::${type})::text[])))`,
          )
          .join(" or "),
      ),
    ),
  ],
);

/** A code (reason codes), an id (request/job ids) or a job name: never a sentence (Q66). */
const codePattern = "^[a-z][a-z0-9_]{0,62}$";
const correlationPattern = "^[A-Za-z0-9_.:-]{1,64}$";
const systemJobPattern = "^[a-z][a-z0-9_.-]{0,62}$";
/** Strings in `details`: ids, codes, keys, dates and instants only. */
const detailsValuePattern = "^[A-Za-z0-9_.:+-]{1,100}$";
const detailsKeyPattern = "^[a-z][A-Za-z0-9]{0,62}$";

/**
 * The append-only audit trail (ADR-0002). Written only by the status functions;
 * `transfer_app` has no privilege on it in Slice 1. No free-text column: every text column and
 * every string in `details` is held to an id or code pattern by a `CHECK`.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    // No FK: retention deletes the participation and pseudonymises the trail (ADR-0008).
    participationId: uuid("participation_id"),
    eventType: auditEventType("event_type").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(() => staffUser.id),
    actorParticipationId: uuid("actor_participation_id"),
    systemJob: text("system_job"),
    onBehalfOfParticipationId: uuid("on_behalf_of_participation_id"),
    field: statusField("field"),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    reasonCode: text("reason_code"),
    effectiveDate: dateColumn("effective_date"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    requestId: text("request_id"),
    jobId: text("job_id"),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    flaggedForReview: boolean("flagged_for_review").notNull().default(false),
  },
  (t) => [
    index("audit_event_participation_seq_idx").on(t.participationId, t.seq),
    index("audit_event_project_seq_idx").on(t.projectId, t.seq),
    check(
      "audit_event_actor_consistent",
      sql`case ${t.actorType}
        when 'user' then ${t.actorStaffUserId} is not null and ${t.actorParticipationId} is null and ${t.systemJob} is null
        when 'participant' then ${t.actorParticipationId} is not null and ${t.actorStaffUserId} is null and ${t.systemJob} is null and ${t.onBehalfOfParticipationId} is null
        else ${t.systemJob} is not null and ${t.actorStaffUserId} is null and ${t.actorParticipationId} is null and ${t.onBehalfOfParticipationId} is null
      end`,
    ),
    check(
      "audit_event_lifecycle_has_participation",
      sql`${t.participationId} is not null or ${t.eventType}::text not in ('participation_created', 'status_changed', 'entry_wave_assigned', 'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected', 'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed', 'participation_created_manually', 'participation_dates_changed', 'sensitive_read', 'sensitive_write', 'break_glass_access', 'document_opened', 'participant_assigned', 'participant_unassigned')`,
    ),
    // `field`, `from_value` and `to_value` only on a status change (creation: to `imported`) and,
    // as end reasons, on a correction; their values come from the matching enum.
    check(
      "audit_event_change_values",
      sql`case
        when ${t.eventType} = 'status_changed' then ${t.field} is not null and ${t.fromValue} is not null and ${t.toValue} is not null
        when ${t.eventType} = 'participation_created' then ${t.field} = 'status' and ${t.fromValue} is null and ${t.toValue} = 'imported'
        when ${t.eventType} = 'end_reason_corrected' then ${t.field} is null and ${t.fromValue} = any(enum_range(null::end_reason)::text[]) and ${t.toValue} = any(enum_range(null::end_reason)::text[])
        else ${t.field} is null and ${t.fromValue} is null and ${t.toValue} is null
      end`,
    ),
    check(
      "audit_event_values_of_field",
      sql`${t.field} is null or case ${t.field}
        when 'status' then ${t.toValue} = any(enum_range(null::main_status)::text[]) and (${t.fromValue} is null or ${t.fromValue} = any(enum_range(null::main_status)::text[]))
        when 'profiling_status' then ${t.toValue} = any(enum_range(null::profiling_status)::text[]) and ${t.fromValue} = any(enum_range(null::profiling_status)::text[])
        else ${t.toValue} = any(enum_range(null::dsv_status)::text[]) and ${t.fromValue} = any(enum_range(null::dsv_status)::text[])
      end`,
    ),
    check(
      "audit_event_reason_code_is_code",
      sql`${t.reasonCode} ~ ${sql.raw(`'${codePattern}'`)} and ${t.reasonCode} <> 'long_term_illness_reduced_earning_capacity'`,
    ),
    check(
      "audit_event_system_job_is_name",
      sql`${t.systemJob} ~ ${sql.raw(`'${systemJobPattern}'`)}`,
    ),
    check(
      "audit_event_request_id_is_id",
      sql`${t.requestId} ~ ${sql.raw(`'${correlationPattern}'`)}`,
    ),
    check("audit_event_job_id_is_id", sql`${t.jobId} ~ ${sql.raw(`'${correlationPattern}'`)}`),
    check(
      "audit_event_details_ids_and_codes",
      sql.raw(
        `jsonb_typeof("audit_event"."details") = 'object' and not jsonb_path_exists("audit_event"."details", 'strict $.** ? (@.type() == "string" && !(@ like_regex "${detailsValuePattern}"))') and not jsonb_path_exists("audit_event"."details", 'strict $.** ? (@.type() == "object").keyvalue() ? (!(@.key like_regex "${detailsKeyPattern}"))')`,
      ),
    ),
  ],
);

/**
 * The staff audit trail (data-protection.md, Authentication): logins, logouts, refused logins and
 * identity bindings. No `project_id`, so not `audit_event`. Written only by the staff session
 * functions; `transfer_app` has no privilege on it. Ids and codes only, held by the `CHECK`s: a
 * refused login records its code, never the claimed email.
 */
export const staffAuditEvent = pgTable(
  "staff_audit_event",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    eventType: staffAuditEventType("event_type").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(() => staffUser.id),
    subjectStaffUserId: uuid("subject_staff_user_id").references(() => staffUser.id),
    reasonCode: text("reason_code"),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    requestId: text("request_id"),
  },
  (t) => [
    index("staff_audit_event_subject_seq_idx").on(t.subjectStaffUserId, t.seq),
    // A login, logout or binding is the user's own; a refusal has no actor, an account only
    // where one was matched, and its code. An account or org-role event names the acting admin
    // and the account; a deactivation-driven org-role revocation has `account_deactivated`; a
    // region event names the admin and, in its details, the region. The values
    // added with the administration events are compared as text (ADR-0002, migrations). A null
    // (a missing subject or region) fails the check.
    check(
      "staff_audit_event_shape",
      sql`coalesce(case
        when ${t.eventType}::text = 'staff_login_refused' then ${t.actorStaffUserId} is null
          and ${t.reasonCode} in ('unknown_account', 'account_deactivated', 'identity_mismatch')
          and (${t.subjectStaffUserId} is null) = (${t.reasonCode} = 'unknown_account')
        when ${t.eventType}::text in ('staff_login', 'staff_logout', 'staff_identity_bound') then ${t.actorStaffUserId} is not null
          and ${t.subjectStaffUserId} = ${t.actorStaffUserId} and ${t.reasonCode} is null
        when ${t.eventType}::text in ('region_created', 'region_changed') then ${t.actorStaffUserId} is not null
          and ${t.subjectStaffUserId} is null and ${t.reasonCode} is null
          and jsonb_typeof(${t.details} -> 'regionId') = 'string'
        when ${t.eventType}::text = 'org_role_revoked' then ${t.actorStaffUserId} is not null
          and ${t.subjectStaffUserId} is not null
          and (${t.reasonCode} is null or ${t.reasonCode} = 'account_deactivated')
        else ${t.actorStaffUserId} is not null and ${t.subjectStaffUserId} is not null
          and ${t.reasonCode} is null
      end, false)`,
    ),
    check(
      "staff_audit_event_reason_code_is_code",
      sql`${t.reasonCode} ~ ${sql.raw(`'${codePattern}'`)}`,
    ),
    check(
      "staff_audit_event_request_id_is_id",
      sql`${t.requestId} ~ ${sql.raw(`'${correlationPattern}'`)}`,
    ),
    check(
      "staff_audit_event_details_ids_and_codes",
      sql.raw(
        `jsonb_typeof("staff_audit_event"."details") = 'object' and not jsonb_path_exists("staff_audit_event"."details", 'strict $.** ? (@.type() == "string" && !(@ like_regex "${detailsValuePattern}"))') and not jsonb_path_exists("staff_audit_event"."details", 'strict $.** ? (@.type() == "object").keyvalue() ? (!(@.key like_regex "${detailsKeyPattern}"))')`,
      ),
    ),
  ],
);

/**
 * A template version as first pinned anywhere (regional-variation.md, "Template versions"):
 * global reference data without `project_id`. Keyed by Agentur and version, so two first pins of
 * one version serialise on the primary key; every later pin must match both the content and its
 * canonical SHA-256. Written only by `pin_agentur_template`; a trigger refuses `UPDATE` and
 * `DELETE`, for the owner too.
 */
export const configTemplateVersion = pgTable(
  "config_template_version",
  {
    agenturKey: text("agentur_key").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").notNull(),
    contentSha256: text("content_sha256").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "config_template_version_pkey", columns: [t.agenturKey, t.version] }),
    check("config_template_version_version_positive", sql`${t.version} >= 1`),
    check("config_template_version_sha256_hex", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    // The content is the template its key names (as `loadTemplate` checks the file's path).
    check(
      "config_template_version_content_matches_key",
      sql`${t.content} ->> 'kind' = 'regional_template' and ${t.content} ->> 'agenturKey' = ${t.agenturKey} and ${t.content} -> 'version' = to_jsonb(${t.version})`,
    ),
  ],
);

/**
 * A project's pins (regional-variation.md, snapshot): append-only, the current pin per Agentur is
 * the one with the highest `seq`. Written only by `pin_agentur_template`; a trigger refuses
 * `UPDATE` and `DELETE`.
 */
export const projectTemplatePin = pgTable(
  "project_template_pin",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    agenturKey: text("agentur_key").notNull(),
    version: integer("version").notNull(),
    pinnedBy: uuid("pinned_by")
      .notNull()
      .references(() => staffUser.id),
    pinnedAt: timestamp("pinned_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "project_template_pin_version_fk",
      columns: [t.agenturKey, t.version],
      foreignColumns: [configTemplateVersion.agenturKey, configTemplateVersion.version],
    }),
    index("project_template_pin_project_agentur_seq_idx").on(t.projectId, t.agenturKey, t.seq),
  ],
);

/**
 * A project's configuration override, one row per version (regional-variation.md): append-only
 * and written only by `write_project_override`, which takes the next version under the project
 * lock (`override_version_stale` otherwise). The current override is the highest version; no row
 * is version 0, the empty override. The content is a validated `project_override` layer.
 */
export const projectConfigOverride = pgTable(
  "project_config_override",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    version: integer("version").notNull(),
    content: jsonb("content").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => staffUser.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "project_config_override_pkey", columns: [t.projectId, t.version] }),
    check("project_config_override_version_positive", sql`${t.version} >= 1`),
    check(
      "project_config_override_is_override",
      sql`jsonb_typeof(${t.content}) = 'object' and ${t.content} ->> 'kind' = 'project_override'`,
    ),
  ],
);

const relaxationStatusIn = (...list: string[]) =>
  sql.raw(`"config_relaxation_request"."status" in (${list.map((v) => `'${v}'`).join(", ")})`);

/**
 * A request to relax one `operational_default` rule of a project (regional-variation.md, rule
 * relaxations; Q75): the PL asks with a controlled reason code; another person approves or rejects
 * it, or the PL withdraws it. Only an approval changes the configuration, as a new override version
 * in the same transaction. At most one open request per project and rule. Written only by the
 * relaxation functions; a trigger lets the status move only forward.
 */
export const configRelaxationRequest = pgTable(
  "config_relaxation_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    ruleId: text("rule_id").notNull(),
    reasonCode: relaxationReasonCode("reason_code").notNull(),
    status: relaxationRequestStatus("status").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => staffUser.id),
    /** The Berlin business date, from the caller's Clock. */
    requestedOn: dateColumn("requested_on").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    decidedBy: uuid("decided_by").references(() => staffUser.id),
    decidedOn: dateColumn("decided_on"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("config_relaxation_request_one_open_idx")
      .on(t.projectId, t.ruleId)
      .where(sql`${t.status} = 'requested'`),
    // A rule id as the domain's `RuleId` (it enters the audit trail).
    check(
      "config_relaxation_request_rule_id",
      sql`${t.ruleId} ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'`,
    ),
    // A decision has its decider, date and instant; only approvals and rejections are decided.
    check(
      "config_relaxation_request_decision",
      sql`(${t.decidedBy} is null) = (${t.decidedOn} is null) and (${t.decidedBy} is null) = (${t.decidedAt} is null) and (${relaxationStatusIn("approved", "rejected")}) = (${t.decidedBy} is not null)`,
    ),
    // Four eyes (round 8): the decider is never the requester.
    check("config_relaxation_request_four_eyes", sql`${t.decidedBy} <> ${t.requestedBy}`),
  ],
);

/**
 * One row per job and Berlin run day, inserted once when that day's run has completed (ADR-0011):
 * the lifecycle sweep's catch-up window starts after the latest, and a same-day reconciliation
 * needs today's row. No personal data. `transfer_app` may select it and insert only `job_name`,
 * `run_date` and `scheduled_at`, never update or delete: `completed_at` is always database time
 * and never before the scheduled run (round 19).
 */
export const jobRun = pgTable(
  "job_run",
  {
    jobName: text("job_name").notNull(),
    runDate: dateColumn("run_date").notNull(),
    /** The day's originally scheduled run time (`JOBS_LIFECYCLE_TIME`, Europe/Berlin). */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "job_run_pkey", columns: [t.jobName, t.runDate] }),
    check("job_run_job_name_is_name", sql`${t.jobName} ~ ${sql.raw(`'${systemJobPattern}'`)}`),
    check(
      "job_run_scheduled_on_run_date",
      sql`(${t.scheduledAt} at time zone 'Europe/Berlin')::date = ${t.runDate}`,
    ),
    check("job_run_completed_after_scheduled", sql`${t.completedAt} >= ${t.scheduledAt}`),
  ],
);

/**
 * Participant assignments (Q62): the PL assigns a participation to members holding `consultant`
 * in its project, zero or more per participation. Rows are closed, never deleted (`ended_*`):
 * by `unassign_participation`, when the consultant role is removed, or when the account is
 * deactivated. The open ones are a consultant's access to person-level data. Written only by the
 * functions; `transfer_app` only reads it.
 */
export const participantAssignment = pgTable(
  "participant_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    participationId: uuid("participation_id").notNull(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUser.id),
    assignedBy: uuid("assigned_by")
      .notNull()
      .references(() => staffUser.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    endedBy: uuid("ended_by").references(() => staffUser.id),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
    endReason: assignmentEndReason("end_reason"),
  },
  (t) => [
    // An assignment is of its participation's project.
    foreignKey({
      name: "participant_assignment_participation_fk",
      columns: [t.participationId, t.projectId],
      foreignColumns: [participation.id, participation.projectId],
    }),
    uniqueIndex("participant_assignment_one_open_idx")
      .on(t.participationId, t.staffUserId)
      .where(sql`${t.endedAt} is null`),
    index("participant_assignment_staff_user_open_idx")
      .on(t.staffUserId)
      .where(sql`${t.endedAt} is null`),
    check(
      "participant_assignment_ended",
      sql`(${t.endedAt} is null) = (${t.endedBy} is null) and (${t.endedAt} is null) = (${t.endReason} is null) and ${t.endedAt} >= ${t.assignedAt}`,
    ),
  ],
);

/**
 * A saved import column mapping (data-protection.md, retention): the keyed hash of a normalised
 * header and the target it was mapped to in a confirmed import of the project. Never header text
 * (a file without a header row would store a person's name). No personal data and no audit:
 * the application writes it directly (`SELECT, INSERT, UPDATE`). Suggestions for another
 * project of the same customer read it by the customer name.
 */
export const importColumnMapping = pgTable(
  "import_column_mapping",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    /** HMAC-SHA256 as 64 lowercase hex digits. */
    headerHmac: text("header_hmac").notNull(),
    target: importTarget("target").notNull(),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => staffUser.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "import_column_mapping_pkey", columns: [t.projectId, t.headerHmac] }),
    check("import_column_mapping_header_hmac", sql`${t.headerHmac} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const tables = [
  staffUser,
  region,
  staffOrgRole,
  participantAssignment,
  staffSession,
  staffAuditEvent,
  project,
  projectMembership,
  projectEntryWave,
  participation,
  profilingExceptionRequest,
  participantIdentity,
  participantDetails,
  participantProfile,
  participantIdentifierData,
  participantResidenceSocialData,
  participantHealthData,
  participantProfiling,
  profilingSession,
  participantProfilingAssessment,
  participantProfilingHealthAssessment,
  selfServiceNoticeAcknowledgement,
  activationCode,
  privacyNoticeDelivery,
  participantAccount,
  consentRecord,
  participantChannel,
  oneTimeCodeChallenge,
  participantSession,
  assistedMode,
  documentTypePolicy,
  auditEventProjection,
  roleFieldKnowledge,
  fieldAccessCategory,
  document,
  documentLink,
  participantReminder,
  appointment,
  appointmentBooking,
  lifecycleEdge,
  auditEvent,
  jobRun,
  configTemplateVersion,
  projectTemplatePin,
  projectConfigOverride,
  configRelaxationRequest,
  importColumnMapping,
  participationDsvAmendment,
  baReportingTask,
];
