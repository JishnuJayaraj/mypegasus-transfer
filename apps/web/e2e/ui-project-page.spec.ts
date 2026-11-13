import type { Page } from "@playwright/test";
import { seedRegionIds } from "@transfer/db";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, expectAccessible, openCard, test } from "./helpers";
import { worklistParticipations } from "./participants";

// The project page, its dashboard and the projects list (docs/architecture/ui-patterns.md; UX
// foundation plan, 6b-4): the page header with breadcrumb, tags and region; the sections by
// frequency; "Einrichtung" as a step list; the dashboard's three layers. Each width
// passes axe without a horizontal page scroll (D10). The test brings its own project (created
// through the staff API) and participations (owner fixtures). Synthetic data only; the suite fails
// on any CSP violation. Screenshots go to docs/screenshots/6b-4/ (the overview) and 7b-7/ (the setup).

const screenshots = fileURLToPath(new URL("../../../docs/screenshots/6b-4/", import.meta.url));
const setupScreenshots = fileURLToPath(new URL("../../../docs/screenshots/7b-7/", import.meta.url));
// 320px is a 1280px window at 400 % zoom (WCAG 1.4.10).
const widths = [1440, 768, 375, 320] as const;
// A 1280×720 window at 200 % and 400 % zoom, in CSS pixels (D10's manual check, emulated).
const zooms = [
  { width: 640, height: 360 },
  { width: 320, height: 180 },
] as const;

/** A new `ta_tg` project of the PL (who creates it), with `count` participations. */
async function projectWithParticipants(page: Page, baseURL: string, count: number) {
  const api = page.context().request;
  const headers = { Origin: baseURL };
  await api.post("/api/v1/dev/session", {
    headers,
    data: { staffUserId: "00000000-0000-4000-8000-000000000003" },
  });
  const response = await api.post("/api/v1/projects", {
    headers,
    data: {
      name: "E2E Projektseite Mitte",
      customerName: "Beispiel Präzisionsteile GmbH",
      type: "ta_tg",
      regionId: seedRegionIds.nord,
    },
  });
  expect(response.status()).toBe(201);
  const { id: projectId } = (await response.json()) as { id: string };
  await worklistParticipations(page, baseURL, {
    projectId,
    prefix: "PP",
    count,
    names: [
      ["Jana", "Beispiel"],
      ["Kurt", "Muster"],
    ],
    wave: true,
  });
  return projectId;
}

/** A screenshot after Carbon's transitions have ended. */
async function shot(page: Page, name: string, fullPage = true, folder = screenshots) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: `${folder}${name}.png`, fullPage });
}

/** No horizontal page scroll (D10); a failure names the elements that stick out. */
async function expectNoPageScroll(page: Page) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, serialised whole
    const scrolls = (element: Element | null): boolean =>
      element !== null &&
      element !== document.documentElement &&
      (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(element).overflowX) ||
        scrolls(element.parentElement));
    return {
      overflow: document.documentElement.scrollWidth - width,
      offenders: [...document.body.querySelectorAll("*")]
        .filter((element) => element.getBoundingClientRect().right > width + 0.5)
        .filter((element) => !scrolls(element.parentElement))
        .slice(0, 5)
        .map(
          (element) =>
            `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} "${element.textContent?.slice(0, 40)}"`,
        ),
    };
  });
  expect(overflow, `horizontal page overflow in px (${offenders.join(", ")})`).toBeLessThanOrEqual(
    0,
  );
}

