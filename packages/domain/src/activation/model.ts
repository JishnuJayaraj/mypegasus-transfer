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

export type ActivationPurpose = z.infer<typeof ActivationPurpose>;
export type ActivationChannel = z.infer<typeof ActivationChannel>;
export type IdentityCheck = z.infer<typeof IdentityCheck>;
export type ActivationDeliveryKind = z.infer<typeof ActivationDeliveryKind>;
export type ActivationDeliveryStatus = z.infer<typeof ActivationDeliveryStatus>;
export type ActivationRevokeReason = z.infer<typeof ActivationRevokeReason>;
export type NoticeMethod = z.infer<typeof NoticeMethod>;
