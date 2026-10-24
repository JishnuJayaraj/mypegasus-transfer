import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "adapters",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The PDF contract tests fill, flatten and render real forms; under coverage on CI one took
    // longer than the 5 s default.
    testTimeout: 30_000,
  },
});
