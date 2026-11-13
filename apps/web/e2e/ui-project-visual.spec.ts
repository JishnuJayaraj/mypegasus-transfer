import { readFileSync } from "node:fs";
import { expect, test } from "./helpers";

// The pixel comparison of the project overview (ui-patterns.md, testing; the plan of Slice 7b,
// D14a): the overview on a frozen synthetic fixture and a fixed clock, in CI's environment only,
// with the kit page's tolerance (ui-kit-visual.spec.ts, ui-participant-visual.spec.ts). The API's
// answers come from e2e/fixtures/project-overview.json, so no count, date or id depends on the
// day or the database; a request the fixture doesn't hold is answered 404. The baseline
// (e2e/__screenshots__/) changes only in a PR that changes the design, is named in that PR's
// description for a human to review, and is never regenerated to get CI green.

test.skip(!process.env.CI, "the pixel comparison runs in CI's environment only");

const fixture = JSON.parse(
  readFileSync(new URL("fixtures/project-overview.json", import.meta.url), "utf8"),
) as {
  now: string;
  projectId: string;
  responses: Record<string, unknown>;
};

test("the project overview looks as its reviewed baseline", async ({ page }) => {
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

  await page.goto(`/projects/${fixture.projectId}/overview`);
  await expect(page.getByRole("region", { name: "Verlauf" })).toBeVisible();
  await expect(page.getByRole("link", { name: "14 Teilnehmende" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // The whole page in one viewport: a full-page capture would stitch the fixed header in.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1280, height });
  // Soft: one run reports every baseline that differs, not only the first.
  await expect.soft(page).toHaveScreenshot("project-overview-1280.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});
