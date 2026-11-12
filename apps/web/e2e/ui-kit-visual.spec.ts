import { seedStaffUserIds } from "@transfer/db";
import { expect, test } from "./helpers";

// The pixel comparison of the kit page (ui-patterns.md, testing): fixed synthetic fixtures and a
// fixed clock, in CI's environment only (its Chromium and fonts; another machine renders text a
// few pixels differently), with a small tolerance. The baseline (e2e/__screenshots__/) changes
// only in a PR that changes the design, is named in that PR's description for a human to review,
// and is never regenerated to get CI green. It adds to ui-kit.spec.ts, axe and the zoom checks.

test.skip(!process.env.CI, "the pixel comparison runs in CI's environment only");

test("the kit page looks as its reviewed baseline", async ({ page, baseURL }) => {
  // The project lead of the seed: the shell beside the page shows "Projekte" only.
  const session = await page.request.post("/api/v1/dev/session", {
    headers: { Origin: baseURL! },
    data: { staffUserId: seedStaffUserIds.projectLead },
  });
  expect(session.ok()).toBe(true);
  await page.clock.setFixedTime(new Date("2027-02-07T09:00:00Z"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/ui-kit");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("UI-Kit");
  await page.evaluate(() => document.fonts.ready);
  // The whole page in one viewport: a full-page capture would stitch the fixed header in.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1280, height });
  await expect(page).toHaveScreenshot("ui-kit-1280.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});
