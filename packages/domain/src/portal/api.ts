import { z } from "zod";
import { ActivationChannel, ActivationDeliveryKind, ActivationPurpose } from "../activation/model";
import { ActivationStep } from "../activation/steps";
import { isoDate } from "../iso-date";
import {
  ART14_NOTICE_VERSION,
  NoticeLanguage,
  PORTAL_CONTACT_CONSENT_VERSION,
} from "../notices/catalog";

// The participant portal's activation API (Slice 3 plan, PR 3e; D22–D29). Requests carry codes and
// addresses only in bodies; responses never carry a code, a whole address or a hash.

/** `POST /portal/activation`: the code as typed or taken from the link's fragment. */
export const ActivationCodeInput = z
  .strictObject({ code: z.string().min(1).max(40) })
  .meta({ id: "ActivationCodeInput" });

/** Where an activating session stands; the portal shows the next step. */
export const ActivationState = z
  .strictObject({
    nextStep: ActivationStep,
    /** `recovery` after lost access (Q130): the same steps; the new channel replaces the old ones. */
    purpose: ActivationPurpose,
    channel: ActivationChannel,
    /** For an `in_person` code: the kind of address the link came to. */
    deliveryKind: ActivationDeliveryKind.nullable(),
    /** The language the PL chose at issuance; the portal starts in it. */
    language: NoticeLanguage,
    noticeVersion: z.literal(ART14_NOTICE_VERSION),
    consentVersion: z.literal(PORTAL_CONTACT_CONSENT_VERSION),
  })
  .meta({ id: "ActivationState" });
export type ActivationState = z.infer<typeof ActivationState>;

export const ActivationBirthDateInput = z
  .strictObject({ birthDate: isoDate })
  .meta({ id: "ActivationBirthDateInput" });

export const ActivationDeliveryAddressInput = z
  .strictObject({ deliveryAddress: z.string().min(1).max(254) })
  .meta({ id: "ActivationDeliveryAddressInput" });

/** `POST /portal/activation/channel`: the private email or mobile a one-time code goes to. */
export const ActivationChannelInput = z
  .strictObject({
    kind: ActivationDeliveryKind,
    address: z.string().min(1).max(254),
    /** The language of the message with the code: the portal's. */
    language: NoticeLanguage.default("de"),
  })
  .meta({ id: "ActivationChannelInput" });

export const ActivationCompletionInput = z
  .strictObject({
    /** The one-time code; for an `in_person` code, the delivery address instead. */
    oneTimeCode: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional(),
    deliveryAddress: z.string().min(1).max(254).optional(),
    /** The notice version the portal showed (D18: repeated, never the first delivery). */
    noticeVersion: z.literal(ART14_NOTICE_VERSION),
    consent: z.literal(true),
    consentVersion: z.literal(PORTAL_CONTACT_CONSENT_VERSION),
    language: NoticeLanguage,
  })
  .refine((input) => (input.oneTimeCode === undefined) !== (input.deliveryAddress === undefined), {
    message: "Either the one-time code or the delivery address",
    params: { code: "one_of_required" },
  })
  .meta({ id: "ActivationCompletionInput" });

export const PortalChannel = z
  .strictObject({
    id: z.uuid(),
    kind: ActivationDeliveryKind,
    /** The participant's own address, masked (`p…@example.org`, `+49 … 123`). */
    maskedAddress: z.string(),
    verifiedAt: z.iso.datetime(),
  })
  .meta({ id: "PortalChannel" });

/** `GET /portal/me`: the logged-in participant's greeting and channels. */
export const PortalMe = z
  .strictObject({
    firstName: z.string(),
    language: NoticeLanguage,
    sessionExpiresAt: z.iso.datetime(),
    channels: z.array(PortalChannel),
  })
  .meta({ id: "PortalMe" });
export type PortalMe = z.infer<typeof PortalMe>;

// Login, channels (PR 3f; ADR-0007, Q123). The login answers never say whether an address
// belongs to an account.

const oneTimeCode = z.string().regex(/^[0-9]{6}$/);

/** `POST /portal/login/code-request`: `202` whether or not the address belongs to an account. */
export const LoginCodeRequestInput = z
  .strictObject({
    kind: ActivationDeliveryKind,
    address: z.string().min(1).max(254),
    /** The language of the message: the portal's. */
    language: NoticeLanguage.default("de"),
  })
  .meta({ id: "LoginCodeRequestInput" });

/** `POST /portal/login`: the address again and the code that went to it. */
export const LoginInput = z
  .strictObject({
    kind: ActivationDeliveryKind,
    address: z.string().min(1).max(254),
    oneTimeCode,
  })
  .meta({ id: "LoginInput" });

/** `GET /portal/channels`: the participant's own channels, masked. */
export const PortalChannels = z
  .strictObject({ channels: z.array(PortalChannel) })
  .meta({ id: "PortalChannels" });

/** `POST /portal/channels`: a one-time code to the new private email or mobile. */
export const ChannelCodeRequestInput = z
  .strictObject({
    kind: ActivationDeliveryKind,
    address: z.string().min(1).max(254),
    language: NoticeLanguage.default("de"),
  })
  .meta({ id: "ChannelCodeRequestInput" });

/** `POST /portal/channels/verification`: the code, with the consent for the new channel. */
export const ChannelVerificationInput = z
  .strictObject({
    oneTimeCode,
    consent: z.literal(true),
    consentVersion: z.literal(PORTAL_CONTACT_CONSENT_VERSION),
    language: NoticeLanguage,
  })
  .meta({ id: "ChannelVerificationInput" });

/** `DELETE /portal/channels/{id}`: whether removing it ended the session (the last one, Q123). */
export const ChannelRemovalResult = z
  .strictObject({ sessionEnded: z.boolean() })
  .meta({ id: "ChannelRemovalResult" });
