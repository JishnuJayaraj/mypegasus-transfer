import type { Clock } from "@transfer/adapters";
import {
  eq,
  participation,
  profilingExceptionRequest,
  project,
  projectEntryWave,
  sql,
  type Database,
} from "@transfer/db";
import {
  entryClarificationActions,
  entryClarificationOpenedOn,
  mayPerformOperation,
  maySeeReview,
  mayWorkDsv,
  type EntryClarificationRecord,
  type EntryClarificationReviewItem,
  type EntryClarificationState,
  type StaffUser,
  type Subject,
} from "@transfer/domain";
import { projectAccess } from "../access";
import { lifecycleRunCompleted, exceptionOf } from "./status-service";
import type { GuardFactsProvider } from "./guard-facts";

// The entry clarification of a signed DSV that has not entered (process-and-lifecycle.md, the entry
// clarification): the state the PL reads and the escalated cases "Freigaben" lists. Reads only; the
// writes are `record_entry_clarification`, `escalate_entry_clarification` and
// `record_clarification_instruction`. The documented sources are `case_internal`: the PL who wrote
// one and the manager who instructs read it, nobody else, and no log or history carries it.

export type ClarificationDeps = { db: Database; clock: Clock; facts: GuardFactsProvider };

export type ClarificationResult =
  | { kind: "not_found" | "forbidden" }
  | { kind: "ok"; state: EntryClarificationState };

type Row = {
  id: string;
  opened_on: string;
  pending_code: string | null;
  pending_source: string | null;
  pending_on: string | null;
  escalated_on: string | null;
  instruction_code: string | null;
  instruction_source: string | null;
  instruction_on: string | null;
};

/**
 * One participation's clarification state in one snapshot: undefined-visibility is a 404, no DSV
 * permission a 403 (a consultant is not told it exists). The recorded row is the one of the
 * current planned start; the actions follow `entryClarificationActions`.
 */
