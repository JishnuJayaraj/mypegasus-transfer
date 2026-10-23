import { z } from "zod";
import { ActivationDeliveryKind } from "../activation/model";
import { isoDate } from "../iso-date";
import { NoticeLanguage, PORTAL_CONTACT_CONSENT_VERSION } from "../notices/catalog";
import {
  ReminderCancelReason,
  ReminderKind,
  reminderPolicy,
  ReminderSkip,
  ReminderStatus,
} from "./model";

// The reminder routes (ADR-0010; data-protection.md, reminders). Ids, codes and dates only: never
// an address, a rendered text or the requester's name.

/** `POST /projects/{id}/reminders`: 1–500 distinct participations. */
export const ReminderRequestInput = z
  .strictObject({
    kind: ReminderKind,
    participationIds: z
      .array(z.uuid())
      .min(reminderPolicy.minPerRequest)
      .max(reminderPolicy.maxPerRequest),
  })
  .refine(({ participationIds }) => new Set(participationIds).size === participationIds.length, {
    message: "A participation is named twice",
    path: ["participationIds"],
    params: { code: "duplicate_participation" },
  })
  .meta({ id: "ReminderRequestInput" });
export type ReminderRequestInput = z.infer<typeof ReminderRequestInput>;

/** The reminders queued, and each skipped participation with its code (data, not a problem). */
export const ReminderRequestResult = z
  .strictObject({
    batchId: z.uuid(),
    queued: z.array(z.strictObject({ participationId: z.uuid(), channel: ActivationDeliveryKind })),
    skipped: z.array(z.strictObject({ participationId: z.uuid(), code: ReminderSkip })),
  })
  .meta({ id: "ReminderRequestResult" });
export type ReminderRequestResult = z.infer<typeof ReminderRequestResult>;

/** One reminder in "Nachrichten": who requested it is shown as the team, never by name. */
export const ReminderRecord = z
  .strictObject({
    id: z.uuid(),
    kind: ReminderKind,
    messageVersion: z.string(),
    language: NoticeLanguage,
    channel: ActivationDeliveryKind,
    requestedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    requestedOn: isoDate,
    status: ReminderStatus,
    cancelReason: ReminderCancelReason.nullable(),
    outcomeAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ReminderRecord" });
export type ReminderRecord = z.infer<typeof ReminderRecord>;

export const ReminderPage = z
  .strictObject({ items: z.array(ReminderRecord), nextCursor: z.string().nullable() })
  .meta({ id: "ReminderPage" });
export type ReminderPage = z.infer<typeof ReminderPage>;

/** The latest reminder of a work list row. */
export const WorklistReminder = z
  .strictObject({ lastRequestedOn: isoDate, status: ReminderStatus })
  .meta({ id: "WorklistReminder" });

/**
 * Whether the viewer may remind the row now: `allowed`, or the `code` it would be skipped with
 * (`null` when the viewer may not remind at all); `channel` is the kind it would go to.
 */
export const RemindCapability = z
  .strictObject({
    allowed: z.boolean(),
    code: ReminderSkip.nullable(),
    channel: ActivationDeliveryKind.nullable(),
  })
  .meta({ id: "RemindCapability" });
export type RemindCapability = z.infer<typeof RemindCapability>;

/** `POST /portal/channels/{id}/consent-upgrade`: the participant's own consent v2. */
export const ConsentUpgradeInput = z
  .strictObject({
    consent: z.literal(true),
    consentVersion: z.literal(PORTAL_CONTACT_CONSENT_VERSION),
    language: NoticeLanguage,
  })
  .meta({ id: "ConsentUpgradeInput" });

export const ConsentUpgradeResult = z
  .strictObject({ result: z.enum(["upgraded", "already_current"]) })
  .meta({ id: "ConsentUpgradeResult" });
