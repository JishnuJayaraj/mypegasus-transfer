import { createRoute, z } from "@hono/zod-openapi";
import { configDirs, loadOrganisation } from "@transfer/config/load";
import { eq, kug200bBatch, sql, type Database } from "@transfer/db";
import {
  BatchStaleRow,
  CreateKug200bBatchInput,
  DiscardKug200bBatchInput,
  Kug200bBatchCreated,
  Kug200bBatchesView,
  Kug200bBatchParams,
  Kug200bBatchSubmissionInput,
  Kug200bBatchSubmitted,
  mayWorkKug200bBatches,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { artifactChecklist, type BatchPrintSources } from "../forms/kug200a";
import { formRegistry } from "../forms/registry";
import { agenturBatchSettings, batchesView, settingsArgs } from "../participations/kug200b-batches";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// The project tab "Agentur" (process-and-lifecycle.md, Kug 200b batches; ADR-0010; D25, Q203):
// the PL builds a batch of one placement Agentur's accepted Kug 200b scans, records "Übermittelt
// am" or discards it. Order as in ADR-0010: schema → visibility (404: a batch is the PL's alone,
// so it is hidden from everyone else whatever its state) → permission (403) → state (422). Each
// write takes the project's exclusive lock first, resolves the Agentur's settings under it and
// passes them to the function, which rechecks under the same lock (`batch_stale` with its rows).

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

/** The rows of a `batch_stale` refusal (its DETAIL), validated: ids and codes only. */
export function staleRowsOf(error: unknown) {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const detail = (cause as { detail?: unknown } | null)?.detail;
  if (typeof detail !== "string") return [];
  return z.array(BatchStaleRow).parse(JSON.parse(detail));
}

/** A batch function's refusal as its problem (allowlisted, R21), or rethrown. */
export function batchRefused(c: Context<AppEnv>, error: unknown, hidden: "project" | "batch") {
  const code = functionRefusal(error);
  if (code === "batch_stale") {
    return problem(c, "domain-error", {
      errors: [{ pointer: "", code, detail: "Refused by a domain rule" }],
      staleRows: staleRowsOf(error),
    });
  }
  if (code === `${hidden}_not_found`) return problem(c, "not-found");
  if (code === "session_invalid") return problem(c, "unauthenticated");
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code === "submitted_on_in_future" || code === "submitted_before_batch") {
    return domainProblem(c, [{ code, field: "submittedOn" }]);
  }
  if (
    code === "asu_not_applicable" ||
    code === "batch_settings_missing" ||
    code === "batch_not_open" ||
    code === "export_not_applicable" ||
    code === "document_not_found" ||
    code === "invalid_argument"
  ) {
    return domainProblem(c, [code]);
  }
  throw error;
}

