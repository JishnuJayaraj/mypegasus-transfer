import type { Clock } from "@transfer/adapters";
import {
  and,
  asc,
  baReportingTask,
  consentRecord,
  desc,
  eq,
  inArray,
  isNull,
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
  mayGenerateKug200bBulk,
  mayListField,
  mayPerformOperation,
  mayReadBaReportingTasks,
  mayWorkDsv,
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
  evidenceInvalidatedSince,
  type ApprovedInvalidation,
  type DocumentType,
  type RecoveryFacts,
  type DsvSupport,
} from "@transfer/domain";
import { projectAccess, projectTarget } from "../access";
import { itemBookingsOf, itemNoticesOf } from "../appointments/items";
import type { FormRegistry } from "../forms/registry";
import type { Release } from "../projects/template-pins";
import { asuStatesOf, type AsuState } from "./asu";
import type { GuardFactsProvider } from "./guard-facts";
import { kug200bStatesOf } from "./kug200b";
import { attemptsOf, submissionSettingsOf } from "./tl407-submissions";
import { consultantsOf, listStatesOf } from "./list-states";
import { loadSelfServiceRecords } from "./self-service";
import { exceptionOf } from "./status-service";
import { reconciliationClarificationsOf } from "./reconciliation";
import { utc } from "../sql";

// The work list snapshot (data-protection.md, the work list and the dashboard): the viewer's
// whole authorized scope of a project, evaluated once per request in one read-only snapshot of
// the database, so no row is computed against another state than its neighbours.

export type WorklistDeps = {
  db: Database;
  clock: Clock;
  release: Release;
  facts: GuardFactsProvider;
  registry: FormRegistry;
};

