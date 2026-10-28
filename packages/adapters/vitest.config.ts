import { defineProject } from "vitest/config";
import { maxWorkers } from "../../vitest.workers.ts";

export default defineProject({
  test: {
    name: "adapters",
    maxWorkers,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The PDF contract tests fill, flatten and render real forms; under coverage on CI one took
    // longer than the 5 s default.
    testTimeout: 30_000,
  },
});
