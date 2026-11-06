import type { Page } from "@playwright/test";
import { seedRegionIds } from "@transfer/db";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, expectAccessible, expectWithinBudget, test } from "./helpers";
import { worklistParticipations } from "./participants";

// The work list (docs/architecture/ui-patterns.md; UX foundation plan, 6b-3): the next step's
// order, quick views, the filter panel, the column chooser in memory, the batch bar only with a
// selection, and the way back from a participant (C6). Each test brings its own project (created
// through the staff API) and participations (owner fixtures), so no other spec's rows change its
// counts. Synthetic data only; the suite fails on any CSP violation. Screenshots go to
// docs/screenshots/6b-3/.

const screenshots = fileURLToPath(new URL("../../../docs/screenshots/6b-3/", import.meta.url));
// 320px is a 1280px window at 400 % zoom (WCAG 1.4.10).
const widths = [1440, 768, 375, 320] as const;
const names: [string, string][] = [
  ["Jürgen", "Größer"],
  ["Anna", "Muster"],
  ["Bernd", "Beispiel"],
  ["Clara", "Probe"],
  ["Dieter", "Fiktiv"],
];

/** A new `ta_tg` project of the PL (who creates it), with `count` participations. */
async function projectWithParticipants(page: Page, baseURL: string, prefix: string, count: number) {
  const api = page.context().request;
  const headers = { Origin: baseURL };
  await api.post("/api/v1/dev/session", {
    headers,
    data: { staffUserId: "00000000-0000-4000-8000-000000000003" },
  });
  const response = await api.post("/api/v1/projects", {
    headers,
    data: {
      name: `E2E Arbeitsliste ${prefix}`,
      customerName: "Beispiel GmbH",
      type: "ta_tg",
      regionId: seedRegionIds.nord,
    },
  });
  expect(response.status()).toBe(201);
  const { id: projectId } = (await response.json()) as { id: string };
  await worklistParticipations(page, baseURL, { projectId, prefix, count, names, wave: true });
  return projectId;
}

