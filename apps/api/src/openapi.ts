import { SystemClock } from "@transfer/adapters";
import { createDb } from "@transfer/db";
import { pino } from "pino";
import { createApp, openApiConfig } from "./app";

/**
 * The OpenAPI document as `pnpm api:generate` writes it: the dev configuration, so the dev
 * routes are included (tagged `dev`, `x-dev-only`). Nothing connects to the database.
 */
export function openApiDocument(): ReturnType<
  ReturnType<typeof createApp>["getOpenAPI31Document"]
> {
  const app = createApp({
    db: createDb("postgres://unused@localhost/unused"),
    env: {
      nodeEnv: "development",
      authMode: "dev",
      sessionSecret: "unused".repeat(6),
      appOrigins: [],
      databaseUrl: "unused",
      port: 0,
      logLevel: "silent",
      jobsEnabled: false,
      jobsLifecycleTime: "04:15",
      clock: "system",
      configDir: undefined,
    },
    logger: pino({ enabled: false }),
    clock: new SystemClock(),
  });
  return app.getOpenAPI31Document(openApiConfig);
}
