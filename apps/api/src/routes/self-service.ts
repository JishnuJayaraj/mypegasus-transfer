import { createRoute, z } from "@hono/zod-openapi";
import { asc, consentRecord, eq, sql } from "@transfer/db";
import {
  completePageValues,
  ConfidentialPage,
  contactFields,
  decideAccess,
  pageValuesSchema,
  ParticipationSelfService,
  PortalConsents,
  PortalSelfService,
  PortalSelfServiceWrite,
  SELF_SERVICE_NOTICE_VERSION,
  selfServiceMissing,
  SelfServiceNoticeInput,
  SelfServicePageInput,
  selfServiceValueSchemas,
  selfServiceWizard,
  valueIssueCode,
  valueWarnings,
  type SelfServiceField,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { loadSelfService, type SelfServiceRecord } from "../participations/self-service";
import { portalSession, requirePortalSession } from "../portal-session";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";
import { utc } from "../sql";

// Self-service data (data-protection.md, self-service; Q112, Q138, Q140): the participant's wizard
// in the portal and the staff's normal-mode projection. Confidential data only: a highly
// confidential or special-category key is unknown here (422) and no response carries one. The
// functions check the session, the notice and the revision again under their locks.

const PageParams = z.object({ page: ConfidentialPage });
const ParticipationParams = z.object({ participationId: z.uuid() });

/** The participant's audit context (ADR-0002): the participation acts for itself. */
const participantContext = (participationId: string, requestId: string) =>
  sql`row('participant'::actor_type, null::uuid, ${participationId}::uuid, null::text, null::uuid,
    ${requestId}::text, null::text)::audit_context`;

/** The wizard state the portal shows. */
function portalState(record: SelfServiceRecord) {
  const { pages, missing } = selfServiceWizard(record.wizard);
  return {
    revision: record.revision,
    notice: { version: SELF_SERVICE_NOTICE_VERSION, acknowledged: record.acknowledgedAt !== null },
    identity: record.identity,
    values: record.values,
    customValues: record.customValues,
    pages,
    missing,
  };
}

/** Where a page value is in the body, as a domain problem's field. */
const at = (path: PropertyKey[]) => ["values", ...path.map(String)].join("/");

/** 409 with the code (a stale revision, the notice not acknowledged). */
const conflict = (c: Context<AppEnv>, code: string) =>
  problem(c, "conflict", { errors: [{ pointer: "", code, detail: "Read the state again" }] });

/** A refusal of the self-service functions as its problem, or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "session_invalid") return problem(c, "unauthenticated");
  if (code === "stale_revision" || code === "notice_required") return conflict(c, code);
  if (code === "participation_closed") return domainProblem(c, [code]);
  throw error;
}

export function selfServiceRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const release = loadRelease(deps.env.configDir);
  const active = [requirePortalSession(deps, "active")];

  router.openapi(
    createRoute({
      method: "get",
      path: "/portal/self-service",
      tags: ["portal"],
      summary:
        "The wizard: pages with their fields and requirements, the confidential values, missing items (codes), the notice state and the revision",
      middleware: active,
      responses: {
        200: json(PortalSelfService, "The wizard state"),
        ...problemResponses("unauthenticated"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const record = (await loadSelfService(db, release, portalSession(c).participationId))!;
      return c.json(portalState(record), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/portal/self-service/pages/{page}",
      tags: ["portal"],
      summary:
        "Save one confidential page whole into the real fields; 409 stale_revision or notice_required",
      middleware: active,
      request: {
        params: PageParams,
        body: {
          required: true,
          content: { "application/json": { schema: SelfServicePageInput } },
        },
      },
      responses: {
        200: json(PortalSelfServiceWrite, "Saved; the state, with warnings on what was saved"),
        ...problemResponses("validation-error", "unauthenticated", "conflict", "domain-error"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const session = portalSession(c);
      const { page } = c.req.valid("param");
      const input = c.req.valid("json");
      const record = (await loadSelfService(db, release, session.participationId))!;
      const parsed = pageValuesSchema(page, record.customValidators).safeParse(input.values);
      if (!parsed.success) {
        // Each issue's code and location under `/values`, never the value (ADR-0010).
        return domainProblem(
          c,
          parsed.error.issues.flatMap((issue) => {
            if (issue.code === "unrecognized_keys") {
              return issue.keys.map((key) => ({
                code: "unknown_field",
                field: at([...issue.path, key]),
              }));
            }
            return [{ code: valueIssueCode(issue), field: at(issue.path) }];
          }),
        );
      }
      const values = completePageValues(page, parsed.data, [...record.customValidators.keys()]);
      try {
        await db.execute(sql`select write_self_service_data(
          p_participation_id => ${session.participationId}::uuid,
          p_context => ${participantContext(session.participationId, c.get("requestId"))},
          p_page => ${page}, p_values => ${JSON.stringify(values)}::jsonb,
          p_revision => ${input.revision}::integer,
          p_notice_version => ${SELF_SERVICE_NOTICE_VERSION},
          p_token_hash => ${session.tokenHash}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      const after = (await loadSelfService(db, release, session.participationId))!;
      return c.json({ ...portalState(after), warnings: valueWarnings(parsed.data) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/self-service/notice",
      tags: ["portal"],
      summary: "Acknowledge the purposes notice (not a consent); once per version",
      middleware: active,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: SelfServiceNoticeInput } },
        },
      },
      responses: {
        204: { description: "Acknowledged" },
        ...problemResponses("validation-error", "unauthenticated", "domain-error"),
      },
    }),
    async (c) => {
      const session = portalSession(c);
      const { version, language } = c.req.valid("json");
      try {
        await db.execute(sql`select acknowledge_self_service_notice(
          p_participation_id => ${session.participationId}::uuid,
          p_context => ${participantContext(session.participationId, c.get("requestId"))},
          p_notice_version => ${version}, p_language => ${language}::notice_language,
          p_id => ${randomUUID()}::uuid, p_token_hash => ${session.tokenHash}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      return c.body(null, 204);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/portal/consents",
      tags: ["portal"],
      summary: "The participant's own consents: purpose, source, version, given and ended",
      middleware: active,
      responses: {
        200: json(PortalConsents, "The consents, oldest first"),
        ...problemResponses("unauthenticated"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const consents = await db
        .select({
          id: consentRecord.id,
          purpose: consentRecord.purpose,
          source: consentRecord.source,
          textVersion: consentRecord.textVersion,
          language: consentRecord.language,
          channelId: consentRecord.channelId,
          givenAt: utc(consentRecord.givenAt),
          endedAt: utc(consentRecord.endedAt),
          endReason: consentRecord.endReason,
        })
        .from(consentRecord)
        .where(eq(consentRecord.participationId, portalSession(c).participationId))
        .orderBy(asc(consentRecord.givenAt), asc(consentRecord.id));
      return c.json({ consents }, 200);
    },
  );

  /**
   * The staff projection (data-protection.md, access matrix, normal mode): undefined for no
   * participation or a hidden project (404), null when the viewer may read no confidential
   * self-service field (403).
   */
  async function staffView(user: StaffUser, participationId: string) {
    const record = await loadSelfService(db, release, participationId);
    if (!record) return undefined;
    const { subject, visible, regionId } = await projectAccess(db, user, record.projectId);
    if (!visible) return undefined;
    const readable = (key: string) =>
      decideAccess(
        subject,
        {
          kind: "field",
          projectId: record.projectId,
          regionId,
          participationId,
          phase: "active",
          // A custom field is confidential at most (regional-variation.md, custom fields).
          field: key.startsWith("custom.") ? "gender" : key,
        },
        "read",
        { kind: "normal" },
      ).effect === "allow";
    const fields = Object.keys(selfServiceValueSchemas) as SelfServiceField[];
    // All confidential: no value here needs a logged read (decideAccess names none).
    const shown = fields.filter(readable);
    if (shown.length === 0) return null;
    return {
      participationId,
      revision: record.revision,
      updatedAt: record.updatedAt,
      notice: { version: SELF_SERVICE_NOTICE_VERSION, acknowledgedAt: record.acknowledgedAt },
      values: Object.fromEntries(shown.map((key) => [key, record.values[key]])),
      customValues: readable("custom.") ? record.customValues : {},
      participantMaintained: contactFields.filter((key) =>
        record.participantMaintained.includes(key),
      ),
      // Codes only; a field the viewer may not read isn't named either.
      missing: selfServiceMissing(record.wizard).filter(
        (item) => item.kind === "document" || readable(item.key),
      ),
    };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/self-service",
      tags: ["participations"],
      summary:
        "The participant's self-service data as the viewer may read it (normal mode), the maintained contact fields and the missing items (codes)",
      middleware: [requireSession(deps)],
      request: { params: ParticipationParams },
      responses: {
        200: json(ParticipationSelfService, "The self-service data"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const view = await staffView(sessionUser(c), c.req.valid("param").participationId);
      if (view === undefined) return problem(c, "not-found");
      if (view === null) return problem(c, "forbidden");
      c.header("Cache-Control", "no-store");
      return c.json(view, 200);
    },
  );

  return router;
}
