import { createRoute, z } from "@hono/zod-openapi";
import { PinTemplateInput, ProjectConfig } from "@transfer/domain";
import { projectDenial } from "../access";
import { createRouter, json, type Deps } from "../context";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease, pinTemplate, projectConfig } from "../projects/template-pins";
import { requireSession, sessionUser } from "../session";

const ProjectParams = z.object({ projectId: z.uuid() });

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
      // Members and global org roles read the configuration (5.4, R9); the PL may also pin.
      const denied = await projectDenial(db, sessionUser(c), projectId, { kind: "pinTemplate" });
      if (denied === "not-found") return problem(c, "not-found");
      const config = await projectConfig(db, release, projectId, { mayPin: denied === undefined });
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
      const denied = await projectDenial(db, user, projectId, { kind: "pinTemplate" });
      if (denied) return problem(c, denied);
      const actor = { staffUserId: user.id, requestId: c.get("requestId") };
      const result = await pinTemplate(db, release, actor, projectId, c.req.valid("json"));
      if (result === null) return problem(c, "not-found");
      if (result !== true) return domainProblem(c, result.issues);
      const config = await projectConfig(db, release, projectId, { mayPin: true });
      return config ? c.json(config, 200) : problem(c, "not-found");
    },
  );

  return router;
}
