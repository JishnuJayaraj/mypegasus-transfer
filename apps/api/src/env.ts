import { assertRunTime, createClock } from "@transfer/adapters";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_MODE: z.enum(["dev", "oidc"]),
  DATABASE_URL: z.url(),
  SESSION_SECRET: z.string().min(32).optional(),
  APP_ORIGINS: z.string().transform((value) => value.split(",").map((o) => o.trim())),
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // ADR-0011: pg-boss in the API process; tests switch it off and start it themselves.
  JOBS_ENABLED: z.enum(["true", "false"]).default("true"),
  // The nightly lifecycle run, Berlin local time (round 9).
  JOBS_LIFECYCLE_TIME: z.string().default("04:15"),
  // ADR-0006: system, or fixed:<ISO instant> outside production.
  CLOCK: z.string().default("system"),
  // ADR-0004 (architecture/overview.md, packages/config): templates/ and base-defaults.json;
  // unset, the repo paths.
  CONFIG_DIR: z.string().optional(),
  // Staff login with AUTH_MODE=oidc (ADR-0007, staff sessions): all four or none.
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URL: z.url().optional(),
  ACCESS_CODE_SECRET: z.string().min(32).optional(),
  FIELD_ENCRYPTION_KEY: z.string().min(32).optional(),
  PORTAL_PUBLIC_URL: z.url().optional(),
  MAIL_ADAPTER: z.literal("mock").default("mock"),
  SMS_ADAPTER: z.literal("mock").default("mock"),
  // Document files (ADR-0006): their own HKDF root (`document-encryption:v1`), the store and
  // the scanner. `mock` is the value `.env` files copied before Slice 4b hold: the filesystem.
  DOCUMENT_ENCRYPTION_KEY: z.string().min(32).optional(),
  STORAGE_ADAPTER: z
    .enum(["filesystem", "memory", "mock"])
    .default("filesystem")
    .transform((value) => (value === "mock" ? "filesystem" : value)),
  STORAGE_DIR: z.string().optional(),
  VIRUS_SCAN_ADAPTER: z.literal("mock").default("mock"),
});

/** The route the identity provider returns to (routes/auth.ts). */
export const OIDC_CALLBACK_PATH = "/api/v1/auth/callback";

/** Loads the repo's `.env` when present (not in the image); variables already set win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // no .env file: the environment must provide everything
  }
}

export interface Env {
  nodeEnv: "development" | "test" | "production";
  authMode: "dev" | "oidc";
  databaseUrl: string;
  sessionSecret: string;
  appOrigins: string[];
  port: number;
  logLevel: string;
  jobsEnabled: boolean;
  /** `HH:MM`, Europe/Berlin; never 02:00–02:59. */
  jobsLifecycleTime: string;
  /** Validated; the server builds the `Clock` from it with `createClock`. */
  clock: string;
  /** The configuration directory (`CONFIG_DIR`); undefined: the repo paths. */
  configDir: string | undefined;
  /** Set exactly when `authMode` is `oidc`. */
  oidc?: OidcEnv | undefined;
  accessCodeSecret?: string | undefined;
  /** The root of the encrypted fields' key (ADR-0002, encryption); never logged or returned. */
  fieldEncryptionKey?: string | undefined;
  portalPublicUrl?: string | undefined;
  mailAdapter?: "mock" | undefined;
  smsAdapter?: "mock" | undefined;
  /** The root of the document files' key (document-encryption.ts); never logged or returned. */
  documentEncryptionKey: string;
  /** Neither storage nor scanner is wired with `NODE_ENV=production` before the pilot (Q149). */
  storageAdapter: "filesystem" | "memory";
  /** The filesystem store's directory; outside the web root. */
  storageDir: string;
  virusScanAdapter: "mock";
}

export interface OidcEnv {
  issuer: string;
  clientId: string;
  /** From the secret store; never logged or returned. */
  clientSecret: string;
  redirectUrl: string;
}

