import { resolveForParticipation } from "@transfer/config";
import {
  agenturSubmission,
  and,
  asuRecord,
  asuRegistration,
  desc,
  document,
  eq,
  kug200bBatch,
  kug200bBatchMember,
  participantIdentity,
  participation,
  sql,
  type Database,
} from "@transfer/db";
import {
  batchEligibility,
  batchRecheck,
  batchSettings,
  type BatchMemberFacts,
  type IsoDate,
  type Kug200bArtifactView,
  type Kug200bBatchesView,
} from "@transfer/domain";
import type { FormRegistry } from "../forms/registry";
import { projectSnapshot, type Release } from "../projects/template-pins";
import { utc } from "../sql";
import { closedStatuses } from "../routes/profiling";

// Kug 200b batches as the API reads them (process-and-lifecycle.md, Kug 200b batches;
// regional-variation.md, the accepted alternative; D25, Q203): a project's participations and
// accepted Kug 200b scans as the domain's facts, an Agentur's batch settings as resolved from the
// project's layers, and the tab "Agentur" built from both. The database functions check the same
// rules again under the project's exclusive lock. Reads run one after another on the caller's
// connection (ADR-0002, queries on one connection).

type Db = Pick<Database, "select" | "selectDistinctOn" | "execute">;

/** An Agentur's batch settings now: the channel (null: the step blocker), the artifact and the versions it rejects. */
export type AgenturBatchSettings = {
  channel: ReturnType<typeof batchSettings>["channel"];
  artifact: Kug200bArtifactView;
  /** The Kug 200b versions not in use today, where the Agentur rejects outdated forms (D26). */
  outdatedVersions: string[];
};

/**
 * The batch settings of one placement Agentur (regional-variation.md, the accepted alternative):
 * resolved from the project's snapshot as read in `db`. A writer calls it after taking the project's
 * exclusive lock (`lock_project_setup`), which every configuration write takes, so the values it
 * passes to a batch function are the ones in force at its commit.
 */
export async function agenturBatchSettings(
  db: Db,
  release: Release,
  registry: FormRegistry,
  projectId: string,
  agenturKey: string,
  today: IsoDate,
): Promise<AgenturBatchSettings> {
  const snapshot = (await projectSnapshot(db, release, projectId))!;
  return settingsOf(snapshot, registry, agenturKey, today);
}

function settingsOf(
  snapshot: NonNullable<Awaited<ReturnType<typeof projectSnapshot>>>,
  registry: FormRegistry,
  agenturKey: string,
  today: IsoDate,
): AgenturBatchSettings {
  const { config, provenance } = resolveForParticipation({
    ...snapshot.input,
    placementAgenturKey: agenturKey,
  });
  const resolved = batchSettings(
    config.settings,
    provenance["settings.asu_registration.kug200aAlternativeAccepted"],
  );
  const rejects = config.settings.agentur_submission?.rejectsOutdatedFormVersions === true;
  return {
    ...resolved,
    outdatedVersions: rejects
      ? registry.versions("kug200b").filter((v) => !registry.versionInUse("kug200b", v, today))
      : [],
  };
}

/** Arguments of a batch function from the settings. */
export const settingsArgs = (settings: AgenturBatchSettings) => ({
  channel: settings.channel,
  artifact: settings.artifact.kind,
  outdatedVersions: `{${settings.outdatedVersions.join(",")}}`,
});

type ScanRow = {
  documentId: string;
  participationId: string;
  usable: boolean;
  formVersion: string | null;
};

