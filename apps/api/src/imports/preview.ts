import { headerLooksLikeData, type ImportPreview, type ImportPreviewInput } from "@transfer/domain";
import {
  analyse,
  checkColumns,
  checkWave,
  cleanCountry,
  countsOf,
  binding,
  ImportRefusal,
  loadState,
  planDigest,
  readFile,
  reportRows,
  suggest,
  type ImportActor,
  type ImportContext,
} from "./analysis";
import { previewToken } from "./keys";

/**
 * The preview (5.11): writes nothing. Sheets and headers, the suggested mapping, what the
 * mapping lacks and, for a mapping without issues, the report, the counts and the token. Read
 * in one read-only `REPEATABLE READ` transaction, so the state is one coherent snapshot.
 */
export async function previewImport(
  ctx: ImportContext,
  actor: ImportActor,
  projectId: string,
  input: ImportPreviewInput,
): Promise<ImportPreview> {
  const { db, release, clock, logger, mapKey, tokKey } = ctx;
  const started = Date.now();
  const read = await readFile(input, ctx.slots);
  checkColumns(read.grid, input.mapping);
  const today = clock.today();
  const country = cleanCountry(input.country);
  const answer = await db.transaction(
    async (tx) => {
      const state = await loadState(tx, release, projectId);
      if (!state) throw new ImportRefusal("not_found");
      await checkWave(tx, state, projectId, input.waveId);
      const suggestedMapping = await suggest(
        tx,
        mapKey,
        projectId,
        state.customerName,
        read.grid.headers,
      );
      const sent = input.mapping ?? [];
      const analysis = analyse({
        grid: read.grid,
        // Without a mapping the missing targets are those of the suggestions.
        mapping: input.mapping ?? suggestedMapping,
        country,
        state,
        today,
      });
      const mappingIssues = analysis.mappingIssues;
      const report =
        input.mapping && analysis.plan
          ? {
              counts: countsOf(analysis.plan),
              rows: reportRows(analysis.plan, analysis.validated, state),
            }
          : null;
      const token =
        input.mapping && analysis.plan && analysis.plan.counts.error === 0
          ? previewToken(
              tokKey,
              binding(
                projectId,
                read,
                input,
                sent,
                planDigest(analysis.plan, analysis.validated, state),
              ),
            )
          : null;
      return { suggestedMapping, sent, mappingIssues, report, token };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  logger.info(
    {
      projectId,
      requestId: actor.requestId,
      rows: read.grid.rows.length,
      mapped: input.mapping !== undefined,
      durationMs: Date.now() - started,
    },
    "import previewed",
  );
  return {
    format: read.parsed.format,
    sheets: read.parsed.sheets,
    sheet: read.parsed.sheet,
    csv: read.parsed.csv,
    headerRow: read.grid.headerRow,
    headers: read.grid.headers,
    headerLooksLikeData: headerLooksLikeData(read.grid.headers),
    suggestedMapping: answer.suggestedMapping,
    mapping: answer.sent,
    missingTargets: answer.mappingIssues
      .filter((i) => i.code === "required_missing")
      .map((i) => i.target!),
    mappingIssues: answer.mappingIssues.map(({ row, target, code, severity }) => ({
      row,
      target,
      code,
      severity,
    })),
    report: answer.report,
    previewToken: answer.token,
  };
}
