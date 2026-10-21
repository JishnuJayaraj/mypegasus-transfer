import { compileFieldSchema, resolveForParticipation, type FieldSchema } from "@transfer/config";
import {
  and,
  eq,
  participantDetails,
  participantIdentity,
  participantProfile,
  participation,
  selfServiceNoticeAcknowledgement as acknowledgement,
  type Database,
} from "@transfer/db";
import {
  SELF_SERVICE_NOTICE_VERSION,
  type ContactField,
  type CustomFieldDefinition,
  type SelfServiceValueMap,
  type WizardInput,
} from "@transfer/domain";
import type { z } from "zod";
import { projectSnapshot, type Release } from "../projects/template-pins";
import { utc } from "../sql";

// What the self-service routes read (data-protection.md, self-service; Q140): a participation's
// confidential self-service values, its own resolved chain (regional-variation.md, "Self-service
// wizard") and the facts its completeness is evaluated on. No highly confidential or
// special-category value is read here; their presence joins with their encrypted tables.

type Db = Pick<Database, "select" | "selectDistinctOn" | "execute">;
type CustomValue = string | number | boolean;

export type SelfServiceRecord = {
  id: string;
  projectId: string;
  identity: { firstName: string; lastName: string; birthDate: string | null };
  values: SelfServiceValueMap;
  customValues: Record<string, CustomValue>;
  revision: number;
  updatedAt: string | null;
  /** When the current purposes notice was acknowledged, if it was. */
  acknowledgedAt: string | null;
  participantMaintained: ContactField[];
  /** The wizard's input: the participation's chain and its facts. */
  wizard: WizardInput;
  /** The compiled validators of the chain's confidential custom fields. */
  customValidators: ReadonlyMap<string, z.ZodType>;
};

const validators = new Map<string, z.ZodType>();

/** A field schema compiled once per content (ADR-0004, field-schema profile). */
function validatorOf(schema: FieldSchema) {
  const key = JSON.stringify(schema);
  let validator = validators.get(key);
  if (!validator) {
    validator = compileFieldSchema(schema);
    validators.set(key, validator);
  }
  return validator;
}

/** The highly confidential and special-category wizard fields: not stored yet, so absent. */
const sensitiveFacts = {
  pensionInsuranceNumber: null,
  nationality: null,
  entryToGermanyDate: null,
  residenceStatus: null,
  buergergeld: null,
  healthRestrictions: null,
  severeDisability: null,
};

/** One participation's self-service record, or undefined when it doesn't exist. */
export async function loadSelfService(
  db: Db,
  release: Release,
  participationId: string,
): Promise<SelfServiceRecord | undefined> {
  const [row] = await db
    .select({
      id: participation.id,
      projectId: participation.projectId,
      placementAgenturKey: participation.placementAgenturKey,
      identity: participantIdentity,
      details: participantDetails,
      profile: participantProfile,
      profileUpdatedAt: utc(participantProfile.updatedAt),
      acknowledgedAt: utc(acknowledgement.acknowledgedAt),
    })
    .from(participation)
    .leftJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
    .leftJoin(participantDetails, eq(participantDetails.participationId, participation.id))
    .leftJoin(participantProfile, eq(participantProfile.participationId, participation.id))
    .leftJoin(
      acknowledgement,
      and(
        eq(acknowledgement.participationId, participation.id),
        eq(acknowledgement.noticeVersion, SELF_SERVICE_NOTICE_VERSION),
      ),
    )
    .where(eq(participation.id, participationId));
  if (!row) return undefined;
  const { identity, details, profile } = row;
  const snapshot = (await projectSnapshot(db, release, row.projectId))!;
  const { config } = resolveForParticipation({
    ...snapshot.input,
    placementAgenturKey: row.placementAgenturKey,
  });
  // Custom fields are confidential or internal; the participant answers the confidential ones.
  const custom = Object.entries(config.fields).filter(
    ([, schema]) => schema["x-dataClass"] === "confidential",
  );
  const customFields: Record<string, CustomFieldDefinition> = Object.fromEntries(
    custom.map(([key, schema]) => [key, { label: schema["x-label"], schema }]),
  );
  const licence = profile?.drivingLicence ?? null;
  const values: SelfServiceValueMap = {
    gender: profile?.gender ?? null,
    maritalStatus: profile?.maritalStatus ?? null,
    address:
      details?.addressStreet != null
        ? {
            street: details.addressStreet,
            postalCode: details.addressPostalCode!,
            city: details.addressCity!,
            country: details.addressCountry as "DE",
          }
        : null,
    phone: details?.phone ?? null,
    mobile: details?.mobile ?? null,
    privateEmail: details?.privateEmail ?? null,
    educationHistory: (profile?.educationHistory ??
      null) as SelfServiceValueMap["educationHistory"],
    workHistory: (profile?.workHistory ?? null) as SelfServiceValueMap["workHistory"],
    languageSkills: (profile?.languageSkills ?? null) as SelfServiceValueMap["languageSkills"],
    // An empty array is the answer "no licence" (TL 407 field 42).
    drivingLicence: licence === null ? null : licence.length === 0 ? "none" : licence,
    vehicleAvailable: profile?.vehicleAvailable ?? null,
    workingTimePreferences: (profile?.workingTimePreferences ??
      null) as SelfServiceValueMap["workingTimePreferences"],
    jobWishes: (profile?.jobWishes ?? null) as SelfServiceValueMap["jobWishes"],
    desiredWorkLocations: profile?.desiredWorkLocations ?? null,
    maxCommuteDistance: (profile?.maxCommuteDistance ??
      null) as SelfServiceValueMap["maxCommuteDistance"],
    earliestStartDate: profile?.earliestStartDate ?? null,
  };
  const customValues = (profile?.customFields ?? {}) as Record<string, CustomValue>;
  return {
    id: row.id,
    projectId: row.projectId,
    identity: {
      firstName: identity?.firstName ?? "",
      lastName: identity?.lastName ?? "",
      birthDate: identity?.birthDate ?? null,
    },
    values,
    customValues,
    revision: profile?.revision ?? 0,
    updatedAt: profile ? row.profileUpdatedAt : null,
    acknowledgedAt: row.acknowledgedAt,
    participantMaintained: (details?.participantMaintained ?? []) as ContactField[],
    wizard: {
      projectType: snapshot.project.type,
      rules: config.rules,
      customFields,
      helpTexts: config.helpTexts,
      fields: {
        personnelNumber: identity?.personnelNumber ?? null,
        lastName: identity?.lastName ?? null,
        firstName: identity?.firstName ?? null,
        birthDate: identity?.birthDate ?? null,
        oldEmploymentEndDate: details?.oldEmploymentEndDate ?? null,
        workEmail: details?.workEmail ?? null,
        ...values,
        ...sensitiveFacts,
        ...customValues,
      },
    },
    customValidators: new Map(custom.map(([key, schema]) => [key, validatorOf(schema)])),
  };
}
