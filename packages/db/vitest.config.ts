import { defineProject } from "vitest/config";
import { maxWorkers } from "../../vitest.workers.ts";

export default defineProject({
  test: {
    name: "db",
    maxWorkers,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Migrates the template transfer_test and clones it once per worker; each file runs on its
    // worker's clone, so files run in parallel (ADR-0003, testing). The api project declares it
    // too; it runs once.
    globalSetup: ["src/testing/global-setup.ts"],
    // Fails a test whose queries overlap on one connection (ADR-0002, queries on one connection).
    setupFiles: ["src/testing/sequential-queries.ts"],
    // A migration test rebuilds its database twice inside one test (about 3 s alone, more beside
    // the other workers). At Vitest's 5 s a slow run timed out mid-migration, and the file's
    // cleanup then deadlocked with the migration still running.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
