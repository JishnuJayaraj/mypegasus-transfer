import {
  ActorType,
  AmendmentOriginalLocation,
  AuditEventType,
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
  IdentityAssurance,
  OneTimeCodePurpose,
  ParticipantSessionState,
  StepUpMethod,
  ChannelSuspensionReason,
  ChannelRemovalReason,
  ConsentEndReason,
  ParticipantSessionEndReason,
  edgeKinds,
  portalLimits,
} from "@transfer/domain";
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
 * `bind_staff_identity` (D5); a deactivated account can't log in. No flat role: org roles are
 * `staff_org_role` rows, project roles `project_membership` rows, and `may_create_projects` lets
 * its holder create projects (and become their first PL).
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
    // The first login matches the email case-insensitively (D5), so one address is one account.
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
 * Server-side staff sessions for both login modes (D1, D2): the cookie holds 32 random bytes, the
 * row only their SHA-256, so reading the table gives no live session. 8 hours absolute; the API
 * checks expiry against database time. Written only by `start_staff_session` and
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
 * setup functions (Slice 2, D2); `transfer_app` only reads it.
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
    /** The Project Agentur (Q90); chosen with its pinned template (PR 2c-2). */
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
 * Project roles of staff (D6, Q61): zero or more per person and project; permissions are their
 * union. Written by `create_project` (the creator's PL row), `add_project_member` and
 * `remove_project_member` (the PL; a global admin adds a replacement PL, Q126) and
 * `deactivate_staff_user`; a removed role's row is deleted, its audit events stay.
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

const dateColumn = (name: string) => date(name, { mode: "string" });
const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

/**
 * An entry wave of a `ta_tg` project (Q79): a timing cohort with its contractual dates, nullable
 * while draft. Written only by `create_entry_wave` and `update_entry_wave` (Slice 2 plan 5.6);
 * `transfer_app` only reads it. The CHECKs hold the ordering the offer and entry guards need.
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
 * One person in one project (plan 5.10). Written only by the status functions (ADR-0002, D2):
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

/** Trimmed text of 1 to `max` characters without control characters (plan 5.11). */
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
 * Who a participation is (Slice 2 plan 5.2, 5.10; R8): the import's match key and the minimal
 * identity, class `participation_record`. Written only by `write_participant_data` (D2); the
 * Personalnummer never changes and is unique in the project.
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
 * The personnel-file data of a participation (plan 5.2, 5.10; R8, round 32): the structured
 * address with its country (ISO 3166-1 alpha-2, only `DE` in the MVP; all four parts or none),
 * phone, mobile, emails and the Austrittsdatum; class `personnel_file`. Written only by
 * `write_participant_data` (D2).
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
  ],
);

/**
 * A personal activation code (D12–D20). The code and an in-person destination are never stored:
 * only HMAC-SHA256 values under separately derived keys. All writes go through the Slice 3d
 * functions; the runtime role reads only the non-secret projection it needs.
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
 * An activated participant account (Slice 3 plan D23, D29): one per participation, with the code it
 * was activated by and how the identity was assured (`photo_id` with the staff confirmer of the
 * code's ID check, only when the birth-date step was skipped, Q129). Written only by
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
 * A consent to the portal contact purpose for one channel (D28): the text version and language
 * shown, who gave it and when; never the address. Written only by the activation functions.
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
    channelId: uuid("channel_id").notNull(),
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
  ],
);

/**
 * A verified private email or mobile of an activated participant (D28): the normalised address,
 * how it was verified, its consent and when the activation notice went to it (D21). One address
 * belongs to at most one channel that isn't removed. Staff never read the address (Q123).
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
 * A one-time code sent to an address (D27): only its keyed hash; the normalised address it went to,
 * the delivery outcome (D20), 15 minutes, its own counter of 5 wrong entries. Written only by the
 * one-time-code functions; never served.
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
 * Participant sessions (D29): the cookie holds 32 random bytes, the row their SHA-256. An
 * `activating` session (code accepted) opens only the activation steps and records them; an
 * `active` one starts with a new token at completion. 30 minutes idle, 12 hours absolute, checked
 * against database time. `transfer_app` may update `last_seen_at` only; everything else goes
 * through the activation functions.
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
      "participant_session_activating",
      sql`(${t.state} = 'activating') = (${t.activationCodeId} is not null) and (${t.state} = 'activating' or ${t.birthDateCheckedAt} is null and ${t.deliveryAddressCheckedAt} is null)`,
    ),
  ],
);

/**
 * A fully executed DSV amendment of a contractual date change (Slice 2 plan 5.2, 5.7; round 32 L4,
 * D3; R41; PR 2h-3): operational evidence, not the contract (the signed original stays on paper).
 * Written only by `set_participation_dates`; a trigger refuses every update and deletion.
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
 * A BA reporting task (Slice 2 plan 5.2, 5.7; round 32 B3; R38, R42; PR 2h-3): created by
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
 * The lifecycle edges (plan 5.3) as reference data for the status functions; a drift test keeps
 * them equal to the domain's `edges`. Creation edges have no `from_value`.
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
 * The append-only audit trail (plan 5.4, ADR-0002). Written only by the status functions;
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
    // No FK: retention deletes the participation and pseudonymises the trail (plan 5.4).
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
 * The staff audit trail (D6): logins, logouts, refused logins and identity bindings. No
 * `project_id`, so not `audit_event`. Written only by the staff session functions; `transfer_app`
 * has no privilege on it. Ids and codes only, held by the `CHECK`s: a refused login records its
 * code, never the claimed email.
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
 * A template version as first pinned anywhere (Slice 2 plan 5.2, 5.8; D5): global reference data
 * without `project_id` (R27). Keyed by Agentur and version, so two first pins of one version
 * serialise on the primary key; every later pin must match both the content and its canonical
 * SHA-256 (R22). Written only by `pin_agentur_template`; a trigger refuses `UPDATE` and `DELETE`,
 * for the owner too.
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
 * A project's pins (plan 5.2): append-only, the current pin per Agentur is the one with the
 * highest `seq`. Written only by `pin_agentur_template`; a trigger refuses `UPDATE` and `DELETE`.
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
 * A project's configuration override, one row per version (Slice 2 plan 5.2, 5.9): append-only
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
 * A request to relax one `operational_default` rule of a project (Slice 2 plan 5.2, 5.9; Q75,
 * R2): the PL asks with a controlled reason code; another person approves or rejects it, or the
 * PL withdraws it. Only an approval changes the configuration, as a new override version in the
 * same transaction. At most one open request per project and rule. Written only by the
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
    // Four eyes (round 8, R2): the decider is never the requester.
    check("config_relaxation_request_four_eyes", sql`${t.decidedBy} <> ${t.requestedBy}`),
  ],
);

/**
 * One row per job and Berlin run day, inserted once when that day's run has completed (plan 5.9):
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
 * A saved import column mapping (Slice 2 plan 5.2, 5.11; R7): the keyed hash of a normalised
 * header and the target it was mapped to in a confirmed import of the project. Never header text
 * (a file without a header row would store a person's name). No personal data and no audit
 * (D2): the application writes it directly (`SELECT, INSERT, UPDATE`). Suggestions for another
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
  activationCode,
  privacyNoticeDelivery,
  participantAccount,
  consentRecord,
  participantChannel,
  oneTimeCodeChallenge,
  participantSession,
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
