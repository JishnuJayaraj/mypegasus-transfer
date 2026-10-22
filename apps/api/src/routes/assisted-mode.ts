import { createRoute, z } from "@hono/zod-openapi";
import { and, assistedMode, eq, isNull, participation, sql, staffSession } from "@transfer/db";
import {
  AssistedModeQuery,
  AssistedModeView,
  AssistedSelfService,
  AssistedSelfServiceWrite,
  assistedFieldAccess,
  completePageValues,
  completeSensitiveValues,
  ConfidentialPage,
  confidentialFieldsOf,
  mayPerformOperation,
  pageValuesSchema,
  ParticipationSensitiveValues,
  restrictWizard,
  SELF_SERVICE_NOTICE_VERSION,
  SelfServiceNoticeInput,
  SelfServicePageInput,
  selfServiceWizard,
  sensitiveFieldsOf,
  SensitivePage,
  sensitiveValuesSchema,
  StartAssistedModeInput,
  terminalMainStatuses,
  valueWarnings,
  type SensitiveField,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { projectAccess, projectTarget } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { fieldEncryptionKey } from "../field-encryption";
import { loadSelfService, type SelfServiceRecord } from "../participations/self-service";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { requireSession, sessionHash, sessionUser } from "../session";
import { assistedContext, auditContext, utc } from "../sql";
import { conflict, textArray, valueIssues } from "./self-service";

// Assisted mode (ADR-0007, assisted mode; data-protection.md, self-service; Q136): the PL, the
// assigned consultant and back office open the participant's wizard after confirming the person is
// present or on the phone and asked for help. The mode is bound to the staff session; every
// assisted request names it (`assistedModeId`) and is refused without a live one of this session
// and participation (`403 assisted_mode_required`). Rights are the access matrix in mode
// `assisted`: a field the role can't see is left out, never shown empty. Writes are audited as
// actor and onBehalfOf; each sensitive field read or written as `sensitive_read`/`sensitive_write`
// with its key. The database functions check the mode, the roles and the fields again.

const ParticipationParams = z.object({ participationId: z.uuid() });
const PageParams = z.object({ participationId: z.uuid(), page: ConfidentialPage });
const GroupParams = z.object({ participationId: z.uuid(), group: SensitivePage });

/** 403 without a live assisted mode of this staff session and participation. */
const assistedModeRequired = (c: Context<AppEnv>) =>
  problem(c, "forbidden", {
    errors: [{ pointer: "", code: "assisted_mode_required", detail: "Start assisted mode first" }],
  });

/** A refusal of the self-service functions in assisted mode as its problem, or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "assisted_mode_required") return assistedModeRequired(c);
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code === "stale_revision" || code === "notice_required") return conflict(c, code);
  if (code === "participation_closed") return domainProblem(c, [code]);
  throw error;
}

/** A refusal of the logged read in assisted mode as its problem, or rethrown. */
function readRefused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "assisted_mode_required") return assistedModeRequired(c);
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  throw error;
}

/** The wizard as the role sees it in assisted mode: hidden fields left out everywhere. */
function assistedState(
  record: SelfServiceRecord,
  visible: (key: string) => boolean,
  assistedModeId: string,
) {
  const { pages, missing } = restrictWizard(selfServiceWizard(record.wizard), visible);
  const pick = <T extends object>(values: T) =>
    Object.fromEntries(Object.entries(values).filter(([key]) => visible(key))) as Partial<T>;
  return {
    participationId: record.id,
    assistedModeId,
    revision: record.revision,
    notice: { version: SELF_SERVICE_NOTICE_VERSION, acknowledged: record.acknowledgedAt !== null },
    identity: record.identity,
    values: pick(record.values),
    customValues: visible("custom.") ? record.customValues : {},
    sensitive: pick(record.sensitive),
    pages,
    missing,
  };
}

