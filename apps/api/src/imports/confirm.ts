import { importColumnMapping, sql } from "@transfer/db";
import {
  checkImportDecisions,
  headerLooksLikeData,
  warningsToAudit,
  type ImportConfirmInput,
  type ImportDecisions,
  type ImportResult,
  type ImportValues,
} from "@transfer/domain";
import { functionRefusal } from "../database-errors";
import { createParticipationIn, type ServiceActor } from "../participations/status-service";
import { auditContext, callFunction } from "../sql";
import {
  analyse,
  binding,
  checkColumns,
  checkWave,
  cleanCountry,
  domain,
  ImportRefusal,
  loadState,
  planDigest,
  readFile,
  writeParticipantData,
  type ImportActor,
  type ImportContext,
} from "./analysis";
import { headerHmac, previewToken, tokensEqual } from "./keys";

/**
 * The confirm (5.11, R18): the file is parsed again, then one transaction under the exclusive
 * project lock reloads the state, re-plans, and refuses a mapping with issues or a plan with
 * errors (422), a plan that differs from the preview (409 `import_preview_stale`) and
 * decisions that don't fit the plan (422 `decisions_invalid`); then it writes every row
 * through the creation edge and `write_participant_data`, the confirmed warnings and
 * `import_confirmed`, and saves the mapping. Any failure rolls everything back.
 */
export async function confirmImport(
  ctx: ImportContext,
  actor: ImportActor,
  projectId: string,
  input: ImportConfirmInput,
): Promise<ImportResult> {
  const { db, release, clock, logger, mapKey, tokKey } = ctx;
  const started = Date.now();
  const read = await readFile(input, ctx.slots);
  checkColumns(read.grid, input.mapping);
  const country = cleanCountry(input.country);
  const staff: ServiceActor = actor.subject;
  const context = auditContext(actor.staffUserId, actor.requestId);
  const decisions: ImportDecisions = input.decisions;

  const result = await db
    .transaction(async (tx) => {
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const state = await loadState(tx, release, projectId);
      if (!state) throw new ImportRefusal("not_found");
      await checkWave(tx, state, projectId, input.waveId);
      // The injected clock's Berlin date decides "today" for the date rules, like the status service.
      const analysis = analyse({
        grid: read.grid,
        mapping: input.mapping,
        country,
        state,
        today: clock.today(),
      });
      if (analysis.mappingIssues.length > 0 || !analysis.plan) {
        throw new ImportRefusal("domain", [
          { code: "mapping_invalid", field: "mapping" },
          ...analysis.mappingIssues.map((i) => ({ code: i.code, field: "mapping" })),
        ]);
      }
      const plan = analysis.plan;
      if (plan.counts.error > 0) throw domain("import_has_errors");
      const expected = previewToken(
        tokKey,
        binding(projectId, read, input, input.mapping, planDigest(plan, analysis.validated, state)),
      );
      if (!tokensEqual(expected, input.previewToken)) {
        throw new ImportRefusal("conflict", [{ code: "import_preview_stale", field: null }]);
      }
      const checked = checkImportDecisions(plan, decisions);
      if (!checked.ok) {
        throw new ImportRefusal("domain", [
          { code: "decisions_invalid", field: "decisions" },
          ...checked.issues.map((i) => ({ code: i.code, field: "decisions" })),
        ]);
      }

      const values = new Map(analysis.validated.map((v) => [v.row, v.values]));
      const idOfRow = new Map<number, string>();
      const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
      const write = (participationId: string, v: ImportValues) =>
        writeParticipantData(tx, context, participationId, v);

      for (const planned of plan.rows) {
        const rowValues = values.get(planned.row)!;
        if (planned.outcome === "create") {
          if (decisions.possibleDuplicates[String(planned.row)] === "skip") {
            counts.skipped += 1;
            continue;
          }
          const { participationId } = await createParticipationIn(
            tx,
            staff,
            { projectId, ...(input.waveId && { entryWaveId: input.waveId }) },
            { requestId: actor.requestId ?? undefined },
          );
          await write(participationId, rowValues);
          idOfRow.set(planned.row, participationId);
          counts.created += 1;
        } else if (planned.outcome === "update") {
          await write(planned.participationId!, rowValues);
          idOfRow.set(planned.row, planned.participationId!);
          counts.updated += 1;
        } else if (planned.outcome === "unchanged") {
          idOfRow.set(planned.row, planned.participationId!);
          counts.unchanged += 1;
        } else {
          // A terminal participation: noted, never updated.
          idOfRow.set(planned.row, planned.participationId!);
          counts.skipped += 1;
        }
      }

      for (const { row, codes } of warningsToAudit(plan, decisions)) {
        for (const code of codes) {
          await callFunction(
            tx,
            sql`record_audit_event(p_project_id => ${projectId}::uuid,
              p_participation_id => ${idOfRow.get(row)!}::uuid,
              p_event_type => 'warning_confirmed'::audit_event_type, p_context => ${context},
              p_reason_code => ${code})`,
          );
        }
      }
      await callFunction(
        tx,
        sql`record_audit_event(p_project_id => ${projectId}::uuid, p_participation_id => null,
          p_event_type => 'import_confirmed'::audit_event_type, p_context => ${context},
          p_details => ${JSON.stringify({ ...counts, baseDefaultsVersion: release.baseDefaults.version })}::jsonb)`,
      );

      // Saved last, keyed by the hash of each normalised header, never the header text (R7).
      // Columns whose headers normalise alike keep the first one's target (as `suggest` reads
      // it back); one upsert may not touch a key twice. A header row that looks like a person's
      // data saves nothing: its hashes would be pseudonymised values of that person (R44).
      const byHmac = new Map<string, (typeof input.mapping)[number]["target"]>();
      const dataLike = headerLooksLikeData(read.grid.headers);
      for (const { column, target } of dataLike
        ? []
        : input.mapping.toSorted((a, b) => a.column - b.column)) {
        const hmac = headerHmac(mapKey, read.grid.headers[column]!);
        if (hmac !== null && !byHmac.has(hmac)) byHmac.set(hmac, target);
      }
      const saved = [...byHmac].map(([hmac, target]) => ({ hmac, target }));
      if (saved.length > 0) {
        await tx
          .insert(importColumnMapping)
          .values(
            saved.map(({ hmac, target }) => ({
              projectId,
              headerHmac: hmac,
              target,
              updatedBy: actor.staffUserId,
            })),
          )
          .onConflictDoUpdate({
            target: [importColumnMapping.projectId, importColumnMapping.headerHmac],
            set: {
              target: sql`excluded.target`,
              updatedBy: actor.staffUserId,
              updatedAt: sql`now()`,
            },
          });
      }
      // True only when a mapping row was written (a header that normalises to nothing isn't).
      return { ...counts, mappingSaved: saved.length > 0 };
    })
    .catch((error: unknown) => {
      const code = functionRefusal(error);
      if (code === "project_not_found") throw new ImportRefusal("not_found");
      throw error;
    });
  logger.info(
    { projectId, requestId: actor.requestId, ...result, durationMs: Date.now() - started },
    "import confirmed",
  );
  return result;
}
