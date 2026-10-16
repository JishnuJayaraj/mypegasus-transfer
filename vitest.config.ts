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
      exclude: ["**/testing/**"],
      // Domain rules are 100 % covered (Slice 1 plan, section 6); more paths join with their PRs.
      thresholds: Object.fromEntries(
        [
          "packages/domain/src/lifecycle/**",
          "packages/domain/src/eligibility/**",
          "packages/domain/src/access/**",
          "packages/domain/src/audit/**",
          "packages/domain/src/documents/**",
          "packages/domain/src/completeness/**",
          "packages/domain/src/dates.ts",
          "packages/domain/src/project.ts",
          "packages/config/src/**",
        ].map((glob) => [glob, { lines: 100, functions: 100, branches: 100, statements: 100 }]),
      ),
    },
  },
});
