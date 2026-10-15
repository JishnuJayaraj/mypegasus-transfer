import { defineConfig, devices } from "@playwright/test";
import { testDatabaseUrls } from "@transfer/db/testing";

// Against the built app (`pnpm build` first): the API bundle on transfer_e2e and the web SPA
// served by `vite preview`, which proxies /api to that API.
const API_PORT = 3101;
const WEB_PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    // Cloud sessions ship an older Chromium than this Playwright expects (spike S2).
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
  },
  webServer: [
    {
      command: "node ../api/dist/server.js",
      url: `http://localhost:${API_PORT}/api/v1/health`,
      env: {
        NODE_ENV: "development",
        AUTH_MODE: "dev",
        DATABASE_URL: testDatabaseUrls("transfer_e2e").app,
        APP_ORIGINS: `http://localhost:${WEB_PORT}`,
        API_PORT: String(API_PORT),
        LOG_LEVEL: "warn",
      },
    },
    {
      command: `pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
