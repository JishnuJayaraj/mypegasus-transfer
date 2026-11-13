import type { Page } from "@playwright/test";
import { seedRegionIds } from "@transfer/db";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, expectAccessible, openCard, openStep, test } from "./helpers";
import { worklistParticipations } from "./participants";

// The participant page (docs/architecture/ui-patterns.md): the header
// with its breadcrumb back to the work list as it was left (C6), the three tracks as separate tags
// and bars (C3), "Als Nächstes", the timeline with its keyboard path and its list, an edit
// form in a side panel that keeps its input on Escape (C4), and the tab "Profiling" as a step list. Each width passes axe without a
// horizontal page scroll (D10). The test brings its own project (created through the staff API)
// and participations (owner fixtures). Synthetic data only; the suite fails on any CSP violation.
// Screenshots go to docs/screenshots/7b-5/.

const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7b-5/", import.meta.url));
// 320px is a 1280px window at 400 % zoom (WCAG 1.4.10).
const widths = [1440, 768, 375, 320] as const;
// A 1280×720 window at 200 % and 400 % zoom, in CSS pixels (D10's manual check, emulated).
const zooms = [
  { width: 640, height: 360 },
  { width: 320, height: 180 },
] as const;

/** A new `ta_tg` project with three participations, the first one in the wave W1. */
async function participantInWave(page: Page, baseURL: string) {
  const api = page.context().request;
  const headers = { Origin: baseURL };
  await api.post("/api/v1/dev/session", {
    headers,
    data: { staffUserId: "00000000-0000-4000-8000-000000000003" },
  });
  const created = await api.post("/api/v1/projects", {
    headers,
    data: {
      name: "E2E Teilnehmendenseite",
      customerName: "Beispiel Feinmechanik GmbH",
      type: "ta_tg",
      regionId: seedRegionIds.nord,
    },
  });
  expect(created.status()).toBe(201);
  const { id: projectId } = (await created.json()) as { id: string };
  await worklistParticipations(page, baseURL, {
    projectId,
    prefix: "TP",
    count: 3,
    names: [
      ["Jana", "Beispiel"],
      ["Kurt", "Muster"],
      ["Lea", "Probe"],
    ],
    wave: true,
  });
  const list = (await (await api.get(`/api/v1/projects/${projectId}/worklist`)).json()) as {
    items: { id: string; personnelNumber: string }[];
  };
  const participationId = list.items.find((item) => item.personnelNumber === "TP-0001")!.id;
  const waves = (await (await api.get(`/api/v1/projects/${projectId}/entry-waves`)).json()) as {
    items: { id: string }[];
  };
  const assigned = await api.put(`/api/v1/participations/${participationId}/entry-wave`, {
    headers,
    data: { waveId: waves.items[0]!.id },
  });
  expect(assigned.ok()).toBe(true);
  return { projectId, participationId };
}

/** A screenshot after Carbon's transitions have ended. */
async function shot(page: Page, name: string, fullPage = true) {
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

/** Every button of the overview's cards fits its card (the kit's cap, D10). */
async function expectButtonsInsideCards(page: Page) {
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll(".tp-card .cds--btn")]
      // A dialog's buttons sit in the card's DOM but over the page, not in the card.
      .filter((button) => !button.closest(".cds--modal"))
      .filter((button) => {
        const card = button.closest(".tp-card")!.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return box.width > 0 && (box.left < card.left - 0.5 || box.right > card.right + 0.5);
      })
      .map((button) => button.textContent),
  );
  expect(outside, "buttons wider than their card").toEqual([]);
}

