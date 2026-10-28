import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import packageJson from "../package.json" with { type: "json" };
import {
  DevelopmentOutbox,
  MockMailer,
  MockSmsSender,
  type Clock,
  type Mailer,
  type SmsSender,
} from "@transfer/adapters";
import type { Logger } from "pino";
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
import { worklistRoutes } from "./routes/worklist";
import { historyRoutes } from "./routes/history";
import { reminderRoutes } from "./routes/reminders";
import { appointmentRoutes } from "./routes/appointments";
import { projectConfigRoutes } from "./routes/project-config";
import { projectRoutes } from "./routes/projects";
import { teamRoutes } from "./routes/team";
import { activationRoutes } from "./routes/activation";
import { portalRoutes } from "./routes/portal";
import { portalAppointmentRoutes } from "./routes/portal-appointments";
import { selfServiceRoutes } from "./routes/self-service";
import { assistedModeRoutes } from "./routes/assisted-mode";
import { createDetached } from "./detached";
import { documentFiles } from "./documents/files";
import { documentRoutes } from "./routes/documents";
import { profilingRoutes } from "./routes/profiling";
import { asuRoutes } from "./routes/asu";
import { formRoutes } from "./routes/forms";
import { formRegistry } from "./forms/registry";
import { mountSpas } from "./static";

export const openApiConfig = {
  openapi: "3.1.0",
  info: { title: "Transfer Platform API", version: packageJson.version },
};

/**
 * Bodies are 100 kB, except the two import routes and the three upload routes, which carry a
 * base64 file (ADR-0010, uploads).
 */
const bodyLimits = {
  default: 100 * 1024,
  imports: 8 * 1024 * 1024,
  uploads: 14 * 1024 * 1024,
} as const;
const IMPORT_PATH = /^\/api\/v1\/projects\/[^/]+\/imports(\/preview)?$/;
const UPLOAD_PATH =
  /^\/api\/v1\/(portal\/documents|participations\/[^/]+\/(assisted\/)?documents)$/;
/** A document download (Q147): its own, strictest headers. */
const DOCUMENT_CONTENT_PATH = /^\/api\/v1\/document-content\//;

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

/** A download is never rendered from our origin (Q147): no source at all, sandboxed. */
const downloadSecurityPolicy = { defaultSrc: ["'none'"], sandbox: [] as string[] };

/**
 * The senders: the mocks on a shared development outbox outside production. The mocks report
 * `sent` without sending, which would record Art. 14 evidence for a message nobody received:
 * production gets no sender until a real adapter exists (ADR-0006). The server builds them once for
 * the API and the jobs, so the dev outbox shows the activation notice too.
 */
export function messaging(
  { env, clock, logger }: { env: Pick<Deps["env"], "nodeEnv">; clock: Clock; logger: Logger },
  outbox = new DevelopmentOutbox(clock, (fields, message) => logger.info(fields, message)),
): { outbox: DevelopmentOutbox; mailer?: Mailer; smsSender?: SmsSender } {
  if (env.nodeEnv === "production") return { outbox };
  return { outbox, mailer: new MockMailer(outbox), smsSender: new MockSmsSender(outbox) };
}

/** The whole API with injected dependencies, so tests can use `app.request()`. */
export function createApp(deps: Deps) {
  const { env, logger } = deps;
  const defaults = messaging(deps, deps.outbox);
  const runtimeDeps: Deps = {
    ...deps,
    outbox: defaults.outbox,
    mailer: deps.mailer ?? defaults.mailer,
    smsSender: deps.smsSender ?? defaults.smsSender,
    detached: deps.detached ?? createDetached(logger),
    documentFiles: documentFiles(env, { storage: deps.fileStorage, scanner: deps.virusScanner }),
  };
  runtimeDeps.formRegistry ??= formRegistry(env.configDir);
  const app = createRouter();

  app.use(requestLogger(logger));
  const pageHeaders = secureHeaders({ contentSecurityPolicy });
  const downloadHeaders = secureHeaders({ contentSecurityPolicy: downloadSecurityPolicy });
  app.use((c, next) =>
    (DOCUMENT_CONTENT_PATH.test(c.req.path) ? downloadHeaders : pageHeaders)(c, next),
  );
  app.use("/api/*", originCheck(env.appOrigins));
  const limits = Object.fromEntries(
    Object.entries(bodyLimits).map(([name, maxSize]) => [
      name,
      bodyLimit({ maxSize, onError: (c) => problem(c, "payload-too-large") }),
    ]),
  ) as Record<keyof typeof bodyLimits, ReturnType<typeof bodyLimit>>;
  app.use("/api/*", (c, next) => {
    const path = c.req.path;
    const limit = IMPORT_PATH.test(path)
      ? "imports"
      : UPLOAD_PATH.test(path)
        ? "uploads"
        : "default";
    return limits[limit](c, next);
  });
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
  api.route("/", worklistRoutes(runtimeDeps));
  api.route("/", reminderRoutes(runtimeDeps));
  api.route("/", appointmentRoutes(runtimeDeps));
  api.route("/", historyRoutes(runtimeDeps));
  api.route("/", teamRoutes(runtimeDeps));
  api.route("/", adminRoutes(runtimeDeps));
  api.route("/", activationRoutes(runtimeDeps));
  api.route("/", portalRoutes(runtimeDeps));
  api.route("/", portalAppointmentRoutes(runtimeDeps));
  api.route("/", selfServiceRoutes(runtimeDeps));
  api.route("/", assistedModeRoutes(runtimeDeps));
  api.route("/", documentRoutes(runtimeDeps));
  api.route("/", profilingRoutes(runtimeDeps));
  api.route("/", asuRoutes(runtimeDeps));
  api.route("/", formRoutes(runtimeDeps));
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
