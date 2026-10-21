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
/** Participant channels, consents, one-time codes and sessions (ADR-0007, Q123). */
export const ChannelVerification = z.enum(["one_time_code", "activation_link"]);
/**
 * Our consents (data-protection.md, legal basis; Q138): a portal contact channel, given in the
 * portal; the TG's access to the BA applicant profile, recorded from the signed Kug 200b.
 */
export const ConsentPurpose = z.enum(["portal_contact", "kug200b_profile_access"]);
/** Where a consent was given: in the portal, or on a signed paper form staff record. */
export const ConsentSource = z.enum(["portal", "paper_form"]);
/** A login, a new channel's verification, or the step-up before special-category data (Q137). */
export const OneTimeCodePurpose = z.enum(["login", "channel_verification", "step_up"]);
export const ParticipantSessionState = z.enum(["activating", "active"]);
export const StepUpMethod = z.enum(["birth_date", "one_time_code"]);
/** Q130, Q123: why a channel was suspended or removed, and why its consent ended. */
export const ChannelSuspensionReason = z.enum(["lost_access"]);
export const ChannelRemovalReason = z.enum(["consent_revoked", "lost_access_replaced"]);
export const ConsentEndReason = z.enum(["revoked", "lost_access_replaced"]);
/**
 * Why a participant session ended: logout, activation (the activating session gives way to an
 * active one), a newer activating session of the same code, the code locked or revoked, a terminal
 * status, a recovery code issued (Q130), the last channel removed (Q123), the fifth wrong birth
 * date of a step-up (Q137).
 */
export const ParticipantSessionEndReason = z.enum([
  "logout",
  "activated",
  "superseded",
  "code_closed",
  "participation_closed",
  "lost_access",
  "no_channel",
  "step_up_failed",
]);
/** ADR-0007, Q130: how a participant logged in. */
export const LoginMethod = z.enum(["one_time_code", "recovery_code"]);

export type ActivationPurpose = z.infer<typeof ActivationPurpose>;
export type ActivationChannel = z.infer<typeof ActivationChannel>;
export type IdentityCheck = z.infer<typeof IdentityCheck>;
export type ActivationDeliveryKind = z.infer<typeof ActivationDeliveryKind>;
export type ActivationDeliveryStatus = z.infer<typeof ActivationDeliveryStatus>;
export type ActivationRevokeReason = z.infer<typeof ActivationRevokeReason>;
export type NoticeMethod = z.infer<typeof NoticeMethod>;
export type ChannelVerification = z.infer<typeof ChannelVerification>;
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;
export type ConsentSource = z.infer<typeof ConsentSource>;
export type OneTimeCodePurpose = z.infer<typeof OneTimeCodePurpose>;
export type ParticipantSessionState = z.infer<typeof ParticipantSessionState>;
export type StepUpMethod = z.infer<typeof StepUpMethod>;
export type ChannelSuspensionReason = z.infer<typeof ChannelSuspensionReason>;
export type ChannelRemovalReason = z.infer<typeof ChannelRemovalReason>;
export type ConsentEndReason = z.infer<typeof ConsentEndReason>;
export type ParticipantSessionEndReason = z.infer<typeof ParticipantSessionEndReason>;
export type LoginMethod = z.infer<typeof LoginMethod>;