export async function loadClarification(
  { db, clock, facts }: ClarificationDeps,
  user: StaffUser,
  participationId: string,
): Promise<ClarificationResult> {
  const [found] = await db
    .select({ projectId: participation.projectId })
    .from(participation)
    .where(eq(participation.id, participationId));
  if (!found) return { kind: "not_found" };
  const { subject, visible, regionId } = await projectAccess(db, user, found.projectId);
  if (!visible) return { kind: "not_found" };
  const target = { projectId: found.projectId, regionId, participationId };
  const allowed = mayWorkDsv(subject, target);
  if (!allowed.ok) return { kind: allowed.because === "not_assigned" ? "not_found" : "forbidden" };
  const today = clock.today();
  return db.transaction(
    async (tx) => {
      const [p] = await tx
        .select({
          p: participation,
          type: project.type,
          wave: projectEntryWave,
          request: profilingExceptionRequest,
        })
        .from(participation)
        .innerJoin(project, eq(project.id, participation.projectId))
        .leftJoin(projectEntryWave, eq(projectEntryWave.id, participation.entryWaveId))
        .leftJoin(
          profilingExceptionRequest,
          eq(profilingExceptionRequest.id, participation.profilingExceptionRequestId),
        )
        .where(eq(participation.id, participationId));
      const row = p!;
      const tgStart = row.p.tgStart ?? row.wave?.defaultTgStart ?? null;
      const guard = await facts.facts(tx, {
        participationId,
        currentRequest: exceptionOf(row.request ?? undefined),
      });
      // The row of the current planned start: the day after it, while the case is open.
      const openedOn = entryClarificationOpenedOn({
        projectType: row.type,
        status: row.p.status,
        dsvStatus: row.p.dsvStatus,
        tgStart,
        today,
      });
      const { rows } = await tx.execute<Row>(sql`
        select id, opened_on::text, pending_code, pending_source,
          to_char(pending_recorded_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as pending_on,
          to_char(escalated_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as escalated_on,
          instruction_code, instruction_source,
          to_char(instruction_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as instruction_on
        from entry_clarification
        where participation_id = ${participationId}::uuid
          and ${openedOn}::date is not null and opened_on = ${openedOn}::date`);
      const recorded = rows[0];
      const record: EntryClarificationRecord | null = recorded
        ? {
            pending: recorded.pending_code !== null,
            escalated: recorded.escalated_on !== null,
            instructed: recorded.instruction_code !== null,
          }
        : null;
      const actions = entryClarificationActions({
        projectType: row.type,
        status: row.p.status,
        dsvStatus: row.p.dsvStatus,
        tgStart,
        latestEntryDate: row.wave?.latestEntryDate ?? null,
        today,
        entryRunCompletedToday: await lifecycleRunCompleted(tx, today),
        facts: guard,
        clarification: record,
      });
      const mayRecord = mayPerformOperation(
        subject,
        { kind: "recordEntryClarification" },
        target,
      ).ok;
      const mayEscalate = mayPerformOperation(
        subject,
        { kind: "escalateEntryClarification" },
        target,
      ).ok;
      return {
        kind: "ok" as const,
        state: {
          participationId,
          statusVersion: row.p.statusVersion,
          clarification: recorded
            ? {
                id: recorded.id,
                openedOn: recorded.opened_on,
                pending:
                  recorded.pending_code === null
                    ? null
                    : {
                        code: recorded.pending_code as never,
                        source: recorded.pending_source!,
                        recordedOn: recorded.pending_on!,
                      },
                escalatedOn: recorded.escalated_on,
                instruction:
                  recorded.instruction_code === null
                    ? null
                    : {
                        code: recorded.instruction_code as never,
                        source: recorded.instruction_source!,
                        recordedOn: recorded.instruction_on!,
                      },
              }
            : null,
          actions,
          capabilities: {
            record: mayRecord && actions.recordPending,
            escalate: mayEscalate && actions.escalate,
          },
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The escalated clarifications awaiting an instruction in "Freigaben": open ones (the participation
 * still `informed`, the planned start unchanged) of the projects of the manager's regions, oldest
 * first; the project, the dates and the PL's code and source, never a name or an id of the
 * participation. Whether the viewer may instruct (never the PL who escalated).
 */
export async function clarificationReviewItemsOf(
  db: Database,
  subject: Subject,
  today: string,
): Promise<EntryClarificationReviewItem[]> {
  const { rows } = await db.execute<{
    id: string;
    project_id: string;
    project_name: string;
    region_id: string | null;
    participation_id: string;
    tg_start: string;
    opened_on: string;
    escalated_on: string;
    escalated_by: string;
    pending_code: EntryClarificationReviewItem["pendingCode"];
    pending_source: string;
    status_version: number;
  }>(sql`select c.id, c.project_id, pr.name as project_name, pr.region_id, c.participation_id,
      (c.opened_on - 1)::text as tg_start, c.opened_on::text as opened_on,
      to_char(c.escalated_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as escalated_on,
      c.escalated_by, c.pending_code, c.pending_source, p.status_version
    from entry_clarification c
    join project pr on pr.id = c.project_id
    join participation p on p.id = c.participation_id
    left join project_entry_wave w on w.id = p.entry_wave_id
    where c.escalated_at is not null and c.instruction_code is null
      and pr.type = 'ta_tg' and p.status = 'informed' and p.dsv_status = 'dsv_signed'
      and c.opened_on = coalesce(p.tg_start, w.default_tg_start) + 1
      and ${today}::date > coalesce(p.tg_start, w.default_tg_start)
    order by c.escalated_at, c.id`);
  return rows
    .filter((row) => maySeeReview(subject, { regionId: row.region_id }))
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      tgStart: row.tg_start,
      openedOn: row.opened_on,
      escalatedOn: row.escalated_on,
      pendingCode: row.pending_code,
      pendingSource: row.pending_source,
      statusVersion: row.status_version,
      capabilities: {
        instruct: mayPerformOperation(
          subject,
          { kind: "recordClarificationInstruction", requestedBy: row.escalated_by },
          {
            projectId: row.project_id,
            regionId: row.region_id,
            participationId: row.participation_id,
          },
        ).ok,
      },
    }));
}
