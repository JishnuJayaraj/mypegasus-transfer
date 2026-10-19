import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import packageJson from "../package.json" with { type: "json" };
import { createRouter, type Deps } from "./context";
import { errorForLog, requestLogger } from "./logger";
import { problem } from "./problem";
import { configRoutes } from "./routes/config";
import { devRoutes } from "./routes/dev";
import { entryWaveRoutes } from "./routes/entry-waves";
import { healthRoutes } from "./routes/health";
import { importRoutes } from "./routes/imports";
import { meRoutes } from "./routes/me";
import { participationRoutes } from "./routes/participations";
import { projectConfigRoutes } from "./routes/project-config";
import { projectRoutes } from "./routes/projects";
import { mountSpas } from "./static";

export const openApiConfig = {
  openapi: "3.1.0",
  info: { title: "Transfer Platform API", version: packageJson.version },
};

/** Bodies are 100 kB, except the two import routes, which carry a base64 file (plan 5.11). */
const bodyLimits = { default: 100 * 1024, imports: 8 * 1024 * 1024 } as const;
const IMPORT_PATH = /^\/api\/v1\/projects\/[^/]+\/imports(\/preview)?$/;

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
  const limits = Object.fromEntries(
    Object.entries(bodyLimits).map(([name, maxSize]) => [
      name,
      bodyLimit({ maxSize, onError: (c) => problem(c, "payload-too-large") }),
    ]),
  ) as Record<keyof typeof bodyLimits, ReturnType<typeof bodyLimit>>;
  app.use("/api/*", (c, next) =>
    limits[IMPORT_PATH.test(c.req.path) ? "imports" : "default"](c, next),
  );
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
  api.route("/", entryWaveRoutes(deps));
  api.route("/", configRoutes(deps));
  api.route("/", projectConfigRoutes(deps));
  api.route("/", importRoutes(deps));
  api.route("/", participationRoutes(deps));
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
