import { HTTPException } from "hono/http-exception";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import packageJson from "../package.json" with { type: "json" };
import { createRouter, type Deps } from "./context";
import { errorForLog, requestLogger } from "./logger";
import { problem } from "./problem";
import { devRoutes } from "./routes/dev";
import { healthRoutes } from "./routes/health";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { mountSpas } from "./static";

export const openApiConfig = {
  openapi: "3.1.0",
  info: { title: "Transfer Platform API", version: packageJson.version },
};

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

/**
 * CSP for the SPAs and the API. Carbon needs no relaxation: Vite extracts all CSS into files,
 * and React's `style` props go through the CSSOM, which `style-src` doesn't restrict. Checked
 * in the e2e tests, which fail on any CSP violation.
 */
const contentSecurityPolicy = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/** The whole API with injected dependencies, so tests can use `app.request()`. */
export function createApp(deps: Deps) {
  const { env, logger } = deps;
  const app = createRouter();

  app.use(requestLogger(logger));
  app.use(secureHeaders({ contentSecurityPolicy }));
  app.use("/api/*", csrf({ origin: env.appOrigins }));
  app.use("/api/*", async (c, next) => {
    if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
      if (!JSON_CONTENT_TYPE.test(c.req.header("content-type") ?? "")) {
        return problem(c, "unsupported-media-type", { detail: "Send application/json" });
      }
    }
    await next();
  });

  const api = createRouter();
  api.route("/", healthRoutes(deps));
  api.route("/", meRoutes(deps));
  api.route("/", projectRoutes(deps));
  if (env.authMode === "dev") api.route("/", devRoutes(deps));
  app.route("/api/v1", api);

  if (env.nodeEnv !== "production") app.doc31("/api/v1/openapi.json", openApiConfig);
  if (deps.spa) mountSpas(app, deps.spa);

  app.notFound((c) => problem(c, "not-found"));
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return problem(c, "validation-error", {
        errors: [{ pointer: "", code: "malformed_json", detail: "The body is not valid JSON" }],
      });
    }
    if (error instanceof HTTPException && error.status === 403) return problem(c, "forbidden");
    const requestId = c.get("requestId");
    logger.error({ requestId, error: errorForLog(error) }, "unhandled error");
    return problem(c, "internal-error", { instance: `urn:request:${requestId}` });
  });

  return app;
}
