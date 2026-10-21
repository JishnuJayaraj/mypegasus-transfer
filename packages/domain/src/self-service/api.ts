import { z } from "zod";
import { ConsentEndReason, ConsentPurpose, ConsentSource } from "../activation/model";
import { isoDate } from "../iso-date";
import { Step } from "../lifecycle/enums";
import { NoticeLanguage, SELF_SERVICE_NOTICE_VERSION } from "../notices/catalog";
import { contactFields, selfServiceValueSchemas, type SelfServiceField } from "./values";
import { SelfServicePage } from "./wizard";

// The self-service API (data-protection.md, self-service; Q112, Q138, Q140). No response carries a
// highly confidential or special-category value: those have their own logged endpoints. Missing
// items are codes.

const utc = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });

/** The confidential self-service values; `null` where nothing is recorded. */
export const SelfServiceValues = z
  .strictObject(
    Object.fromEntries(
      Object.entries(selfServiceValueSchemas).map(([key, schema]) => [key, schema.nullable()]),
    ) as { [K in SelfServiceField]: z.ZodNullable<(typeof selfServiceValueSchemas)[K]> },
  )
  .meta({ id: "SelfServiceValues" });

/** A custom field's value (the field-schema profile: scalars only), `null` where empty. */
const CustomValue = z.union([z.string(), z.number(), z.boolean()]).nullable();
const CustomValues = z.record(z.string(), CustomValue);

const LocalizedHelp = z.strictObject({ de: z.string().optional(), en: z.string().optional() });

export const SelfServiceFieldView = z
  .strictObject({
    key: z.string(),
    required: z.boolean(),
    helpText: LocalizedHelp.optional(),
    /** A custom field's label and field schema (regional-variation.md, custom fields). */
    custom: z
      .strictObject({
        label: z.strictObject({ de: z.string(), en: z.string().optional() }),
        schema: z.record(z.string(), z.unknown()),
      })
      .optional(),
  })
  .meta({ id: "SelfServiceField" });

export const SelfServicePageView = z
  .strictObject({
    page: SelfServicePage,
    /** Its fields are written and read on their own, logged endpoints. */
    sensitive: z.boolean(),
    complete: z.boolean(),
    fields: z.array(SelfServiceFieldView),
  })
  .meta({ id: "SelfServicePageView" });

/** A missing item of the data-collection or profiling step: keys only, never a value. */
export const SelfServiceMissingItem = z
  .strictObject({
    step: Step,
    ruleId: z.string(),
    kind: z.enum(["field", "document"]),
    key: z.string(),
    reason: z.enum(["missing", "not_accepted"]),
  })
  .meta({ id: "SelfServiceMissingItem" });

/** `GET /portal/self-service`. */
export const PortalSelfService = z
  .strictObject({
    /** The profile's revision; a write names it (`409 stale_revision` when it moved). */
    revision: z.int().min(0),
    notice: z.strictObject({
      version: z.literal(SELF_SERVICE_NOTICE_VERSION),
      /** The current version is acknowledged; until then no page is written. */
      acknowledged: z.boolean(),
    }),
    /** Shown read-only on the contact page. */
    identity: z.strictObject({
      firstName: z.string(),
      lastName: z.string(),
      birthDate: isoDate.nullable(),
    }),
    values: SelfServiceValues,
    customValues: CustomValues,
    pages: z.array(SelfServicePageView),
    missing: z.array(SelfServiceMissingItem),
  })
  .meta({ id: "PortalSelfService" });
export type PortalSelfService = z.infer<typeof PortalSelfService>;

/**
 * `PUT /portal/self-service/pages/{page}`: the page's values, checked against the page's schema
 * (`422` with the code and location of each issue, never the value), and the revision read.
 */
export const SelfServicePageInput = z
  .strictObject({
    revision: z.int().min(0),
    values: z.record(z.string(), z.unknown()).meta({
      description:
        "The page's fields (SelfServiceValues for the catalog pages, the custom fields on " +
        "`further`); a field absent or null is empty. Unknown keys are refused.",
    }),
  })
  .meta({ id: "SelfServicePageInput" });

export const SelfServiceWarning = z
  .strictObject({
    code: z.literal("from_after_to"),
    path: z.array(z.union([z.string(), z.int()])),
  })
  .meta({ id: "SelfServiceWarning" });

/** The state after a page write, with the warnings on what was saved. */
export const PortalSelfServiceWrite = PortalSelfService.extend({
  warnings: z.array(SelfServiceWarning),
}).meta({ id: "PortalSelfServiceWrite" });

/** `POST /portal/self-service/notice`: the version and language shown. */
export const SelfServiceNoticeInput = z
  .strictObject({ version: z.literal(SELF_SERVICE_NOTICE_VERSION), language: NoticeLanguage })
  .meta({ id: "SelfServiceNoticeInput" });

/** One of the participant's own consents (Q138): never the channel's address. */
export const PortalConsent = z
  .strictObject({
    id: z.uuid(),
    purpose: ConsentPurpose,
    source: ConsentSource,
    textVersion: z.string(),
    language: NoticeLanguage,
    /** The channel of a `portal_contact` consent (`GET /portal/channels` masks it). */
    channelId: z.uuid().nullable(),
    givenAt: utc,
    endedAt: utc.nullable(),
    endReason: ConsentEndReason.nullable(),
  })
  .meta({ id: "PortalConsent" });

export const PortalConsents = z
  .strictObject({ consents: z.array(PortalConsent) })
  .meta({ id: "PortalConsents" });

/**
 * `GET /participations/{id}/self-service`: the normal-mode projection for staff
 * (data-protection.md, access matrix): each confidential value the viewer may read, which contact
 * fields the participant maintains and the missing items of the data-collection and profiling
 * steps.
 */
export const ParticipationSelfService = z
  .strictObject({
    participationId: z.uuid(),
    revision: z.int().min(0),
    updatedAt: utc.nullable(),
    notice: z.strictObject({
      version: z.literal(SELF_SERVICE_NOTICE_VERSION),
      acknowledgedAt: utc.nullable(),
    }),
    values: SelfServiceValues.partial(),
    customValues: CustomValues,
    participantMaintained: z.array(z.enum(contactFields)),
    missing: z.array(SelfServiceMissingItem),
  })
  .meta({ id: "ParticipationSelfService" });
export type ParticipationSelfService = z.infer<typeof ParticipationSelfService>;
