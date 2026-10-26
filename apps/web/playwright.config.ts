import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { testDatabaseUrls } from "@transfer/db/testing";

// Against the built app (`pnpm build` first), production-like: the API bundle on transfer_e2e
// serves the web SPA at / and the portal at /portal/ (the same as `pnpm start` and the image).
const PORT = 3101;
const origin = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: origin,
    trace: "retain-on-failure",
    // Cloud sessions ship an older Chromium than this Playwright expects (spike S2).
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
  },
  webServer: {
    command: "node ../api/dist/server.js",
    url: `${origin}/api/v1/health`,
    env: {
      NODE_ENV: "development",
      AUTH_MODE: "dev",
      DATABASE_URL: testDatabaseUrls("transfer_e2e").app,
      APP_ORIGINS: origin,
      // The portal the messages link to: the one this server serves (reminders.spec.ts follows it).
      PORTAL_PUBLIC_URL: `${origin}/portal/`,
      API_PORT: String(PORT),
      LOG_LEVEL: "warn",
      // Playwright starts the server before the global setup recreates transfer_e2e (and its
      // pgboss schema), so pg-boss stays off here; the image smoke test starts it (AC-41).
      JOBS_ENABLED: "false",
      // The Anlage drawn by the mock, whatever a local .env names (ADR-0006).
      PDF_ADAPTER: "mock",
      // The configuration the build copied next to the bundle (Slice 2 plan 5.8), as in the image.
      CONFIG_DIR: fileURLToPath(new URL("../api/dist/config", import.meta.url)),
    },
  },
});
