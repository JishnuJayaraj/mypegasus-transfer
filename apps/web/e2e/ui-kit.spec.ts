import type { Page } from "@playwright/test";
import { seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { berlinDate } from "@transfer/domain";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant } from "./participants";

// The UI kit's first consumers (docs/architecture/ui-patterns.md): the
// appointment page's header, the work list's status tags, relative dates and empty states, and
// the admin pages' data table and side panel, each with axe at 1440, 768, 375 and 320px (D10).
// Synthetic data only; the suite fails on any CSP violation. Screenshots go to
// docs/screenshots/6b-2/. The kit page (`/ui-kit`) and the navigation are the last test, with
// their screenshots in docs/screenshots/7b-4/.

const projectId = seedProjectIds.werkNord;
const DAY_MS = 24 * 60 * 60 * 1000;
// 320px is a 1280px window at 400 % zoom (WCAG 1.4.10), checked too; screenshots at all four.
const widths = [1440, 768, 375, 320] as const;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/6b-2/", import.meta.url));

/** A screenshot of the viewport (or the page), after Carbon's transitions have ended. */
async function shot(page: Page, name: string, fullPage = false, dir = screenshots) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}.png`, fullPage });
}

/** The page itself never scrolls sideways; a table may, inside its own container (D10). */
async function expectNoPageScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal page overflow in px").toBeLessThanOrEqual(0);
}

async function logInAs(page: Page, baseURL: string, staffUserId: string) {
  const response = await page.request.post("/api/v1/dev/session", {
    headers: { Origin: baseURL },
    data: { staffUserId },
  });
  expect(response.ok()).toBe(true);
}

async function expectNothingStored(page: Page) {
  const stored = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
  ]);
  expect(stored).toEqual([]);
}

test("the appointment page and the work list on the kit, at every width", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: "kit.privat@example.org",
  });
  const personnelNumber = `E2E-${participationId.slice(0, 8)}`;

  // An info event in two days (the PL).
  await page.goto(`/projects/${projectId}?tab=appointments`);
  await page.getByRole("button", { name: "Infoveranstaltung anlegen" }).click();
  const [year, month, day] = berlinDate(new Date(Date.now() + 2 * DAY_MS).toISOString()).split("-");
  await page.getByLabel("Datum (TT.MM.JJJJ)").fill(`${day}.${month}.${year}`);
  await page.getByLabel("Beginn (HH:MM)").fill("10:00");
  await page.getByLabel("Ende (HH:MM)").fill("12:00");
  await page.getByLabel("Plätze (1–500)").fill("40");
  await page.getByLabel("Ort").fill("Kantine Werk 2");
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${projectId}/appointments`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Speichern" }).click();
  const appointmentId = ((await (await created).json()) as { id: string }).id;

  await page.goto(`/projects/${projectId}/appointments/${appointmentId}`);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    // The page header: breadcrumbs, one h1, the status tag, the metadata line, the primary action.
    const crumbs = page.getByRole("navigation", { name: "Navigationspfad" });
    await expect(crumbs.getByRole("link")).toHaveText(["Projekte", /Werk Nord/, "Termine"]);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator(".tp-page-header .tp-status-tag")).toHaveText("Geplant");
    await expect(page.locator(".tp-page-header-metadata")).toContainText("Kantine Werk 2");
    await expect(page.getByRole("button", { name: "Ändern" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Termin" })).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `appointment-${width}`);
    // The secondary actions in "Aktionen", destructive ones in red; Escape closes the menu.
    await page.getByRole("button", { name: "Aktionen" }).click();
    await expect(page.getByRole("menuitem", { name: "Absagen" })).toBeVisible();
    await expectAccessible(page);
    if (width === 1440) await shot(page, `appointment-actions-${width}`);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Absagen" })).toHaveCount(0);
  }
  // The breadcrumb leads back to the project's appointments.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByRole("navigation", { name: "Navigationspfad" })
    .getByRole("link", { name: "Termine" })
    .click();
  await expect(page).toHaveURL(/\/appointments$/);

  // The work list: three separate track tags (C3) and the deadline with relative and absolute date.
  await page.goto(`/projects/${projectId}?tab=participants`);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  const row = list.getByRole("row", { name: new RegExp(personnelNumber) });
  await expect(row.locator(".tp-status-tag")).toHaveCount(3);
  await expect(row.locator(".tp-status-tag").first()).toHaveText("Kontaktiert");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `worklist-${width}`, true);
  }
  // No matches: says so and resets the filters and the search (the empty state, principle 7).
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/projects/${projectId}?tab=participants&deadlineState=overdue`);
  await list
    .getByRole("searchbox", { name: "Name oder Personalnummer suchen" })
    .fill("Kein-Treffer-XYZ");
  const empty = list.locator(".tp-empty-state");
  await expect(empty).toContainText("Keine Teilnehmenden entsprechen");
  await expectAccessible(page);
  await shot(page, "worklist-no-matches-1280");
  await empty.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await expect(page).toHaveURL(/\/participants$/);
  await expect(
    list.getByRole("searchbox", { name: "Name oder Personalnummer suchen" }),
  ).toHaveValue("");
  await expect(row).toBeVisible();
  await expectNothingStored(page);
});

test("the staff accounts: data table, row menu and the side panel's discard question", async ({
  page,
  baseURL,
}) => {
  await logInAs(page, baseURL!, seedStaffUserIds.admin);
  await page.goto("/admin/staff");
  const table = page.getByRole("table", { name: "Mitarbeitende" });
  await expect(table).toBeVisible();
  // Sortable header: by name, ascending, then descending.
  await table.getByRole("button", { name: /^Name/ }).click();
  await expect(table.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  const names = await table.locator("tbody tr td:first-child").allTextContents();
  expect(names).toEqual(names.toSorted((a, b) => a.localeCompare(b, "de")));

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `staff-${width}`);

    // The row's overflow menu, by keyboard.
    const menu = page.getByRole("button", { name: "Aktionen für Bernd Beratung" });
    await menu.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Bearbeiten" }).click();
    const panel = page.getByRole("dialog", { name: "Bernd Beratung" });
    await expect(panel).toBeVisible();
    // Full width below 42rem, 30rem from there.
    const box = (await panel.boundingBox())!;
    if (width < 672) expect(Math.round(box.width)).toBe(width);
    else expect(Math.round(box.width)).toBe(480);
    // The prerequisite of a blocked action as text (C1).
    await expect(panel.getByText("Erst eine Region wählen.")).toBeVisible();
    await expectAccessible(page);
    await shot(page, `staff-panel-${width}`);

    // C4: edited input is not discarded silently; Escape on the question keeps it.
    const name = panel.getByLabel("Name", { exact: true });
    await name.fill("Bernd Beratung (geändert)");
    await page.keyboard.press("Escape");
    const ask = page.getByRole("alertdialog", { name: "Änderungen verwerfen?" });
    await expect(ask).toBeVisible();
    await expect(page.getByRole("button", { name: "Weiter bearbeiten" })).toBeFocused();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `staff-discard-${width}`);
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(name).toHaveValue("Bernd Beratung (geändert)");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Verwerfen" }).click();
    await expect(panel).toHaveCount(0);
    await expect(menu).toBeFocused();
  }
  await expectNothingStored(page);
});

test("the regions and escalations on the kit", async ({ page, baseURL }) => {
  await logInAs(page, baseURL!, seedStaffUserIds.admin);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/regions");
    await expect(page.getByRole("table", { name: "Regionen" })).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `regions-${width}`);
    await page.getByRole("button", { name: "Region anlegen" }).click();
    await expect(page.getByRole("dialog", { name: "Region anlegen" })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.goto("/admin/escalations");
    await expect(page.getByRole("heading", { name: "Eskalationen", level: 1 })).toBeVisible();
    await expect(page.getByText("Überfällige Punkte je Projekt")).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `escalations-${width}`);
  }
});

const kitShots = fileURLToPath(new URL("../../../docs/screenshots/7b-4/", import.meta.url));

test("the kit page: every component of the second layer in its states, at every width", async ({
  page,
  baseURL,
}) => {
  await logInAs(page, baseURL!, seedStaffUserIds.projectLead);
  await page.goto("/ui-kit");
  // DetailHeader: the one h1, the metadata line, three track tags (C3), five facts, the one
  // primary action and "Aktionen".
  const header = page.locator(".tp-detail-header");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("UI-Kit");
  await expect(header.locator(".tp-status-tag")).toHaveCount(3);
  await expect(header.locator("dt")).toHaveCount(5);
  await expect(header.getByRole("button", { name: "Profilingbogen erzeugen" })).toBeVisible();
  await header.getByRole("button", { name: "Aktionen" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Erinnern",
    "Zuweisen",
    "Teilnahme beenden",
  ]);
  await page.keyboard.press("Escape");

  // The tiles (a zero is neutral) and their skeleton; the funnel as one row.
  const tiles = page.getByRole("region", { name: "CountTile" });
  await expect(tiles.getByRole("link")).toHaveText([
    /^7\s*Überfällig$/,
    /^12\s*In den nächsten 14 Tagen$/,
    /^23\s*Angaben\/Unterlagen fehlen$/,
    /^0\s*Termine zu klären$/,
  ]);
  await expect(tiles.locator(".tp-tile--neutral")).toHaveCount(1);
  await expect(tiles.locator("[aria-busy=true]")).toHaveCount(1);
  const funnel = page.getByRole("list", { name: "Verlauf" });
  await expect(funnel.getByRole("listitem")).toHaveCount(7);
  await expect(funnel.getByRole("link")).toHaveCount(5);

  // NextSteps: each item with its own action; the empty state says so.
  const steps = page.getByRole("region", { name: "Als Nächstes", exact: true });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps.getByRole("button")).toHaveText([
    "Meldung erfassen",
    "Scan hochladen",
    "Erinnern",
  ]);
  await expect(page.getByRole("region", { name: "Als Nächstes (leer)" })).toContainText(
    "Keine offenen Punkte.",
  );

  // SectionCard: open by default, collapsed to its summary, and protected content never open by
  // default nor in the document before it is opened. The open state is memory only.
  await expect(page.getByRole("button", { name: "Stammdaten" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const collapsed = page.getByRole("region", { name: "Welle und Vertragsdaten" });
  await expect(collapsed).toContainText("W1 · 01.03.2027 – 29.02.2028");
  const sensitive = page.getByRole("button", { name: "Besonders geschützte Angaben" });
  await expect(sensitive).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Synthetischer Inhalt")).toHaveCount(0);
  await sensitive.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Synthetischer Inhalt")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Synthetischer Inhalt")).toHaveCount(0);

  // StepList: starts on the current step; another opens by keyboard.
  const track = page.getByRole("navigation", { name: "Profiling" });
  await expect(track.getByRole("button", { name: /Profilingbogen erzeugen/ })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await track.getByRole("button", { name: /Angaben prüfen/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Angaben prüfen" })).toBeVisible();
  await track.getByRole("button", { name: /Profilingbogen erzeugen/ }).click();

  // DataTable: sort, filter with its reset, the column chooser, loading and empty.
  const table = page.getByRole("table", { name: "Dringend", exact: true });
  await table.getByRole("button", { name: /^Teilnehmende/ }).click();
  await expect(table.locator("tbody tr td:first-child")).toHaveText([
    /^Beispiel, Bruno/,
    /^Muster, Carla/,
    /^Normalverbraucher, Anna/,
  ]);
  const filter = page.getByRole("searchbox", { name: "Name oder Personalnummer filtern" }).first();
  await filter.fill("BSP-0042");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await filter.fill("kein Treffer");
  await expect(page.getByText("Kein Eintrag entspricht dem Filter")).toBeVisible();
  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  const data = page.getByRole("region", { name: "DataTable" });
  await data.getByRole("button", { name: "Spalten" }).first().click();
  await data.getByRole("group", { name: "Angezeigte Spalten" }).getByText("Beratung").click();
  await expect(table.getByRole("columnheader", { name: /Beratung/ })).toHaveCount(0);
  await data.getByRole("group", { name: "Angezeigte Spalten" }).getByText("Beratung").click();
  await data.getByRole("button", { name: "Spalten" }).first().click();
  await table.getByRole("button", { name: /^Teilnehmende/ }).click();
  await table.getByRole("button", { name: /^Teilnehmende/ }).click();
  await expect(data.locator(".tp-table-skeleton")).toHaveCount(1);
  await expect(data).toContainText("Keine überfälligen Punkte");

  // No dark `secondary` button anywhere; a blocked action has its prerequisite beside it (C1).
  await expect(page.locator(".cds--btn--secondary")).toHaveCount(0);
  await expect(page.getByText("Erst eine Region wählen.")).toBeVisible();

  // 1440, 768, 375 and 320px: 768px is a 1536px window at 200 %, 320px a 1280px one at 400 %.
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(header).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    // The whole page in one viewport: a full-page capture would stitch the fixed header in.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height });
    await shot(page, `kit-${width}`, false, kitShots);
  }
  await expectNothingStored(page);
});

test("the navigation with the project's sections, at every width", async ({ page, baseURL }) => {
  await logInAs(page, baseURL!, seedStaffUserIds.projectLead);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}/participants`);
    await expect(page.getByRole("heading", { name: "Teilnehmende", level: 2 })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Navigation", exact: true });
    const menu = page.getByRole("button", { name: "Navigation öffnen oder schließen" });
    if (width >= 1056) {
      // Always open from 66rem: no menu button, the entries in the focus order after the header.
      await expect(menu).toHaveCount(0);
    } else {
      await expect(nav).toBeHidden();
      await menu.click();
    }
    await expect(nav.getByRole("link")).toHaveText([
      "Projekte",
      "Übersicht",
      /^Teilnehmende/,
      "Termine",
      "Agentur",
      "Einrichtung",
      "Team",
    ]);
    await expect(nav.locator('[aria-current="page"]')).toHaveText(/^Teilnehmende/);
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `navigation-${width}`, false, kitShots);
    if (width < 1056) await page.keyboard.press("Escape");
  }
  // The old address still opens its section, the anchor included.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/projects/${projectId}?tab=agentur`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/agentur$`));
  await expect(page.getByRole("heading", { name: "Agentur", level: 2 })).toBeVisible();
  await page.goto(`/projects/${projectId}?tab=setup#project-import`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/setup#project-import$`));
  // Focus order: the skip link, the product name, the user menu, then the navigation's entries.
  await page.goto(`/projects/${projectId}/overview`);
  await expect(page.getByRole("heading", { name: "Übersicht", level: 2 })).toBeVisible();
  for (const name of [/Zum Inhalt/, "Transferplattform", /Benutzermenü/, "Projekte", "Übersicht"]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveAccessibleName(name);
  }
  await expectNothingStored(page);
});
