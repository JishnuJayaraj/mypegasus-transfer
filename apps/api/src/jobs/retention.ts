import type { Clock, FileStorage } from "@transfer/adapters";
import { sql, type Database } from "@transfer/db";
import {
  credentialCutoff,
  evidenceOnlyApplies,
  evidenceSetDue,
  participationRetentionTriggers,
  RetentionClass,
  retentionActivation,
  retentionDue,
  retentionRules,
  settlementDatesRequired,
  workingCopyTriggers,
  type Funded110,
  type IsoDate,
  type RetentionPeriods,
  type RetentionPrerequisite,
  type RetentionPrerequisites,
} from "@transfer/domain";
import type { Logger } from "pino";
import { functionRefusal } from "../database-errors";
import { objectKey } from "../documents/files";
import { JobError } from "./errors";

/** How a class fared in a run: never a subject, only counts (ADR-0011). */
export type ClassOutcome =
  | "period_unset"
  | "never"
  | "not_applied"
  | "no_storage"
  | "counted"
  | "applied";
/**
 * Per class: how many items were due, deleted, kept by a legal hold, and blocked (an `unknown`
 * funding, a missing required settlement date or an active job); never which.
 */
export type ClassReport = {
  outcome: ClassOutcome;
  due: number;
  deleted: number;
  held: number;
  blocked: number;
};
export type RetentionSummary = {
  runDay: IsoDate;
  dryRun: boolean;
  /** The prerequisites of a live deletion still unmet; any makes the run a dry run. */
  unmet: RetentionPrerequisite[];
  classes: Record<RetentionClass, ClassReport>;
  /** Participations that entered the evidence-only phase in this run. */
  evidenceOnly: number;
};

export type RetentionDeps = {
  /** The retention role's connection (`RETENTION_DATABASE_URL`), never the API's. */
  db: Database;
  /** The document store; none before the pilot's adapter (Q149): files are then only counted. */
  storage: FileStorage | undefined;
  clock: Clock;
  logger: Logger;
};

export type RetentionOptions = {
  /** Production passes the data catalog's; integration tests synthetic ones. */
  periods: RetentionPeriods;
  prerequisites: RetentionPrerequisites;
  dryRun: boolean;
  /** The Berlin day to run for; the clock's today by default. */
  today?: IsoDate;
};

const day = 86_400_000;
const documentId = /^documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
class ErasureNeedsStorage extends Error {}

/**
 * The retention job (ADR-0008, ADR-0011; data-protection.md, retention as built), stage one
 * without a person trigger: access credentials, generated working copies' files and orphaned
 * objects, each by its class's period as `retentionDue` decides. One transaction under the
 * retention role, opened as a run (the immutability triggers' path); idempotent. While a class's
 * period is `unset` it is only reported; while any prerequisite of a live deletion is unmet, or
 * with `dryRun`, the run computes and counts and deletes nothing. Every class is reported. Then
 * per closed participation (data-protection.md, retention per class) each class, the health record
 * and the personnel file, at its own trigger and period, the held rows kept; the participation
 * record is reported (`funding_unknown` blocks it) and erased in stage two; the evidence-only
 * phase starts only where it applies.
 */
