import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    // Integration tests share one database (transfer_test), migrated from scratch once per run
    // and truncated before each test. The projects that use it run one file at a time, each in
    // its own sequence group (plan, section 10).
    globalSetup: ["packages/db/src/testing/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
    },
  },
});
