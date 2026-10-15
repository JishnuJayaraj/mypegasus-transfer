import { serve } from "@hono/node-server";
import { createDb } from "@transfer/db";
import { createApp } from "./app";
import { parseEnv } from "./env";
import { createLogger } from "./logger";

// Node entry. `.env` is loaded when present; variables already set win.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // no .env file: the environment must provide everything
}
const env = parseEnv();
const logger = createLogger(env.logLevel);
const db = createDb(env.databaseUrl);
serve({ fetch: createApp({ db, env, logger }).fetch, port: env.port }, ({ port }) =>
  logger.info({ port }, "api listening"),
);
