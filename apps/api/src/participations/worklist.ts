import type { Clock } from "@transfer/adapters";
import {
  and,
  asc,
  consentRecord,
  desc,
  eq,
  inArray,
  participantChannel,
  participantDetails,
  participantIdentity,
  participantReminder,
  participation,
  profilingExceptionRequest,
  project,
  projectEntryWave,
  sql,
  type Database,
} from "@transfer/db";
import {
  applicableAsuDueDate,
  mayListField,
  mayPerformOperation,
  mayRemind,
  participationListScope,
  staffSelfServiceAccess,
  worklistMaxRows,
  worklistProjection,
  type EntryWave,
  type ReminderChannelFacts,
  type ReminderStatus,
  type StaffUser,
  type WorklistItem,
  type WorklistProject,
} from "@transfer/domain";
import { projectAccess, projectTarget } from "../access";
import { itemBookingsOf, itemNoticesOf } from "../appointments/items";
import type { Release } from "../projects/template-pins";
import type { GuardFactsProvider } from "./guard-facts";
import { consultantsOf, listStatesOf } from "./list-states";
import { loadSelfServiceRecords } from "./self-service";
import { exceptionOf } from "./status-service";
import { utc } from "../sql";

// The work list snapshot (data-protection.md, the work list and the dashboard): the viewer's
// whole authorized scope of a project, evaluated once per request in one read-only snapshot of
// the database, so no row is computed against another state than its neighbours.

export type WorklistDeps = {
  db: Database;
  clock: Clock;
  release: Release;
  facts: GuardFactsProvider;
};

export type WorklistResult =
  | { kind: "not_found" | "forbidden" | "too_large" }
  | {
      kind: "ok";
      scope: "project" | "assigned";
      generatedAt: string;
      project: WorklistProject;
      items: WorklistItem[];
    };

const waveColumns = {
  id: projectEntryWave.id,
  code: projectEntryWave.code,
  signingDeadline: projectEntryWave.signingDeadline,
  defaultTgStart: projectEntryWave.defaultTgStart,
  defaultTgEnd: projectEntryWave.defaultTgEnd,
  latestEntryDate: projectEntryWave.latestEntryDate,
};

/**
 * Visibility (404), then the list scope (403: an unassigned consultant, the org roles), then the
 * bound (`too_large` above `worklistMaxRows`). The scope follows the memberships and assignments
 * of this request.
 */
