import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    // Integration tests share one database (transfer_test), migrated from scratch once per run
    // and truncated before each test. The projects that use it run one file at a time, each in
    // its own sequence group (ADR-0003, testing).
    globalSetup: ["packages/db/src/testing/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["**/testing/**"],
      // Domain rules are 100 % covered (ADR-0003, coverage); more paths join with their PRs.
      thresholds: Object.fromEntries(
        [
          "packages/domain/src/lifecycle/**",
          "packages/domain/src/eligibility/**",
          "packages/domain/src/access/**",
          "packages/domain/src/audit/**",
          "packages/domain/src/auth/**",
          "packages/domain/src/documents/**",
          "packages/domain/src/completeness/**",
          "packages/domain/src/dates.ts",
          "packages/domain/src/project.ts",
          "packages/domain/src/projects/**",
          "packages/domain/src/import/**",
          "packages/domain/src/activation/**",
          "packages/domain/src/portal/**",
          "packages/domain/src/notices/**",
          "packages/domain/src/privacy/**",
          "packages/domain/src/self-service/**",
          "packages/domain/src/worklist/**",
          "packages/config/src/**",
        ].map((glob) => [glob, { lines: 100, functions: 100, branches: 100, statements: 100 }]),
      ),
    },
  },
});
