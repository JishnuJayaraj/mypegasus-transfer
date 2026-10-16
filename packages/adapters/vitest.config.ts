import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "adapters",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
