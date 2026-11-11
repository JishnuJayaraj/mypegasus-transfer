import { createRoute, z } from "@hono/zod-openapi";
import { participation, project, sql, eq } from "@transfer/db";
import {
  FundingRequest,
  FundingView,
  mayReadFunding,
  mayRecordFunding,
  SettlementDatesRequest,
  SettlementDatesView,
  settlementDatesRequired,
  type Funded110,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// Retention's inputs (data-protection.md, funding and settlement dates; Q52, Q217): the project's
// settlement dates and a participation's §110 funding, recorded by back office against the values
// read. Order as in ADR-0010: schema → visibility (404) → permission (403) → state (409 for what
// moved since it was read, 422 for a domain rule). The functions check the role and the values
// again under the locks. Logs carry ids and codes, never a source or a date.

const ProjectParams = z.object({ projectId: z.uuid() });
const ParticipationParams = z.object({ participationId: z.uuid() });

const context = (c: Context<AppEnv>) =>
  auditContext(sessionUser(c).id, c.get("requestId") as string);

const stale = (c: Context<AppEnv>, code: string) =>
  problem(c, "conflict", {
    errors: [{ pointer: "/expected", code, detail: "Read the values again" }],
  });

const fundingView = (
  found: { funded110: Funded110; source: string | null; setAt: string | null },
  canSet: boolean,
): FundingView => ({
  funded110: found.funded110,
  source: found.source,
  setAt: found.setAt === null ? null : new Date(found.setAt).toISOString(),
  capabilities: { set: canSet },
});

export function retentionRoutes(deps: Deps) {
  const { db, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  async function settlementView(projectId: string, canSet: boolean): Promise<SettlementDatesView> {
    const [dates] = await db
      .select({
        kugFinalSettlementDate: project.kugFinalSettlementDate,
        measure110SettlementDate: project.measure110SettlementDate,
      })
      .from(project)
      .where(eq(project.id, projectId));
    const { rows } = await db.execute<{ entered: boolean; fundings: Funded110[] }>(
      sql`select coalesce(bool_or(p.tg_entry_date is not null), false) as entered,
        coalesce(array_agg(distinct p.funded110::text), '{}') as fundings
        from participation p where p.project_id = ${projectId}::uuid`,
    );
    return {
      ...dates!,
      required: settlementDatesRequired({
        anyEnteredTg: rows[0]!.entered,
        fundings: rows[0]!.fundings,
      }),
      capabilities: { set: canSet },
    };
  }

  async function projectFor(c: Context<AppEnv>, projectId: string) {
    const access = await projectAccess(db, sessionUser(c), projectId);
    if (!access.visible) return undefined;
    const target = { projectId, regionId: access.regionId, participationId: null };
    return { canSet: mayRecordFunding(access.subject, target).ok };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/settlement-dates",
      tags: ["projects"],
      summary:
        "The project's settlement dates (whoever sees the project), which of them apply (the final Transfer-KuG settlement when a participation entered the TG, the §110 settlement when one is funded known_yes) and whether a funding is still unknown",
      middleware,
      request: { params: ProjectParams },
      responses: {
        200: json(SettlementDatesView, "The settlement dates"),
        ...problemResponses("validation-error", "unauthenticated", "not-found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const found = await projectFor(c, projectId);
      if (!found) return problem(c, "not-found") as never;
      return c.json(await settlementView(projectId, found.canSet), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/projects/{projectId}/settlement-dates",
      tags: ["projects"],
      summary:
        "Set the project's settlement dates (back office; Q52) against the dates read; null clears one. Audited settlement_dates_set with the names of the dates set",
      description: [
        "Refusals, in this order:",
        "- `404`: the project is hidden from the viewer.",
        "- `403`: not back office of the project.",
        "- `409 stale_settlement_dates` at `/expected`: the dates changed since they were read.",
        "- `422 project_unchanged`: the dates are the ones recorded.",
      ].join("\n"),
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: SettlementDatesRequest } },
        },
      },
      responses: {
        200: json(SettlementDatesView, "Recorded"),
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
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const found = await projectFor(c, projectId);
      if (!found) return problem(c, "not-found") as never;
      const log = (outcome: string) =>
        logger.info({ requestId: c.get("requestId"), projectId, outcome }, "settlement dates");
      if (!found.canSet) {
        log("actor_not_allowed");
        return problem(c, "forbidden") as never;
      }
      try {
        await db.execute(sql`select set_settlement_dates(p_context => ${context(c)},
          p_project_id => ${projectId}::uuid,
          p_kug_final => ${input.kugFinalSettlementDate}::date,
          p_measure110 => ${input.measure110SettlementDate}::date,
          p_expected_kug_final => ${input.expected.kugFinalSettlementDate}::date,
          p_expected_measure110 => ${input.expected.measure110SettlementDate}::date)`);
      } catch (error) {
        const code = functionRefusal(error);
        if (code) log(code);
        if (code === "actor_not_allowed") return problem(c, "forbidden") as never;
        if (code === "stale_settlement_dates") return stale(c, code) as never;
        if (code === "project_unchanged") return domainProblem(c, [code]) as never;
        throw error;
      }
      log("set");
      return c.json(await settlementView(projectId, true), 200);
    },
  );

  async function participationFor(c: Context<AppEnv>, participationId: string) {
    const [found] = await db
      .select({
        projectId: participation.projectId,
        funded110: participation.funded110,
        source: participation.funded110Source,
        setAt: participation.funded110SetAt,
      })
      .from(participation)
      .where(eq(participation.id, participationId));
    if (!found) return undefined;
    const access = await projectAccess(db, sessionUser(c), found.projectId);
    if (!access.visible) return undefined;
    const target = { projectId: found.projectId, regionId: access.regionId, participationId };
    return {
      found,
      canRead: mayReadFunding(access.subject, target).ok,
      canSet: mayRecordFunding(access.subject, target).ok,
    };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/funding",
      tags: ["participations"],
      summary:
        "The participation's §110 funding with its documented source (back office and the PL; Q217): known_yes, known_no or unknown",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(FundingView, "The funding"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const result = await participationFor(c, participationId);
      if (!result) return problem(c, "not-found") as never;
      if (!result.canRead) return problem(c, "forbidden") as never;
      return c.json(fundingView(result.found, result.canSet), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/funding",
      tags: ["participations"],
      summary:
        "Record the participation's §110 funding with its documented source (back office; Q217) against the value and source read. Audited funding_status_set with the code, never the source. TG entry is never proof of Transfer-KuG",
      description: [
        "Refusals, in this order:",
        "- `404`: the participation is hidden from the viewer.",
        "- `403`: not back office of the project.",
        "- `409 stale_funding` at `/expected`: the funding changed since it was read.",
        "- `422 funding_unchanged`: the value and source are the ones recorded.",
      ].join("\n"),
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: FundingRequest } } },
      },
      responses: {
        200: json(FundingView, "Recorded"),
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
      const result = await participationFor(c, participationId);
      if (!result) return problem(c, "not-found") as never;
      const log = (outcome: string) =>
        logger.info({ requestId: c.get("requestId"), participationId, outcome }, "funding");
      if (!result.canSet) {
        log("actor_not_allowed");
        return problem(c, "forbidden") as never;
      }
      try {
        await db.execute(sql`select set_funding_status(p_context => ${context(c)},
          p_participation_id => ${participationId}::uuid,
          p_funded110 => ${input.funded110}::funded110, p_source => ${input.source},
          p_expected_funded110 => ${input.expected.funded110}::funded110,
          p_expected_source => ${input.expected.source})`);
      } catch (error) {
        const code = functionRefusal(error);
        if (code) log(code);
        if (code === "actor_not_allowed") return problem(c, "forbidden") as never;
        if (code === "stale_funding") return stale(c, code) as never;
        if (code === "funding_unchanged") return domainProblem(c, [code]) as never;
        throw error;
      }
      log("set");
      const after = await participationFor(c, participationId);
      return c.json(fundingView(after!.found, true), 200);
    },
  );

  return router;
}
