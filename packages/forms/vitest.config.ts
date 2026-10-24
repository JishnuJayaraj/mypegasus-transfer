import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "forms",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
