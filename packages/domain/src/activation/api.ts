import { z } from "zod";
import { ParticipantAddress } from "../participations";
import { NoticeLanguage } from "../notices/catalog";
import {
  ActivationChannel,
  ActivationDeliveryKind,
  ActivationDeliveryStatus,
  ActivationPurpose,
  ActivationRevokeReason,
  ChannelVerification,
} from "./model";
import { ActivationStatus } from "./status";
import { IdentityAssurance } from "./steps";

export const ActivationCapabilities = z.strictObject({
  issueActivationCode: z.boolean(),
  recordHandover: z.boolean(),
  revokeActivationCode: z.boolean(),
  providePrivacyNotice: z.boolean(),
});

export const BatchActivationCodeInput = z
  .strictObject({
    participationIds: z.array(z.uuid()).min(1).max(500),
    channel: z.enum(["letter", "sheet"]),
    language: NoticeLanguage.default("de"),
    replaceOpenCode: z.boolean().default(false),
  })
  .superRefine(({ participationIds }, ctx) => {
    if (new Set(participationIds).size !== participationIds.length) {
      ctx.addIssue({ code: "custom", path: ["participationIds"], params: { code: "duplicate" } });
    }
  })
  .meta({ id: "BatchActivationCodeInput" });

export const ActivationPrintItem = z.strictObject({
  activationCodeId: z.uuid(),
  participationId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  address: ParticipantAddress.nullable(),
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  activationUrl: z.url(),
  expiresAt: z.iso.datetime(),
  noticeVersion: z.string(),
  noticeLanguage: NoticeLanguage,
  noticeTitle: z.string(),
  noticeText: z.string(),
});

export const BatchActivationCodeResult = z
  .strictObject({ items: z.array(ActivationPrintItem).min(1) })
  .meta({ id: "BatchActivationCodeResult" });

export const InPersonActivationCodeInput = z
  .strictObject({
    deliveryKind: ActivationDeliveryKind,
    deliveryAddress: z.string().min(1).max(254),
    language: NoticeLanguage.default("de"),
    identityChecked: z.literal(true),
    replaceOpenCode: z.boolean().default(false),
  })
  .meta({ id: "InPersonActivationCodeInput" });

export const ActivationCodeActionInput = z
  .strictObject({ activationCodeId: z.uuid() })
  .meta({ id: "ActivationCodeActionInput" });

export const ActivationCodeRevocationInput = z
  .strictObject({
    activationCodeId: z.uuid(),
    reason: z.enum(["not_handed_over", "lost"]),
  })
  .meta({ id: "ActivationCodeRevocationInput" });

export const ActivationRecord = z
  .strictObject({
    activationCodeId: z.uuid(),
    purpose: ActivationPurpose,
    channel: ActivationChannel,
    deliveryKind: ActivationDeliveryKind.nullable(),
    deliveryStatus: ActivationDeliveryStatus.nullable(),
    noticeLanguage: NoticeLanguage,
    issuedBy: z.uuid(),
    issuedByDisplayName: z.string().min(1).max(100),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    handedOverBy: z.uuid().nullable(),
    handedOverAt: z.iso.datetime().nullable(),
    identityCheckedBy: z.uuid().nullable(),
    identityCheckedAt: z.iso.datetime().nullable(),
    failedAttempts: z.int().min(0).max(5),
    attemptsLeft: z.int().min(0).max(5),
    lockedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    revokeReason: ActivationRevokeReason.nullable(),
    usedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ActivationRecord" });

/** The activated account as staff see it (D29): when, and how the identity was assured. */
export const ParticipantAccountRecord = z.strictObject({
  activatedAt: z.iso.datetime(),
  identityAssurance: IdentityAssurance,
  identityAssuredAt: z.iso.datetime().nullable(),
});

/** A participant channel as staff see it (D28, Q123): kind, states and dates, never the address. */
export const StaffChannelRecord = z.strictObject({
  id: z.uuid(),
  kind: ActivationDeliveryKind,
  verifiedAt: z.iso.datetime(),
  verifiedBy: ChannelVerification,
  consentGivenAt: z.iso.datetime(),
  consentEndedAt: z.iso.datetime().nullable(),
  noticeSentAt: z.iso.datetime().nullable(),
  suspendedAt: z.iso.datetime().nullable(),
  removedAt: z.iso.datetime().nullable(),
});

export const ParticipationActivation = z
  .strictObject({
    status: ActivationStatus,
    current: ActivationRecord.nullable(),
    account: ParticipantAccountRecord.nullable(),
    channels: z.array(StaffChannelRecord),
    capabilities: ActivationCapabilities,
  })
  .meta({ id: "ParticipationActivation" });

export const PrivacyNoticeBatchInput = z
  .strictObject({
    participationIds: z.array(z.uuid()).min(1).max(500),
    language: NoticeLanguage.default("de"),
  })
  .meta({ id: "PrivacyNoticeBatchInput" });

export const PrivacyNoticeInput = z
  .strictObject({
    language: NoticeLanguage.default("de"),
    method: z.literal("in_person_print"),
    handedOver: z.literal(true),
  })
  .meta({ id: "PrivacyNoticeInput" });

export const PrivacyNoticePrintItem = z.strictObject({
  participationId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  address: ParticipantAddress.nullable(),
  noticeVersion: z.string(),
  noticeLanguage: NoticeLanguage,
  noticeTitle: z.string(),
  noticeText: z.string(),
});

export const PrivacyNoticeBatchResult = z
  .strictObject({ items: z.array(PrivacyNoticePrintItem).min(1) })
  .meta({ id: "PrivacyNoticeBatchResult" });

/**
 * `POST /participations/{id}/activation-codes` with purpose `recovery` (D24, Q130): after staff
 * verified the person, a code by any channel; issuing it ends the participant's sessions and
 * suspends the old channels at once. An `in_person` code is sent to the typed address like the
 * first one (the photo-ID check recorded first).
 */
export const RecoveryCodeInput = z
  .discriminatedUnion("channel", [
    z.strictObject({
      purpose: z.literal("recovery"),
      channel: z.enum(["letter", "sheet"]),
      language: NoticeLanguage.default("de"),
      identityVerified: z.literal(true),
      replaceOpenCode: z.boolean().default(false),
    }),
    z.strictObject({
      purpose: z.literal("recovery"),
      channel: z.literal("in_person"),
      language: NoticeLanguage.default("de"),
      identityVerified: z.literal(true),
      identityChecked: z.literal(true),
      deliveryKind: ActivationDeliveryKind,
      deliveryAddress: z.string().min(1).max(254),
      replaceOpenCode: z.boolean().default(false),
    }),
  ])
  .meta({ id: "RecoveryCodeInput" });

/** The new state, with the print data of a letter or sheet (never retrievable later). */
export const RecoveryCodeResult = z
  .strictObject({
    item: ActivationPrintItem.nullable(),
    activation: ParticipationActivation,
  })
  .meta({ id: "RecoveryCodeResult" });
