import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq, project, sql } from "@transfer/db";
import { CreateProjectInput, PageQuery, Project, page } from "@transfer/domain";

import { createRouter, type Deps } from "../context";
import { decodeCursor, encodeCursor } from "../cursor";
import { problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";

const ProjectPage = page(Project).meta({ id: "ProjectPage" });
const ProjectParams = z.object({ projectId: z.uuid() });

// createdAt as ISO 8601 UTC with the database's microseconds, so it doubles as an exact cursor.
const columns = {
  id: project.id,
  name: project.name,
  customerName: project.customerName,
  type: project.type,
  signingDeadline: project.signingDeadline,
  defaultTgStart: project.defaultTgStart,
  defaultTgEnd: project.defaultTgEnd,
  createdAt: sql<string>`to_char(${project.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  createdBy: project.createdBy,
};

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export function projectRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects",
      tags: ["projects"],
      summary: "Projects, newest first (cursor pagination)",
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
      const rows = await db
        .select(columns)
        .from(project)
        .where(
          cursor &&
            sql`(${project.createdAt}, ${project.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
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
      summary: "Create a project",
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
      const [created] = await db
        .insert(project)
        .values({ ...input, createdBy: sessionUser(c).id })
        .returning(columns);
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
      const [found] = await db.select(columns).from(project).where(eq(project.id, projectId));
      return found ? c.json(found, 200) : problem(c, "not-found");
    },
  );

  return router;
}
