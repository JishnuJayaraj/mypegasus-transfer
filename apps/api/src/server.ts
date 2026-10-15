import { serve } from "@hono/node-server";
import { createDb } from "@transfer/db";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { loadDotEnv, parseEnv } from "./env";
import { createLogger } from "./logger";

// Node entry (`tsx watch` in dev, `dist/server.js` in the image and `pnpm start`).
loadDotEnv();
const env = parseEnv();
const logger = createLogger(env.logLevel);
const db = createDb(env.databaseUrl);

// The built SPAs sit at apps/{web,portal}/dist, relative to src/ and dist/ alike (the image
// keeps that layout). Served only when both are built; in dev, Vite serves them.
const built = (app: string) => fileURLToPath(new URL(`../../${app}/dist`, import.meta.url));
const spa = { web: built("web"), portal: built("portal") };
const serveSpas = Object.values(spa).every((dir) => existsSync(`${dir}/index.html`));

serve(
  {
    fetch: createApp({ db, env, logger, spa: serveSpas ? spa : undefined }).fetch,
    port: env.port,
  },
  ({ port }) => logger.info({ port, serveSpas }, "api listening"),
);