export type WorklistResult =
  | { kind: "not_found" | "forbidden" | "too_large" }
  | {
      kind: "ok";
      scope: "project" | "assigned";
      generatedAt: string;
      project: WorklistProject;
      /** `mayWorkDsv` in a `ta_tg` project: the DSV case items and tile are the viewer's. */
      worksDsv: boolean;
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
  { db, clock, release, facts, registry }: WorklistDeps,
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
            isNull(participation.evidenceSetSince),
            isNull(participation.erasurePendingAt),
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
      // The Kug 200b offer's items (process-and-lifecycle.md, the Kug 200b offer).
      const [asuStates, offers] = [await asuStatesOf(tx, ids), await kug200bStatesOf(tx, ids)];
      // The TL 407's attempts and, for the deadline, the lead time of the placement Agenturen of
      // the open participations it applies to (D27); no other Agentur's settings are looked up.
      const attempts = await attemptsOf(tx, ids);
      // Pending BA reports (D28), only of the participations whose tasks the viewer reads.
      const pendingReports = await pendingReportsOf(
        tx,
        ids.filter((id) => mayReadBaReportingTasks(subject, projectId, id)),
      );
      // "Nachweis ungültig" (data-protection.md, evidence corrections).
      const invalidated = await invalidationsOf(tx, ids);
      const leadTimes = await submissionSettingsOf(
        tx,
        release,
        registry,
        projectId,
        found!.type === "ta_tg"
          ? rows.flatMap(({ p }) =>
              (p.status === "informed" || p.status === "active_in_tg") &&
              p.placementAgenturKey !== null
                ? [p.placementAgenturKey]
                : [],
            )
          : [],
        today,
      );
      const generatesKug200b = mayGenerateKug200bBulk(subject, {
        projectId,
        regionId,
        participationId: null,
      }).ok;
      // The DSV: the PL and back office only (the packet is the employment contract's).
      const worksDsv =
        found!.type === "ta_tg" &&
        mayWorkDsv(subject, { projectId, regionId, participationId: null }).ok;
      const dsvFacts = worksDsv ? await dsvStatesOf(tx, ids) : new Map<string, DsvListFacts>();
      // "Rückfrage zum Eintritt" (process-and-lifecycle.md, the reconciliation): until resolved.
      const clarifications = worksDsv
        ? await reconciliationClarificationsOf(tx, ids)
        : new Map<string, string>();
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
              dsv: {
                ...(dsvFacts.get(p.id) ?? {
                  signedOn: null,
                  fullyExecuted: false,
                  unresolvedClarificationOpenedOn: null,
                  customerNotice: { withdrawnOn: null, notifiedOn: null },
                }),
                reconciliationClarificationSince: clarifications.get(p.id) ?? null,
              },
              kug200b: {
                channel: asuStates.get(p.id)!.channel,
                offeredOn: offers.get(p.id)!.offeredOn,
                signed: offers.get(p.id)!.signed,
                declinedOn: offers.get(p.id)!.declinedOn,
                withdrawals: offers.get(p.id)!.withdrawals,
              },
              evidenceInvalidatedSince: invalidatedSince(
                invalidated.get(p.id),
                asuStates.get(p.id)!,
              ),
              agentur: {
                attempts: attempts.get(p.id)!,
                leadTimeDays:
                  p.placementAgenturKey === null
                    ? null
                    : (leadTimes.get(p.placementAgenturKey)?.leadTimeDays ?? null),
                kug200bRegistration: kug200bRegistrationOf(asuStates.get(p.id)!),
                baReportPendingSince: pendingReports.get(p.id) ?? null,
              },
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
              generatesKug200b,
              worksDsv,
            },
          ),
        );
      }
      return {
        kind: "ok" as const,
        scope: scope.kind === "all" ? ("project" as const) : ("assigned" as const),
        generatedAt: now.toISOString(),
        project: worklistProject,
        worksDsv,
        items,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

type DsvListFacts = {
  signedOn: string | null;
  fullyExecuted: boolean;
  unresolvedClarificationOpenedOn: string | null;
  customerNotice: { withdrawnOn: string | null; notifiedOn: string | null };
};

/**
 * The signed DSV's work list facts: the participant's signature day (the contract's, set once
 * at signing, else the counting scan's), whether a counting complete packet exists now, and the
 * withdrawal day and customer notice of a cancellation-based withdrawal. Read in
 * the work list's snapshot, so the item, the filter and the tile count the same participations.
 */
async function dsvStatesOf(db: Pick<Database, "execute">, ids: readonly string[]) {
  const result = new Map<string, DsvListFacts>();
  if (ids.length === 0) return result;
  const list = sql.param([...ids]);
  const { rows } = await db.execute<{
    participation_id: string;
    signed_on: string | null;
    fully_executed: boolean;
    unresolved_opened_on: string | null;
    withdrawn_on: string | null;
    notified_on: string | null;
  }>(sql`
    with f as (select * from dsv_facts(${list}::uuid[])),
    agg as (select participation_id, min(signed_on) as signed_on,
        bool_or(executed_on is not null) as executed from f group by participation_id)
    select p.id as participation_id,
      coalesce(c.participant_signed_on, a.signed_on)::text as signed_on,
      coalesce(a.executed, false) as fully_executed,
      u.opened_on::text as unresolved_opened_on,
      p.withdrawn_on::text as withdrawn_on, n.notified_on::text as notified_on
    from participation p
    left join lateral (select participant_signed_on from dsv_contract
      where participation_id = p.id order by created_at desc limit 1) c on true
    left join agg a on a.participation_id = p.id
    left join entry_clarification u on u.participation_id = p.id and u.stage <> 'instructed'
    left join dsv_customer_notice n on n.participation_id = p.id
    where p.id = any(${list}::uuid[])
      and (p.dsv_status = 'dsv_signed' or u.id is not null)`);
  for (const row of rows) {
    result.set(row.participation_id, {
      signedOn: row.signed_on,
      fullyExecuted: row.fully_executed,
      unresolvedClarificationOpenedOn: row.unresolved_opened_on,
      // "Kunde informieren" (process-and-lifecycle.md, the customer notice): the domain decides.
      customerNotice: { withdrawnOn: row.withdrawn_on, notifiedOn: row.notified_on },
    });
  }
  return result;
}

/** A batch's ASU registration (the Kug 200b's submission is its proof) and its confirmation. */
function kug200bRegistrationOf(state: AsuState) {
  const registration = state.registration;
  return registration?.proofKind === "kug200b_submission"
    ? { registeredOn: registration.registeredOn, confirmedOn: registration.confirmedOn }
    : null;
}

/**
 * Per participation the approved invalidations and the replacement evidence it has now
 * (data-protection.md, evidence corrections; Q209 (7) as amended): which fact each invalidated
 * piece supported (a registration's proof), the valid documents with their acceptance and TL 407
 * signature dates, the retained dates, and whether the open exception request still rests on
 * evidence that doesn't count. The ASU fact comes from the caller's `asuStatesOf`.
 */
async function invalidationsOf(db: Pick<Database, "execute">, ids: readonly string[]) {
  const result = new Map<
    string,
    { invalidations: ApprovedInvalidation[]; facts: Omit<RecoveryFacts, "asu"> }
  >();
  if (ids.length === 0) return result;
  const list = sql.param([...ids]);
  const { rows: corrections } = await db.execute<{
    participation_id: string;
    decided_at: string;
    decided_on: string;
    target_kind: "document" | "asu_registration" | "field" | "dsv_signature";
    field_key: string | null;
    document_type: DocumentType | null;
    signed: boolean | null;
    supported_registration: boolean;
    dsv: DsvSupport | null;
  }>(sql`
    select c.participation_id,
      to_char(c.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as decided_at,
      to_char(c.decided_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as decided_on,
      c.target_kind, c.field_key, d.type as document_type, pol.signed,
      exists (select from asu_registration g
          left join agentur_submission s on s.id = g.agentur_submission_id
        where g.participation_id = c.participation_id
          and d.id in (g.proof_document_id, s.document_id)) as supported_registration,
      -- A DSV scan supported its offer's signatures with their actual dates (D8).
      case when d.type = 'dsv_signed_scan' then jsonb_build_object('offerId', d.dsv_offer_id,
        'signatures', coalesce((select jsonb_object_agg(x.kind, x.signed_on::text)
          from dsv_scan_signature x where x.document_id = d.id and x.superseded_by is null), '{}'::jsonb)) end as dsv
    from evidence_correction c
    left join document d on d.id = c.document_id
    left join document_type_policy pol
      on pol.type = d.type and pol.catalog_version = d.catalog_version
    where c.participation_id = any(${list}::uuid[])
      and c.status = 'approved' and (c.action = 'invalidate'
        -- A date correction may leave an entry already recorded unsupported (data-protection.md,
        -- evidence corrections: field targets and the signature supersession).
        or (c.target_kind = 'field' and c.field_key = 'profilingDoneOn')
        or (c.target_kind = 'dsv_signature' and c.signature_paper = 'dsv_signed_scan'))
    order by c.decided_at`);
  const withInvalidations = [...new Set(corrections.map((c) => c.participation_id))];
  if (withInvalidations.length === 0) return result;
  const scoped = sql.param(withInvalidations);
  const { rows: participations } = await db.execute<{
    id: string;
    tg_entry_date: string | null;
    profiling_done_on: string | null;
    exception_unsupported: boolean;
    exception_approved: boolean;
    fully_executed_on: string | null;
  }>(sql`
    select p.id, p.tg_entry_date::text, p.profiling_done_on::text,
      coalesce(r.status::text in ('requested', 'approved')
        and not exception_evidence_usable(r.evidence_record_id), false) as exception_unsupported,
      coalesce(r.status::text = 'approved', false) as exception_approved,
      (select min(f.executed_on)::text from dsv_facts(array[p.id]) f
        where f.executed_on is not null) as fully_executed_on
    from participation p
    left join profiling_exception_request r on r.id = p.profiling_exception_request_id
    where p.id = any(${scoped}::uuid[])`);
  const { rows: documents } = await db.execute<{
    participation_id: string;
    type: DocumentType;
    accepted_at: string;
    signed_on: string | null;
    dsv: DsvSupport | null;
  }>(sql`
    select participation_id, type,
      to_char(reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as accepted_at,
      greatest(signed_on, countersigned_on)::text as signed_on,
      case when type = 'dsv_signed_scan' then jsonb_build_object('offerId', dsv_offer_id,
        'signatures', coalesce((select jsonb_object_agg(x.kind, x.signed_on::text)
          from dsv_scan_signature x where x.document_id = document.id and x.superseded_by is null), '{}'::jsonb)) end as dsv
    from document
    where participation_id = any(${scoped}::uuid[]) and deleted_at is null
      and review_state = 'accepted' and quarantined_at is null
      and invalidated_by_correction is null
      -- A DSV scan counts only as dsv_facts says (an open or signed offer, the receipt recorded).
      and (type <> 'dsv_signed_scan' or id in (select f.document_id from dsv_facts(${scoped}::uuid[]) f))`);
  for (const p of participations) {
    result.set(p.id, {
      invalidations: [],
      facts: {
        tgEntryDate: p.tg_entry_date,
        profilingDoneOn: p.profiling_done_on,
        exceptionUnsupported: p.exception_unsupported,
        profilingExceptionApproved: p.exception_approved,
        fullyExecutedOn: p.fully_executed_on,
        documents: documents
          .filter((d) => d.participation_id === p.id)
          .map((d) => ({
            type: d.type,
            acceptedAt: d.accepted_at,
            signedOn: d.signed_on,
            ...(d.dsv && { dsv: d.dsv }),
          })),
      },
    });
  }
  for (const c of corrections) {
    result.get(c.participation_id)!.invalidations.push({
      decidedAt: c.decided_at,
      decidedOn: c.decided_on,
      target:
        c.target_kind === "field" || c.target_kind === "dsv_signature"
          ? {
              kind: "date_correction",
              subject: c.target_kind === "field" ? "profilingDoneOn" : "dsvSignature",
            }
          : c.target_kind === "asu_registration"
            ? { kind: "asu_registration" }
            : {
                kind: "document",
                documentType: c.document_type!,
                signed: c.signed === true,
                supportedRegistration: c.supported_registration,
                ...(c.dsv && { dsv: c.dsv }),
              },
    });
  }
  return result;
}

/** "Nachweis ungültig" since, with the current ASU fact; null without an open invalidation. */
function invalidatedSince(
  entry: { invalidations: ApprovedInvalidation[]; facts: Omit<RecoveryFacts, "asu"> } | undefined,
  asu: AsuState,
) {
  if (!entry) return null;
  const fact = asu.fact
    ? { validOn: asu.fact.validOn, recordedAt: asu.fact.recordedAt.toISOString() }
    : null;
  return evidenceInvalidatedSince(entry.invalidations, { ...entry.facts, asu: fact });
}

/** Per participation the Berlin day its oldest pending BA reporting task was created. */
async function pendingReportsOf(db: Pick<Database, "select">, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({
      participationId: baReportingTask.participationId,
      since: sql<string>`to_char(min(${baReportingTask.createdAt}) at time zone 'Europe/Berlin', 'YYYY-MM-DD')`,
    })
    .from(baReportingTask)
    .where(
      and(
        inArray(baReportingTask.participationId, [...ids]),
        eq(baReportingTask.status, "pending"),
      ),
    )
    .groupBy(baReportingTask.participationId);
  return new Map(rows.map((row) => [row.participationId, row.since]));
}

/** A provider's facts one participation after another, in one transaction. */
export async function eachOf(
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
