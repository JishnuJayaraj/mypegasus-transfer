import { eq, participation, sql, type Database } from "@transfer/db";
import {
  mayPerformOperation,
  maySeeReview,
  mayWorkDsv,
  reconciliationOutcomes,
  reconciliationReviewDueOn,
  type ReconciliationEvidenceKind,
  type ReconciliationReviewItem,
  type ReconciliationStage,
  type ReconciliationStep,
  type StaffUser,
  type Subject,
  type TgEntryReconciliationState,
  type TgEntryReconciliationView,
} from "@transfer/domain";
import { projectAccess } from "../access";
import type { createStatusService } from "./status-service";

// The reconciliation of a missed TG entry as the API reads it (process-and-lifecycle.md, the
// reconciliation; Q68 case 2, Q80, Q216): the PL's dialog and review card on the tab "DSV", and the
// open reconciliations in "Freigaben". Reads only; the writes are `reconcile_tg_entry`,
// `review_reconciliation` and `reply_reconciliation_clarification`. The documented sources are
// `case_internal`: shown to the PL and back office on the tab and to the manager in "Freigaben",
// never in a history, an audit event or a log. The queue names no participant and no participation.

type StatusService = ReturnType<typeof createStatusService>;

type Row = {
  id: string;
  project_id: string;
  participation_id: string;
  effective_date: string;
  reconciled_on: string;
  reconciled_by: string;
  evidence: { kind: ReconciliationEvidenceKind; validOn: string; recordedAt: string }[];
  stage: ReconciliationStage;
  revision: number;
};

const columns = sql`t.id, t.project_id, t.participation_id, t.effective_date::text,
  to_char(t.reconciled_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as reconciled_on,
  t.reconciled_by, t.evidence, t.stage, t.revision`;

/** The Berlin day of a UTC instant. */
const berlinDay = (instant: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(instant));

/** The evidence's kinds with their valid and recorded days: no record id, no file. */
const evidenceDays = (row: Row) =>
  row.evidence.map((e) => ({
    kind: e.kind,
    validOn: e.validOn,
    recordedOn: berlinDay(e.recordedAt),
  }));

async function stepsOf(db: Pick<Database, "execute">, id: string): Promise<ReconciliationStep[]> {
  const { rows } = await db.execute<ReconciliationStep>(sql`select kind, code, source,
      to_char(at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "on"
    from tg_entry_reconciliation_step where reconciliation_id = ${id}::uuid order by seq`);
  return rows;
}

async function viewOf(db: Pick<Database, "execute">, row: Row): Promise<TgEntryReconciliationView> {
  return {
    id: row.id,
    effectiveDate: row.effective_date,
    reconciledOn: row.reconciled_on,
    reviewDueOn: reconciliationReviewDueOn(row.reconciled_on),
    evidence: evidenceDays(row),
    stage: row.stage,
    revision: row.revision,
    steps: await stepsOf(db, row.id),
  };
}

export type ReconciliationResult =
  | { kind: "not_found" | "forbidden" }
  | { kind: "ok"; state: TgEntryReconciliationState; subject: Subject };

/**
 * One participation's reconciliation for the tab "DSV": a hidden participation is a 404, a viewer
 * without the DSV (`mayWorkDsv`: the PL and back office) a 403. The evidence and the refusal are
 * the status service's, as its write decides them.
 */
export async function loadReconciliation(
  { db, service }: { db: Database; service: StatusService },
  user: StaffUser,
  participationId: string,
): Promise<ReconciliationResult> {
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
  const read = await service.reconciliationState(subject, participationId);
  const { rows } = await db.execute<Row>(
    sql`select ${columns} from tg_entry_reconciliation t
      where t.participation_id = ${participationId}::uuid`,
  );
  const row = rows[0];
  const reconciliation = row ? await viewOf(db, row) : null;
  return {
    kind: "ok",
    subject,
    state: {
      participationId,
      statusVersion: read.statusVersion,
      tgStart: read.tgStart,
      evidence: read.evidence.map((e) => ({ ...e, recordedAt: e.recordedAt.toISOString() })),
      problems: read.problems,
      reconciliation,
      capabilities: {
        reconcile: read.refusal === null,
        reply:
          reconciliation?.stage === "clarification_requested" &&
          mayPerformOperation(subject, { kind: "replyReconciliation" }, target).ok,
      },
      refusal: read.refusal,
    },
  };
}

/**
 * The open reconciliations in "Freigaben" of the projects of the manager's regions, oldest first:
 * the project, the TG start, the evidence's kinds and days, the review's steps and the outcomes
 * the viewer may record now (none for the PL who reconciled, `four_eyes`). A closed review leaves
 * the queue; a clarification stays in it while the PL is to reply, an escalation until resolved.
 */
export async function reconciliationReviewItemsOf(
  db: Database,
  subject: Subject,
): Promise<ReconciliationReviewItem[]> {
  const { rows } = await db.execute<Row & { project_name: string; region_id: string | null }>(
    sql`select ${columns}, pr.name as project_name, pr.region_id
      from tg_entry_reconciliation t join project pr on pr.id = t.project_id
      where t.stage not in ('no_objection', 'resolved_no_objection')
      order by t.reconciled_at, t.id`,
  );
  const items: ReconciliationReviewItem[] = [];
  for (const row of rows) {
    if (!maySeeReview(subject, { regionId: row.region_id })) continue;
    const permitted = mayPerformOperation(
      subject,
      { kind: "reviewReconciliation", actorStaffUserId: row.reconciled_by },
      { projectId: row.project_id, regionId: row.region_id, participationId: row.participation_id },
    ).ok;
    const view = await viewOf(db, row);
    items.push({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      tgStart: view.effectiveDate,
      reconciledOn: view.reconciledOn,
      reviewDueOn: view.reviewDueOn,
      evidence: view.evidence,
      stage: view.stage,
      revision: view.revision,
      steps: view.steps,
      capabilities: { outcomes: permitted ? reconciliationOutcomes(row.stage) : [] },
    });
  }
  return items;
}

/**
 * The day the manager first asked for a clarification of each participation's reconciliation,
 * while it is open (the work list's "Rückfrage zum Eintritt"), by participation id.
 */
export async function reconciliationClarificationsOf(
  db: Pick<Database, "execute">,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.execute<{ participation_id: string; since: string }>(
    sql`select t.participation_id,
        to_char(min(s.at) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as since
      from tg_entry_reconciliation t
      join tg_entry_reconciliation_step s on s.reconciliation_id = t.id
        and s.kind = 'clarification_requested'
      where t.participation_id = any(${sql.param([...ids])}::uuid[])
        and t.stage in ('clarification_requested', 'replied', 'escalated_to_dpo')
      group by t.participation_id`,
  );
  return new Map(rows.map((row) => [row.participation_id, row.since]));
}
