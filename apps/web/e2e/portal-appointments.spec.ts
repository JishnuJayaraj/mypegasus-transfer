import type { APIRequestContext, Page } from "@playwright/test";
import { seedProjectIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant, loggedInAsOwner } from "./participants";

// Invitations and the portal's "Termine" (data-protection.md, invitations and appointments: the
// portal): the PL creates an info event and invites an activated participant from the work list;
// the invitation goes out with the fixed text; the participant, on a 320 px wide phone, sees it
// in German and English, books it after a confirmation and cancels the booking. The suite fails on
// any CSP violation. Synthetic data only.

const projectId = seedProjectIds.werkNord;
const PRIVATE = "termine.privat@example.org";
const DAY_MS = 24 * 60 * 60 * 1000;

type Message = { kind: string; to: string; subject?: string; text: string };
const outboxTo = async (staff: APIRequestContext, to: string) =>
  ((await (await staff.get("/api/v1/dev/outbox")).json()) as Message[]).filter((m) => m.to === to);

/** No horizontal scrolling at this width. */
const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("appointments: the PL invites, the participant books and cancels in the portal", async ({
  page,
  baseURL,
  browser,
}) => {
  test.slow();
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: PRIVATE,
  });
  const personnelNumber = `E2E-${participationId.slice(0, 8)}`;
  const staff = page.context().request;
  const startsAt = new Date(Math.ceil((Date.now() + 3 * DAY_MS) / 3_600_000) * 3_600_000);
  const created = await staff.post(`/api/v1/projects/${projectId}/appointments`, {
    data: {
      kind: "info_event",
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      capacity: 40,
      title: "Infoveranstaltung Transfer",
      venue: "Kantine Werk 2",
    },
    headers: { Origin: baseURL! },
  });
  expect(created.status()).toBe(201);
  const { id: appointmentId } = (await created.json()) as { id: string };

  // The work list: "Zu Termin einladen" with the counts per channel and the fixed text.
  await page.goto(`/projects/${projectId}?tab=participants`);
  const search = page.getByLabel("Name oder Personalnummer suchen");
  await expect(search).toBeEnabled();
  await search.fill(personnelNumber);
  await page.getByRole("checkbox", { name: `${personnelNumber} auswählen` }).check({ force: true });
  await page.getByRole("button", { name: "Zu Termin einladen (1)" }).click();
  const dialog = page.getByRole("dialog", { name: "Zu Termin einladen" });
  await dialog.getByLabel("Termin", { exact: true }).selectOption(appointmentId);
  await expect(
    dialog.getByRole("list", { name: "Ausgewählte Teilnehmende" }).getByRole("listitem"),
  ).toHaveText(["1 per E-Mail"]);
  await expect(dialog.getByText("Neue Einladung im Teilnehmerportal")).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("invitation-dialog.png") });
  await dialog.getByRole("button", { name: "Einladen" }).click();
  await expect(
    dialog.getByText("1 Einladung wird gesendet (1 per E-Mail, 0 per SMS)."),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("invitation-result.png") });
  await dialog.getByRole("button", { name: "Schließen" }).click();
  await expect.poll(async () => (await outboxTo(staff, PRIVATE)).length).toBeGreaterThan(0);
  const invitation = (await outboxTo(staff, PRIVATE)).find((m) =>
    m.subject?.startsWith("Neue Einladung"),
  );
  expect(invitation).toMatchObject({
    kind: "email",
    text:
      `In Ihrem Teilnehmerportal gibt es eine Einladung zu einem Termin. Bitte melden Sie sich an: ${baseURL}/portal/\n\n` +
      "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.",
  });

  // The participant on a 320 px wide phone.
  const participant = await browser.newContext({ baseURL, viewport: { width: 320, height: 900 } });
  const portal = await participant.newPage();
  await loggedInAsOwner(portal, baseURL!, participationId);
  await portal.goto("/portal/");
  await portal.getByRole("link", { name: "Termine" }).click();
  const invitations = portal.getByRole("region", { name: "Einladungen" });
  const item = invitations.getByRole("listitem");
  await expect(item.getByRole("heading", { level: 3 })).toHaveText(/^Infoveranstaltung am /);
  await expect(item).toContainText("Kantine Werk 2");
  expect(await fitsWidth(portal)).toBe(true);
  await expectAccessible(portal);
  await portal.screenshot({
    path: test.info().outputPath("portal-termine-de-320.png"),
    fullPage: true,
  });

  // English, then back to the start page's link.
  await portal.goto("/portal/");
  await portal.getByLabel("Sprache").selectOption("en");
  await portal.getByRole("link", { name: "Appointments" }).click();
  await expect(portal.getByRole("region", { name: "Invitations" })).toBeVisible();
  await expect(portal.getByRole("button", { name: "Book" })).toBeVisible();
  expect(await fitsWidth(portal)).toBe(true);
  await expectAccessible(portal);
  await portal.screenshot({
    path: test.info().outputPath("portal-termine-en-320.png"),
    fullPage: true,
  });
  // A new page load starts in German again.
  await portal.goto("/portal/appointments");

  // Book after a confirmation (keyboard), then cancel.
  await invitations.getByRole("button", { name: "Buchen" }).focus();
  await portal.keyboard.press("Enter");
  await portal.getByRole("button", { name: "Ja, buchen" }).click();
  await expect(portal.getByText("Der Termin ist gebucht.")).toBeVisible();
  const mine = portal.getByRole("region", { name: "Meine Termine" });
  await expect(mine.getByRole("listitem")).toContainText("Kantine Werk 2");
  await expect(invitations.getByText("Sie haben keine offenen Einladungen.")).toBeVisible();
  await portal.screenshot({
    path: test.info().outputPath("portal-termine-booked-de-320.png"),
    fullPage: true,
  });
  await mine.getByRole("button", { name: "Absagen" }).click();
  await mine.getByRole("button", { name: "Ja, absagen" }).click();
  await expect(portal.getByText("Ihre Buchung ist abgesagt.")).toBeVisible();
  await expect(mine.getByText("Sie haben keine gebuchten Termine.")).toBeVisible();
  // The participant's own cancellation: the invitation is back, nothing under "Abgesagt".
  await expect(invitations.getByRole("listitem")).toHaveCount(1);
  await expect(
    portal.getByRole("region", { name: "Abgesagt" }).getByText("Keine abgesagten Termine."),
  ).toBeVisible();
  expect(await fitsWidth(portal)).toBe(true);

  // "Nachrichten" names the invitation, by "Team".
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=messages`);
  const row = page.getByRole("row", { name: /Einladung zu einem Termin/ });
  await expect(row).toContainText("E-Mail");
  await expect(row).toContainText("Team");
  await participant.close();
});
