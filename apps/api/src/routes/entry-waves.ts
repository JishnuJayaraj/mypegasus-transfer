import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, participation, project, projectEntryWave as wave, sql } from "@transfer/db";
import {
  checkWaveChange,
  CreateEntryWaveInput,
  EntryWaveRecord,
  PageQuery,
  page,
  UpdateEntryWaveInput,
  type StaffUser,
  type WaveIssue,
  type WaveValues,
} from "@transfer/domain";
import { projectDenial } from "../access";
import { createRouter, json, type Deps } from "../context";
import { decodeCursor, encodeCursor } from "../cursor";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext, callFunction, utc } from "../sql";

const WavePage = page(EntryWaveRecord).meta({ id: "EntryWavePage" });
const ProjectParams = z.object({ projectId: z.uuid() });
const WaveParams = ProjectParams.extend({ waveId: z.uuid() });

const values = {
  code: wave.code,
  name: wave.name,
  signingDeadline: wave.signingDeadline,
  defaultTgStart: wave.defaultTgStart,
  defaultTgEnd: wave.defaultTgEnd,
  latestEntryDate: wave.latestEntryDate,
};
const columns = {
  id: wave.id,
  projectId: wave.projectId,
  ...values,
  // Drizzle leaves columns unqualified here, so the outer wave's id is named in full.
  participations: sql<number>`(select count(*)::int from ${participation} where ${participation.entryWaveId} = ${wave}.${sql.identifier("id")})`,
  createdAt: utc(wave.createdAt),
  updatedAt: utc(wave.updatedAt),
};
const noWave: WaveValues = {
  code: "",
  name: "",
  signingDeadline: null,
  defaultTgStart: null,
  defaultTgEnd: null,
  latestEntryDate: null,
};

/** The refusals of the wave functions that are a 422; `*_not_found` is a 404, others propagate. */
const waveRefusals: ReadonlySet<string> = new Set(["not_ta_tg", "wave_unchanged"]);

type Change = { projectId: string; waveId: string | null; input: Partial<WaveValues> };

/**
 * Checks a wave creation or edit (`checkWaveChange`) on the state read under the exclusive project
 * lock, then writes it through its function in the same transaction (D3). Returns the wave's id,
 * the refusals, or null when the project or wave doesn't exist.
 */
async function writeWave(
  deps: Deps,
  user: StaffUser,
  requestId: string,
  change: Change,
): Promise<{ id: string } | { issues: readonly (WaveIssue | string)[] } | null> {
  const { projectId, waveId, input } = change;
  return deps.db
    .transaction(async (tx) => {
      // The functions take the lock again (re-entrant).
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const [found] = await tx
        .select({ type: project.type, status: project.status })
        .from(project)
        .where(eq(project.id, projectId));
      const waves = await tx
        .select({ id: wave.id, ...values })
        .from(wave)
        .where(eq(wave.projectId, projectId));
      const before = waveId === null ? null : waves.find((w) => w.id === waveId);
      if (before === undefined) return null;
      const set = Object.entries(input).filter(([, value]) => value !== undefined);
      const after: WaveValues = { ...(before ?? noWave), ...Object.fromEntries(set) };
      const [usage] = await tx
        .select({
          participations: sql<number>`count(*)::int`,
          openFirstOffers: sql<number>`(count(*) filter (where ${participation.dsvStatus} = 'dsv_offered' and ${participation.offerDeadline} is null))::int`,
          reliesOnDefaultStart: sql<boolean>`coalesce(bool_or(${participation.tgStart} is null and ${participation.tgEntryDate} is null and ${participation.status} <> 'withdrawn'), false)`,
        })
        .from(participation)
        .where(waveId === null ? sql`false` : eq(participation.entryWaveId, waveId));
      const issues = checkWaveChange({
        project: found!,
        before,
        after,
        usage: usage!,
        otherWaves: waves.filter((w) => w.id !== waveId),
        today: deps.clock.today(),
      });
      if (issues.length) return { issues };
      const args = sql`p_project_id => ${projectId}::uuid, p_code => ${after.code},
        p_name => ${after.name}, p_signing_deadline => ${after.signingDeadline}::date,
        p_default_tg_start => ${after.defaultTgStart}::date,
        p_default_tg_end => ${after.defaultTgEnd}::date,
        p_latest_entry_date => ${after.latestEntryDate}::date,
        p_context => ${auditContext(user.id, requestId)}`;
      if (waveId === null) return { id: await callFunction(tx, sql`create_entry_wave(${args})`) };
      await callFunction(tx, sql`update_entry_wave(p_id => ${waveId}::uuid, ${args})`);
      return { id: waveId };
    })
    .catch((error: unknown) => {
      const code = functionRefusal(error);
      // Deleted meanwhile: never a 422 or a 500.
      if (code === "project_not_found" || code === "wave_not_found") return null;
      if (code !== undefined && waveRefusals.has(code)) return { issues: [code] };
      throw error;
    });
}

