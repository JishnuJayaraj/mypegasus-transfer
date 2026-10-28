import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";
import { maxWorkers } from "../../vitest.workers.ts";

export default defineProject({
  plugins: [react()],
  test: {
    name: "self-service-ui",
    maxWorkers,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
