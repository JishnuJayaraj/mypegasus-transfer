import { z } from "zod";
import { ActivationDeliveryKind } from "../activation/model";
import { isoDate } from "../iso-date";
import { NoticeLanguage, PORTAL_CONTACT_CONSENT_VERSION } from "../notices/catalog";
import {
  NoticeFollowUpMethod,
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

/** 1–500 distinct participations of one request. */
const participationIds = z
  .array(z.uuid())
  .min(reminderPolicy.minPerRequest)
  .max(reminderPolicy.maxPerRequest)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "A participation is named twice",
    params: { code: "duplicate_participation" },
  });

/** `POST /appointments/{id}/invitations` (data-protection.md, invitations): 1–500 participations. */
export const InvitationRequestInput = z
  .strictObject({ participationIds })
  .meta({ id: "InvitationRequestInput" });
export type InvitationRequestInput = z.infer<typeof InvitationRequestInput>;

/**
 * The invitations queued per channel, those written without a usable channel ("nicht zustellbar,
 * im Portal sichtbar"), and each skipped participation with its code (data, not a problem).
 */
export const InvitationRequestResult = z
  .strictObject({
    batchId: z.uuid(),
    queued: z.array(z.strictObject({ participationId: z.uuid(), channel: ActivationDeliveryKind })),
    notDeliverable: z.array(
      z.strictObject({
        participationId: z.uuid(),
        code: z.enum(["no_channel", "consent_required"]),
      }),
    ),
    skipped: z.array(z.strictObject({ participationId: z.uuid(), code: ReminderSkip })),
  })
  .meta({ id: "InvitationRequestResult" });
export type InvitationRequestResult = z.infer<typeof InvitationRequestResult>;

/** `POST /participations/{id}/reminders/{reminderId}/follow-up`: how the person was told. */
export const NoticeFollowUpInput = z
  .strictObject({ method: NoticeFollowUpMethod })
  .meta({ id: "NoticeFollowUpInput" });

/**
 * One message in "Nachrichten": who requested it is shown as the team (or the system for a
 * notice), never by name; no channel for one written without a usable channel; an appointment's
 * message names the appointment; a notice's follow-up once recorded.
 */
export const ReminderRecord = z
  .strictObject({
    id: z.uuid(),
    kind: ReminderKind,
    messageVersion: z.string(),
    language: NoticeLanguage,
    channel: ActivationDeliveryKind.nullable(),
    appointmentId: z.uuid().nullable(),
    requestedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    requestedOn: isoDate,
    /** Queued by the system: an organizer's notice. */
    bySystem: z.boolean(),
    status: ReminderStatus,
    cancelReason: ReminderCancelReason.nullable(),
    outcomeAt: z.iso.datetime().nullable(),
    followUpMethod: z.enum(NoticeFollowUpMethod.options).nullable(),
    followedUpAt: z.iso.datetime().nullable(),
    /** "Nachverfolgung erfassen" on an undelivered notice (the PL, the assigned consultant). */
    capabilities: z.strictObject({ followUp: z.boolean() }),
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
