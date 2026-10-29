import { createRoute, z } from "@hono/zod-openapi";
import {
  and,
  desc,
  eq,
  inArray,
  or,
  participation,
  project,
  projectEntryWave,
  projectMembership,
  sql,
} from "@transfer/db";
import {
  checkProjectUpdate,
  CreateProjectInput,
  hasGlobalOrgRole,
  mayPerformOperation,
  PageQuery,
  Project,
  projectCreationRefusals,
  regionChangeRefusal,
  seesProject,
  UpdateProjectInput,
  page,
  type StaffUser,
} from "@transfer/domain";

import { projectTarget, staffSubjectOf } from "../access";
import { createRouter, json, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { decodeCursor, encodeCursor } from "../cursor";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext, callFunction, utc } from "../sql";

const ProjectPage = page(Project).meta({ id: "ProjectPage" });
const ProjectParams = z.object({ projectId: z.uuid() });

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
  regionId: project.regionId,
  tKugNumber: project.tKugNumber,
  employerBetriebsnummer: project.employerBetriebsnummer,
  employerEconomicClass: project.employerEconomicClass,
};

/** The refusals of `update_project` (and `checkProjectUpdate`) that are a 422; others propagate. */
const projectRefusals: ReadonlySet<string> = new Set([
  "project_unchanged",
  "project_not_draft",
  "project_has_participations",
  "project_has_waves",
  "region_not_found",
]);

/** The project's metadata, if the subject may see it (Q106, Q126); otherwise undefined (404). */
async function visibleProject(deps: Deps, user: StaffUser, id: string) {
  const subject = await staffSubjectOf(deps.db, user);
  const [found] = await deps.db.select(columns).from(project).where(eq(project.id, id));
  if (!found || !seesProject(subject, found)) return { subject, found: undefined };
  return { subject, found };
}

/** The regions of the subject's regional org roles (global roles see every project anyway). */
const regionsOf = (subject: Awaited<ReturnType<typeof staffSubjectOf>>) =>
  [...subject.orgRoles.values()].flatMap(({ regionIds }) =>
    regionIds === "all" ? [] : [...regionIds],
  );

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
            // Members, the regional org roles of the project's region, global roles (Q126).
            hasGlobalOrgRole(subject)
              ? undefined
              : or(
                  sql`exists (select from ${projectMembership} where ${projectMembership.projectId} = ${project.id} and ${projectMembership.staffUserId} = ${user.id})`,
                  regionsOf(subject).length > 0
                    ? inArray(project.regionId, regionsOf(subject))
                    : undefined,
                ),
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
      summary: "Create a project in a region (Q126); the creator becomes its PL",
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
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const user = sessionUser(c);
      // Q126: staff whose account may create projects, set by the global admin.
      if (!user.mayCreateProjects) return problem(c, "forbidden");
      const refusals = projectCreationRefusals(input);
      if (refusals.length) return domainProblem(c, refusals);
      const id = await callFunction(
        db,
        sql`create_project(p_name => ${input.name}, p_customer_name => ${input.customerName},
          p_type => ${input.type}::project_type, p_region_id => ${input.regionId!}::uuid,
          p_context => ${auditContext(user.id, c.get("requestId"))})`,
      ).catch((error: unknown) => {
        if (functionRefusal(error) === "region_not_found") return null;
        throw error;
      });
      if (id === null) return domainProblem(c, ["region_not_found"]);
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
      summary:
        "Change name, customer, type (only while draft and unused, Q98), region (the PL while draft, the global admin at any time, Q126) or the Kug 200a's header (T-Kug-Nummer, the employer's Betriebsnummer and Branche/WK; null clears)",
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
      const { regionId, tKugNumber, employerBetriebsnummer, employerEconomicClass, ...fields } =
        input;
      // The Kug 200a's header (ba-forms.md, the Kug 200a as built): the keys sent, null clears.
      const kug200a = Object.fromEntries(
        Object.entries({ tKugNumber, employerBetriebsnummer, employerEconomicClass }).filter(
          ([, value]) => value !== undefined,
        ),
      );
      const target = projectTarget(projectId, found.regionId);
      const editsFields =
        Object.values(fields).some((value) => value !== undefined) ||
        Object.keys(kug200a).length > 0;
      if (editsFields && !mayPerformOperation(subject, { kind: "editProject" }, target).ok) {
        return problem(c, "forbidden");
      }
      const regionRefusal =
        regionId === undefined || regionId === found.regionId
          ? null
          : regionChangeRefusal(subject, found);
      if (regionRefusal === "forbidden") return problem(c, "forbidden");
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
          const refusals: string[] = checkProjectUpdate({ status, type }, usage, input);
          // Under the lock: the PL's region change only while draft (Q126).
          if (regionRefusal !== null && status !== "draft") refusals.push(regionRefusal);
          if (refusals.length) return refusals;
          await callFunction(
            tx,
            sql`update_project(p_id => ${projectId}::uuid,
              p_context => ${auditContext(user.id, c.get("requestId"))},
              p_name => ${input.name ?? null}::text,
              p_customer_name => ${input.customerName ?? null}::text,
              p_type => ${input.type ?? null}::project_type,
              p_region_id => ${regionId ?? null}::uuid,
              p_kug200a => ${Object.keys(kug200a).length > 0 ? JSON.stringify(kug200a) : null}::jsonb)`,
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