/**
 * Parses the environment and fails fast. Errors name the variable, never its value, because
 * a value may be a secret (CLAUDE.md rule 9).
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  // `.env` copied from `.env.example` has empty optional variables (`SESSION_SECRET=`).
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = schema.safeParse(set);
  if (!result.success) {
    const names = result.error.issues.map((issue) => `${String(issue.path[0])} (${issue.code})`);
    throw new Error(`Invalid environment variables: ${names.join(", ")} (see .env.example)`);
  }
  const env = result.data;
  try {
    assertRunTime(env.JOBS_LIFECYCLE_TIME);
  } catch (error) {
    // The RangeError names the rule, never the value.
    throw new Error(`JOBS_LIFECYCLE_TIME: ${(error as Error).message}`, { cause: error });
  }
  createClock({ CLOCK: env.CLOCK, NODE_ENV: env.NODE_ENV });
  const oidc = env.AUTH_MODE === "oidc" ? oidcEnv(env) : undefined;
  if (env.NODE_ENV === "production" && env.AUTH_MODE === "dev") {
    throw new Error("AUTH_MODE=dev is not allowed with NODE_ENV=production");
  }
  if (!env.SESSION_SECRET && env.NODE_ENV !== "development") {
    throw new Error("SESSION_SECRET is required outside development");
  }
  if (!env.ACCESS_CODE_SECRET && env.NODE_ENV !== "development") {
    throw new Error("ACCESS_CODE_SECRET is required outside development");
  }
  if (!env.FIELD_ENCRYPTION_KEY && env.NODE_ENV !== "development") {
    throw new Error("FIELD_ENCRYPTION_KEY is required outside development");
  }
  if (!env.DOCUMENT_ENCRYPTION_KEY && env.NODE_ENV !== "development") {
    throw new Error("DOCUMENT_ENCRYPTION_KEY is required outside development");
  }
  if (!env.PORTAL_PUBLIC_URL && env.NODE_ENV !== "development") {
    throw new Error("PORTAL_PUBLIC_URL is required outside development");
  }
  if (env.NODE_ENV !== "development" && env.PORTAL_PUBLIC_URL) {
    const portal = new URL(env.PORTAL_PUBLIC_URL);
    if (portal.protocol !== "https:") {
      throw new Error("PORTAL_PUBLIC_URL must be https outside development");
    }
  }
  return {
    nodeEnv: env.NODE_ENV,
    authMode: env.AUTH_MODE,
    databaseUrl: env.DATABASE_URL,
    // Dev only: a random secret per start, so sessions don't survive a restart.
    sessionSecret: env.SESSION_SECRET ?? randomBytes(32).toString("hex"),
    appOrigins: env.APP_ORIGINS,
    port: env.PORT ?? env.API_PORT,
    logLevel: env.LOG_LEVEL,
    jobsEnabled: env.JOBS_ENABLED === "true",
    jobsLifecycleTime: env.JOBS_LIFECYCLE_TIME,
    clock: env.CLOCK,
    configDir: env.CONFIG_DIR,
    oidc,
    // Fixed only for synthetic development so a watch restart keeps printed codes usable.
    accessCodeSecret: env.ACCESS_CODE_SECRET ?? "development-access-code-secret-only-0001",
    // Fixed only for synthetic development so a restart can still read what was written.
    fieldEncryptionKey: env.FIELD_ENCRYPTION_KEY ?? "development-field-encryption-key-only-0001",
    portalPublicUrl: env.PORTAL_PUBLIC_URL ?? "http://localhost:5174/portal/",
    mailAdapter: env.MAIL_ADAPTER,
    smsAdapter: env.SMS_ADAPTER,
    // Fixed only for synthetic development so a restart can still open what was stored.
    documentEncryptionKey:
      env.DOCUMENT_ENCRYPTION_KEY ?? "development-document-encryption-key-only-0001",
    storageAdapter: env.STORAGE_ADAPTER,
    storageDir:
      env.STORAGE_DIR ?? fileURLToPath(new URL("../../../.data/documents", import.meta.url)),
    virusScanAdapter: env.VIRUS_SCAN_ADAPTER,
  };
}

/**
 * AUTH_MODE=oidc refuses to start without its four variables. Outside development the issuer
 * and the redirect URL are https; the redirect URL is the callback route on an origin in
 * APP_ORIGINS.
 */
function oidcEnv(env: z.output<typeof schema>): OidcEnv {
  const missing = (
    ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URL"] as const
  ).filter((name) => env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`AUTH_MODE=oidc needs ${missing.join(", ")} (see .env.example)`);
  }
  const issuer = new URL(env.OIDC_ISSUER!);
  const redirect = new URL(env.OIDC_REDIRECT_URL!);
  if (env.NODE_ENV !== "development") {
    for (const [name, url] of [
      ["OIDC_ISSUER", issuer],
      ["OIDC_REDIRECT_URL", redirect],
    ] as const) {
      if (url.protocol !== "https:") throw new Error(`${name} must be https outside development`);
    }
  }
  if (
    !env.APP_ORIGINS.includes(redirect.origin) ||
    redirect.pathname !== OIDC_CALLBACK_PATH ||
    redirect.search !== "" ||
    redirect.hash !== ""
  ) {
    throw new Error(
      `OIDC_REDIRECT_URL must be ${OIDC_CALLBACK_PATH} on an origin in APP_ORIGINS, without a query`,
    );
  }
  return {
    issuer: env.OIDC_ISSUER!,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!,
    redirectUrl: redirect.href,
  };
}
