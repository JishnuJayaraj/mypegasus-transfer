import { createRoute, z } from "@hono/zod-openapi";
import { participation, sql, eq, type Database } from "@transfer/db";
import {
  LegalHoldRelease,
  LegalHoldRequest,
  LegalHoldsView,
  maySeeReview,
  mayPlaceLegalHold,
  mayReleaseLegalHold,
  type HoldableClass,
  type HoldRecordKind,
  type LegalHoldItem,
  type LegalHoldReason,
  type LegalHoldReviewItem,
  type Subject,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// Legal holds (data-protection.md, legal holds; Q218): on selected classes, record kinds or
// documents of one participation, never the whole participation; placed by the PL or back office
// with a reason code and the documented basis, released by another regional operations manager of
// the region with the instruction's source. Order as in ADR-0010: schema → visibility (404) →
// permission (403) → state (409 for what moved since it was read, 422 for a domain rule). The
// functions check the roles and the scope again under the locks. Logs carry ids and codes, never
// the basis or the source.

const ParticipationParams = z.object({ participationId: z.uuid() });
const HoldParams = z.object({ holdId: z.uuid() });

type HoldRow = {
  id: string;
  project_id: string;
  participation_id: string;
  classes: HoldableClass[];
  record_kinds: HoldRecordKind[];
  document_ids: string[];
  reason: LegalHoldReason;
  basis: string;
  placed_by: string;
  placed_on: string;
  released_on: string | null;
};

const holdColumns = sql`h.id, h.project_id, h.participation_id, h.classes, h.record_kinds,
  h.document_ids, h.reason, h.basis, h.placed_by,
  (h.placed_at at time zone 'Europe/Berlin')::date::text as placed_on,
  (h.released_at at time zone 'Europe/Berlin')::date::text as released_on`;

/** The active legal holds of the viewer's regions, for "Freigaben": no participant name or id. */
export async function legalHoldReviewItemsOf(
  db: Database,
  subject: Subject,
): Promise<LegalHoldReviewItem[]> {
  const { rows } = await db.execute<
    HoldRow & { project_name: string; region_id: string | null }
  >(sql`select ${holdColumns}, p.name as project_name, p.region_id
    from legal_hold h join project p on p.id = h.project_id
    where h.released_at is null order by h.placed_at, h.id`);
  return rows
    .filter((row) => maySeeReview(subject, { regionId: row.region_id }))
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      classes: row.classes,
      recordKinds: row.record_kinds,
      documentCount: row.document_ids.length,
      reason: row.reason,
      placedOn: row.placed_on,
      capabilities: {
        release: mayReleaseLegalHold(
          subject,
          {
            projectId: row.project_id,
            regionId: row.region_id,
            participationId: row.participation_id,
          },
          row.placed_by,
        ).ok,
      },
    }));
}

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

