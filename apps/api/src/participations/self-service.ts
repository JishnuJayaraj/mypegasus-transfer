import { compileFieldSchema, resolveForParticipation, type FieldSchema } from "@transfer/config";
import {
  and,
  document,
  eq,
  inArray,
  isNull,
  participantDetails,
  participantHealthData,
  participantIdentifierData,
  participantIdentity,
  participantProfile,
  participantResidenceSocialData,
  participation,
  selfServiceNoticeAcknowledgement as acknowledgement,
  sql,
  type Database,
} from "@transfer/db";
import {
  asuProofState,
  documentState,
  SELF_SERVICE_NOTICE_VERSION,
  type AsuChannel,
  type CompletenessFacts,
  type ContactField,
  type DocumentState,
  type DocumentType,
  type CustomFieldDefinition,
  type SelfServiceValueMap,
  type SensitivePresence,
  type WizardInput,
} from "@transfer/domain";
import type { z } from "zod";
import { projectSnapshot, type Release } from "../projects/template-pins";
import { asuStatesOf, type AsuState } from "./asu";
import { utc } from "../sql";

// What the self-service routes read (data-protection.md, self-service; Q140): a participation's
// confidential self-service values, its own resolved chain (regional-variation.md, "Self-service
// wizard") and the facts its completeness is evaluated on. No highly confidential or
// special-category value is read here, only their presence beside the ciphertexts (ADR-0002,
// encryption), which the runtime role can't select.

type Db = Pick<Database, "select" | "selectDistinctOn" | "execute">;
type CustomValue = string | number | boolean;

