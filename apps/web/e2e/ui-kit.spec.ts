import type { Page } from "@playwright/test";
import { seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { berlinDate } from "@transfer/domain";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant } from "./participants";

// The UI kit's first consumers (docs/architecture/ui-patterns.md; UX foundation plan, 6b-2): the
// appointment page's header, the work list's status tags, relative dates and empty states, and
// the admin pages' data table and side panel, each with axe at 1440, 768, 375 and 320px (D10).
// Synthetic data only; the suite fails on any CSP violation. Screenshots go to
// docs/screenshots/6b-2/.

const projectId = seedProjectIds.werkNord;
const DAY_MS = 24 * 60 * 60 * 1000;
// 320px is a 1280px window at 400 % zoom (WCAG 1.4.10), checked too; screenshots at all four.
const widths = [1440, 768, 375, 320] as const;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/6b-2/", import.meta.url));

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
  await expect(page).toHaveURL(/tab=appointments/);

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
  await list.getByLabel("Name oder Personalnummer suchen").fill("Kein-Treffer-XYZ");
  const empty = list.locator(".tp-empty-state");
  await expect(empty).toContainText("Keine Teilnehmenden entsprechen");
  await expectAccessible(page);
  await shot(page, "worklist-no-matches-1280");
  await empty.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await expect(page).toHaveURL(/\?tab=participants$/);
  await expect(list.getByLabel("Name oder Personalnummer suchen")).toHaveValue("");
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
