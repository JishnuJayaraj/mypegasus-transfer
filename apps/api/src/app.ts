import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import packageJson from "../package.json" with { type: "json" };
import { DevelopmentOutbox, MockMailer, MockSmsSender } from "@transfer/adapters";
import { createRouter, type Deps } from "./context";
import { originCheck } from "./csrf";
import { errorForLog, requestLogger } from "./logger";
import { createOidc } from "./oidc";
import { problem } from "./problem";
import { logoutRoutes, oidcRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import { configRoutes } from "./routes/config";
import { devRoutes } from "./routes/dev";
import { entryWaveRoutes } from "./routes/entry-waves";
import { healthRoutes } from "./routes/health";
import { importRoutes } from "./routes/imports";
import { meRoutes } from "./routes/me";
import { participationRoutes } from "./routes/participations";
import { projectConfigRoutes } from "./routes/project-config";
import { projectRoutes } from "./routes/projects";
import { teamRoutes } from "./routes/team";
import { activationRoutes } from "./routes/activation";
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
  // Activation QR codes are generated in the staff browser and rendered as data URLs.
  imgSrc: ["'self'", "data:"],
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
  const outbox =
    deps.outbox ??
    new DevelopmentOutbox(deps.clock, (fields, message) => logger.info(fields, message));
  // The mocks report `sent` without sending, which would record Art. 14 evidence for a message
  // nobody received: production gets no default sender until a real adapter exists (ADR-0006).
  const mocks = env.nodeEnv !== "production";
  const runtimeDeps: Deps = {
    ...deps,
    outbox,
    mailer: deps.mailer ?? (mocks ? new MockMailer(outbox) : undefined),
    smsSender: deps.smsSender ?? (mocks ? new MockSmsSender(outbox) : undefined),
  };
  const app = createRouter();

  app.use(requestLogger(logger));
  app.use(secureHeaders({ contentSecurityPolicy }));
  app.use("/api/*", originCheck(env.appOrigins));
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
  api.route("/", healthRoutes(runtimeDeps));
  api.route("/", meRoutes(runtimeDeps));
  api.route("/", logoutRoutes(runtimeDeps));
  if (env.authMode === "oidc") {
    const oidc = deps.oidc ?? createOidc(env.oidc!);
    api.route("/", oidcRoutes(runtimeDeps, oidc));
  }
  api.route("/", projectRoutes(runtimeDeps));
  api.route("/", entryWaveRoutes(runtimeDeps));
  api.route("/", configRoutes(runtimeDeps));
  api.route("/", projectConfigRoutes(runtimeDeps));
  api.route("/", importRoutes(runtimeDeps));
  api.route("/", participationRoutes(runtimeDeps));
  api.route("/", teamRoutes(runtimeDeps));
  api.route("/", adminRoutes(runtimeDeps));
  api.route("/", activationRoutes(runtimeDeps));
  if (env.authMode === "dev") api.route("/", devRoutes(runtimeDeps));
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
    const requestId = c.get("requestId");
    logger.error({ requestId, error: errorForLog(error) }, "unhandled error");
    return problem(c, "internal-error", { instance: `urn:request:${requestId}` });
  });

  return app;
}
