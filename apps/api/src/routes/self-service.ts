import { createRoute, z } from "@hono/zod-openapi";
import { asc, consentRecord, eq, participation, sql } from "@transfer/db";
import {
  completePageValues,
  completeSensitiveValues,
  ConfidentialPage,
  contactFields,
  decideAccess,
  pageValuesSchema,
  ParticipationSelfService,
  ParticipationSensitiveQuery,
  ParticipationSensitiveValues,
  PortalConsents,
  PortalSelfService,
  PortalSelfServiceWrite,
  PortalSensitiveValues,
  SELF_SERVICE_NOTICE_VERSION,
  selfServiceMissing,
  SelfServiceNoticeInput,
  SelfServicePageInput,
  selfServiceValueSchemas,
  selfServiceWizard,
  sensitiveFieldsOf,
  sensitiveFieldsWhere,
  SensitivePage,
  staffSelfServiceAccess,
  sensitiveValuesSchema,
  valueIssueCode,
  valueWarnings,
  type PortalStepUp,
  type SelfServiceField,
  type SensitiveField,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { fieldEncryptionKey } from "../field-encryption";
import { loadSelfService, type SelfServiceRecord } from "../participations/self-service";
import { portalSession, portalStepUp, requirePortalSession } from "../portal-session";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";
import { auditContext, utc } from "../sql";

// Self-service data (data-protection.md, self-service; Q112, Q135, Q138, Q140): the participant's
// wizard in the portal and the staff's normal-mode projection. A highly confidential or
// special-category value travels only on the sensitive routes (decrypted and encrypted by the
// database functions, each field read or written audited); a page write doesn't know those keys
// (422) and every other response carries their presence only. The functions check the session,
// the step-up, the notice and the revision again under their locks.

const PageParams = z.object({ page: ConfidentialPage });
const GroupParams = z.object({ group: SensitivePage });
const ParticipationParams = z.object({ participationId: z.uuid() });
const ParticipationGroupParams = z.object({ participationId: z.uuid(), group: SensitivePage });

/** The participant's audit context (ADR-0002): the participation acts for itself. */
const participantContext = (participationId: string, requestId: string) =>
  sql`row('participant'::actor_type, null::uuid, ${participationId}::uuid, null::text, null::uuid,
    ${requestId}::text, null::text)::audit_context`;

/** The wizard state the portal shows: sensitive fields by presence only. */
function portalState(record: SelfServiceRecord, stepUp: PortalStepUp) {
  const { pages, missing } = selfServiceWizard(record.wizard);
  return {
    revision: record.revision,
    notice: { version: SELF_SERVICE_NOTICE_VERSION, acknowledged: record.acknowledgedAt !== null },
    identity: record.identity,
    values: record.values,
    customValues: record.customValues,
    sensitive: record.sensitive,
    stepUp,
    pages,
    missing,
  };
}

/** Field keys as a Postgres array literal (a JS array would expand into a list). */
export const textArray = (keys: readonly string[]) => `{${keys.join(",")}}`;

/** Where a page value is in the body, as a domain problem's field. */
const at = (path: PropertyKey[]) => ["values", ...path.map(String)].join("/");

/** Each issue's code and location under `/values`, never the value (ADR-0010). */
export const valueIssues = (issues: readonly z.core.$ZodIssue[]) =>
  issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ code: "unknown_field", field: at([...issue.path, key]) }));
    }
    return [{ code: valueIssueCode(issue), field: at(issue.path) }];
  });

/** 409 with the code (a stale revision, the notice not acknowledged). */
export const conflict = (c: Context<AppEnv>, code: string) =>
  problem(c, "conflict", { errors: [{ pointer: "", code, detail: "Read the state again" }] });

/** 403 until the session's step-up before special-category data (Q137). */
const stepUpRequired = (c: Context<AppEnv>) =>
  problem(c, "forbidden", {
    errors: [{ pointer: "", code: "step_up_required", detail: "Step up first" }],
  });

/** A refusal of the self-service functions as its problem, or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "session_invalid") return problem(c, "unauthenticated");
  if (code === "stale_revision" || code === "notice_required") return conflict(c, code);
  if (code === "participation_closed") return domainProblem(c, [code]);
  throw error;
}

/** A refusal of the sensitive read: a dead session, or the step-up missing; else rethrown. */
function readRefused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "session_invalid") return problem(c, "unauthenticated");
  if (code === "step_up_required") return stepUpRequired(c);
  throw error;
}

