import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";
import { maxWorkers } from "../../vitest.workers.ts";

export default defineProject({
  plugins: [react()],
  test: {
    name: "web",
    maxWorkers,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    // The work list's row menus are Carbon icon buttons with floating tooltips, which jsdom lays
    // out slowly (~0.3 s a row); the browser's cost is measured by the e2e budget. Coverage on
    // CI adds enough overhead that the slowest tests reach the old 20 s limit, so keep headroom.
    testTimeout: 40_000,
  },
});
