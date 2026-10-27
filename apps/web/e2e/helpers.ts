import { AxeBuilder } from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";

/**
 * Every test fails on a Content-Security-Policy violation: the API serves the built SPAs with a
 * strict CSP (no inline styles or scripts, no eval), and this proves Carbon and Zod work under it.
 * Chromium reports some violations only as a `securitypolicyviolation` event, never on the
 * console (e.g. a caught `new Function`, which is how Zod probes for eval; ADR-0004), so both
 * are watched.
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
          violations.push(message.text());
        }
      });
      await page.exposeBinding("reportCspViolation", (_source, violation: string) => {
        violations.push(violation);
      });
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          const report = (window as unknown as { reportCspViolation: (v: string) => void })
            .reportCspViolation;
          void report(`${event.violatedDirective} ${event.blockedURI} (${event.sourceFile})`);
        });
      });
      await use(violations);
      expect(violations).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** AC-23: no serious or critical accessibility violations. */
export async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
    ),
  ).toEqual([]);
}

/**
 * A timing budget (CLAUDE.md, how we work): above `ceiling` it always fails, since that is a bug and
 * not a slow runner; above `budget` it fails only with `PERF_BUDGET=strict` (.env.example) and
 * otherwise warns with the likely causes, as a console line and a test annotation. Invariants are
 * asserted before it, never through it.
 */
export function expectWithinBudget(
  label: string,
  ms: number,
  { budget, ceiling, causes }: { budget: number; ceiling: number; causes: string },
) {
  expect(ms, `${label}: ${Math.round(ms)} ms, hard ceiling ${ceiling} ms`).toBeLessThan(ceiling);
  if (ms < budget) return;
  const message = `${label}: ${Math.round(ms)} ms, over the budget of ${budget} ms. Likely causes: ${causes}`;
  if (process.env.PERF_BUDGET === "strict") throw new Error(message);
  test.info().annotations.push({ type: "performance warning", description: message });
  // oxlint-disable-next-line no-console -- a soft budget warns instead of failing (PERF_BUDGET)
  console.warn(`WARNING ${message}`);
}
