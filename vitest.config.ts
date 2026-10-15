import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    // Integration tests share one database (transfer_test), migrated from scratch once per run
    // and truncated before each test, so test files run one at a time (plan, section 10).
    globalSetup: ["packages/db/src/testing/global-setup.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
    },
  },
});