export async function loadWorklist(
  { db, clock, release, facts }: WorklistDeps,
  user: StaffUser,
  projectId: string,
): Promise<WorklistResult> {
  const { subject, visible, regionId } = await projectAccess(db, user, projectId);
  if (!visible) return { kind: "not_found" };
  const scope = participationListScope(subject, projectId);
  if (scope.kind === "none") return { kind: "forbidden" };
  const today = clock.today();
  const now = clock.now();
  return db.transaction(
    async (tx) => {
      const [found] = await tx
        .select({ type: project.type, status: project.status })
        .from(project)
        .where(eq(project.id, projectId));
      const waves: EntryWave[] = await tx
        .select(waveColumns)
        .from(projectEntryWave)
        .where(eq(projectEntryWave.projectId, projectId))
        .orderBy(asc(projectEntryWave.createdAt), asc(projectEntryWave.id));
      const rows = await tx
        .select({
          p: participation,
          receivedOn: sql<string>`to_char(${participation.createdAt} at time zone 'Europe/Berlin', 'YYYY-MM-DD')`,
          personnelNumber: participantIdentity.personnelNumber,
          lastName: participantIdentity.lastName,
          firstName: participantIdentity.firstName,
          // The ASU due date's inputs (process-and-lifecycle.md, dates)
          endDate: participantDetails.oldEmploymentEndDate,
          knowledgeDate: participantDetails.knowledgeDate,
        })
        .from(participation)
        .leftJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
        .leftJoin(participantDetails, eq(participantDetails.participationId, participation.id))
        .where(
          and(
            eq(participation.projectId, projectId),
            scope.kind === "assigned"
              ? inArray(participation.id, [...scope.participationIds])
              : undefined,
          ),
        )
        .orderBy(asc(participation.createdAt), asc(participation.id))
        .limit(worklistMaxRows + 1);
      if (rows.length > worklistMaxRows) return { kind: "too_large" as const };
      const ids = rows.map(({ p }) => p.id);
      const requestIds = rows.flatMap(({ p }) => p.profilingExceptionRequestId ?? []);
      // The appointment items' host rule is the PL's (as on the appointment page).
      const resolvesHosts = subject.projectRoles[projectId]?.has("project_lead") ?? false;
      const [consultants, states, records, channels, reminders, requests, bookings, notices] = [
        await consultantsOf(tx, ids),
        await listStatesOf(tx, clock, ids, new Map(rows.map((r) => [r.p.id, r.receivedOn]))),
        await loadSelfServiceRecords(tx, release, projectId, ids),
        await channelsOf(tx, ids),
        await lastRemindersOf(tx, ids),
        requestIds.length
          ? await tx
              .select()
              .from(profilingExceptionRequest)
              .where(inArray(profilingExceptionRequest.id, requestIds))
          : [],
        await itemBookingsOf(tx, projectId, ids, resolvesHosts),
        await itemNoticesOf(tx, ids),
      ];
      // Every participation's dated facts in one read where the provider can (the TL 407's).
      const inputs = rows.map(({ p }) => ({
        participationId: p.id,
        currentRequest: exceptionOf(requests.find((r) => r.id === p.profilingExceptionRequestId)),
      }));
      const guardFacts = new Map(
        (facts.many ? await facts.many(tx, inputs) : await eachOf(tx, facts, inputs)).map(
          (each, index) => [inputs[index]!.participationId, each],
        ),
      );
      const worklistProject: WorklistProject = { id: projectId, type: found!.type, waves };
      const items: WorklistItem[] = [];
      for (const { p, endDate, knowledgeDate, ...person } of rows) {
        const record = records.get(p.id)!;
        const dated = guardFacts.get(p.id)!;
        const wave = waves.find((w) => w.id === p.entryWaveId) ?? null;
        const target = projectTarget(projectId, regionId, p.id);
        const { knows } = staffSelfServiceAccess(subject, {
          projectId,
          regionId,
          participationId: p.id,
        });
        items.push(
          worklistProjection(
            {
              id: p.id,
              entryWaveId: p.entryWaveId,
              placementAgenturKey: p.placementAgenturKey,
              person,
              consultants: consultants.get(p.id) ?? [],
              ...states.get(p.id)!,
              completeness: {
                projectType: record.wizard.projectType,
                rules: record.wizard.rules,
                fields: record.wizard.fields,
                documents: record.wizard.documents,
                customFieldKeys: Object.keys(record.wizard.customFields),
              },
              channels: channels.get(p.id) ?? [],
              lastReminder: reminders.get(p.id) ?? null,
              asuDueDate: applicableAsuDueDate({
                projectType: found!.type,
                status: p.status,
                registered: dated.asuRegisteredWithProof !== undefined,
                endDate,
                knowledgeDate,
              }),
              appointments: {
                bookings: bookings.get(p.id) ?? [],
                notices: notices.get(p.id) ?? [],
                // The terminal change cancels the bookings of appointments that hadn't started,
                // so a closed participation's live bookings all started before its close.
                closedAt: null,
              },
            },
            {
              current: {
                status: p.status,
                profilingStatus: p.profilingStatus,
                dsvStatus: p.dsvStatus,
              },
              wave,
              participation: {
                tgStart: p.tgStart,
                tgEnd: p.tgEnd,
                offerDeadline: p.offerDeadline,
                tgEntryDate: p.tgEntryDate,
              },
              facts: dated,
            },
            worklistProject,
            today,
            now,
            {
              staffUserId: user.id,
              lists: (field) => mayListField(subject, projectId, p.id, field),
              knows,
              may: (kind) => mayPerformOperation(subject, { kind }, target).ok,
              remind: found!.status === "active" && mayRemind(subject, target).ok,
            },
          ),
        );
      }
      return {
        kind: "ok" as const,
        scope: scope.kind === "all" ? ("project" as const) : ("assigned" as const),
        generatedAt: now.toISOString(),
        project: worklistProject,
        items,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** A provider's facts one participation after another, in one transaction. */
async function eachOf(
  tx: Parameters<GuardFactsProvider["facts"]>[0],
  facts: GuardFactsProvider,
  inputs: readonly Parameters<GuardFactsProvider["facts"]>[1][],
) {
  const all = [];
  for (const input of inputs) all.push(await facts.facts(tx, input));
  return all;
}

/** Each participation's channels: kind, verification, liveness and consent, never an address. */
async function channelsOf(db: Pick<Database, "select">, ids: readonly string[]) {
  const byParticipation = new Map<string, ReminderChannelFacts[]>();
  if (ids.length === 0) return byParticipation;
  const rows = await db
    .select({
      participationId: participantChannel.participationId,
      id: participantChannel.id,
      kind: participantChannel.kind,
      verifiedAt: utc(participantChannel.verifiedAt),
      live: sql<boolean>`${participantChannel.removedAt} is null and ${participantChannel.suspendedAt} is null`,
      consentVersion: consentRecord.textVersion,
      consentEnded: sql<boolean>`${consentRecord.endedAt} is not null`,
    })
    .from(participantChannel)
    .innerJoin(consentRecord, eq(consentRecord.id, participantChannel.consentId))
    .where(inArray(participantChannel.participationId, [...ids]));
  for (const { participationId, ...channel } of rows) {
    byParticipation.set(participationId, [
      ...(byParticipation.get(participationId) ?? []),
      channel,
    ]);
  }
  return byParticipation;
}

/**
 * Each participation's latest reminder (`open_items`): its Berlin request date and status;
 * invitations and notices neither use nor consume the window (data-protection.md, messages).
 */
async function lastRemindersOf(db: Pick<Database, "selectDistinctOn">, ids: readonly string[]) {
  const byParticipation = new Map<string, { requestedOn: string; status: ReminderStatus }>();
  if (ids.length === 0) return byParticipation;
  const rows = await db
    .selectDistinctOn([participantReminder.participationId], {
      participationId: participantReminder.participationId,
      requestedOn: participantReminder.requestedOn,
      status: participantReminder.status,
    })
    .from(participantReminder)
    .where(
      and(
        inArray(participantReminder.participationId, [...ids]),
        eq(participantReminder.kind, "open_items"),
      ),
    )
    .orderBy(
      participantReminder.participationId,
      desc(participantReminder.requestedAt),
      desc(participantReminder.id),
    );
  for (const { participationId, ...reminder } of rows)
    byParticipation.set(participationId, reminder);
  return byParticipation;
}