/** The facts of every participation of the project and of its Kug 200b scans. */
async function factsOf(db: Db, projectId: string) {
  const people = await db
    .select({
      id: participation.id,
      status: participation.status,
      placementAgenturKey: participation.placementAgenturKey,
      asuChannel: asuRecord.channel,
      asuRegistered: sql<boolean>`exists (select from ${asuRegistration}
        where ${asuRegistration.participationId} = ${participation.id})`,
      inOpenBatch: sql<boolean>`exists (select from ${kug200bBatchMember}
        join ${kug200bBatch} on ${kug200bBatch.id} = ${kug200bBatchMember.batchId}
          and ${kug200bBatch.status} = 'open'
        where ${kug200bBatchMember.participationId} = ${participation.id}
          and ${kug200bBatchMember.active})`,
      submitted: sql<boolean>`exists (select from ${agenturSubmission}
        where ${agenturSubmission.participationId} = ${participation.id}
          and ${agenturSubmission.formCode} = 'kug200b')`,
      lastName: participantIdentity.lastName,
      firstName: participantIdentity.firstName,
    })
    .from(participation)
    .leftJoin(asuRecord, eq(asuRecord.participationId, participation.id))
    .leftJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
    .where(eq(participation.projectId, projectId));
  // Every signed Kug 200b scan, newest accepted first: a member's may have become unusable.
  const scans: ScanRow[] = await db
    .select({
      documentId: document.id,
      participationId: document.participationId,
      usable: sql<boolean>`${document.reviewState} = 'accepted' and ${document.deletedAt} is null
        and ${document.quarantinedAt} is null and ${document.invalidatedByCorrection} is null
        and ${document.formVersion} is not null`,
      formVersion: document.formVersion,
    })
    .from(document)
    .where(and(eq(document.projectId, projectId), eq(document.type, "kug200b_signed_scan")))
    .orderBy(desc(document.signedOn), desc(document.reviewedAt), desc(document.id));
  const byId = new Map(people.map((p) => [p.id, p]));
  const scanById = new Map(scans.map((s) => [s.documentId, s]));
  const facts = (participationId: string, documentId: string): BatchMemberFacts | undefined => {
    const person = byId.get(participationId);
    const scan = scanById.get(documentId);
    if (!person || !scan || scan.participationId !== participationId) return undefined;
    return {
      scanUsable: scan.usable,
      closed: closedStatuses.has(person.status),
      placementAgenturKey: person.placementAgenturKey,
      asuChannel: person.asuChannel,
      asuRegistered: person.asuRegistered,
      formVersion: scan.formVersion,
      inOpenBatch: person.inOpenBatch,
      submitted: person.submitted,
    };
  };
  return { people: byId, scans, facts };
}

/** The tab's order: last name, then first name. */
const byName = (a: { lastName: string; firstName: string }, b: typeof a) =>
  a.lastName.localeCompare(b.lastName, "de") || a.firstName.localeCompare(b.firstName, "de");

/** A name as the tab lists it. */
const nameOf = (person: { lastName: string | null; firstName: string | null } | undefined) => ({
  lastName: person?.lastName ?? "",
  firstName: person?.firstName ?? "",
});

/**
 * The tab "Agentur" for the PL (ADR-0010; process-and-lifecycle.md, Kug 200b batches): per
 * placement Agentur of the project's open participations or batches its settings and ready scans
 * (one per participation: the newest usable one), and the batches newest first, an open batch with
 * its recheck as read now. Read in one snapshot by the caller.
 */