export function selfServiceRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const release = loadRelease(deps.env.configDir);
  const active = [requirePortalSession(deps, "active")];
  const fieldKey = fieldEncryptionKey(deps.env.fieldEncryptionKey!);

  /** The participant's state after a read or write. */
  async function stateOf(participationId: string, tokenHash: string) {
    const [record, stepUp] = await Promise.all([
      loadSelfService(db, release, participationId),
      portalStepUp(db, tokenHash),
    ]);
    return portalState(record!, stepUp);
  }

  /**
   * Whether the participant may use the group now (data-protection.md, access matrix): the health
   * and disability fields need the session's step-up.
   */
  async function participantMay(group: SensitivePage, participationId: string, tokenHash: string) {
    const { done } = await portalStepUp(db, tokenHash);
    const subject = { kind: "participant", participationId, knowledgeCheckPassed: done } as const;
    return sensitiveFieldsOf(group).every(
      (field) =>
        decideAccess(
          subject,
          { kind: "field", projectId: "", regionId: null, participationId, phase: "active", field },
          "read",
          { kind: "normal" },
        ).effect === "allow",
    );
  }

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
      const session = portalSession(c);
      return c.json(await stateOf(session.participationId, session.tokenHash), 200);
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
      if (!parsed.success) return domainProblem(c, valueIssues(parsed.error.issues));
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
      const after = await stateOf(session.participationId, session.tokenHash);
      return c.json({ ...after, warnings: valueWarnings(parsed.data) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/portal/self-service/sensitive/{group}",
      tags: ["portal"],
      summary:
        "The group's highly confidential or special-category values, decrypted; each field's read is audited. health needs the step-up (403 step_up_required)",
      middleware: active,
      request: { params: GroupParams },
      responses: {
        200: json(PortalSensitiveValues, "The values"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const session = portalSession(c);
      const { group } = c.req.valid("param");
      if (!(await participantMay(group, session.participationId, session.tokenHash))) {
        return stepUpRequired(c);
      }
      let values: Partial<Record<SensitiveField, unknown>>;
      try {
        const { rows } = await db.execute<{ result: Partial<Record<SensitiveField, unknown>> }>(
          sql`select read_sensitive_fields(
            p_participation_id => ${session.participationId}::uuid,
            p_context => ${participantContext(session.participationId, c.get("requestId"))},
            p_keys => ${textArray(sensitiveFieldsOf(group))}::text[], p_key => ${fieldKey.key},
            p_key_id => ${fieldKey.keyId}, p_token_hash => ${session.tokenHash}) as result`,
        );
        values = rows[0]!.result;
      } catch (error) {
        return readRefused(c, error);
      }
      return c.json({ group, values } as z.infer<typeof PortalSensitiveValues>, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/portal/self-service/sensitive/{group}",
      tags: ["portal"],
      summary:
        "Save one sensitive group whole, encrypted; each changed field is audited. health needs the step-up (403 step_up_required); 409 stale_revision or notice_required",
      middleware: active,
      request: {
        params: GroupParams,
        body: {
          required: true,
          content: { "application/json": { schema: SelfServicePageInput } },
        },
      },
      responses: {
        200: json(PortalSelfServiceWrite, "Saved; the state, sensitive fields by presence"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const session = portalSession(c);
      const { group } = c.req.valid("param");
      const input = c.req.valid("json");
      if (!(await participantMay(group, session.participationId, session.tokenHash))) {
        return stepUpRequired(c);
      }
      const parsed = sensitiveValuesSchema(group).safeParse(input.values);
      if (!parsed.success) return domainProblem(c, valueIssues(parsed.error.issues));
      const values = completeSensitiveValues(group, parsed.data);
      try {
        await db.execute(sql`select write_sensitive_fields(
          p_participation_id => ${session.participationId}::uuid,
          p_context => ${participantContext(session.participationId, c.get("requestId"))},
          p_group => ${group}, p_values => ${JSON.stringify(values)}::jsonb,
          p_revision => ${input.revision}::integer,
          p_notice_version => ${SELF_SERVICE_NOTICE_VERSION}, p_key => ${fieldKey.key},
          p_key_id => ${fieldKey.keyId}, p_token_hash => ${session.tokenHash}) as result`);
      } catch (error) {
        if (functionRefusal(error) === "step_up_required") return stepUpRequired(c);
        return refused(c, error);
      }
      const after = await stateOf(session.participationId, session.tokenHash);
      return c.json({ ...after, warnings: [] }, 200);
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
   * The staff projection (data-protection.md, self-service, the "Selbstauskunft" tab): undefined
   * for no participation or a hidden project (404), null when the viewer may read no confidential
   * self-service field (403). Values the viewer reads in normal mode; whether each sensitive field
   * the viewer may know about is given, and which of them they may read (a logged read on its own
   * route); missing items as codes, for the fields the viewer may know about.
   */
  async function staffView(user: StaffUser, participationId: string) {
    const record = await loadSelfService(db, release, participationId);
    if (!record) return undefined;
    const { subject, visible, regionId } = await projectAccess(db, user, record.projectId);
    if (!visible) return undefined;
    const { reads, knows } = staffSelfServiceAccess(subject, {
      projectId: record.projectId,
      regionId,
      participationId,
    });
    const fields = Object.keys(selfServiceValueSchemas) as SelfServiceField[];
    // All confidential: no value here needs a logged read (decideAccess names none).
    const shown = fields.filter(reads);
    if (shown.length === 0) return null;
    const known = sensitiveFieldsWhere(knows);
    return {
      participationId,
      revision: record.revision,
      updatedAt: record.updatedAt,
      notice: { version: SELF_SERVICE_NOTICE_VERSION, acknowledgedAt: record.acknowledgedAt },
      values: Object.fromEntries(shown.map((key) => [key, record.values[key]])),
      customValues: reads("custom.") ? record.customValues : {},
      customLabels: reads("custom.")
        ? Object.fromEntries(
            Object.entries(record.wizard.customFields).map(([key, field]) => [key, field.label.de]),
          )
        : {},
      participantMaintained: contactFields.filter((key) =>
        record.participantMaintained.includes(key),
      ),
      sensitive: Object.fromEntries(known.map((key) => [key, record.sensitive[key]])),
      sensitiveReadable: sensitiveFieldsWhere(reads),
      // Codes only; a field the viewer may not know about isn't named either.
      missing: selfServiceMissing(record.wizard).filter(
        (item) => item.kind === "document" || knows(item.key),
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

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/self-service/sensitive/{group}",
      tags: ["participations"],
      summary:
        "The group's sensitive fields the viewer may read in normal mode (or the one `field`), decrypted; each field's read is audited (sensitive_read). The others are left out",
      middleware: [requireSession(deps)],
      request: { params: ParticipationGroupParams, query: ParticipationSensitiveQuery },
      responses: {
        200: json(ParticipationSensitiveValues, "The readable values"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { participationId, group } = c.req.valid("param");
      const { field: only } = c.req.valid("query");
      if (only !== undefined && !sensitiveFieldsOf(group).includes(only)) {
        return problem(c, "validation-error", {
          errors: [
            { parameter: "field", code: "unknown_field", detail: "Not a field of the group" },
          ],
        });
      }
      const [found] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      if (!found) return problem(c, "not-found");
      const { subject, visible, regionId } = await projectAccess(db, user, found.projectId);
      if (!visible) return problem(c, "not-found");
      // Normal mode (data-protection.md, access matrix): each allowed read is a logged one.
      const readable = (only === undefined ? sensitiveFieldsOf(group) : [only]).filter(
        (field) =>
          decideAccess(
            subject,
            {
              kind: "field",
              projectId: found.projectId,
              regionId,
              participationId,
              phase: "active",
              field,
            },
            "read",
            { kind: "normal" },
          ).effect === "allow",
      );
      if (readable.length === 0) return problem(c, "forbidden");
      let values: Partial<Record<SensitiveField, unknown>>;
      try {
        const { rows } = await db.execute<{ result: Partial<Record<SensitiveField, unknown>> }>(
          sql`select read_sensitive_fields(p_participation_id => ${participationId}::uuid,
            p_context => ${auditContext(user.id, c.get("requestId"))},
            p_keys => ${textArray(readable)}::text[], p_key => ${fieldKey.key}, p_key_id => ${fieldKey.keyId}) as result`,
        );
        values = rows[0]!.result;
      } catch (error) {
        if (functionRefusal(error) === "actor_not_allowed") return problem(c, "forbidden");
        throw error;
      }
      c.header("Cache-Control", "no-store");
      return c.json(
        { participationId, group, values } as z.infer<typeof ParticipationSensitiveValues>,
        200,
      );
    },
  );

  return router;
}
