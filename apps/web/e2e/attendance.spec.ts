import { createDb, seedProjectIds } from "@transfer/db";
import { testDatabaseUrls } from "@transfer/db/testing";
import { berlinDate } from "@transfer/domain";
import type { Page } from "@playwright/test";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant } from "./participants";

// Attendance and `informed` (process-and-lifecycle.md, appointments: attendance): the PL creates
// an info event, books a participant, and after the event records the attendance with the
// delivery confirmed; the participant is `informed`. Appointments are created in the future, so
// the owner moves this one into the past (a fixture, as attendance is recorded after the fact).
// The suite fails on any CSP violation. Synthetic data only. The second test follows a missed
// info event through the work list's "Termine" (process-and-lifecycle.md, appointments: the work
// list) to its resolution.

const projectId = seedProjectIds.werkNord;
const PRIVATE = "teilnahme.privat@example.org";
const DAY_MS = 24 * 60 * 60 * 1000;

/** "Termine" → "Infoveranstaltung anlegen" in two days; returns its id. */
async function createInfoEvent(page: Page) {
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
  return ((await (await created).json()) as { id: string }).id;
}

/** The appointment page: "Teilnehmende buchen" for one participation. */
async function bookOnPage(page: Page, appointmentId: string, participationId: string) {
  await page.goto(`/projects/${projectId}/appointments/${appointmentId}`);
  await page.getByLabel("Name oder Personalnummer").fill(`E2E-${participationId.slice(0, 8)}`);
  await page.getByLabel("Teilnehmende·r").selectOption(participationId);
  await page.getByRole("button", { name: "Buchen", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Beispiel, Erika" })).toBeVisible();
}

/** Moves an appointment so it started `hours` hours ago and ended two hours later (a fixture). */
async function startedAgo(appointmentId: string, hours: number) {
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await owner.$client.query(
      `update appointment set starts_at = now() - $2 * interval '1 hour',
         ends_at = now() - ($2 - 2) * interval '1 hour',
         booking_closes_at = now() - ($2 + 24) * interval '1 hour'
       where id = $1`,
      [appointmentId, hours],
    );
  } finally {
    await owner.$client.end();
  }
}

test("attendance: the PL records an info event's attendance and the participant is informed", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: PRIVATE,
  });
  const personnelNumber = `E2E-${participationId.slice(0, 8)}`;
  const label = `Beispiel, Erika (${personnelNumber})`;

  const appointmentId = await createInfoEvent(page);
  await bookOnPage(page, appointmentId, participationId);
  // The event took place: it started three hours ago and ended an hour ago.
  await startedAgo(appointmentId, 3);

  // "Teilnahme erfassen": teilgenommen, "als informiert erfassen" preselected, the confirmation.
  await page.reload();
  await page.getByRole("button", { name: "Teilnahme erfassen" }).click();
  const dialog = page.getByRole("dialog", { name: "Teilnahme erfassen" });
  await dialog.getByLabel(`Teilnahme von ${label}`).selectOption("attended");
  await expect(dialog.getByLabel(`${label} als informiert erfassen`)).toBeChecked();
  await dialog.getByText("Die erforderlichen Informationen wurden vermittelt").click();
  await expectAccessible(page);
  const recorded = page.waitForResponse((r) =>
    r.url().endsWith(`/appointments/${appointmentId}/attendance`),
  );
  await dialog.getByRole("button", { name: "Erfassen" }).click();
  expect(await (await recorded).json()).toEqual({ recorded: 1, informed: 1, statusChanges: 1 });
  await expect(page.getByText("teilgenommen · Grundlage für „informiert“")).toBeVisible();

  // The participant is `informed`.
  const participation = await page
    .context()
    .request.get(`/api/v1/participations/${participationId}`);
  expect(((await participation.json()) as { status: string }).status).toBe("informed");
});

test("the work list: a missed info event under 'Termine überfällig' until the PL resolves it", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: "versaeumt.privat@example.org",
  });
  const personnelNumber = `E2E-${participationId.slice(0, 8)}`;
  const label = `Beispiel, Erika (${personnelNumber})`;
  const appointmentId = await createInfoEvent(page);
  await bookOnPage(page, appointmentId, participationId);
  // Two days ago: its Berlin end date has passed, the attendance is missing.
  await startedAgo(appointmentId, 50);
  const overdue = `/projects/${projectId}?tab=participants&appointment=overdue`;
  const row = () => page.getByRole("row").filter({ hasText: personnelNumber });
  await page.goto(overdue);
  await expect(row()).toContainText("Teilnahme nicht erfasst Infoveranstaltung vom");

  // "Teilnahme erfassen": nicht erschienen.
  await page.goto(`/projects/${projectId}/appointments/${appointmentId}`);
  await page.getByRole("button", { name: "Teilnahme erfassen" }).click();
  const dialog = page.getByRole("dialog", { name: "Teilnahme erfassen" });
  await dialog.getByLabel(`Teilnahme von ${label}`).selectOption("absent");
  await dialog.getByRole("button", { name: "Erfassen" }).click();
  await expect(dialog).toBeHidden();

  // The work list's column "Termin" under the filter "Termine überfällig".
  await page.goto(overdue);
  await expect(page.locator("#worklist-filter-appointment")).toHaveValue("overdue");
  await expect(row()).toContainText("Nicht erschienen Infoveranstaltung vom");
  await expectAccessible(page);
  // Wide enough for every column of the table, "Termin" included.
  await page.setViewportSize({ width: 2400, height: 1000 });
  await page.getByRole("table", { name: "Teilnehmende" }).screenshot({
    path: test.info().outputPath("worklist-termin.png"),
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  // "Übersicht": the tiles and the group "Termine".
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("link", { name: /^\d+ Termine überfällig$/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Termine" })).toBeVisible();
  await page.locator(".tp-tiles").screenshot({
    path: test.info().outputPath("dashboard-tiles.png"),
  });
  await page.getByRole("table", { name: "Termine" }).screenshot({
    path: test.info().outputPath("dashboard-termine.png"),
  });

  // The participant tab "Termine": "Keine weitere Nachverfolgung" with a closed reason.
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=appointments`);
  await expect(page.getByText("Nicht erschienen, Nachverfolgung offen")).toBeVisible();
  await expect(page.getByRole("button", { name: "Folgetermin buchen" })).toBeVisible();
  await page.getByRole("button", { name: "Keine weitere Nachverfolgung" }).click();
  const resolution = page.getByRole("dialog", { name: "Keine weitere Nachverfolgung" });
  await resolution.getByLabel("Grund").selectOption("information_delivered_otherwise");
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("missed-resolution.png") });
  await resolution.getByRole("button", { name: "Keine weitere Nachverfolgung" }).click();
  await expect(
    page.getByText("Keine weitere Nachverfolgung: Anderweitig informiert"),
  ).toBeVisible();

  // The item is gone from the work list.
  await page.goto(overdue);
  await expect(page.locator("#worklist-filter-appointment")).toHaveValue("overdue");
  await expect(page.getByRole("link", { name: personnelNumber })).toHaveCount(0);
});