export function kug200bBatchRoutes(deps: Deps) {
  const { db, clock, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const release = loadRelease(deps.env.configDir);
  const registry = deps.formRegistry ?? formRegistry(deps.env.configDir);
  const company = loadOrganisation(
    configDirs(deps.env.configDir).organisation,
  ).transfergesellschaft;

  /** The project as the PL's: 404 when it isn't visible, 403 for anyone but its PL. */
  async function projectLead(c: Context<AppEnv>, projectId: string) {
    const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), projectId);
    if (!visible) return problem(c, "not-found");
    if (!mayWorkKug200bBatches(subject, { projectId, regionId, participationId: null }).ok) {
      return problem(c, "forbidden");
    }
    return null;
  }

  /** A batch the viewer leads, else 404 whatever its state (only its PL sees it). */
  async function batchOf(c: Context<AppEnv>, batchId: string) {
    const [found] = await db
      .select({ projectId: kug200bBatch.projectId, agenturKey: kug200bBatch.agenturKey })
      .from(kug200bBatch)
      .where(eq(kug200bBatch.id, batchId));
    if (!found) return null;
    const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), found.projectId);
    const target = { projectId: found.projectId, regionId, participationId: null };
    return visible && mayWorkKug200bBatches(subject, target).ok ? found : null;
  }

  /** Runs `write` under the project's exclusive lock with the Agentur's settings read under it. */
  function underLock<T>(
    projectId: string,
    agenturKey: string,
    write: (tx: Tx, settings: ReturnType<typeof settingsArgs>) => Promise<T>,
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const settings = await agenturBatchSettings(
        tx,
        release,
        registry,
        projectId,
        agenturKey,
        clock.today(),
      );
      return write(tx, settingsArgs(settings));
    });
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/kug200b-batches",
      tags: ["projects"],
      summary:
        "The tab Agentur (the PL of a ta_tg project): per placement Agentur its batch channel or the missing settings, the artifact (the Kug 200a or the accepted alternative with its confirmation) and the ready scans; the batches, an open one with its recheck and, when current, its artifact's handwriting checklist (codes, keys and members, never a value)",
      middleware,
      request: { params: z.object({ projectId: z.uuid() }) },
      responses: {
        200: json(Kug200bBatchesView, "The Agenturen and batches"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const refused = await projectLead(c, projectId);
      if (refused) return refused as never;
      const view = await db.transaction(
        async (tx) => {
          const [project] = await tx
            .execute<{ type: string }>(
              sql`select type::text from project where id = ${projectId}::uuid`,
            )
            .then((r) => r.rows);
          if (project?.type !== "ta_tg") return null;
          const found = await batchesView(tx, release, registry, projectId, clock.today());
          // Each open, current batch's handwriting checklist before printing (Q197 (8), Q205):
          // from the sources the artifact prints, the RV-Nummer by its presence only.
          for (const batch of found.batches) {
            if (!batch.capabilities.exportArtifact) continue;
            const { rows } = await tx.execute<{ result: BatchPrintSources }>(
              sql`select kug200b_batch_print_sources(p_context => ${context(c)},
                p_batch_id => ${batch.id}::uuid) as result`,
            );
            batch.checklist = await artifactChecklist(
              registry,
              rows[0]!.result,
              company,
              batch.artifact,
              clock.today(),
            );
          }
          return found;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      if (!view) return domainProblem(c, ["asu_not_applicable"]) as never;
      c.header("Cache-Control", "no-store");
      return c.json(view, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/kug200b-batches",
      tags: ["projects"],
      summary:
        "Build a Kug 200b batch (the PL) of one placement Agentur's accepted scans, 1–200, all or nothing, its membership fixed: refused without the Agentur's batch channel (batch_settings_missing) and with the rows of every scan that can't join (batch_stale)",
      middleware,
      request: {
        params: z.object({ projectId: z.uuid() }),
        body: {
          required: true,
          content: { "application/json": { schema: CreateKug200bBatchInput } },
        },
      },
      responses: {
        201: json(Kug200bBatchCreated, "The batch"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const refused = await projectLead(c, projectId);
      if (refused) return refused as never;
      const batchId = randomUUID();
      try {
        await underLock(projectId, input.agenturKey, (tx, settings) =>
          tx.execute(sql`select create_kug200b_batch(p_context => ${context(c)},
            p_project_id => ${projectId}::uuid, p_batch_id => ${batchId}::uuid,
            p_agentur_key => ${input.agenturKey},
            p_channel => ${settings.channel}::kug200b_batch_channel,
            p_artifact => ${settings.artifact}::kug200b_batch_artifact,
            p_document_ids => ${`{${input.documentIds.join(",")}}`}::uuid[],
            p_outdated_versions => ${settings.outdatedVersions}::text[])`),
        );
      } catch (error) {
        logger.info(
          { requestId: c.get("requestId"), outcome: functionRefusal(error) ?? "failed" },
          "kug200b batch",
        );
        return batchRefused(c, error, "project") as never;
      }
      logger.info(
        { requestId: c.get("requestId"), batchId, count: input.documentIds.length },
        "kug200b batch",
      );
      c.header("Cache-Control", "no-store");
      return c.json({ batchId }, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/kug200b-batches/{batchId}/submission",
      tags: ["projects"],
      summary:
        "\"Übermittelt am\" for an open batch (its PL): the actual sent date from the batch's day to today, after the recheck (batch_stale with the rows, nothing written); records each member's submission and, on the route kug_200b, its ASU registration on that date",
      middleware,
      request: {
        params: Kug200bBatchParams,
        body: {
          required: true,
          content: { "application/json": { schema: Kug200bBatchSubmissionInput } },
        },
      },
      responses: {
        200: json(Kug200bBatchSubmitted, "Submitted"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { batchId } = c.req.valid("param");
      const { submittedOn } = c.req.valid("json");
      const batch = await batchOf(c, batchId);
      if (!batch) return problem(c, "not-found") as never;
      let counts: z.infer<typeof Kug200bBatchSubmitted>;
      try {
        counts = await underLock(batch.projectId, batch.agenturKey, async (tx, settings) => {
          const { rows } = await tx.execute<{ result: z.infer<typeof Kug200bBatchSubmitted> }>(
            sql`select submit_kug200b_batch(p_context => ${context(c)},
              p_batch_id => ${batchId}::uuid, p_submitted_on => ${submittedOn}::date,
              p_channel => ${settings.channel}::kug200b_batch_channel,
              p_artifact => ${settings.artifact}::kug200b_batch_artifact,
              p_outdated_versions => ${settings.outdatedVersions}::text[]) as result`,
          );
          return rows[0]!.result;
        });
      } catch (error) {
        logger.info(
          { requestId: c.get("requestId"), batchId, outcome: functionRefusal(error) ?? "failed" },
          "kug200b batch submission",
        );
        return batchRefused(c, error, "batch") as never;
      }
      logger.info(
        { requestId: c.get("requestId"), batchId, count: counts.submissions },
        "kug200b batch submission",
      );
      c.header("Cache-Control", "no-store");
      return c.json(counts, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/kug200b-batches/{batchId}/discard",
      tags: ["projects"],
      summary:
        "Discard an open batch (its PL): its members are free for a new batch; the batch stays as history",
      middleware,
      request: {
        params: Kug200bBatchParams,
        body: {
          required: true,
          content: { "application/json": { schema: DiscardKug200bBatchInput } },
        },
      },
      responses: {
        204: { description: "Discarded" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { batchId } = c.req.valid("param");
      const batch = await batchOf(c, batchId);
      if (!batch) return problem(c, "not-found") as never;
      try {
        await db.execute(
          sql`select discard_kug200b_batch(p_context => ${context(c)}, p_batch_id => ${batchId}::uuid)`,
        );
      } catch (error) {
        return batchRefused(c, error, "batch") as never;
      }
      return c.body(null, 204) as never;
    },
  );

  return router;
}