export async function batchesView(
  db: Db,
  release: Release,
  registry: FormRegistry,
  projectId: string,
  today: IsoDate,
): Promise<Kug200bBatchesView> {
  const snapshot = (await projectSnapshot(db, release, projectId))!;
  const { people, scans, facts } = await factsOf(db, projectId);
  const batches = await db
    .select({
      id: kug200bBatch.id,
      agenturKey: kug200bBatch.agenturKey,
      channel: kug200bBatch.channel,
      artifact: kug200bBatch.artifact,
      status: kug200bBatch.status,
      createdAt: utc(kug200bBatch.createdAt),
      createdOn: sql<string>`(${kug200bBatch.createdAt} at time zone 'Europe/Berlin')::date::text`,
      submittedOn: kug200bBatch.submittedOn,
      submittedAt: sql<string | null>`case when ${kug200bBatch.submittedAt} is not null
        then ${utc(kug200bBatch.submittedAt)} end`,
      discardedAt: sql<string | null>`case when ${kug200bBatch.discardedAt} is not null
        then ${utc(kug200bBatch.discardedAt)} end`,
    })
    .from(kug200bBatch)
    .where(eq(kug200bBatch.projectId, projectId))
    .orderBy(desc(kug200bBatch.createdAt), desc(kug200bBatch.id));
  const members = await db
    .select({
      batchId: kug200bBatchMember.batchId,
      participationId: kug200bBatchMember.participationId,
      documentId: kug200bBatchMember.documentId,
      formVersion: kug200bBatchMember.formVersion,
      asuChannel: kug200bBatchMember.asuChannel,
    })
    .from(kug200bBatchMember)
    .where(eq(kug200bBatchMember.projectId, projectId));

  const keys = new Set<string>(batches.map((b) => b.agenturKey));
  for (const person of people.values()) {
    if (person.placementAgenturKey !== null && !closedStatuses.has(person.status)) {
      keys.add(person.placementAgenturKey);
    }
  }
  const settings = new Map(
    [...keys].map((key) => [key, settingsOf(snapshot, registry, key, today)]),
  );

  // Each open participation's newest usable scan, if it may join a batch of its Agentur now
  // (`ready`), or would but for the ASU route (`routeMissing`). A closed participation is never a
  // candidate, so its Agentur, which may have no settings read, is never looked up.
  const ready = new Map<string, ScanRow>();
  const routeMissing = new Map<string, ScanRow>();
  for (const scan of scans) {
    if (!scan.usable || ready.has(scan.participationId)) continue;
    if (routeMissing.has(scan.participationId)) continue;
    const person = people.get(scan.participationId)!;
    if (person.placementAgenturKey === null || closedStatuses.has(person.status)) continue;
    const fact = facts(scan.participationId, scan.documentId)!;
    const scope = {
      agenturKey: person.placementAgenturKey,
      outdatedVersions: settings.get(person.placementAgenturKey)!.outdatedVersions,
    };
    const problem = batchEligibility(fact, scope);
    if (problem === null) ready.set(scan.participationId, scan);
    if (problem === "asu_route_unset") routeMissing.set(scan.participationId, scan);
  }
  // Usable scans no batch takes for want of a placement Agentur, once per participation.
  const withoutPlacementAgentur = new Set(
    scans
      .filter((s) => s.usable && people.get(s.participationId)!.placementAgenturKey === null)
      .filter((s) => {
        const fact = facts(s.participationId, s.documentId)!;
        return !fact.closed && !fact.inOpenBatch && !fact.submitted;
      })
      .map((s) => s.participationId),
  ).size;

  const person = (scan: { participationId: string; documentId: string }, formVersion: string) => ({
    participationId: scan.participationId,
    documentId: scan.documentId,
    ...nameOf(people.get(scan.participationId)),
    formVersion,
    asuChannel: people.get(scan.participationId)?.asuChannel ?? null,
  });

  return {
    withoutPlacementAgentur,
    agenturen: [...keys].toSorted().map((agenturKey) => {
      const own = settings.get(agenturKey)!;
      const candidates = [...ready.values()]
        .filter((scan) => people.get(scan.participationId)!.placementAgenturKey === agenturKey)
        .map((scan) => person(scan, scan.formVersion!))
        .toSorted(byName);
      const unrouted = [...routeMissing.values()]
        .filter((scan) => people.get(scan.participationId)!.placementAgenturKey === agenturKey)
        .map((scan) => ({
          participationId: scan.participationId,
          ...nameOf(people.get(scan.participationId)),
        }))
        .toSorted(byName);
      return {
        agenturKey,
        channel: own.channel,
        artifact: own.artifact,
        candidates,
        routeMissing: unrouted,
        capabilities: { createBatch: own.channel !== null && candidates.length > 0 },
      };
    }),
    batches: batches.map((batch) => {
      const own = members.filter((m) => m.batchId === batch.id);
      const open = batch.status === "open";
      const current = settings.get(batch.agenturKey)!;
      const staleRows = open
        ? batchRecheck(
            { ...batch, members: own },
            new Map(
              own.flatMap((m) => {
                const fact = facts(m.participationId, m.documentId);
                return fact ? [[m.participationId, fact] as const] : [];
              }),
            ),
            { channel: current.channel, artifact: current.artifact.kind },
            current.outdatedVersions,
          )
        : [];
      return {
        ...batch,
        members: own
          .map((m) => ({
            ...person(m, m.formVersion),
            asuChannel: m.asuChannel,
          }))
          .toSorted(byName),
        staleRows,
        capabilities: {
          submit: open && staleRows.length === 0,
          discard: open,
          exportIndex: open && staleRows.length === 0,
        },
      };
    }),
  };
}
