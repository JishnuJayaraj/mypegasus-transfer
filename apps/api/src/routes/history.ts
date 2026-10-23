import { createRoute, z } from "@hono/zod-openapi";
import { eq, participation, sql } from "@transfer/db";
import {
  HistoryEntry,
  HistoryEventType,
  HistoryPage,
  historyStreamsOf,
  projectionOf,
  type StatusField,
} from "@transfer/domain";
import { projectAccess } from "../access";
import { createRouter, json, type Deps } from "../context";
import { historyCursor } from "../cursor";
import { functionRefusal } from "../database-errors";
import { problem, problemResponses } from "../problem";
import { requireSession, sessionHash, sessionUser } from "../session";

// A participation's audit history, the tab "Verlauf" (data-protection.md, audit metadata; Q157;
// ADR-0010). `audit_history` is the authorization boundary and returns only the final projection;
// this route checks visibility and permission first for the problem codes, then localizes nothing
// and removes nothing: it validates each row against the event type's projection.

const ParticipationParams = z.object({ participationId: z.uuid() });
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

type HistoryRow = {
  seq: string;
  occurred_at: string;
  event_type: string;
  actor_type: "user" | "participant" | "system";
  actor_name: string | null;
  system_job: string | null;
  on_behalf: boolean;
  field: StatusField | null;
  from_value: string | null;
  to_value: string | null;
  reason_code: string | null;
  effective_date: string | null;
  details: Record<string, string | string[] | null>;
};

const actorKind = { user: "staff", participant: "participant", system: "system" } as const;

/** A row as the client gets it; one the projection doesn't allow is an integrity error (a 500). */
export function historyEntry(row: HistoryRow): HistoryEntry {
  const type = HistoryEventType.parse(row.event_type);
  const shown = projectionOf(type, type === "status_changed" ? row.field : null);
  const hidden = Object.keys(row.details).filter((key) => !shown.detailKeys.includes(key));
  const changed = row.to_value !== null || row.from_value !== null || row.field !== null;
  if (
    hidden.length > 0 ||
    (changed && !shown.showsChange) ||
    (row.reason_code && !shown.showsReason)
  ) {
    throw new Error("audit_history returned more than the projection shows");
  }
  return HistoryEntry.parse({
    occurredAt: row.occurred_at,
    type,
    actor: {
      kind: actorKind[row.actor_type],
      name: row.actor_name,
      assisted: row.on_behalf,
      job: row.system_job,
    },
    change: changed ? { field: row.field, from: row.from_value, to: row.to_value } : null,
    reasonCode: row.reason_code,
    effectiveDate: row.effective_date,
    details: row.details,
  });
}

const refusals = {
  unauthenticated: "unauthenticated",
  not_member: "forbidden",
  not_assigned: "forbidden",
  participation_not_found: "not-found",
} as const;

export function historyRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/history",
      tags: ["participations"],
      summary:
        "The participation's audit history, newest first (an opaque cursor): the viewer's streams only, redacted by the database",
      middleware: [requireSession(deps)],
      request: { params: ParticipationParams, query: PageQuery },
      responses: {
        200: json(HistoryPage, "A page of the history"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const position = cursor === undefined ? undefined : historyCursor.decode(cursor);
      if (cursor !== undefined && !position) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Unknown cursor" }],
        });
      }
      const [row] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      if (!row) return problem(c, "not-found");
      const { subject, visible } = await projectAccess(db, sessionUser(c), row.projectId);
      if (!visible) return problem(c, "not-found");
      const { streams, ownStreams } = historyStreamsOf(subject, {
        projectId: row.projectId,
        participationId,
      });
      if (streams.length + ownStreams.length === 0) return problem(c, "forbidden");

      let rows: HistoryRow[];
      try {
        ({ rows } = await db.execute<HistoryRow>(sql`
          select seq::text, to_char(occurred_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
            event_type::text, actor_type::text, actor_name, system_job, on_behalf, field::text,
            from_value, to_value, reason_code, effective_date::text, details
          from audit_history(${sessionHash(c)}, ${participationId}::uuid,
            ${position?.before ?? null}::bigint, ${limit}::int, ${c.get("requestId")}::text)`));
      } catch (error) {
        const refusal = functionRefusal(error);
        if (refusal && refusal in refusals) {
          return problem(c, refusals[refusal as keyof typeof refusals]);
        }
        throw error;
      }
      const items = rows.map(historyEntry);
      const last = rows.at(-1);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        {
          items,
          nextCursor:
            rows.length === limit && last
              ? historyCursor.encode({ before: Number(last.seq) })
              : null,
        },
        200,
      );
    },
  );

  return router;
}
