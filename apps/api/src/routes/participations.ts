import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, participantIdentity, participation, sql } from "@transfer/db";
import {
  decideAccess,
  PageQuery,
  ParticipationPage,
  type ParticipationListItem,
} from "@transfer/domain";
import { projectAccess } from "../access";
import { createRouter, json, type Deps } from "../context";
import { decodeCursor, encodeCursor } from "../cursor";
import { problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { utc } from "../sql";

const ProjectParams = z.object({ projectId: z.uuid() });
const personFields = ["personnelNumber", "lastName", "firstName"] as const;

export function participationRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/participations",
      tags: ["participations"],
      summary:
        "The project's participations in creation order (cursor pagination), with the person fields the viewer may list",
      middleware,
      request: { params: ProjectParams, query: PageQuery },
      responses: {
        200: json(ParticipationPage, "A page of participations"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
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
      const { subject, visible } = await projectAccess(db, sessionUser(c), projectId);
      if (!visible) return problem(c, "not-found");
      // A participation may be listed by those who may list its person fields (decideAccess): the
      // PL and back office. A viewer who may list none, like an unassigned consultant or an org
      // role, gets no participation at all (AC-33); the decision is made per row below too.
      const mayList = (participationId: string, field: (typeof personFields)[number]) =>
        decideAccess(
          subject,
          { kind: "field", projectId, regionId: null, participationId, phase: "active", field },
          "list",
          { kind: "normal" },
        ).effect === "allow";
      if (!personFields.some((field) => mayList(crypto.randomUUID(), field))) {
        return problem(c, "forbidden");
      }
      const rows = await db
        .select({
          id: participation.id,
          createdAt: utc(participation.createdAt),
          status: participation.status,
          profilingStatus: participation.profilingStatus,
          dsvStatus: participation.dsvStatus,
          entryWaveId: participation.entryWaveId,
          personnelNumber: participantIdentity.personnelNumber,
          lastName: participantIdentity.lastName,
          firstName: participantIdentity.firstName,
        })
        .from(participation)
        .leftJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
        .where(
          and(
            eq(participation.projectId, projectId),
            cursor &&
              sql`(${participation.createdAt}, ${participation.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
          ),
        )
        .orderBy(asc(participation.createdAt), asc(participation.id))
        .limit(limit + 1);
      const last = rows.slice(0, limit).at(-1);
      const items = rows
        .slice(0, limit)
        .map(({ createdAt: _createdAt, ...row }): ParticipationListItem => {
          const item: ParticipationListItem = {
            id: row.id,
            status: row.status,
            profilingStatus: row.profilingStatus,
            dsvStatus: row.dsvStatus,
            entryWaveId: row.entryWaveId,
          };
          for (const field of personFields) {
            const value = row[field];
            if (value !== null && mayList(row.id, field)) item[field] = value;
          }
          return item;
        });
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return c.json({ items, nextCursor }, 200);
    },
  );

  return router;
}
