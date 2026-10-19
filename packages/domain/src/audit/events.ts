import { z } from "zod";
import { DocumentType } from "../documents/catalog";
import { AccessCategory, ParticipantDataField, valueDataClass } from "../fields/catalog";
import { AuditStream } from "../access/decide";
import { isoDate } from "../iso-date";
import { ProjectType } from "../project";
import {
  AgenturKey as agenturKey,
  AgenturSettingSource,
  OverrideChange,
} from "../projects/agentur-settings";
import { RelaxationReasonCode, RuleId } from "../projects/relaxations";
import { SettingKey } from "../projects/migration";
import { waveDateFields } from "../projects/waves";
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
 * The audit event model (plan 5.4, table `audit_event`). Events are append-only and written only
 * by the status functions (ADR-0002, D2). They carry IDs, codes and dates, never free text and
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
  // Slices 3–9, through `record_audit_event` (`config_override_changed`: its function, PR 2d-1)
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
  // Slice 2, through `record_audit_event` (PR 2g, plan 5.11; PR 2h-2, R32)
  "import_confirmed",
  "participation_created_manually",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

/** `record_audit_event` refuses these: only the lifecycle functions write them. */
export const lifecycleEventTypes: ReadonlySet<AuditEventType> = new Set(
  AuditEventType.options.slice(0, AuditEventType.options.indexOf("end_reason_corrected") + 1),
);

/** Project setup events, written only by their functions (Slice 2 plan 5.3, D2). */
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
 * `baseDefaultsVersion` (R26, round 23: `project_activated`, `config_template_pinned`,
 * `config_override_changed`, `rule_relaxation_requested`, `rule_relaxation_approved`,
 * `import_confirmed`; round 33: `participation_created_manually`); each joins this list with the
 * PR that adds its type.
 */
export const configurationDependentEventTypes: ReadonlySet<AuditEventType> = new Set([
  "config_override_changed",
  "config_template_pinned",
  "rule_relaxation_requested",
  "rule_relaxation_approved",
  "project_activated",
  "import_confirmed",
  "participation_created_manually",
]);

/** `record_audit_event` refuses these: each is written only by its own function. */
export const reservedEventTypes: ReadonlySet<AuditEventType> = new Set([
  ...lifecycleEventTypes,
  ...setupEventTypes,
  "participant_data_changed",
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
/** Request and job ids: id characters only. */
const correlationId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
/** A job name such as `lifecycle.evaluate-project` or `seed`. */
const systemJob = z.string().regex(/^[a-z][a-z0-9_.-]{0,62}$/);
/** The base-defaults version of a configuration-dependent event (R26). */
const baseDefaultsVersion = z.int().min(1);
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

const common = {
  projectId: z.uuid(),
  actor: AuditActor,
  requestId: correlationId.nullable(),
  jobId: correlationId.nullable(),
};
/** No FK to the participation: retention deletes it and pseudonymises the trail (plan 5.4). */
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
 * A new override version (5.9): its number, what changed, and either the Agentur key, the setting
 * keys (`step.key`) and, when set, the source, or the relaxed rule's id; never a value or free
 * text (round 8). A migration's review (`agentur_setting_reviewed`, 5.8) names the removed keys as
 * `settingKeys` and the kept ones, if any, as `keptSettingKeys`. R26: the base-defaults version
 * it was validated with.
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
/** Every relaxation event names its request and the rule (5.9); the reason code is its column. */
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
  /** Reviews and clarification requests are new events pointing at the reviewed one (5.4). */
  event("review_recorded", { ...ofProjectOrParticipation, reasonCode: code, details: reviewOf }),
  event("clarification_requested", { ...ofProjectOrParticipation, details: reviewOf }),
  /** Free text (name, customer) never enters the trail: the type, and the changed keys. */
  event("project_created", { ...ofProject, details: z.strictObject({ type: ProjectType }) }),
  event("project_changed", {
    ...ofProject,
    details: z.strictObject({
      fields: z.array(z.enum(["name", "customerName", "type", "projectAgenturKey"])).min(1),
      type: ProjectType.optional(),
      projectAgenturKey: agenturKey.optional(),
    }),
  }),
  /** The wave's dates as created; the code and name stay on the row. */
  event("entry_wave_created", {
    ...ofProject,
    details: z.strictObject({ waveId: z.uuid(), ...waveDates }),
  }),
  entryWaveChanged,
  /** A pin of a template version (plan 5.8); `previousVersion` when it replaces one (2e-2). */
  event("config_template_pinned", {
    ...ofProject,
    details: z.strictObject({
      agenturKey,
      version: z.int().min(1),
      previousVersion: z.int().min(1).optional(),
      baseDefaultsVersion,
    }),
  }),
  /** Requested against the snapshot of this release (R26); approved as override `version`. */
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
   * Draft → active (plan 5.5): the Project Agentur and the version of its pinned template the
   * activation was checked against, and the base-defaults version (R26).
   */
  event("project_activated", {
    ...ofProject,
    details: z.strictObject({
      projectAgenturKey: agenturKey,
      projectAgenturVersion: z.int().min(1),
      baseDefaultsVersion,
    }),
  }),
  /** Person data written (plan 5.3, 5.10): the changed fields, never a value (Q66). */
  event("participant_data_changed", {
    ...ofParticipation,
    details: z.strictObject({ fields: z.array(ParticipantDataField).min(1) }),
  }),
  /**
   * A confirmed import (plan 5.11): the counts and the base-defaults version its required targets
   * were resolved with (R26). Correlated with the rows' own events by the request id.
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
   * A participation the PL created by hand (R32, PR 2h-2): one import row, so its required targets
   * were resolved with this base-defaults version (R26, round 33). The creation and the person
   * data have their own events; correlated by the request id.
   */
  event("participation_created_manually", {
    ...ofParticipation,
    details: z.strictObject({ baseDefaultsVersion }),
  }),
]);
export type AuditEvent = z.infer<typeof AuditEvent>;
