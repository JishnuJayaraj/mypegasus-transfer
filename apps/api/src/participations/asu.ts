import {
  agenturSubmission,
  asuRecord,
  asuRegistration,
  document,
  eq,
  inArray,
  sql,
  type Database,
} from "@transfer/db";
import {
  asuRegisteredSince,
  type AsuChannel,
  type AsuProofKind,
  type AsuRegistrationFacts,
  type AttestationSource,
  type DatedFact,
} from "@transfer/domain";
import { utc } from "../sql";

// The ASU record as the API reads it (process-and-lifecycle.md, Arbeitsuchendmeldung; ADR-0002,
// the ASU record): the route and the registration with its proof's state, codes, dates and
// instants only. The fact `asuRegisteredWithProof` is dated by the domain's `asuRegisteredSince`.
// Reads run one after another on the caller's connection (ADR-0002, queries on one connection).

type Db = Pick<Database, "select">;

export type AsuRegistrationRow = {
  id: string;
  channel: AsuChannel;
  registeredOn: string;
  recordedAt: string;
  proofKind: AsuProofKind | null;
  attestationSource: AttestationSource | null;
  proofDocumentId: string | null;
  proofLinkedAt: string | null;
  /**
   * The document the fact rests on: the linked BA confirmation, or for a batch's registration
   * the member's submitted Kug 200b scan; null for the attestation.
   */
  supportingDocumentId: string | null;
  /** The supporting document may supply a fact: accepted, live, not quarantined or invalidated. */
  documentUsable: boolean | null;
  documentQuarantineLiftedAt: string | null;
  /** "Bestätigung der Agentur am" (the route `kug_200b`). */
  confirmedOn: string | null;
};

export type AsuState = {
  channel: AsuChannel | null;
  version: number;
  registration: AsuRegistrationRow | null;
  /** `asuRegisteredWithProof`, while the registration has a usable proof. */
  fact: DatedFact | null;
};

/** The registration as the domain's fact reads it. */
export function registrationFacts(row: AsuRegistrationRow): AsuRegistrationFacts {
  return {
    registeredOn: row.registeredOn,
    recordedAt: row.recordedAt,
    proof:
      row.proofKind === null
        ? null
        : {
            kind: row.proofKind,
            linkedAt: row.proofLinkedAt!,
            ...(row.supportingDocumentId !== null && {
              document: {
                usable: row.documentUsable === true,
                quarantineLiftedAt: row.documentQuarantineLiftedAt,
              },
            }),
          },
  };
}

/**
 * `asuRegisteredWithProof` (process-and-lifecycle.md, guards): valid on the actual registration
 * date, recorded at `asuRegisteredSince`; none without a usable proof.
 */
function factOf(registration: AsuRegistrationRow): DatedFact | null {
  const since = asuRegisteredSince(registrationFacts(registration));
  return since === null
    ? null
    : { validOn: registration.registeredOn, recordedAt: new Date(since) };
}

/** Each participation's ASU state; a participation without a route or registration has the empty one. */
export async function asuStatesOf(
  db: Db,
  participationIds: readonly string[],
): Promise<Map<string, AsuState>> {
  const states = new Map<string, AsuState>(
    participationIds.map((id) => [
      id,
      { channel: null, version: 0, registration: null, fact: null },
    ]),
  );
  if (participationIds.length === 0) return states;
  const routes = await db
    .select({
      participationId: asuRecord.participationId,
      channel: asuRecord.channel,
      version: asuRecord.version,
    })
    .from(asuRecord)
    .where(inArray(asuRecord.participationId, [...participationIds]));
  const registrations = await db
    .select({
      participationId: asuRegistration.participationId,
      id: asuRegistration.id,
      channel: asuRegistration.channel,
      registeredOn: asuRegistration.registeredOn,
      recordedAt: utc(asuRegistration.recordedAt),
      proofKind: asuRegistration.proofKind,
      attestationSource: asuRegistration.attestationSource,
      proofDocumentId: asuRegistration.proofDocumentId,
      proofLinkedAt: sql<string | null>`case when ${asuRegistration.proofLinkedAt} is not null
        then ${utc(asuRegistration.proofLinkedAt)} end`,
      supportingDocumentId: document.id,
      documentUsable: sql<boolean | null>`${document.reviewState} = 'accepted'
        and ${document.deletedAt} is null and ${document.quarantinedAt} is null
        and ${document.invalidatedByCorrection} is null`,
      documentQuarantineLiftedAt: sql<string | null>`case when ${document.quarantineLiftedAt}
        is not null then ${utc(document.quarantineLiftedAt)} end`,
      confirmedOn: asuRegistration.confirmedOn,
    })
    .from(asuRegistration)
    .leftJoin(agenturSubmission, eq(agenturSubmission.id, asuRegistration.agenturSubmissionId))
    // A batch's registration rests on the submitted scan (process-and-lifecycle.md, Kug 200b
    // batches): while it is unusable the registration stays, but supplies no fact.
    .leftJoin(
      document,
      eq(
        document.id,
        sql`coalesce(${asuRegistration.proofDocumentId}, ${agenturSubmission.documentId})`,
      ),
    )
    .where(inArray(asuRegistration.participationId, [...participationIds]));
  for (const { participationId, ...route } of routes) {
    states.set(participationId, { ...states.get(participationId)!, ...route });
  }
  for (const { participationId, ...registration } of registrations) {
    states.set(participationId, {
      ...states.get(participationId)!,
      registration,
      fact: factOf(registration),
    });
  }
  return states;
}
