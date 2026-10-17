import {
  ActorType,
  AuditEventType,
  DsvStatus,
  EndReason,
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
  StaffRole,
  StatusField,
  TgEntryKind,
  Track,
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

export const staffRole = pgEnum("staff_role", values(StaffRole));
export const projectType = pgEnum("project_type", values(ProjectType));
export const projectStatus = pgEnum("project_status", values(ProjectStatus));
export const projectRole = pgEnum("project_role", values(ProjectRole));

/** Synthetic staff users only in Slice 0 (the dev session stub). Never hard-deleted (Q59). */
export const staffUser = pgTable("staff_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().unique(),
  role: staffRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  },
  (t) => [
    check(
      "project_activated",
      sql`(${t.status} = 'active') = (${t.activatedAt} is not null) and (${t.activatedAt} is null) = (${t.activatedBy} is null)`,
    ),
    check("project_agentur_key_format", sql`${t.projectAgenturKey} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    index("project_created_at_id_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * Project roles of staff (D6, Q61): zero or more per person and project; permissions are their
 * union. Filled by project creation and the seed; managing members is Slice 3 (plan D4).
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
export const edgeKind = pgEnum("edge_kind", [
  ...values(TgEntryKind),
  "manual",
  "system",
  "anonymous_self_registration",
]);
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
export const relaxationReasonCode = pgEnum("relaxation_reason_code", values(RelaxationReasonCode));
export const relaxationRequestStatus = pgEnum(
  "relaxation_request_status",
  values(RelaxationRequestStatus),
);

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
    // isConsistentState (plan 5.3): the tracks start at `informed`, the TG needs a signed DSV,
    // an unmatched self-registration has no wave.
    check(
      "participation_tracks_start_at_informed",
      sql`not (${statusIn("self_registered", "rejected", "imported", "contacted", "unreachable")}) or (${t.profilingStatus} = 'not_started' and ${t.dsvStatus} = 'not_offered')`,
    ),
    check(
      "participation_tg_needs_signed_dsv",
      sql`not (${statusIn("active_in_tg", "exited")}) or ${t.dsvStatus} = 'dsv_signed'`,
    ),
    check(
      "participation_unmatched_has_no_wave",
      sql`not (${statusIn("self_registered", "rejected")}) or ${t.entryWaveId} is null`,
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
      sql`${t.participationId} is not null or ${t.eventType} not in ('participation_created', 'status_changed', 'entry_wave_assigned', 'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected', 'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected', 'sensitive_read', 'sensitive_write', 'break_glass_access', 'document_opened')`,
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

export const tables = [
  staffUser,
  project,
  projectMembership,
  projectEntryWave,
  participation,
  profilingExceptionRequest,
  lifecycleEdge,
  auditEvent,
  jobRun,
  configTemplateVersion,
  projectTemplatePin,
  projectConfigOverride,
  configRelaxationRequest,
];
