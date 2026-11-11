import { z } from "zod";
import {
  staffPermission,
  type Actor,
  type Permission,
  type PermissionTarget,
} from "../access/permissions";
import { isoDate } from "../iso-date";

// Legal holds (data-protection.md, legal holds; Q218): on selected records or classes of one
// participation, never the participation as a whole. Placed by the PL or back office with a reason
// code and the documented basis; released by a regional operations manager of the region who
// didn't place it, against a documented legal or DPO instruction. The job skips exactly the held
// rows. No I/O.

export const LegalHoldReason = z
  .enum(["litigation", "authority_request", "documented_dispute", "dpo_instruction"])
  .meta({ id: "LegalHoldReason" });
export type LegalHoldReason = z.infer<typeof LegalHoldReason>;

/** The classes a hold may name whole; the participation record only by its records. */
export const HoldableClass = z
  .enum(["personnel_file", "health_record", "form_working_copy", "evidence_set"])
  .meta({ id: "HoldableClass" });
export type HoldableClass = z.infer<typeof HoldableClass>;

/** The record kinds a hold may name (a table of the participation), with their class. */
export const holdRecordKinds = {
  dsv_offer: "participation_record",
  dsv_contract: "participation_record",
  dsv_scan_signature: "personnel_file",
  participant_reminder: "personnel_file",
  appointment_booking: "personnel_file",
  consent_record: "personnel_file",
  participant_channel: "personnel_file",
  participant_details: "personnel_file",
  participant_profile: "personnel_file",
  participant_profiling: "personnel_file",
  participant_profiling_assessment: "personnel_file",
  participant_health_data: "health_record",
  participant_profiling_health_assessment: "health_record",
} as const;
export const HoldRecordKind = z
  .enum(Object.keys(holdRecordKinds) as [keyof typeof holdRecordKinds])
  .meta({ id: "HoldRecordKind" });
export type HoldRecordKind = z.infer<typeof HoldRecordKind>;

export type HoldScope = {
  classes: readonly HoldableClass[];
  recordKinds: readonly HoldRecordKind[];
  documentIds: readonly string[];
};

/**
 * A hold's scope problem: nothing selected (`hold_scope_empty`), or every holdable class at once,
 * the participation as a whole (`hold_scope_too_broad`).
 */
export function holdScopeProblem(
  scope: HoldScope,
): null | "hold_scope_empty" | "hold_scope_too_broad" {
  const classes = new Set(scope.classes);
  if (classes.size + scope.recordKinds.length + scope.documentIds.length === 0) {
    return "hold_scope_empty";
  }
  return HoldableClass.options.every((c) => classes.has(c)) ? "hold_scope_too_broad" : null;
}

const denied = { ok: false, because: "actor_not_allowed" } as const satisfies Permission;

/** Who places a hold: the PL or back office of the project. */
export function mayPlaceLegalHold(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => ["project_lead", "back_office"].includes(role));
}

/** Who releases it: a regional operations manager of the region, not the one who placed it. */
export function mayReleaseLegalHold(
  actor: Actor,
  target: PermissionTarget,
  placedBy: string,
): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "regional_operations_manager", placedBy);
}

const basis = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !/\p{Cc}/u.test(value), "source_invalid");

export const LegalHoldRequest = z
  .strictObject({
    classes: z.array(HoldableClass).max(4),
    recordKinds: z.array(HoldRecordKind).max(13),
    documentIds: z.array(z.uuid()).max(100),
    reason: LegalHoldReason,
    /** The documented basis, e.g. the court's or the authority's reference. */
    basis,
    /** The ids of the active holds as read. */
    expected: z.strictObject({ activeHoldIds: z.array(z.uuid()) }),
  })
  .meta({ id: "LegalHoldRequest" });
export type LegalHoldRequest = z.infer<typeof LegalHoldRequest>;

export const LegalHoldRelease = z
  .strictObject({
    /** The documented legal or DPO instruction. */
    source: basis,
  })
  .meta({ id: "LegalHoldRelease" });
export type LegalHoldRelease = z.infer<typeof LegalHoldRelease>;

export const LegalHoldItem = z
  .strictObject({
    id: z.uuid(),
    classes: z.array(HoldableClass),
    recordKinds: z.array(HoldRecordKind),
    documentIds: z.array(z.uuid()),
    reason: LegalHoldReason,
    /** Only for the PL and back office; null for others. */
    basis: z.string().nullable(),
    placedOn: isoDate,
    releasedOn: isoDate.nullable(),
    capabilities: z.strictObject({ release: z.boolean() }),
  })
  .meta({ id: "LegalHoldItem" });
export type LegalHoldItem = z.infer<typeof LegalHoldItem>;

export const LegalHoldsView = z
  .strictObject({
    holds: z.array(LegalHoldItem),
    /** Since when only the evidence set is left (break-glass only); null before. */
    evidenceSetSince: z.iso.datetime({ offset: true }).nullable(),
    capabilities: z.strictObject({ place: z.boolean() }),
  })
  .meta({ id: "LegalHoldsView" });
export type LegalHoldsView = z.infer<typeof LegalHoldsView>;

/** A hold awaiting release in "Freigaben": no participant name or id, by schema. */
export const LegalHoldReviewItem = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    projectName: z.string(),
    classes: z.array(HoldableClass),
    recordKinds: z.array(HoldRecordKind),
    documentCount: z.number().int(),
    reason: LegalHoldReason,
    placedOn: isoDate,
    capabilities: z.strictObject({ release: z.boolean() }),
  })
  .meta({ id: "LegalHoldReviewItem" });
export type LegalHoldReviewItem = z.infer<typeof LegalHoldReviewItem>;
