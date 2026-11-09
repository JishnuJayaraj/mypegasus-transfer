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
  addDays,
  entryClarificationOpenedOn,
  mayPerformOperation,
  maySeeReview,
  mayWorkDsv,
  type EntryClarificationRecord,
  type EntryClarificationStep,
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
// writes are `record_entry_clarification`, `escalate_entry_clarification`,
// `record_clarification_instruction` and `request_entry_clarification_reply`. The documented
// sources are `case_internal`: the PL who wrote one and the manager who answers read it, nobody
// else, and no log or history carries it. An unresolved case is found by its participation, not by
// its planned start: moving the start never hides it while the participation is `informed`.

export type ClarificationDeps = { db: Database; clock: Clock; facts: GuardFactsProvider };

export type ClarificationResult =
  | { kind: "not_found" | "forbidden" }
  | { kind: "ok"; state: EntryClarificationState };

type Row = {
  id: string;
  opened_on: string;
  stage: EntryClarificationRecord["stage"];
  revision: number;
};

type StepRow = {
  kind: EntryClarificationStep["kind"];
  code: EntryClarificationStep["code"];
  source: string;
  on: string;
};

/** The steps of a clarification in order, each with its Berlin day. */
async function stepsOf(tx: Pick<Database, "execute">, clarificationId: string) {
  const { rows } = await tx.execute<StepRow>(sql`
    select kind, code, source, to_char(at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "on"
    from entry_clarification_step where clarification_id = ${clarificationId}::uuid order by seq`);
  return rows;
}

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
      // The unresolved case, whatever planned start it opened for; else the instructed one of the
      // current start (a case that ended with its start is not shown against a new one).
      const { rows } = await tx.execute<Row>(sql`
        select id, opened_on::text, stage, revision from entry_clarification
        where participation_id = ${participationId}::uuid
          and (stage <> 'instructed' or opened_on = ${openedOn}::date)
        order by (stage <> 'instructed') desc, opened_on desc limit 1`);
      const recorded = rows[0];
      const record: EntryClarificationRecord | null = recorded
        ? { stage: recorded.stage, openedOn: recorded.opened_on }
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
                stage: recorded.stage,
                revision: recorded.revision,
                steps: await stepsOf(tx, recorded.id),
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
): Promise<EntryClarificationReviewItem[]> {
  const { rows } = await db.execute<{
    id: string;
    project_id: string;
    project_name: string;
    region_id: string | null;
    participation_id: string;
    opened_on: string;
    escalated_on: string;
    escalated_by: string;
    revision: number;
    status_version: number;
  }>(sql`select c.id, c.project_id, pr.name as project_name, pr.region_id, c.participation_id,
      c.opened_on::text as opened_on,
      to_char(c.escalated_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as escalated_on,
      c.escalated_by, c.revision, p.status_version
    from entry_clarification c
    join project pr on pr.id = c.project_id
    join participation p on p.id = c.participation_id
    where c.stage = 'escalated' and p.status = 'informed'
    order by c.escalated_at, c.id`);
  const visible = rows.filter((row) => maySeeReview(subject, { regionId: row.region_id }));
  const items: EntryClarificationReviewItem[] = [];
  for (const row of visible) {
    items.push({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      // The planned start the case opened for: the day before.
      tgStart: addDays(row.opened_on, -1),
      openedOn: row.opened_on,
      escalatedOn: row.escalated_on,
      revision: row.revision,
      steps: await stepsOf(db, row.id),
      statusVersion: row.status_version,
      capabilities: {
        answer: mayPerformOperation(
          subject,
          { kind: "recordClarificationInstruction", requestedBy: row.escalated_by },
          {
            projectId: row.project_id,
            regionId: row.region_id,
            participationId: row.participation_id,
          },
        ).ok,
      },
    });
  }
  return items;
}
