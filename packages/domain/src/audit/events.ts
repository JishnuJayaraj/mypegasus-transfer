import { z } from "zod";
import { DocumentType } from "../documents/catalog";
import { AccessCategory, valueDataClass } from "../fields/catalog";
import { AuditStream } from "../access/decide";
import { isoDate } from "../iso-date";
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
  // Slices 3–9, through `record_audit_event`
  "sensitive_read",
  "sensitive_write",
  "break_glass_access",
  "document_opened",
  "warning_confirmed",
  "export_created",
  "config_override_changed",
  "review_recorded",
  "clarification_requested",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

/** `record_audit_event` refuses these: only the lifecycle functions write them. */
export const lifecycleEventTypes: ReadonlySet<AuditEventType> = new Set(
  AuditEventType.options.slice(0, AuditEventType.options.indexOf("end_reason_corrected") + 1),
);

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
/** A field key (`healthRestrictions`, `custom.…`) or document type. */
const resourceKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,99}$/);

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
 * shape for (`warning_confirmed`, `export_created`, `config_override_changed`) carry a code and
 * no details until their slices define them.
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
  event("profiling_exception_requested", {
    ...ofParticipation,
    reasonCode: ProfilingExceptionReason,
    details: noDetails,
  }),
  event("profiling_exception_approved", { ...ofParticipation, details: noDetails }),
  event("profiling_exception_rejected", { ...ofParticipation, details: noDetails }),
  event("profiling_exception_revoked", { ...ofParticipation, details: noDetails }),
  event("profiling_exception_superseded", {
    ...ofParticipation,
    reasonCode: ProfilingExceptionSupersededReason,
    /** The `status_changed` event that made the request stale. */
    details: z.strictObject({ statusChangeId: z.uuid() }),
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
  event("config_override_changed", {
    ...ofProjectOrParticipation,
    reasonCode: code,
    details: noDetails,
  }),
  /** Reviews and clarification requests are new events pointing at the reviewed one (5.4). */
  event("review_recorded", { ...ofProjectOrParticipation, reasonCode: code, details: reviewOf }),
  event("clarification_requested", { ...ofProjectOrParticipation, details: reviewOf }),
]);
export type AuditEvent = z.infer<typeof AuditEvent>;
