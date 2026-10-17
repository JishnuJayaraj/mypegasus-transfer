import { createRoute, z } from "@hono/zod-openapi";
import {
  AgenturKey,
  checkAgenturSetting,
  PinTemplateInput,
  ProjectConfig,
  RemoveAgenturSettingQuery,
  SetAgenturSettingInput,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectOperations } from "../access";
import { createRouter, json, type Deps } from "../context";
import { domainProblem, problem, problemResponses } from "../problem";
import { changeAgenturSetting, type OverrideOutcome } from "../projects/overrides";
import { loadRelease, pinTemplate, projectConfig } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";

const ProjectParams = z.object({ projectId: z.uuid() });
const AgenturSettingParams = ProjectParams.extend({ agenturKey: AgenturKey });
/** What a user may do in a project's configuration (round 26). */
const operations = ["pinTemplate", "changeOverride"] as const;

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
      const may = await projectOperations(db, sessionUser(c), projectId, operations);
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
      const may = await projectOperations(db, user, projectId, operations);
      if (!may) return problem(c, "not-found");
      if (!may.pinTemplate) return problem(c, "forbidden");
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
    const may = await projectOperations(db, user, projectId, operations);
    if (!may) return problem(c, "not-found");
    if (!may.changeOverride) return problem(c, "forbidden");
    const issues = input ? checkAgenturSetting(input, deps.clock.today()) : [];
    if (issues.length) return domainProblem(c, issues);
    const change = { expectedVersion, setting: input && { ...input, confirmedBy: user.id } };
    const actor = { staffUserId: user.id, requestId: c.get("requestId") };
    const outcome: OverrideOutcome = await changeAgenturSetting(
      db,
      release,
      actor,
      projectId,
      agenturKey,
      change,
    );
    if ("problem" in outcome) return problem(c, outcome.problem);
    if ("issues" in outcome) return domainProblem(c, outcome.issues);
    const config = await projectConfig(db, release, projectId, may);
    return config ? c.json(config, 200) : problem(c, "not-found");
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

  return router;
}