export function entryWaveRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const editProblems = [
    "validation-error",
    "unauthenticated",
    "forbidden",
    "not-found",
    "unsupported-media-type",
    "domain-error",
  ] as const;

  /** Members and global org roles see a project's waves; only its PL edits them (5.4). */
  const access = (user: StaffUser, projectId: string, edit: boolean) =>
    projectDenial(db, user, projectId, edit ? { kind: "editEntryWaves" } : undefined);

  /** The written wave, or the problem. */
  async function respond<S extends 200 | 201>(
    c: Parameters<typeof problem>[0],
    result: Awaited<ReturnType<typeof writeWave>>,
    status: S,
  ) {
    if (result === null) return problem(c, "not-found");
    if ("issues" in result) return domainProblem(c, result.issues);
    const [written] = await db.select(columns).from(wave).where(eq(wave.id, result.id));
    return c.json(written!, status);
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/entry-waves",
      tags: ["entry-waves"],
      summary: "The project's entry waves in creation order (cursor pagination)",
      middleware,
      request: { params: ProjectParams, query: PageQuery },
      responses: {
        200: json(WavePage, "A page of entry waves"),
        ...problemResponses("validation-error", "unauthenticated", "not-found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { limit, cursor: rawCursor } = c.req.valid("query");
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Malformed cursor" }],
        });
      }
      if (await access(sessionUser(c), projectId, false)) return problem(c, "not-found");
      const rows = await db
        .select(columns)
        .from(wave)
        .where(
          and(
            eq(wave.projectId, projectId),
            cursor &&
              sql`(${wave.createdAt}, ${wave.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
          ),
        )
        .orderBy(asc(wave.createdAt), asc(wave.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return c.json({ items, nextCursor }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/entry-waves",
      tags: ["entry-waves"],
      summary: "Create an entry wave (ta_tg only; the rules of plan 5.6)",
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: CreateEntryWaveInput } } },
      },
      responses: {
        201: json(EntryWaveRecord, "The created wave"),
        ...problemResponses(...editProblems),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const user = sessionUser(c);
      const denied = await access(user, projectId, true);
      if (denied) return problem(c, denied);
      const change = { projectId, waveId: null, input: c.req.valid("json") };
      return respond(c, await writeWave(deps, user, c.get("requestId"), change), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/projects/{projectId}/entry-waves/{waveId}",
      tags: ["entry-waves"],
      summary: "Change an entry wave's code, name or dates (null clears a date; plan 5.6)",
      middleware,
      request: {
        params: WaveParams,
        body: { required: true, content: { "application/json": { schema: UpdateEntryWaveInput } } },
      },
      responses: {
        200: json(EntryWaveRecord, "The changed wave"),
        ...problemResponses(...editProblems),
      },
    }),
    async (c) => {
      const { projectId, waveId } = c.req.valid("param");
      const user = sessionUser(c);
      const denied = await access(user, projectId, true);
      if (denied) return problem(c, denied);
      const change = { projectId, waveId, input: c.req.valid("json") };
      return respond(c, await writeWave(deps, user, c.get("requestId"), change), 200);
    },
  );

  return router;
}
