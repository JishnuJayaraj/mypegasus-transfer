import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "api",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Shares transfer_test with the other integration projects (root vitest.config.ts).
    fileParallelism: false,
    // Fails a test whose queries overlap on one connection (ADR-0002, queries on one connection).
    setupFiles: ["../../packages/db/src/testing/sequential-queries.ts"],
    sequence: { groupOrder: 2 },
  },
});