export type SelfServiceRecord = {
  id: string;
  projectId: string;
  identity: { firstName: string; lastName: string; birthDate: string | null };
  values: SelfServiceValueMap;
  /** Which sensitive fields hold a value; never the value. */
  sensitive: SensitivePresence;
  customValues: Record<string, CustomValue>;
  revision: number;
  updatedAt: string | null;
  /** When the current purposes notice was acknowledged, if it was. */
  acknowledgedAt: string | null;
  participantMaintained: ContactField[];
  /** The wizard's input: the participation's chain and its facts. */
  wizard: WizardInput;
  /** The placement Agentur's resolved ASU `defaultChannel`, preselected on the route (D19). */
  asuDefaultChannel: AsuChannel | null;
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

/** The participation with its self-service rows; the sensitive values only as presence. */
const selectRecords = (db: Db) =>
  db
    .select({
      id: participation.id,
      projectId: participation.projectId,
      placementAgenturKey: participation.placementAgenturKey,
      identity: participantIdentity,
      details: participantDetails,
      profile: participantProfile,
      profileUpdatedAt: utc(participantProfile.updatedAt),
      acknowledgedAt: utc(acknowledgement.acknowledgedAt),
      pensionInsuranceNumber: participantIdentifierData.pensionInsuranceNumberPresent,
      nationality: participantResidenceSocialData.nationalityPresent,
      entryToGermanyDate: participantResidenceSocialData.entryToGermanyDatePresent,
      residenceStatus: participantResidenceSocialData.residenceStatusPresent,
      buergergeld: participantResidenceSocialData.buergergeldPresent,
      healthRestrictions: participantHealthData.healthRestrictionsPresent,
      severeDisability: participantHealthData.severeDisabilityPresent,
    })
    .from(participation)
    .leftJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
    .leftJoin(participantDetails, eq(participantDetails.participationId, participation.id))
    .leftJoin(participantProfile, eq(participantProfile.participationId, participation.id))
    .leftJoin(
      participantIdentifierData,
      eq(participantIdentifierData.participationId, participation.id),
    )
    .leftJoin(
      participantResidenceSocialData,
      eq(participantResidenceSocialData.participationId, participation.id),
    )
    .leftJoin(participantHealthData, eq(participantHealthData.participationId, participation.id))
    .leftJoin(
      acknowledgement,
      and(
        eq(acknowledgement.participationId, participation.id),
        eq(acknowledgement.noticeVersion, SELF_SERVICE_NOTICE_VERSION),
      ),
    );

type Row = Awaited<ReturnType<typeof selectRecords>>[number];
type Documents = Partial<Record<DocumentType, DocumentState[]>>;
type Snapshot = NonNullable<Awaited<ReturnType<typeof projectSnapshot>>>;

/** The live documents' states by type, per participation (process-and-lifecycle.md, document review). */
async function liveDocuments(db: Db, participationIds: readonly string[]) {
  const live = await db
    .select({
      participationId: document.participationId,
      type: document.type,
      reviewState: document.reviewState,
      quarantined: sql<boolean>`${document.quarantinedAt} is not null`,
    })
    .from(document)
    .where(
      and(inArray(document.participationId, [...participationIds]), isNull(document.deletedAt)),
    );
  const byParticipation = new Map<string, Documents>();
  for (const { participationId, type, reviewState, quarantined } of live) {
    const state = documentState({ reviewState, deletedAt: null, quarantined });
    if (state === null) continue;
    const documents = byParticipation.get(participationId) ?? {};
    (documents[type] ??= []).push(state);
    byParticipation.set(participationId, documents);
  }
  return byParticipation;
}

/** One participation's self-service record, or undefined when it doesn't exist. */
export async function loadSelfService(
  db: Db,
  release: Release,
  participationId: string,
): Promise<SelfServiceRecord | undefined> {
  const [row] = await selectRecords(db).where(eq(participation.id, participationId));
  if (!row) return undefined;
  const snapshot = (await projectSnapshot(db, release, row.projectId))!;
  const documents = (await liveDocuments(db, [participationId])).get(participationId) ?? {};
  const asu = (await asuStatesOf(db, [participationId])).get(participationId)!;
  return recordOf(row, snapshot, documents, asu, resolveForParticipation);
}

/**
 * The records of `participationIds` of one project, for the work list: one query each for the
 * rows and the live documents, the configuration resolved once per placement Agentur.
 */
export async function loadSelfServiceRecords(
  db: Db,
  release: Release,
  projectId: string,
  participationIds: readonly string[],
): Promise<Map<string, SelfServiceRecord>> {
  if (participationIds.length === 0) return new Map();
  const rows = await selectRecords(db).where(
    and(eq(participation.projectId, projectId), inArray(participation.id, [...participationIds])),
  );
  const snapshot = (await projectSnapshot(db, release, projectId))!;
  const documents = await liveDocuments(db, participationIds);
  const asu = await asuStatesOf(db, participationIds);
  const configs = new Map<string | null, ReturnType<typeof resolveForParticipation>>();
  const resolve: typeof resolveForParticipation = (input) => {
    let resolved = configs.get(input.placementAgenturKey);
    if (!resolved)
      configs.set(input.placementAgenturKey, (resolved = resolveForParticipation(input)));
    return resolved;
  };
  return new Map(
    rows.map((row) => [
      row.id,
      recordOf(row, snapshot, documents.get(row.id) ?? {}, asu.get(row.id)!, resolve),
    ]),
  );
}

function recordOf(
  row: Row,
  snapshot: Snapshot,
  documents: Documents,
  asu: AsuState,
  resolve: typeof resolveForParticipation,
): SelfServiceRecord {
  const { identity, details, profile } = row;
  const { config } = resolve({
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
  const sensitive: SensitivePresence = {
    pensionInsuranceNumber: row.pensionInsuranceNumber ?? false,
    nationality: row.nationality ?? false,
    entryToGermanyDate: row.entryToGermanyDate ?? false,
    residenceStatus: row.residenceStatus ?? false,
    buergergeld: row.buergergeld ?? false,
    healthRestrictions: row.healthRestrictions ?? false,
    severeDisability: row.severeDisability ?? false,
  };
  // Completeness needs only presence (process-and-lifecycle.md, profiling).
  const sensitiveFacts = Object.fromEntries(
    Object.entries(sensitive).map(([key, present]) => [key, present ? true : null]),
  );
  return {
    id: row.id,
    projectId: row.projectId,
    identity: {
      firstName: identity?.firstName ?? "",
      lastName: identity?.lastName ?? "",
      birthDate: identity?.birthDate ?? null,
    },
    values,
    sensitive,
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
        // The ASU route the Kug 200b rules apply on (regional-variation.md, rule `when`).
        asuChannel: asu.channel,
      },
      // The ASU proof's state comes from the record: a registration with proof, any route (D21).
      documents: {
        ...documents,
        asu_proof: asuProofState(asu.fact !== null, documents.asu_proof ?? []),
      } satisfies CompletenessFacts["documents"],
    },
    asuDefaultChannel: config.settings.asu_registration?.defaultChannel ?? null,
    customValidators: new Map(custom.map(([key, schema]) => [key, validatorOf(schema)])),
  };
}
