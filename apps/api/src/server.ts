import { serve } from "@hono/node-server";
import { createClock } from "@transfer/adapters";
import { createDb } from "@transfer/db";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp, messaging } from "./app";
import { loadDotEnv, parseEnv } from "./env";
import { activationNoticeQueue, startJobs } from "./jobs/jobs";
import { failClosedFacts } from "./participations/guard-facts";
import { createLogger } from "./logger";
import { createShutdown } from "./shutdown";
import { createDetached } from "./detached";

// Node entry (`tsx watch` in dev, `dist/server.js` in the image and `pnpm start`).
loadDotEnv();
const env = parseEnv();
const logger = createLogger(env.logLevel);
const db = createDb(env.databaseUrl);
const clock = createClock({ CLOCK: env.clock, NODE_ENV: env.nodeEnv });
// One set of senders for the API and the jobs (the activation notice, D21).
const senders = messaging({ env, clock, logger });
// Login-code sends finish after their response (ADR-0007); shutdown waits for them.
const detached = createDetached(logger);
// pg-boss in this process (D7) as the runtime role, before listening: a schema `db:migrate`
// hasn't installed fails the start (plan 5.9).
const jobs = env.jobsEnabled
  ? await startJobs({
      connectionString: env.databaseUrl,
      lifecycleTime: env.jobsLifecycleTime,
      logger,
      // Slice 1 fails closed (D4): nobody enters the TG until the facts are recorded.
      work: {
        db,
        clock,
        facts: failClosedFacts,
        notices: {
          mailer: senders.mailer,
          smsSender: senders.smsSender,
          portalPublicUrl: env.portalPublicUrl!,
        },
      },
    })
  : undefined;

// The built SPAs sit at apps/{web,portal}/dist, relative to src/ and dist/ alike (the image
// keeps that layout). Served only when both are built; in dev, Vite serves them.
const built = (app: string) => fileURLToPath(new URL(`../../${app}/dist`, import.meta.url));
const spa = { web: built("web"), portal: built("portal") };
const serveSpas = Object.values(spa).every((dir) => existsSync(`${dir}/index.html`));

const server = serve(
  {
    fetch: createApp({
      db,
      env,
      logger,
      clock,
      spa: serveSpas ? spa : undefined,
      ...senders,
      detached,
      activationNotices: jobs ? activationNoticeQueue(jobs.boss) : undefined,
    }).fetch,
    port: env.port,
  },
  ({ port }) => logger.info({ port, serveSpas, jobs: Boolean(jobs) }, "api listening"),
);

// Graceful and single-flight (round 19): HTTP draining and pg-boss's stop, then the pool. A
// failed step sets a non-zero exit code.
const shutdown = createShutdown({ server, jobs, detached, pool: db.$client, logger });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, (name) => {
    void shutdown(name).then((ok) => {
      if (!ok) process.exitCode = 1;
    });
  });
}
