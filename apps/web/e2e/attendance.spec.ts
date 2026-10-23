import { createDb, seedProjectIds } from "@transfer/db";
import { testDatabaseUrls } from "@transfer/db/testing";
import { berlinDate } from "@transfer/domain";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant } from "./participants";

// Attendance and `informed` (process-and-lifecycle.md, appointments: attendance): the PL creates
// an info event, books a participant, and after the event records the attendance with the
// delivery confirmed; the participant is `informed`. Appointments are created in the future, so
// the owner moves this one into the past (a fixture, as attendance is recorded after the fact).
// The suite fails on any CSP violation. Synthetic data only.

const projectId = seedProjectIds.werkNord;
const PRIVATE = "teilnahme.privat@example.org";
const DAY_MS = 24 * 60 * 60 * 1000;

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

  // "Termine" → "Infoveranstaltung anlegen" in two days.
  await page.goto(`/projects/${projectId}?tab=appointments`);
  await page.getByRole("button", { name: "Infoveranstaltung anlegen" }).click();
  const [year, month, day] = berlinDate(new Date(Date.now() + 2 * DAY_MS).toISOString()).split("-");
  await page.getByLabel("Datum (TT.MM.JJJJ)").fill(`${day}.${month}.${year}`);
  await page.getByLabel("Beginn (HH:MM)").fill("10:00");
  await page.getByLabel("Ende (HH:MM)").fill("12:00");
  await page.getByLabel("Plätze (1–500)").fill("40");
  await page.getByLabel("Ort").fill("Kantine Werk 2");
  const created = page.waitForResponse(
    (r) => r.url().endsWith(`/projects/${projectId}/appointments`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Speichern" }).click();
  const { id: appointmentId } = (await (await created).json()) as { id: string };

  // The appointment page: "Teilnehmende buchen".
  await page.goto(`/projects/${projectId}/appointments/${appointmentId}`);
  await page.getByLabel("Name oder Personalnummer").fill(personnelNumber);
  await page.getByLabel("Teilnehmende·r").selectOption(participationId);
  await page.getByRole("button", { name: "Buchen", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Beispiel, Erika" })).toBeVisible();

  // The event took place: it started three hours ago and ended an hour ago.
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await owner.$client.query(
      `update appointment set starts_at = now() - interval '3 hours',
         ends_at = now() - interval '1 hour', booking_closes_at = now() - interval '27 hours'
       where id = $1`,
      [appointmentId],
    );
  } finally {
    await owner.$client.end();
  }

  // "Teilnahme erfassen": teilgenommen, "als informiert erfassen" preselected, the confirmation.
  await page.reload();
  await page.getByRole("button", { name: "Teilnahme erfassen" }).click();
  const dialog = page.getByRole("dialog", { name: "Teilnahme erfassen" });
  await dialog.getByLabel(`Teilnahme von ${label}`).selectOption("attended");
  await expect(dialog.getByLabel(`${label} als informiert erfassen`)).toBeChecked();
  await dialog.getByText("Die erforderlichen Informationen wurden vermittelt").click();
  await expectAccessible(page);
  const recorded = page.waitForResponse(
    (r) => r.url().endsWith(`/appointments/${appointmentId}/attendance`),
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