/** A screenshot of the viewport (or the page), after Carbon's transitions have ended. */
async function shot(page: Page, name: string, fullPage = false) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}${name}.png`, fullPage });
}

async function expectNoPageScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal page overflow in px").toBeLessThanOrEqual(0);
}

/** Nothing of the list's state in browser storage (data-protection.md; Q223). */
async function expectNothingStored(page: Page) {
  const stored = await page.evaluate(() => [
    ...Object.entries(localStorage),
    ...Object.entries(sessionStorage),
  ]);
  expect(stored).toEqual([]);
}

const batchLabels = [
  "Berater zuweisen",
  "Welle zuweisen",
  "Erinnern",
  "Einladen",
  "Kug 200b erzeugen",
  "Aktivierung drucken",
];

test("the work list: one screen, the batch bar only with a selection, columns in memory", async ({
  page,
  baseURL,
}) => {
  // Axe and screenshots at four widths, with and without the filter panel.
  test.slow();
  const projectId = await projectWithParticipants(page, baseURL!, "WLA", 40);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/projects/${projectId}?tab=participants`);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  const rows = list.locator("tbody tr");

  // AC 7: the first row is visible at 1440×900 without scrolling.
  await expect(rows.first()).toBeInViewport();
  await expect(list.getByText(/^40 Teilnehmende · Stand \d\d:\d\d$/)).toBeVisible();
  // AC 8: at most seven columns (six and "Welle" in ta_tg), plus the selection and the menu.
  await expect(list.getByRole("columnheader")).toHaveText([
    "Alle Zeilen auswählen",
    /Teilnehmende$/,
    /Status$/,
    /Nächster Schritt$/,
    /Frist$/,
    /Beratung$/,
    /Welle$/,
    "Aktionen",
  ]);
  // AC 6: no bulk control without a selection.
  for (const label of batchLabels) {
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }
  await expectAccessible(page);
  await shot(page, "worklist-1440");

  // The chooser adds a column; nothing of it in storage or the URL; a reload restores the six.
  const url = page.url();
  await list.getByRole("button", { name: "Spalten" }).click();
  await list.getByRole("group", { name: "Angezeigte Spalten" }).getByText("Portal").click();
  await expect(list.getByRole("columnheader", { name: /Portal$/ })).toBeVisible();
  await expectAccessible(page);
  expect(page.url()).toBe(url);
  await expectNothingStored(page);
  await page.reload();
  await expect(rows.first()).toBeVisible();
  await expect(list.getByRole("columnheader", { name: /Portal$/ })).toHaveCount(0);

  // AC 9: the toolbar search runs in the browser; the term is in no URL or storage.
  const search = list.getByRole("searchbox", { name: "Name oder Personalnummer suchen" });
  await search.fill("grosser");
  await expect(list.getByText(/^8 Treffer · 40 Teilnehmende/)).toBeVisible();
  expect(page.url()).not.toMatch(/grosser/i);
  await expectNothingStored(page);
  await search.fill("");

  // AC 6: a selection shows the batch bar with the actions the capabilities allow (the PL).
  await rows.first().scrollIntoViewIfNeeded();
  await rows.first().getByRole("checkbox").check({ force: true });
  const bar = list.locator(".cds--batch-actions");
  await expect(bar).toContainText("1 ausgewählt");
  await expect(bar.getByRole("button", { name: "Berater zuweisen" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Welle zuweisen" })).toBeVisible();
  await expectAccessible(page);
  await shot(page, "worklist-batch-1440");
  await bar.getByRole("button", { name: "Welle zuweisen" }).click();
  const panel = page.getByRole("dialog", { name: "Welle zuweisen" });
  await expect(panel.getByText("1 ausgewählt")).toBeVisible();
  await expectAccessible(page);
  await shot(page, "worklist-wave-panel-1440");
  await panel.getByRole("button", { name: "Schließen" }).click();
  await expect(panel).toHaveCount(0);
  await bar.getByRole("button", { name: "Auswahl aufheben" }).click();
  await expect(bar).toHaveCount(0);

  // The filter panel, grouped; a filter shows as a tag and stays a code in the URL.
  await list.getByRole("button", { name: "Filter", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filter" });
  for (const group of ["Status", "Fristen & Termine", "Zuständigkeit", "Erreichbarkeit"]) {
    await expect(filters.getByRole("group", { name: group })).toBeVisible();
  }
  await expectAccessible(page);
  await shot(page, "worklist-filters-1440");
  await filters.getByLabel("Beratung").selectOption("none");
  await filters.getByRole("button", { name: /Treffer anzeigen$/ }).click();
  await expect(page).toHaveURL(/consultant=none/);
  await expect(
    list
      .getByRole("list", { name: "Aktive Filter" })
      .getByText("Beratung: Nicht zugewiesen", { exact: true }),
  ).toBeVisible();
  await expect(list.getByRole("button", { name: "Ohne Beratung (40)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Every width: only the table scrolls sideways, the panels reflow (D10), axe passes.
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(rows.first()).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    if (width !== 1440) await shot(page, `worklist-${width}`);
    await list.getByRole("button", { name: /^Filter( \(\d+\))?$/ }).click();
    await expect(filters).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    if (width !== 1440) await shot(page, `worklist-filters-${width}`);
    await filters.getByRole("button", { name: "Schließen" }).click();
    await expect(filters).toHaveCount(0);
  }
  await expectNothingStored(page);
});

test("back from a participant restores the quick view, filters, sort, search and scroll (C6)", async ({
  page,
  baseURL,
}) => {
  const projectId = await projectWithParticipants(page, baseURL!, "WLB", 25);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/projects/${projectId}?tab=participants`);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  const view = list.getByRole("button", { name: "Ohne Beratung (25)" });
  await view.click();
  await expect(page).toHaveURL(/consultant=none/);
  await list
    .getByRole("columnheader", { name: /Teilnehmende$/ })
    .getByRole("button")
    .click();
  await list
    .getByRole("columnheader", { name: /Teilnehmende$/ })
    .getByRole("button")
    .click();
  await expect(page).toHaveURL(/sort=-name/);
  const search = list.getByRole("searchbox", { name: "Name oder Personalnummer suchen" });
  await search.fill("WLB-00");
  await expect(list.getByText(/^25 Treffer/)).toBeVisible();
  // Scroll the table's own container and the page.
  const table = list.locator(".tp-data-table-scroll");
  await table.evaluate((element) => element.scrollTo({ top: 400 }));
  await page.evaluate(() => window.scrollTo({ top: 200 }));
  // A row in view below the sticky header, so the click scrolls nothing.
  const index = await table.evaluate((element) => {
    const below = element.getBoundingClientRect().top + 80;
    return [...element.querySelectorAll("tbody tr")].findIndex(
      (row) => row.getBoundingClientRect().top > below,
    );
  });
  const scrolled = await table.evaluate((element) => element.scrollTop);
  const pageScrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);

  // Open a row by clicking it (not its link), then go back.
  await list.locator("tbody tr").nth(index).getByRole("cell").nth(4).click();
  await expect(page).toHaveURL(/\/participations\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();

  await expect(page).toHaveURL(/consultant=none/);
  await expect(page).toHaveURL(/sort=-name/);
  await expect(view).toHaveAttribute("aria-pressed", "true");
  await expect(search).toHaveValue("WLB-00");
  await expect(list.getByText(/^25 Treffer/)).toBeVisible();
  await expect.poll(() => table.evaluate((element) => element.scrollTop)).toBeCloseTo(scrolled, -1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(pageScrolled, -1);
  await expectAccessible(page);

  // A reload loses only the search term (memory), never the codes in the URL.
  await page.reload();
  await expect(view).toHaveAttribute("aria-pressed", "true");
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(/sort=-name/);
  await expectNothingStored(page);
});

// The initial sort's budget (CLAUDE.md, how we work; reported, strict only with PERF_BUDGET):
// from the snapshot's arrival to the first rendered row, over 2,000 participations sorted by the
// next step in the browser. The invariant first: one snapshot request.
test("sort 2,000 participations by the next step: snapshot to first row, timing budget", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const projectId = await projectWithParticipants(page, baseURL!, "SORT", 2000);
  const snapshots: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(`/projects/${projectId}/worklist`)) snapshots.push(request.url());
  });
  await page.addInitScript(() => {
    // Runs in the page, so it is self-contained.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const watch = () => {
      // The table's rows, not the skeleton's.
      if (document.querySelector(".tp-worklist .tp-data-table-scroll tbody tr")) {
        (window as unknown as { firstRowAt: number }).firstRowAt = performance.now();
        return;
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await page.goto(`/projects/${projectId}?tab=participants`);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  await expect(list.locator("tbody tr")).toHaveCount(25);
  await expect(list.getByText(/^2000 Teilnehmende/)).toBeVisible();
  expect(snapshots).toHaveLength(1);
  const ms = await page.evaluate(() => {
    const entry = performance
      .getEntriesByType("resource")
      .find((e) => e.name.includes("/worklist")) as PerformanceResourceTiming;
    return (window as unknown as { firstRowAt: number }).firstRowAt - entry.responseEnd;
  });
  const reported = `initial sort of 2,000: snapshot to first row ${Math.round(ms)} ms`;
  test.info().annotations.push({ type: "performance", description: reported });
  // oxlint-disable-next-line no-console -- the timing goes into the PR
  console.info(reported);
  expectWithinBudget("snapshot to first row over 2,000", ms, {
    budget: 500,
    ceiling: 5000,
    causes:
      "sorting in render instead of once per snapshot, computing the next step per comparison",
  });
});