test("the project page: header, sections, the dashboard's three layers and Einrichtung as a step list", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const projectId = await projectWithParticipants(page, baseURL!, 12);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/projects/${projectId}`);

  // The header: one h1, the breadcrumb back to the list, tags and the region as text.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E Projektseite Mitte");
  const crumbs = page.getByRole("navigation", { name: "Navigationspfad" });
  await expect(crumbs.getByRole("link", { name: "Projekte" })).toHaveAttribute("href", "/projects");
  const header = page.locator(".tp-page-header");
  await expect(header.getByText("Kunde: Beispiel Präzisionsteile GmbH")).toBeVisible();
  await expect(header.getByText("Entwurf", { exact: true })).toBeVisible();
  await expect(header.getByText("Region: Niederlassung Nord (NORD)")).toBeVisible();
  // No region select in the header; the sections are the navigation's entries under the project.
  await expect(page.getByLabel("Region (Niederlassung)")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Navigation", exact: true }).getByRole("link"),
  ).toHaveText([
    "Projekte",
    "Übersicht",
    /^Teilnehmende/,
    "Termine",
    "Agentur",
    "Einrichtung",
    "Team",
  ]);

  // The dashboard: four tiles, the other open work, the funnel, the waves at the side.
  const today = page.getByRole("region", { name: "Heute zu tun" });
  await expect(today.locator(".tp-tile")).toHaveCount(4);
  await expect(today.getByRole("region", { name: "Weitere offene Arbeit" })).toBeVisible();
  const progress = page.getByRole("region", { name: "Verlauf" });
  await expect(progress.getByRole("link", { name: "12 Teilnehmende" })).toBeVisible();
  // The main status is one row of stages; its number opens the work list with exactly those rows.
  await expect(progress.getByRole("list", { name: "Status" })).toBeVisible();
  await expect(progress.getByRole("link", { name: "12 Importiert" })).toBeVisible();
  // "Kennzahlen" lists the values above zero; "Alle anzeigen" shows the rest (component state).
  const figures = page.getByRole("region", { name: "Kennzahlen" });
  await expect(figures.getByRole("button", { name: "Alle anzeigen" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Nach Welle" })).toBeVisible();
  // The section is named once, by the heading under the header (principle 6).
  await expect(page.getByRole("heading", { name: "Übersicht" })).toHaveCount(1);

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(today.locator(".tp-tile")).toHaveCount(4);
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `project-overview-${width}`);
  }
  await figures.getByRole("button", { name: "Alle anzeigen" }).click();
  await expect(figures.getByRole("button", { name: "Nur Werte über 0" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Nach Welle" })).toBeVisible();
  await expectNoPageScroll(page);
  await expectAccessible(page);
  await shot(page, "project-overview-all-320");

  // "Datei importieren" opens "Einrichtung" at the Import step.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Aktionen" }).click();
  await page.getByRole("menuitem", { name: "Datei importieren" }).click();
  await expect(page).toHaveURL(/\/setup#project-import$/);
  await expect(page.getByRole("region", { name: "Import" })).toBeInViewport();

  // "Einrichtung": a step list with each step's state; the selected step is open beside it. The
  // region is changed in the step "Projekt"; the rarely used settings sit under "Erweitert".
  await page.goto(`/projects/${projectId}?tab=setup`);
  const steps = page.getByRole("navigation", { name: "Schritte der Einrichtung" });
  await expect(steps.locator(".tp-step-title")).toHaveText([
    "Projekt",
    "Agentur",
    "Eintrittswellen",
    "Import",
    "DSV-Vorlage",
    "Abrechnung",
  ]);
  await steps.getByRole("button", { name: /^Projekt/ }).click();
  const projectStep = page.getByRole("region", { name: "Projekt" });
  await expect(projectStep.getByLabel("Region (Niederlassung)")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Einrichtung" })).toHaveCount(1);
  await openCard(page, "Erweitert");
  await expect(page.getByRole("heading", { name: "Kopf der Kug 200a" })).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}?tab=setup`);
    await steps.getByRole("button", { name: /^Projekt/ }).click();
    await expect(projectStep).toBeVisible();
    await expect(steps).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `project-setup-${width}`, width === 1440, setupScreenshots);
  }

  // D10, emulated: 200 % and 400 % zoom of a 1280×720 window, the overview and the setup.
  for (const size of zooms) {
    await page.setViewportSize(size);
    for (const tab of ["", "?tab=setup"]) {
      await page.goto(`/projects/${projectId}${tab}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoPageScroll(page);
    }
  }
});

test("the projects list: one title, status tags, 'Neues Projekt', an empty state that explains", async ({
  page,
  baseURL,
}) => {
  const api = page.context().request;
  await api.post("/api/v1/dev/session", {
    headers: { Origin: baseURL! },
    data: { staffUserId: "00000000-0000-4000-8000-000000000003" },
  });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projekte" })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Neues Projekt" })).toBeVisible();
    await expect(page.locator(".tp-status-tag").first()).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `projects-${width}`, false);
  }

  // No project yet (the list answered empty): what this is, how a project is created, by whom.
  await page.route(/\/api\/v1\/projects(\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/projects");
  await expect(page.getByText("Noch keine Projekte")).toBeVisible();
  await expect(page.getByText(/werden seine erste Projektleitung/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, "projects-empty-1440", false);
});
