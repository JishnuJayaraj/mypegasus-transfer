import { createRoute, z } from "@hono/zod-openapi";
import {
  AgenturKey,
  checkAgenturSetting,
  DecideRelaxationInput,
  PinTemplateInput,
  ProjectConfig,
  RemoveAgenturSettingQuery,
  RemoveRelaxationQuery,
  RequestRelaxationInput,
  RuleId,
  SetAgenturSettingInput,
  WithdrawRelaxationInput,
  type Operation,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectPermissions } from "../access";
import { createRouter, json, type Deps } from "../context";
import { domainProblem, problem, problemResponses } from "../problem";
import {
  changeAgenturSetting,
  decideRelaxation,
  relaxationRequestOf,
  removeRelaxation,
  requestRelaxation,
  withdrawRelaxation,
  type OverrideOutcome,
} from "../projects/overrides";
import { loadRelease, pinTemplate, projectConfig } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";

const ProjectParams = z.object({ projectId: z.uuid() });
const AgenturSettingParams = ProjectParams.extend({ agenturKey: AgenturKey });
const RelaxationParams = ProjectParams.extend({ ruleId: RuleId });
const RequestParams = z.object({ requestId: z.uuid() });

export function projectConfigRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  // Read once (S2): a missing or invalid configuration fails the start, never a request.
  const release = loadRelease(deps.env.configDir);

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/config",
      tags: ["config"],
      summary: "The project's pinned templates, blockers per Agentur and activation blockers",
      middleware,
      request: { params: ProjectParams },
      responses: {
        200: json(ProjectConfig, "The project's configuration snapshot"),
        ...problemResponses("validation-error", "unauthenticated", "not-found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      // Members and global org roles read the configuration (5.4, R9); the PL may also change it.
      const may = await projectPermissions(db, sessionUser(c), projectId);
      const config = may && (await projectConfig(db, release, projectId, may));
      return config ? c.json(config, 200) : problem(c, "not-found");
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/config/pins",
      tags: ["config"],
      summary:
        "Pin an Agentur template from the catalog (its latest version unless chosen), optionally as the Project Agentur (plan 5.8)",
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: PinTemplateInput } } },
      },
      responses: {
        200: json(ProjectConfig, "The project's configuration after the pin"),
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
      const user = sessionUser(c);
      const may = await projectPermissions(db, user, projectId);
      if (!may) return problem(c, "not-found");
      if (!may({ kind: "pinTemplate" })) return problem(c, "forbidden");
      const actor = { staffUserId: user.id, requestId: c.get("requestId") };
      const result = await pinTemplate(db, release, actor, projectId, c.req.valid("json"));
      if (result === null) return problem(c, "not-found");
      if (result !== true) return domainProblem(c, result.issues);
      const config = await projectConfig(db, release, projectId, may);
      return config ? c.json(config, 200) : problem(c, "not-found");
    },
  );

  /**
   * Sets (`input`) or removes (null) an Agentur-scoped setting (5.9): visibility and the PL's
   * `changeOverride` (5.4) come first (404/403), then the setting's rules (R14, confirmed by the
   * acting user; round 27); a stale expected version is a 409, a refused rule a 422 (R21).
   * Answers with the configuration.
   */
  async function changeSetting(
    c: Context,
    projectId: string,
    agenturKey: string,
    expectedVersion: number,
    input: Omit<SetAgenturSettingInput, "expectedVersion"> | null,
  ) {
    const user = sessionUser(c);
    const may = await projectPermissions(db, user, projectId);
    if (!may) return problem(c, "not-found");
    if (!may({ kind: "changeOverride" })) return problem(c, "forbidden");
    const issues = input ? checkAgenturSetting(input, deps.clock.today()) : [];
    if (issues.length) return domainProblem(c, issues);
    const change = { expectedVersion, setting: input && { ...input, confirmedBy: user.id } };
    const outcome = await changeAgenturSetting(writer(c), projectId, agenturKey, change);
    return respond(c, outcome, projectId, may);
  }

  /** The acting staff user with this release (the services' `Writer`). */
  const writer = (c: Context) => ({
    db,
    release,
    actor: { staffUserId: sessionUser(c).id, requestId: c.get("requestId") as string },
  });

  /** A refusal per R21, else 200 with the project's configuration after the write. */
  async function respond<P extends "not-found" | "conflict" | "forbidden">(
    c: Context,
    outcome: OverrideOutcome<P>,
    projectId: string,
    may: (operation: Operation) => boolean,
  ) {
    if ("problem" in outcome) return problem(c, outcome.problem);
    if ("issues" in outcome) return domainProblem(c, outcome.issues);
    const config = await projectConfig(db, release, projectId, may);
    return config ? c.json(config, 200) : problem(c, "not-found");
  }

  /**
   * The project of a relaxation request and the user's checks there, when they can see it (404
   * otherwise, so neither the request nor its project is revealed).
   */
  async function requestAccess(c: Context, requestId: string) {
    const request = await relaxationRequestOf(db, requestId);
    const may = request && (await projectPermissions(db, sessionUser(c), request.projectId));
    return may && { ...request, may };
  }

  const settingProblems = [
    "validation-error",
    "unauthenticated",
    "forbidden",
    "not-found",
    "conflict",
    "domain-error",
  ] as const;

  router.openapi(
    createRoute({
      method: "put",
      path: "/projects/{projectId}/config/agentur-settings/{agenturKey}",
      tags: ["config"],
      summary:
        "Set an Agentur-scoped setting with its source and confirmation date, as a new override version (plan 5.9)",
      middleware,
      request: {
        params: AgenturSettingParams,
        body: {
          required: true,
          content: { "application/json": { schema: SetAgenturSettingInput } },
        },
      },
      responses: {
        200: json(ProjectConfig, "The project's configuration with the new override version"),
        ...problemResponses(...settingProblems, "unsupported-media-type"),
      },
    }),
    async (c) => {
      const { projectId, agenturKey } = c.req.valid("param");
      const { expectedVersion, ...input } = c.req.valid("json");
      return changeSetting(c, projectId, agenturKey, expectedVersion, input);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/projects/{projectId}/config/agentur-settings/{agenturKey}",
      tags: ["config"],
      summary: "Remove an Agentur-scoped setting, as a new override version (plan 5.9)",
      middleware,
      request: { params: AgenturSettingParams, query: RemoveAgenturSettingQuery },
      responses: {
        200: json(ProjectConfig, "The project's configuration with the new override version"),
        ...problemResponses(...settingProblems),
      },
    }),
    async (c) => {
      const { projectId, agenturKey } = c.req.valid("param");
      const { expectedVersion } = c.req.valid("query");
      return changeSetting(c, projectId, agenturKey, expectedVersion, null);
    },
  );

  const relaxationProblems = [
    "validation-error",
    "unauthenticated",
    "forbidden",
    "not-found",
    "domain-error",
  ] as const;
  const configAfter = json(ProjectConfig, "The project's configuration after the change");

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/config/relaxations",
      tags: ["config"],
      summary:
        "Request the relaxation of an operational_default rule with a controlled reason code (plan 5.9); it takes effect only once another person approves it",
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: RequestRelaxationInput } },
        },
      },
      responses: {
        200: configAfter,
        ...problemResponses(...relaxationProblems, "unsupported-media-type"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      // Visibility and the PL's operation first (404/403), then the rule (422; round 27).
      const may = await projectPermissions(db, sessionUser(c), projectId);
      if (!may) return problem(c, "not-found");
      if (!may({ kind: "requestRelaxation" })) return problem(c, "forbidden");
      const today = deps.clock.today();
      const outcome = await requestRelaxation(writer(c), projectId, c.req.valid("json"), today);
      return respond(c, outcome, projectId, may);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/config/relaxations/{requestId}/decision",
      tags: ["config"],
      summary:
        "Approve or reject a pending relaxation request (another person than the requester, R2); an approval adds the relaxation as a new override version",
      middleware,
      request: {
        params: RequestParams,
        body: {
          required: true,
          content: { "application/json": { schema: DecideRelaxationInput } },
        },
      },
      responses: {
        200: configAfter,
        ...problemResponses(...relaxationProblems, "conflict", "unsupported-media-type"),
      },
    }),
    async (c) => {
      const { requestId } = c.req.valid("param");
      const access = await requestAccess(c, requestId);
      if (!access) return problem(c, "not-found");
      // The regional operations manager, never the requester (four eyes, R2).
      if (!access.may({ kind: "decideRelaxation", requestedBy: access.requestedBy })) {
        return problem(c, "forbidden");
      }
      const today = deps.clock.today();
      const outcome = await decideRelaxation(writer(c), requestId, c.req.valid("json"), today);
      return respond(c, outcome, access.projectId, access.may);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/config/relaxations/{requestId}/withdrawal",
      tags: ["config"],
      summary: "Withdraw a pending relaxation request (plan 5.9)",
      middleware,
      request: {
        params: RequestParams,
        body: {
          required: true,
          content: { "application/json": { schema: WithdrawRelaxationInput } },
        },
      },
      responses: {
        200: configAfter,
        ...problemResponses(...relaxationProblems, "unsupported-media-type"),
      },
    }),
    async (c) => {
      const { requestId } = c.req.valid("param");
      const access = await requestAccess(c, requestId);
      if (!access) return problem(c, "not-found");
      if (!access.may({ kind: "withdrawRelaxation" })) return problem(c, "forbidden");
      const outcome = await withdrawRelaxation(writer(c), requestId);
      return respond(c, outcome, access.projectId, access.may);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/projects/{projectId}/config/relaxations/{ruleId}",
      tags: ["config"],
      summary:
        "Remove an approved relaxation (tightening, no approval), as a new override version (plan 5.9)",
      middleware,
      request: { params: RelaxationParams, query: RemoveRelaxationQuery },
      responses: {
        200: json(ProjectConfig, "The project's configuration with the new override version"),
        ...problemResponses(...relaxationProblems, "conflict"),
      },
    }),
    async (c) => {
      const { projectId, ruleId } = c.req.valid("param");
      const may = await projectPermissions(db, sessionUser(c), projectId);
      if (!may) return problem(c, "not-found");
      if (!may({ kind: "changeOverride" })) return problem(c, "forbidden");
      const { expectedVersion } = c.req.valid("query");
      const outcome = await removeRelaxation(writer(c), projectId, ruleId, expectedVersion);
      return respond(c, outcome, projectId, may);
    },
  );

  return router;
}
