import { createRoute, z } from "@hono/zod-openapi";
import {
  and,
  desc,
  eq,
  participation,
  project,
  projectEntryWave,
  projectMembership,
  sql,
  type Database,
} from "@transfer/db";
import {
  checkProjectUpdate,
  CreateProjectInput,
  mayCreateProject,
  mayPerformOperation,
  PageQuery,
  Project,
  UpdateProjectInput,
  page,
} from "@transfer/domain";

import { hasGlobalOrgRole, seesProject, staffSubjectOf } from "../access";
import { createRouter, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { decodeCursor, encodeCursor } from "../cursor";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";

const ProjectPage = page(Project).meta({ id: "ProjectPage" });
const ProjectParams = z.object({ projectId: z.uuid() });

// Timestamps as ISO 8601 UTC with the database's microseconds; createdAt doubles as an exact cursor.
const utc = (column: typeof project.createdAt | typeof project.activatedAt) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const columns = {
  id: project.id,
  name: project.name,
  customerName: project.customerName,
  type: project.type,
  status: project.status,
  projectAgenturKey: project.projectAgenturKey,
  activatedAt: utc(project.activatedAt),
  createdAt: utc(project.createdAt),
  createdBy: project.createdBy,
};

/** The refusals of `update_project` (and `checkProjectUpdate`) that are a 422; others propagate. */
const projectRefusals: ReadonlySet<string> = new Set([
  "project_unchanged",
  "project_not_draft",
  "project_has_participations",
  "project_has_waves",
]);

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

/** Calls a setup function in `db` (a transaction or the pool); returns its result. */
async function callFunction(db: Pick<Database, "execute">, query: ReturnType<typeof sql>) {
  const { rows } = await db.execute<{ result: string }>(sql`select ${query} as result`);
  return rows[0]!.result;
}

const auditContext = (staffUserId: string, requestId: string) =>
  sql`row('user'::actor_type, ${staffUserId}::uuid, null::uuid, null::text, null::uuid,
    ${requestId}::text, null::text)::audit_context`;

/** The project's metadata, if the subject may see it (Q106); otherwise undefined (404). */
async function visibleProject(deps: Deps, user: Parameters<typeof staffSubjectOf>[1], id: string) {
  const subject = await staffSubjectOf(deps.db, user);
  if (!seesProject(subject, id)) return { subject, found: undefined };
  const [found] = await deps.db.select(columns).from(project).where(eq(project.id, id));
  return { subject, found };
}

export function projectRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects",
      tags: ["projects"],
      summary: "The projects the user may see, newest first (cursor pagination)",
      middleware,
      request: { query: PageQuery },
      responses: {
        200: json(ProjectPage, "A page of projects"),
        ...problemResponses("validation-error", "unauthenticated"),
      },
    }),
    async (c) => {
      const { limit, cursor: rawCursor } = c.req.valid("query");
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Malformed cursor" }],
        });
      }
      const user = sessionUser(c);
      const subject = await staffSubjectOf(db, user);
      const rows = await db
        .select(columns)
        .from(project)
        .where(
          and(
            cursor &&
              sql`(${project.createdAt}, ${project.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
            hasGlobalOrgRole(subject)
              ? undefined
              : sql`exists (select from ${projectMembership} where ${projectMembership.projectId} = ${project.id} and ${projectMembership.staffUserId} = ${user.id})`,
          ),
        )
        .orderBy(desc(project.createdAt), desc(project.id))
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
      path: "/projects",
      tags: ["projects"],
      summary: "Create a project; the creator becomes its PL",
      middleware,
      request: {
        body: { required: true, content: { "application/json": { schema: CreateProjectInput } } },
      },
      responses: {
        201: json(Project, "The created project"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "unsupported-media-type",
        ),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const user = sessionUser(c);
      // Q106: until Slice 3, staff with the flat role project_lead create projects.
      if (!mayCreateProject(user.role)) return problem(c, "forbidden");
      const id = await callFunction(
        db,
        sql`create_project(p_name => ${input.name}, p_customer_name => ${input.customerName},
          p_type => ${input.type}::project_type,
          p_context => ${auditContext(user.id, c.get("requestId"))})`,
      );
      const [created] = await db.select(columns).from(project).where(eq(project.id, id));
      return c.json(created!, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}",
      tags: ["projects"],
      summary: "One project",
      middleware,
      request: { params: ProjectParams },
      responses: {
        200: json(Project, "The project"),
        ...problemResponses("validation-error", "unauthenticated", "not-found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { found } = await visibleProject(deps, sessionUser(c), projectId);
      return found ? c.json(found, 200) : problem(c, "not-found");
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/projects/{projectId}",
      tags: ["projects"],
      summary: "Change name, customer or type (the type only while draft and unused, Q98)",
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: UpdateProjectInput } } },
      },
      responses: {
        200: json(Project, "The changed project"),
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
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const user = sessionUser(c);
      const { subject, found } = await visibleProject(deps, user, projectId);
      if (!found) return problem(c, "not-found");
      const target = { projectId, regionId: null, participationId: null };
      if (!mayPerformOperation(subject, { kind: "editProject" }, target).ok) {
        return problem(c, "forbidden");
      }
      const refused = await db
        .transaction(async (tx) => {
          // The domain check reads under the lock the function takes again (re-entrant).
          await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
          const [row] = await tx
            .select({
              status: project.status,
              type: project.type,
              participations: sql<number>`(select count(*)::int from ${participation} where ${participation.projectId} = ${projectId})`,
              waves: sql<number>`(select count(*)::int from ${projectEntryWave} where ${projectEntryWave.projectId} = ${projectId})`,
            })
            .from(project)
            .where(eq(project.id, projectId));
          const { status, type, ...usage } = row!;
          const refusals = checkProjectUpdate({ status, type }, usage, input);
          if (refusals.length) return refusals;
          await callFunction(
            tx,
            sql`update_project(p_id => ${projectId}::uuid,
              p_context => ${auditContext(user.id, c.get("requestId"))},
              p_name => ${input.name ?? null}::text,
              p_customer_name => ${input.customerName ?? null}::text,
              p_type => ${input.type ?? null}::project_type)`,
          );
          return [];
        })
        .catch((error: unknown) => {
          const code = functionRefusal(error);
          // Deleted meanwhile: never a 422 or a 500 (projects aren't deleted before Slice 7).
          if (code === "project_not_found") return null;
          if (code !== undefined && projectRefusals.has(code)) return [code];
          throw error;
        });
      if (refused === null) return problem(c, "not-found");
      if (refused.length) return domainProblem(c, refused);
      const [changed] = await db.select(columns).from(project).where(eq(project.id, projectId));
      return c.json(changed!, 200);
    },
  );

  return router;
}
