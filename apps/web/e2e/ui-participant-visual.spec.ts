import { readFileSync } from "node:fs";
import { expect, openStep, test } from "./helpers";

// The pixel comparison of the participant page (ui-patterns.md, testing): the overview and the
// tab "Profiling" on fixed synthetic fixtures and a fixed clock, in CI's environment only, with
// the kit page's tolerance (ui-kit-visual.spec.ts). The API's answers come from
// e2e/fixtures/participant-page.json, so no date, count or id depends on the day or the
// database; a request the fixture doesn't hold is answered 404. The baselines
// (e2e/__screenshots__/) change only in a PR that changes the design, are named in that PR's
// description for a human to review, and are never regenerated to get CI green.

test.skip(!process.env.CI, "the pixel comparison runs in CI's environment only");

const fixture = JSON.parse(
  readFileSync(new URL("fixtures/participant-page.json", import.meta.url), "utf8"),
) as {
  now: string;
  projectId: string;
  participationId: string;
  responses: Record<string, unknown>;
};

test("the participant page looks as its reviewed baselines", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    const body = route.request().method() === "GET" && fixture.responses[url.pathname + url.search];
    return body
      ? route.fulfill({ json: body })
      : route.fulfill({
          status: 404,
          contentType: "application/problem+json",
          json: { type: "urn:transfer:problem:not-found", title: "Not found", status: 404 },
        });
  });
  await page.clock.setFixedTime(new Date(fixture.now));
  await page.setViewportSize({ width: 1280, height: 900 });
  const path = `/projects/${fixture.projectId}/participations/${fixture.participationId}`;

  /** The whole page in one viewport: a full-page capture would stitch the fixed header in. */
  const compare = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: 1280, height: 900 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1280, height });
    // Soft: one run reports every baseline that differs, not only the first.
    await expect
      .soft(page)
      .toHaveScreenshot(name, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  };

  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Beispiel, Jana");
  await expect(
    page.getByRole("region", { name: "Als Nächstes" }).getByRole("listitem"),
  ).toHaveCount(3);
  await compare("participant-overview-1280.png");

  await page.goto(`${path}?tab=profiling`);
  await openStep(page, "Profilingbogen (TL 407)");
  await expect(page.getByText(/4 Pflichtangaben fehlen noch/)).toBeVisible();
  await compare("participant-profiling-1280.png");
});