export function assistedModeRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const release = loadRelease(deps.env.configDir);
  const fieldKey = fieldEncryptionKey(deps.env.fieldEncryptionKey!);
  const staff = [requireSession(deps)];

  /** The participation as the user may see it (undefined: 404), with their access subject. */
  async function access(user: StaffUser, participationId: string) {
    const [found] = await db
      .select({ projectId: participation.projectId, status: participation.status })
      .from(participation)
      .where(eq(participation.id, participationId));
    if (!found) return undefined;
    const { subject, visible, regionId } = await projectAccess(db, user, found.projectId);
    if (!visible) return undefined;
    const target = { projectId: found.projectId, regionId, participationId };
    return { subject, target, status: found.status };
  }

  /**
   * The assisted request: the live mode it names (of this staff session and participation) and
   * what the role sees in it; else the problem to answer.
   */
  async function assisted(c: Context<AppEnv>, participationId: string, assistedModeId: string) {
    const user = sessionUser(c);
    const found = await access(user, participationId);
    if (!found) return { ok: false, response: problem(c, "not-found") } as const;
    const [live] = await db
      .select({ id: assistedMode.id })
      .from(assistedMode)
      .innerJoin(staffSession, eq(staffSession.tokenHash, assistedMode.staffSessionHash))
      .where(
        and(
          eq(assistedMode.id, assistedModeId),
          eq(assistedMode.participationId, participationId),
          eq(assistedMode.staffSessionHash, sessionHash(c)),
          isNull(assistedMode.endedAt),
          isNull(staffSession.endedAt),
          sql`${staffSession.expiresAt} > now()`,
        ),
      );
    if (!live) return { ok: false, response: assistedModeRequired(c) } as const;
    const visible = assistedFieldAccess(found.subject, found.target);
    // A role lost since the start (e.g. the assignment ended) sees nothing any more.
    if (!confidentialFieldsOf("personal").some(visible)) {
      return { ok: false, response: problem(c, "forbidden") } as const;
    }
    const context = assistedContext(user.id, participationId, c.get("requestId"));
    return { ok: true, user, visible, context, assistedModeId } as const;
  }

  async function stateOf(participationId: string, visible: (key: string) => boolean, id: string) {
    const record = (await loadSelfService(db, release, participationId))!;
    return assistedState(record, visible, id);
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/assisted-mode",
      tags: ["participations"],
      summary:
        "Open assisted mode after the confirmation (the person is present or on the phone and asked for help) and how; bound to this staff session, audited (assisted_mode_started)",
      middleware: staff,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: StartAssistedModeInput } },
        },
      },
      responses: {
        201: json(AssistedModeView, "Opened; every assisted request names its id"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { participationId } = c.req.valid("param");
      const { how } = c.req.valid("json");
      const found = await access(user, participationId);
      if (!found) return problem(c, "not-found");
      const { projectId, regionId } = found.target;
      const target = projectTarget(projectId, regionId, participationId);
      if (!mayPerformOperation(found.subject, { kind: "startAssistedMode" }, target).ok) {
        return problem(c, "forbidden");
      }
      if (terminalMainStatuses.has(found.status)) {
        return domainProblem(c, ["participation_closed"]);
      }
      let assistedModeId: string;
      try {
        const { rows } = await db.execute<{ result: string }>(sql`select start_assisted_mode(
          p_participation_id => ${participationId}::uuid,
          p_context => ${auditContext(user.id, c.get("requestId"))},
          p_staff_session_hash => ${sessionHash(c)}, p_how => ${how}::assisted_mode_how,
          p_id => ${randomUUID()}::uuid) as result`);
        assistedModeId = rows[0]!.result;
      } catch (error) {
        const code = functionRefusal(error);
        if (code === "participation_closed") return domainProblem(c, [code]);
        if (code === "actor_not_allowed") return problem(c, "forbidden");
        if (code === "session_invalid") return problem(c, "unauthenticated");
        throw error;
      }
      const [started] = await db
        .select({ startedAt: utc(assistedMode.startedAt) })
        .from(assistedMode)
        .where(eq(assistedMode.id, assistedModeId));
      c.header("Cache-Control", "no-store");
      return c.json({ assistedModeId, participationId, how, startedAt: started!.startedAt }, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/participations/{participationId}/assisted-mode",
      tags: ["participations"],
      summary:
        'End this staff session\'s assisted mode for the participation ("Beenden"), audited (assisted_mode_ended); none live is no error',
      middleware: staff,
      request: { params: ParticipationParams },
      responses: {
        204: { description: "Ended, or none was live" },
        ...problemResponses("validation-error", "unauthenticated", "not-found"),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { participationId } = c.req.valid("param");
      if (!(await access(user, participationId))) return problem(c, "not-found");
      await db.execute(sql`select end_assisted_mode(
        p_participation_id => ${participationId}::uuid,
        p_context => ${auditContext(user.id, c.get("requestId"))},
        p_staff_session_hash => ${sessionHash(c)}) as result`);
      return c.body(null, 204);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/assisted/self-service",
      tags: ["participations"],
      summary:
        "The wizard in assisted mode: pages, values, sensitive presence and missing items the role sees there; 403 assisted_mode_required without a live mode of this session",
      middleware: staff,
      request: { params: ParticipationParams, query: AssistedModeQuery },
      responses: {
        200: json(AssistedSelfService, "The wizard state"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const mode = await assisted(c, participationId, c.req.valid("query").assistedModeId);
      if (!mode.ok) return mode.response;
      c.header("Cache-Control", "no-store");
      return c.json(await stateOf(participationId, mode.visible, mode.assistedModeId), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/assisted/self-service/pages/{page}",
      tags: ["participations"],
      summary:
        "Save one confidential page whole on the participant's behalf (actor and onBehalfOf); 409 stale_revision or notice_required",
      middleware: staff,
      request: {
        params: PageParams,
        query: AssistedModeQuery,
        body: {
          required: true,
          content: { "application/json": { schema: SelfServicePageInput } },
        },
      },
      responses: {
        200: json(AssistedSelfServiceWrite, "Saved; the state, with warnings on what was saved"),
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
      c.header("Cache-Control", "no-store");
      const { participationId, page } = c.req.valid("param");
      const mode = await assisted(c, participationId, c.req.valid("query").assistedModeId);
      if (!mode.ok) return mode.response;
      const input = c.req.valid("json");
      const record = (await loadSelfService(db, release, participationId))!;
      const keys =
        page === "further" ? [...record.customValidators.keys()] : confidentialFieldsOf(page);
      if (!keys.every(mode.visible)) return problem(c, "forbidden");
      const parsed = pageValuesSchema(page, record.customValidators).safeParse(input.values);
      if (!parsed.success) return domainProblem(c, valueIssues(parsed.error.issues));
      const values = completePageValues(page, parsed.data, [...record.customValidators.keys()]);
      try {
        await db.execute(sql`select write_self_service_data(
          p_participation_id => ${participationId}::uuid, p_context => ${mode.context},
          p_page => ${page}, p_values => ${JSON.stringify(values)}::jsonb,
          p_revision => ${input.revision}::integer,
          p_notice_version => ${SELF_SERVICE_NOTICE_VERSION},
          p_token_hash => ${sessionHash(c)}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      const after = await stateOf(participationId, mode.visible, mode.assistedModeId);
      return c.json({ ...after, warnings: valueWarnings(parsed.data) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/assisted/self-service/sensitive/{group}",
      tags: ["participations"],
      summary:
        "The group's sensitive fields the role sees in assisted mode, decrypted; each field's read is audited (sensitive_read). The others are left out",
      middleware: staff,
      request: { params: GroupParams, query: AssistedModeQuery },
      responses: {
        200: json(ParticipationSensitiveValues, "The values"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId, group } = c.req.valid("param");
      const mode = await assisted(c, participationId, c.req.valid("query").assistedModeId);
      if (!mode.ok) return mode.response;
      const fields = sensitiveFieldsOf(group).filter(mode.visible);
      if (fields.length === 0) return problem(c, "forbidden");
      let values: Partial<Record<SensitiveField, unknown>>;
      try {
        const { rows } = await db.execute<{ result: Partial<Record<SensitiveField, unknown>> }>(
          sql`select read_sensitive_fields(p_participation_id => ${participationId}::uuid,
            p_context => ${mode.context}, p_keys => ${textArray(fields)}::text[],
            p_key => ${fieldKey.key}, p_key_id => ${fieldKey.keyId},
            p_token_hash => ${sessionHash(c)}) as result`,
        );
        values = rows[0]!.result;
      } catch (error) {
        return readRefused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(
        { participationId, group, values } as z.infer<typeof ParticipationSensitiveValues>,
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/assisted/self-service/sensitive/{group}",
      tags: ["participations"],
      summary:
        "Save the group's fields the role sees in assisted mode, encrypted; the others keep their values. Each changed field is audited (sensitive_write); 409 stale_revision or notice_required",
      middleware: staff,
      request: {
        params: GroupParams,
        query: AssistedModeQuery,
        body: {
          required: true,
          content: { "application/json": { schema: SelfServicePageInput } },
        },
      },
      responses: {
        200: json(AssistedSelfServiceWrite, "Saved; the state, sensitive fields by presence"),
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
      c.header("Cache-Control", "no-store");
      const { participationId, group } = c.req.valid("param");
      const mode = await assisted(c, participationId, c.req.valid("query").assistedModeId);
      if (!mode.ok) return mode.response;
      const fields = sensitiveFieldsOf(group).filter(mode.visible);
      if (fields.length === 0) return problem(c, "forbidden");
      const input = c.req.valid("json");
      const parsed = sensitiveValuesSchema(group, fields).safeParse(input.values);
      if (!parsed.success) return domainProblem(c, valueIssues(parsed.error.issues));
      const values = completeSensitiveValues(group, parsed.data, fields);
      try {
        await db.execute(sql`select write_sensitive_fields(
          p_participation_id => ${participationId}::uuid, p_context => ${mode.context},
          p_group => ${group}, p_values => ${JSON.stringify(values)}::jsonb,
          p_revision => ${input.revision}::integer,
          p_notice_version => ${SELF_SERVICE_NOTICE_VERSION}, p_key => ${fieldKey.key},
          p_key_id => ${fieldKey.keyId}, p_token_hash => ${sessionHash(c)}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      const after = await stateOf(participationId, mode.visible, mode.assistedModeId);
      return c.json({ ...after, warnings: [] }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/assisted/self-service/notice",
      tags: ["participations"],
      summary:
        "Acknowledge the purposes notice shown to the participant, on their behalf (not a consent); once per version",
      middleware: staff,
      request: {
        params: ParticipationParams,
        query: AssistedModeQuery,
        body: {
          required: true,
          content: { "application/json": { schema: SelfServiceNoticeInput } },
        },
      },
      responses: {
        204: { description: "Acknowledged" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const mode = await assisted(c, participationId, c.req.valid("query").assistedModeId);
      if (!mode.ok) return mode.response;
      const { version, language } = c.req.valid("json");
      try {
        await db.execute(sql`select acknowledge_self_service_notice(
          p_participation_id => ${participationId}::uuid, p_context => ${mode.context},
          p_notice_version => ${version}, p_language => ${language}::notice_language,
          p_id => ${randomUUID()}::uuid, p_token_hash => ${sessionHash(c)}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      return c.body(null, 204);
    },
  );

  return router;
}
