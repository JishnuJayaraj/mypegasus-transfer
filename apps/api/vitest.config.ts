import { defineProject } from "vitest/config";
import { maxWorkers } from "../../vitest.workers.ts";

export default defineProject({
  test: {
    name: "api",
    maxWorkers,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // One clone of the migrated transfer_test per worker, shared with the db project's setup
    // (packages/db/vitest.config.ts; ADR-0003, testing).
    globalSetup: ["../../packages/db/src/testing/global-setup.ts"],
    // Fails a test whose queries overlap on one connection (ADR-0002, queries on one connection).
    setupFiles: ["../../packages/db/src/testing/sequential-queries.ts"],
  },
});
