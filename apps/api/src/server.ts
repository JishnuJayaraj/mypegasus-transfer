import { serve } from "@hono/node-server";
import { createClock } from "@transfer/adapters";
import { createDb } from "@transfer/db";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { loadDotEnv, parseEnv } from "./env";
import { startJobs } from "./jobs/jobs";
import { createLogger } from "./logger";
import { createShutdown } from "./shutdown";

// Node entry (`tsx watch` in dev, `dist/server.js` in the image and `pnpm start`).
loadDotEnv();
const env = parseEnv();
const logger = createLogger(env.logLevel);
const db = createDb(env.databaseUrl);
const clock = createClock({ CLOCK: env.clock, NODE_ENV: env.nodeEnv });
// pg-boss in this process (D7) as the runtime role, before listening: a schema `db:migrate`
// hasn't installed fails the start (plan 5.9).
const jobs = env.jobsEnabled
  ? await startJobs({
      connectionString: env.databaseUrl,
      lifecycleTime: env.jobsLifecycleTime,
      logger,
    })
  : undefined;

// The built SPAs sit at apps/{web,portal}/dist, relative to src/ and dist/ alike (the image
// keeps that layout). Served only when both are built; in dev, Vite serves them.
const built = (app: string) => fileURLToPath(new URL(`../../${app}/dist`, import.meta.url));
const spa = { web: built("web"), portal: built("portal") };
const serveSpas = Object.values(spa).every((dir) => existsSync(`${dir}/index.html`));

const server = serve(
  {
    fetch: createApp({ db, env, logger, clock, spa: serveSpas ? spa : undefined }).fetch,
    port: env.port,
  },
  ({ port }) => logger.info({ port, serveSpas, jobs: Boolean(jobs) }, "api listening"),
);

// Graceful and single-flight (round 19): HTTP draining and pg-boss's stop, then the pool. A
// failed step sets a non-zero exit code.
const shutdown = createShutdown({ server, jobs, pool: db.$client, logger });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, (name) => {
    void shutdown(name).then((ok) => {
      if (!ok) process.exitCode = 1;
    });
  });
}
