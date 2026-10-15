import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "db",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Shares transfer_test with the other integration projects (root vitest.config.ts).
    fileParallelism: false,
    sequence: { groupOrder: 1 },
  },
});
