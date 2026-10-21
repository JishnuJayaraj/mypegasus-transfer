import { z } from "zod";
import { ActivationChannel, ActivationDeliveryKind } from "../activation/model";
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

export const PortalChannel = z.strictObject({
  id: z.uuid(),
  kind: ActivationDeliveryKind,
  /** The participant's own address, masked (`p…@example.org`, `+49 … 123`). */
  maskedAddress: z.string(),
  verifiedAt: z.iso.datetime(),
});

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
