import { randomBytes } from "node:crypto";
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
});

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
  if (env.AUTH_MODE === "oidc") {
    throw new Error("AUTH_MODE=oidc is not implemented until Slice 3; use AUTH_MODE=dev");
  }
  if (env.NODE_ENV === "production" && env.AUTH_MODE === "dev") {
    throw new Error("AUTH_MODE=dev is not allowed with NODE_ENV=production");
  }
  if (!env.SESSION_SECRET && env.NODE_ENV !== "development") {
    throw new Error("SESSION_SECRET is required outside development");
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
  };
}
