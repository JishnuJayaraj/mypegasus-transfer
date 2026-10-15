import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));

/** Loads the repo's `.env` if present. Variables already set in the environment win. */
export function loadEnv(): void {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/** Reads a required variable. Errors name the variable, never its value. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

/** Seed, reset and setup are dev/test tools; they must never touch production. */
export function refuseInProduction(what: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${what} refuses to run with NODE_ENV=production`);
  }
}