test("the participant page: header, Stand, Offen, the timeline and a side panel", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const { projectId, participationId } = await participantInWave(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });

  // From the work list, sorted by name descending, to the participant.
  await page.goto(`/projects/${projectId}?tab=participants&sort=-name`);
  await page.getByRole("link", { name: "Beispiel, Jana" }).click();
  await expect(page).toHaveURL(new RegExp(`/participations/${participationId}$`));

  // The header: one h1, the breadcrumb, the number and the wave, three separate tags.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Beispiel, Jana");
  await expect(page).not.toHaveTitle(/Beispiel|Jana|TP-0001/);
  const crumbs = page.getByRole("navigation", { name: "Navigationspfad" });
  await expect(crumbs.getByRole("link")).toHaveText([
    "Projekte",
    "E2E Teilnehmendenseite",
    "Teilnehmende",
  ]);
  await expect(crumbs.locator("[aria-current]")).toHaveCount(0);
  const header = page.locator(".tp-detail-header");
  await expect(header.getByText("Personalnummer TP-0001 · Welle W1")).toBeVisible();
  await expect(header.locator(".tp-status-tag")).toHaveText([
    "Status: Importiert",
    "Profiling: Nicht begonnen",
    "DSV: Nicht angeboten",
  ]);

  // The overview: each track its own bar (C3), the open items, the side column, the timeline.
  const stand = page.getByRole("region", { name: "Stand" });
  await expect(stand.getByRole("region")).toHaveCount(3);
  await expect(page.locator(".cds--progress")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Als Nächstes" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Fristen" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Termine & Zuständigkeit" })).toBeVisible();
  const timeline = page.getByRole("region", { name: "Zeitstrahl" });
  const markers = timeline.locator("svg.tp-timeline-svg a");
  await expect(markers.first()).toBeVisible();
  const events = timeline.locator(".tp-timeline-list li");
  await expect(events).toHaveCount(await markers.count());
  await expect(events.filter({ hasText: "Geplanter TG-Beginn" })).toContainText("01.03.2091");
  await expect(page.getByRole("heading", { name: "Übersicht" })).toHaveCount(0);

  // A marker is reached by the keyboard, shows its tooltip on focus and opens its card on Enter.
  const start = timeline.locator('svg a[aria-label^="Geplanter TG-Beginn"]');
  await start.focus();
  await expect(start).toBeFocused();
  await expect(timeline.locator(".tp-timeline-tooltip")).toHaveText(
    "Geplanter TG-Beginn · 01.03.2091",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#participant-dates$/);
  await expect(page.getByRole("region", { name: "Welle und Vertragsdaten" })).toBeInViewport();

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    // A reload, as the browser does it: the way back to the list survives it (C6).
    await page.reload();
    await expect(stand).toBeVisible();
    // Below 30rem the graphic gives way to its list (400 % zoom, D10).
    await expect(timeline.locator(".tp-timeline-graphic")).toBeVisible({ visible: width >= 480 });
    await expect(events.first()).toBeVisible();
    await expectNoPageScroll(page);
    await expectButtonsInsideCards(page);
    await expectAccessible(page);
    await shot(page, `participant-overview-${width}`);
  }

  // An edit form in a side panel: Escape asks before discarding, Escape again keeps the input.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCard(page, "Welle und Vertragsdaten");
  await page.getByRole("button", { name: "Vertragsdaten ändern" }).click();
  const panel = page.getByRole("dialog", { name: "Vertragsdaten ändern" });
  await panel.getByLabel("TG-Ende (TT.MM.JJJJ)").fill("31.01.2092");
  await page.keyboard.press("Escape");
  const question = page.getByRole("alertdialog", { name: "Änderungen verwerfen?" });
  await expect(question.getByRole("button", { name: "Weiter bearbeiten" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(question).toBeHidden();
  await expect(panel.getByLabel("TG-Ende (TT.MM.JJJJ)")).toHaveValue("31.01.2092");
  await expectAccessible(page);
  await shot(page, "participant-dates-panel-1440", false);
  for (const size of zooms) {
    await page.setViewportSize(size);
    await expect(panel.getByLabel("TG-Ende (TT.MM.JJJJ)")).toBeVisible();
    await expectNoPageScroll(page);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await expectAccessible(page);
  await shot(page, "participant-dates-panel-320", false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel
    .getByRole("button", { name: /schließen|Close/i })
    .first()
    .click();
  await question.getByRole("button", { name: "Verwerfen" }).click();
  await expect(panel).toBeHidden();

  // D10, emulated: 200 % and 400 % zoom of a 1280×720 window, the overview.
  for (const size of zooms) {
    await page.setViewportSize(size);
    // A reload, as the browser does it: the way back to the list survives it (C6).
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoPageScroll(page);
  }

  // The tab "Profiling" as a step list: the track's steps, one open at a time, at every width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Profiling" }).click();
  const steps = page.getByRole("navigation", { name: "Schritte des Profilings" });
  await expect(steps.getByRole("button")).toHaveText([
    /^Profiling-Status/,
    /^Termine des Profilings/,
    /^Angaben aus der Selbstauskunft/,
    /^Profilingbogen \(TL 407\)/,
    /^Unterschriebene Bögen/,
    /^Übermittlung an die Agentur/,
  ]);
  await expect(steps.locator('[aria-current="step"]')).toHaveCount(1);
  await openStep(page, "Angaben aus der Selbstauskunft");
  await expect(page.getByRole("region", { name: "Angaben aus der Selbstauskunft" })).toContainText(
    "Fehlende Angaben",
  );
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(steps).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `participant-profiling-${width}`);
  }
  for (const size of zooms) {
    await page.setViewportSize(size);
    await expect(steps).toBeVisible();
    await expectNoPageScroll(page);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Übersicht" }).click();

  // Back through the breadcrumb: the work list as it was left, sorted by name descending (C6).
  await page.setViewportSize({ width: 1440, height: 900 });
  await crumbs.getByRole("link", { name: "Teilnehmende", exact: true }).click();
  await expect(page).toHaveURL(/\/participants\?/);
  await expect(page).toHaveURL(/sort=-name/);
  await expect(page.getByRole("columnheader", { name: /Teilnehmende/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
});
