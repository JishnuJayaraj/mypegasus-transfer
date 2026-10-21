import { z } from "zod";

export const ActivationPurpose = z.enum(["activation", "recovery"]);
export const ActivationChannel = z.enum(["letter", "sheet", "in_person"]);
export const IdentityCheck = z.enum(["none", "photo_id"]);
export const ActivationDeliveryKind = z.enum(["email", "sms"]);
export const ActivationDeliveryStatus = z.enum(["pending", "sent", "failed", "unknown"]);
export const ActivationRevokeReason = z.enum([
  "reissued",
  "not_handed_over",
  "lost",
  "delivery_failed",
  "participation_closed",
]);
export const NoticeMethod = z.enum(["letter", "sheet", "email", "sms", "in_person_print"]);
export const IdentityCheckMethod = z.literal("official_photo_id");
/** Slice 3 plan D28, D29: participant channels, consents, one-time codes and sessions. */
export const ChannelVerification = z.enum(["one_time_code", "activation_link"]);
export const ConsentPurpose = z.enum(["portal_contact"]);
export const OneTimeCodePurpose = z.enum(["login", "channel_verification"]);
export const ParticipantSessionState = z.enum(["activating", "active"]);
export const StepUpMethod = z.enum(["birth_date", "one_time_code"]);

export type ActivationPurpose = z.infer<typeof ActivationPurpose>;
export type ActivationChannel = z.infer<typeof ActivationChannel>;
export type IdentityCheck = z.infer<typeof IdentityCheck>;
export type ActivationDeliveryKind = z.infer<typeof ActivationDeliveryKind>;
export type ActivationDeliveryStatus = z.infer<typeof ActivationDeliveryStatus>;
export type ActivationRevokeReason = z.infer<typeof ActivationRevokeReason>;
export type NoticeMethod = z.infer<typeof NoticeMethod>;
export type ChannelVerification = z.infer<typeof ChannelVerification>;
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;
export type OneTimeCodePurpose = z.infer<typeof OneTimeCodePurpose>;
export type ParticipantSessionState = z.infer<typeof ParticipantSessionState>;
export type StepUpMethod = z.infer<typeof StepUpMethod>;