export async function runRetention(
  { db, storage, clock, logger }: RetentionDeps,
  options: RetentionOptions,
): Promise<RetentionSummary> {
  const { active, unmet } = retentionActivation(options.prerequisites);
  const dryRun = options.dryRun || !active;
  const runDay = options.today ?? clock.today();
  const { periods } = options;
  const classes = Object.fromEntries(
    RetentionClass.options.map((c) => {
      const period = periods[c];
      const outcome: ClassOutcome =
        period === "never"
          ? "never"
          : period === "unset"
            ? "period_unset"
            : retentionRules[c].applied
              ? "counted"
              : "not_applied";
      return [c, { outcome, due: 0, deleted: 0, held: 0, blocked: 0 }];
    }),
  ) as Record<RetentionClass, ClassReport>;
  const summary: RetentionSummary = { runDay, dryRun, unmet, classes, evidenceOnly: 0 };
  const applies = (c: RetentionClass) => classes[c].outcome === "counted";
  const apply = (c: RetentionClass, deleted: number) => {
    classes[c].deleted += deleted;
    if (!dryRun) classes[c].outcome = "applied";
  };

  try {
    await db.transaction(async (tx) => {
      const run = await scalar<string>(
        tx,
        sql`select retention_open_run(${runDay}::date, ${dryRun}) as result`,
      );

      const stageTwoConfigured =
        periods.participation_record !== "unset" && periods.participation_record !== "never";
      if (stageTwoConfigured)
        await tx.execute(sql`select retention_lock_erasure_projects(${run}::uuid)`);
      const nonDueWorkingCopies = new Set<string>();

      const cutoff = credentialCutoff(periods, runDay);
      if (applies("access_credential") && cutoff) {
        const counts = await scalar<Record<string, number>>(
          tx,
          sql`select retention_purge_credentials(${run}::uuid, ${cutoff}::date) as result`,
        );
        const due = Object.values(counts).reduce((sum, n) => sum + n, 0);
        classes.access_credential.due = due;
        apply("access_credential", dryRun ? 0 : due);
      }

      if (applies("form_working_copy")) {
        const { rows } = await tx.execute<{
          document_id: string;
          participation_id: string;
          generated_on: IsoDate;
          superseded_on: IsoDate | null;
          scan_accepted_on: IsoDate | null;
          closed_on: IsoDate | null;
        }>(sql`select document_id, participation_id, generated_on::text, superseded_on::text,
          scan_accepted_on::text, closed_on::text from retention_working_copies(${run}::uuid)`);
        let deleted = 0;
        for (const row of rows) {
          const due = retentionDue(
            {
              class: "form_working_copy",
              triggers: workingCopyTriggers({
                generatedOn: row.generated_on,
                supersededOn: row.superseded_on,
                scanAcceptedOn: row.scan_accepted_on,
                closedOn: row.closed_on,
              }),
              held: false,
            },
            periods,
            runDay,
          );
          if (due.kind !== "due") {
            nonDueWorkingCopies.add(row.participation_id);
            continue;
          }
          const available = await scalar<boolean>(
            tx,
            sql`select retention_lock_working_copy(${run}::uuid, ${row.document_id}::uuid) as result`,
          );
          if (!available) {
            classes.form_working_copy.held += 1;
            continue;
          }
          classes.form_working_copy.due += 1;
          if (dryRun) continue;
          if (!storage) {
            nonDueWorkingCopies.add(row.participation_id);
            continue;
          }
          // The object first: a failure after it leaves the row for the next run to record.
          await storage.delete(objectKey(row.document_id));
          const purged = await scalar<boolean>(
            tx,
            sql`select retention_purge_working_copy(${run}::uuid, ${row.document_id}::uuid) as result`,
          );
          if (purged) deleted += 1;
        }
        if (!dryRun && !storage && classes.form_working_copy.due > 0) {
          classes.form_working_copy.outcome = "no_storage";
        } else apply("form_working_copy", deleted);
      }

      if (applies("orphaned_object")) {
        if (!storage) classes.orphaned_object.outcome = "no_storage";
        else {
          const now = clock.now().getTime();
          const stored = (await storage.list("documents")).flatMap((object) => {
            const id = documentId.exec(object.key)?.[1];
            const storedOn = berlinDay(object.modifiedAt.getTime());
            const due = retentionDue(
              { class: "orphaned_object", triggers: { stored: storedOn }, held: false },
              periods,
              runDay,
            );
            // Never a write of the last day, whatever the period: its row may be on its way.
            return id && due.kind === "due" && now - object.modifiedAt.getTime() >= day
              ? [{ id, key: object.key }]
              : [];
          });
          const known = new Set(
            await scalar<string[]>(
              tx,
              sql`select retention_known_objects(${run}::uuid, ${`{${stored.map((o) => o.id).join(",")}}`}::uuid[]) as result`,
            ),
          );
          const orphans = stored.filter((object) => !known.has(object.id));
          classes.orphaned_object.due = orphans.length;
          if (!dryRun) for (const object of orphans) await storage.delete(object.key);
          apply("orphaned_object", dryRun ? 0 : orphans.length);
        }
      }

      // Stage one per class of each closed participation (data-protection.md, retention per
      // class): each class at its own trigger and period, only that class, the held rows kept.
      const perClass = (["health_record", "personnel_file"] as const).filter(applies);
      const reported = classes.participation_record.outcome !== "period_unset";
      const projectFacts =
        perClass.length > 0 || reported
          ? (
              await tx.execute<ErasureFacts>(sql`select participation_id, any_entered_tg, fundings,
            kug_final_settlement_date::text, measure110_settlement_date::text, erasure_pending_at, erasure_entered_tg, erasure_trigger, erasure_trigger_on::text from retention_erasure_facts(${run}::uuid)`)
            ).rows
          : [];
      const factsByParticipation = new Map(
        projectFacts.map((facts) => [facts.participation_id, facts]),
      );
      if (perClass.length > 0 || reported) {
        const { rows } = await tx.execute<ParticipationFacts>(sql`select participation_id,
          status, closed_on::text, withdrawn_on::text, exit_date::text, entered_tg,
          dsv_fully_executed, funded110, evidence_set_since, held_classes, classes_left
          from retention_participations(${run}::uuid)`);
        for (const row of rows) {
          const anchor = factsByParticipation.get(row.participation_id);
          const enteredTg = anchor?.erasure_entered_tg ?? row.entered_tg;
          const triggers = anchor?.erasure_pending_at
            ? {
                non_signer_withdrawn:
                  anchor.erasure_trigger === "non_signer_withdrawn"
                    ? anchor.erasure_trigger_on
                    : null,
                closed_without_tg:
                  anchor.erasure_trigger === "closed_without_tg" ? anchor.erasure_trigger_on : null,
                exited: anchor.erasure_trigger === "exited" ? anchor.erasure_trigger_on : null,
              }
            : participationRetentionTriggers({
                status: row.status,
                closedOn:
                  row.status === "exited" ? (row.exit_date ?? row.closed_on) : row.closed_on,
                withdrawnOn: row.withdrawn_on,
                enteredTg,
                dsvFullyExecuted: row.dsv_fully_executed,
              });
          const left = new Set(row.classes_left);
          for (const c of row.evidence_set_since === null && !anchor?.erasure_pending_at
            ? perClass
            : []) {
            if (!left.has(c)) continue;
            const due = retentionDue(
              {
                class: c,
                triggers,
                held: row.held_classes.includes(c),
                funding: { funded110: row.funded110, enteredTg },
              },
              periods,
              runDay,
            );
            if (due.kind === "held") classes[c].held += 1;
            if (due.kind === "blocked") classes[c].blocked += 1;
            if (due.kind !== "due") continue;
            classes[c].due += 1;
            const documents = await scalar<string[]>(
              tx,
              sql`select retention_class_documents(${run}::uuid, ${row.participation_id}::uuid, ${c}) as result`,
            );
            if (!dryRun && documents.length > 0) {
              if (!storage) {
                classes[c].outcome = "no_storage";
                continue;
              }
              // The objects first: a failure leaves the rows for the next run.
              for (const id of documents) await storage.delete(objectKey(id));
            }
            const result = await scalar<{ deleted: number; kept: number; held: boolean }>(
              tx,
              sql`select retention_delete_class(${run}::uuid, ${row.participation_id}::uuid, ${c}) as result`,
            );
            if (result.kept > 0) classes[c].held += 1;
            if (!dryRun) {
              // Read the remaining classes again: held rows and retained dependencies can survive
              // a partial deletion (data-protection.md, retained dependencies).
              const remaining = await tx.execute<{ classes_left: string[] }>(sql`select classes_left
                from retention_participations(${run}::uuid) where participation_id = ${row.participation_id}::uuid`);
              if (remaining.rows[0]) {
                left.clear();
                for (const retained of remaining.rows[0].classes_left) left.add(retained);
              }
              apply(c, 1);
            }
          }
          const record = reported
            ? retentionDue(
                {
                  class: "participation_record",
                  triggers,
                  held: false,
                  funding: { funded110: row.funded110, enteredTg },
                },
                periods,
                runDay,
              )
            : null;
          if (record) {
            if (record.kind === "blocked") classes.participation_record.blocked += 1;
            if (record.kind === "due") classes.participation_record.due += 1;
          }
          if (stageTwoConfigured && record?.kind === "due") {
            const project = factsByParticipation.get(row.participation_id);
            if (!project) continue;
            const requirements = settlementDatesRequired({
              anyEnteredTg: project.any_entered_tg,
              fundings: project.fundings,
            });
            if (
              requirements.fundingUnknown ||
              (requirements.kugFinalSettlementDate && !project.kug_final_settlement_date) ||
              (requirements.measure110SettlementDate && !project.measure110_settlement_date)
            ) {
              classes.participation_record.blocked += 1;
              continue;
            }
            const hasEvidence = enteredTg || row.funded110 === "known_yes";
            if (hasEvidence) {
              const period = periods.evidence_set;
              const years =
                period === "unset" ||
                period === "never" ||
                period.days?.settled !== undefined ||
                period.months?.settled !== undefined
                  ? null
                  : (period.yearEnds?.settled ?? null);
              const evidence = evidenceSetDue(
                {
                  anyEnteredTg: project.any_entered_tg,
                  fundings: project.fundings,
                  kugFinalSettlementDate: project.kug_final_settlement_date,
                  measure110SettlementDate: project.measure110_settlement_date,
                },
                years,
                runDay,
              );
              if (evidence !== "due") continue;
              classes.evidence_set.due += 1;
            }
            const remainingStageOneDue = (["personnel_file", "health_record"] as const).every(
              (c) =>
                !left.has(c) ||
                retentionDue(
                  {
                    class: c,
                    triggers,
                    held: false,
                    funding: { funded110: row.funded110, enteredTg },
                  },
                  periods,
                  runDay,
                ).kind === "due",
            );
            if (
              !remainingStageOneDue ||
              (left.has("form_working_copy") &&
                (!applies("form_working_copy") || nonDueWorkingCopies.has(row.participation_id)))
            )
              continue;
            try {
              const result = await tx.transaction(async (nested) => {
                const erased = await scalar<{
                  completed: boolean;
                  documents: string[];
                  blocked?: string;
                }>(
                  nested,
                  sql`select retention_erase_participation(${run}::uuid, ${row.participation_id}::uuid) as result`,
                );
                if (!dryRun && erased.documents.length && !storage) throw new ErasureNeedsStorage();
                if (!dryRun && storage)
                  for (const id of erased.documents) await storage.delete(objectKey(id));
                return erased;
              });
              if (result.blocked) {
                classes.participation_record.blocked += 1;
                continue;
              }
              if (result.completed) {
                apply("participation_record", dryRun ? 0 : 1);
                if (hasEvidence) apply("evidence_set", dryRun ? 0 : 1);
                continue;
              }
              classes.participation_record.held += 1;
              continue;
            } catch (error) {
              if (!(error instanceof ErasureNeedsStorage)) throw error;
              classes.participation_record.outcome = "no_storage";
              continue;
            }
          }
          if (
            !dryRun &&
            !anchor?.erasure_pending_at &&
            evidenceOnlyApplies([...left] as RetentionClass[], row.funded110, enteredTg) ===
              "applies"
          ) {
            const entered = await scalar<boolean>(
              tx,
              sql`select retention_enter_evidence_only(${run}::uuid, ${row.participation_id}::uuid) as result`,
            );
            if (entered) summary.evidenceOnly += 1;
          }
        }
      }

      await tx.execute(
        sql`select retention_close_run(${run}::uuid, ${JSON.stringify({ dryRun, unmet, classes, evidenceOnly: summary.evidenceOnly })}::jsonb)`,
      );
    });
  } catch (error) {
    const code = functionRefusal(error);
    if (code) throw new JobError(code);
    throw error;
  }
  logger.info({ job: "retention", ...summary }, "retention run");
  return summary;
}

type ParticipationFacts = {
  participation_id: string;
  status: string;
  closed_on: IsoDate | null;
  withdrawn_on: IsoDate | null;
  exit_date: IsoDate | null;
  entered_tg: boolean;
  dsv_fully_executed: boolean;
  funded110: Funded110;
  evidence_set_since: string | null;
  held_classes: string[];
  classes_left: string[];
};

type ErasureFacts = {
  participation_id: string;
  erasure_pending_at: string | null;
  erasure_entered_tg: boolean | null;
  erasure_trigger: string | null;
  erasure_trigger_on: IsoDate | null;
  any_entered_tg: boolean;
  fundings: Funded110[];
  kug_final_settlement_date: IsoDate | null;
  measure110_settlement_date: IsoDate | null;
};

async function scalar<T>(
  tx: { execute: Database["execute"] },
  query: ReturnType<typeof sql>,
): Promise<T> {
  const { rows } = await tx.execute<{ result: T }>(query);
  return rows[0]!.result;
}

const berlin = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Berlin day of an instant (epoch milliseconds). */
function berlinDay(epochMs: number): IsoDate {
  return berlin.format(epochMs) as IsoDate;
}