export function legalHoldRoutes(deps: Deps) {
  const { db, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  async function participationFor(c: Context<AppEnv>, participationId: string) {
    const [found] = await db
      .select({ projectId: participation.projectId, since: participation.evidenceSetSince })
      .from(participation)
      .where(eq(participation.id, participationId));
    if (!found) return undefined;
    const access = await projectAccess(db, sessionUser(c), found.projectId);
    if (!access.visible) return undefined;
    const target = { projectId: found.projectId, regionId: access.regionId, participationId };
    return { found, access, target, place: mayPlaceLegalHold(access.subject, target).ok };
  }

  async function view(
    found: NonNullable<Awaited<ReturnType<typeof participationFor>>>,
    participationId: string,
  ): Promise<LegalHoldsView> {
    const { rows } = await db.execute<HoldRow>(sql`select ${holdColumns} from legal_hold h
      where h.participation_id = ${participationId}::uuid order by h.placed_at, h.id`);
    const holds: LegalHoldItem[] = rows.map((row) => ({
      id: row.id,
      classes: row.classes,
      recordKinds: row.record_kinds,
      documentIds: row.document_ids,
      reason: row.reason,
      basis: found.place ? row.basis : null,
      placedOn: row.placed_on,
      releasedOn: row.released_on,
      capabilities: {
        release:
          row.released_on === null &&
          mayReleaseLegalHold(found.access.subject, found.target, row.placed_by).ok,
      },
    }));
    return {
      holds,
      evidenceSetSince:
        found.found.since === null ? null : new Date(found.found.since).toISOString(),
      capabilities: { place: found.place },
    };
  }

  const reads = (found: NonNullable<Awaited<ReturnType<typeof participationFor>>>) =>
    found.place || maySeeReview(found.access.subject, { regionId: found.access.regionId });

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/legal-holds",
      tags: ["participations"],
      summary:
        "The participation's legal holds (Q218): scope, reason code, dates; the documented basis for the PL and back office only. The PL, back office and the region's operations manager",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(LegalHoldsView, "The holds"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const found = await participationFor(c, participationId);
      if (!found) return problem(c, "not-found") as never;
      if (!reads(found)) return problem(c, "forbidden") as never;
      c.header("Cache-Control", "no-store");
      return c.json(await view(found, participationId), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/legal-holds",
      tags: ["participations"],
      summary:
        "Place a legal hold on selected classes, record kinds or documents of the participation (the PL or back office; Q218), never all of it, with a reason code and the documented basis, against the active holds read. Audited legal_hold_placed (security) with the scope and the code, never the basis",
      description: [
        "Refusals, in this order:",
        "- `404`: the participation is hidden from the viewer, or a document isn't one of its own.",
        "- `403`: not the PL or back office of the project.",
        "- `409 stale_holds` at `/expected`: the active holds changed since they were read.",
        "- `422 hold_scope_empty`: nothing selected; `hold_scope_too_broad`: every class at once.",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: LegalHoldRequest } } },
      },
      responses: {
        201: json(LegalHoldsView, "Placed"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const found = await participationFor(c, participationId);
      if (!found) return problem(c, "not-found") as never;
      const log = (outcome: string) =>
        logger.info({ requestId: c.get("requestId"), participationId, outcome }, "legal hold");
      if (!found.place) {
        log("actor_not_allowed");
        return problem(c, "forbidden") as never;
      }
      try {
        await db.execute(sql`select place_legal_hold(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid,
          p_classes => ${`{${input.classes.join(",")}}`}::text[],
          p_record_kinds => ${`{${input.recordKinds.join(",")}}`}::text[],
          p_document_ids => ${`{${input.documentIds.join(",")}}`}::uuid[],
          p_reason => ${input.reason}, p_basis => ${input.basis},
          p_expected_active => ${`{${input.expected.activeHoldIds.join(",")}}`}::uuid[])`);
      } catch (error) {
        const code = functionRefusal(error);
        if (code) log(code);
        if (code === "actor_not_allowed") return problem(c, "forbidden") as never;
        if (code === "document_not_found") return problem(c, "not-found") as never;
        if (code === "stale_holds") {
          return problem(c, "conflict", {
            errors: [{ pointer: "/expected", code, detail: "Read the holds again" }],
          }) as never;
        }
        if (code === "hold_scope_empty" || code === "hold_scope_too_broad") {
          return domainProblem(c, [code]) as never;
        }
        if (code === "evidence_set_phase") return domainProblem(c, [code]) as never;
        throw error;
      }
      log("placed");
      return c.json(
        await view((await participationFor(c, participationId))!, participationId),
        201,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/legal-holds/{holdId}/release",
      tags: ["participations"],
      summary:
        "Release a legal hold (a regional operations manager of the project's region who didn't place it; Q218) against a documented legal or DPO instruction. Audited legal_hold_released (security), never the source",
      description: [
        "Refusals, in this order:",
        "- `404`: the hold doesn't exist or its project is hidden from the viewer.",
        "- `403`: not a regional operations manager of the region, or the one who placed it.",
        "- `409 hold_released`: it was released already.",
      ].join("\n"),
      middleware,
      request: {
        params: HoldParams,
        body: { required: true, content: { "application/json": { schema: LegalHoldRelease } } },
      },
      responses: {
        204: { description: "Released" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
        ),
      },
    }),
    async (c) => {
      const { holdId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { rows } = await db.execute<HoldRow>(
        sql`select ${holdColumns} from legal_hold h where h.id = ${holdId}::uuid`,
      );
      const hold = rows[0];
      if (!hold) return problem(c, "not-found") as never;
      const access = await projectAccess(db, sessionUser(c), hold.project_id);
      if (!access.visible) return problem(c, "not-found") as never;
      const log = (outcome: string) =>
        logger.info({ requestId: c.get("requestId"), holdId, outcome }, "legal hold release");
      const target = {
        projectId: hold.project_id,
        regionId: access.regionId,
        participationId: hold.participation_id,
      };
      if (!mayReleaseLegalHold(access.subject, target, hold.placed_by).ok) {
        log("actor_not_allowed");
        return problem(c, "forbidden") as never;
      }
      try {
        await db.execute(sql`select release_legal_hold(p_context => ${context(c)},
          p_hold_id => ${holdId}::uuid, p_source => ${input.source})`);
      } catch (error) {
        const code = functionRefusal(error);
        if (code) log(code);
        if (code === "actor_not_allowed" || code === "four_eyes") {
          return problem(c, "forbidden") as never;
        }
        if (code === "hold_released") {
          return problem(c, "conflict", {
            errors: [{ pointer: "/", code, detail: "The hold was released already" }],
          }) as never;
        }
        throw error;
      }
      log("released");
      return c.body(null, 204) as never;
    },
  );

  return router;
}
