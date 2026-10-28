import { defineProject } from "vitest/config";
import { maxWorkers } from "../../vitest.workers.ts";

export default defineProject({
  test: {
    name: "api-client",
    maxWorkers,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
