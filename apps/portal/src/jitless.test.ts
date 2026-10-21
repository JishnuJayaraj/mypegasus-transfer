import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ADR-0004 (spike S1): Zod runs jitless in the SPA, set before any schema is built, so the API's
// CSP (no `unsafe-eval`) reports no violation. The e2e suite fails on any CSP violation.
describe("jitless Zod", () => {
  it("is set by the entry before the app is loaded", () => {
    const main = readFileSync(join(import.meta.dirname, "main.tsx"), "utf8");
    // Only Zod is imported statically; everything else comes with the app, after the setting.
    expect([...main.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual(["zod"]);
    expect(main.indexOf("z.config({ jitless: true });")).toBeGreaterThan(0);
    expect(main.indexOf("z.config({ jitless: true });")).toBeLessThan(
      main.indexOf('void import("./app");'),
    );
  });
});
