import type { APIRequestContext, Page } from "@playwright/test";
import { seedProjectIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";
import {
  activatedParticipant,
  consentAsV1,
  loggedInAsOwner,
  worklistParticipations,
} from "./participants";

// Reminders (data-protection.md, reminders and consent v2), without any code submission: the
// participants are set up by the owner fixtures (participants.ts) and the portal login is the
// owner's session. One activated participant (consent v2) is reminded by email; one without an
// account is skipped `no_channel`, one whose channel still has a v1 consent `consent_required`;
// that one accepts consent v2 in "Meine Kontaktwege" and the PL's next reminder reaches them.
// The suite fails on any CSP violation. Synthetic data only.

const projectId = seedProjectIds.werkNord;
const REACHABLE = "reminder.reachable@example.org";
const V1 = "reminder.consent-v1@example.org";

type Message = { kind: string; to: string; subject?: string; text: string };
const outboxTo = async (staff: APIRequestContext, to: string) =>
  ((await (await staff.get("/api/v1/dev/outbox")).json()) as Message[]).filter((m) => m.to === to);

/** Selects the rows by Personalnummer through the in-memory search; the selection stays. */
async function select(page: Page, personnelNumbers: string[]) {
  const search = page.getByLabel("Name oder Personalnummer suchen");
  await expect(search).toBeEnabled();
  for (const number of personnelNumbers) {
    await search.fill(number);
    await page.getByRole("checkbox", { name: `${number} auswählen` }).check({ force: true });
  }
  await search.fill("");
}

const personnelNumber = (participationId: string) => `E2E-${participationId.slice(0, 8)}`;

test("reminders: sent by email, skipped without a usable channel, and after consent v2", async ({
  page,
  baseURL,
  browser,
}) => {
  test.slow();
  const reachable = await activatedParticipant(page, baseURL!, { projectId, address: REACHABLE });
  const v1 = await activatedParticipant(page, baseURL!, { projectId, address: V1 });
  await consentAsV1(v1);
  await worklistParticipations(page, baseURL!, {
    projectId,
    prefix: "REM",
    count: 1,
    names: [["Bea", "Ohnekonto"]],
  });
  const staff = page.context().request;

  await page.goto(`/projects/${projectId}?tab=participants`);
  await select(page, [personnelNumber(reachable), "REM-0001", personnelNumber(v1)]);
  await page.getByRole("button", { name: "Erinnern (3)" }).click();
  const dialog = page.getByRole("dialog", { name: "An offene Punkte erinnern" });
  const counts = dialog.getByRole("list", { name: "Ausgewählte Teilnehmende" });
  await expect(counts.getByRole("listitem")).toHaveText([
    "1 per E-Mail",
    "2 ohne Kontaktweg: Kein für Erinnerungen nutzbarer Kontaktweg.",
  ]);
  await expect(dialog.getByText("Im Teilnehmerportal ist noch etwas offen")).toBeVisible();
  await expectAccessible(page);
  const answer = page.waitForResponse(
    (r) => r.url().endsWith(`/projects/${projectId}/reminders`) && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Senden" }).click();
  const result = (await (await answer).json()) as {
    skipped: { participationId: string; code: string }[];
  };
  expect(result.skipped.map((s) => s.code).toSorted()).toEqual(["consent_required", "no_channel"]);
  expect(result.skipped.find((s) => s.participationId === v1)?.code).toBe("consent_required");
  await expect(
    dialog.getByText("1 Erinnerung wird gesendet (1 per E-Mail, 0 per SMS)."),
  ).toBeVisible();
  await expect(dialog.getByText("2: Kein für Erinnerungen nutzbarer Kontaktweg.")).toBeVisible();
  await dialog.getByRole("button", { name: "Schließen" }).click();

  // Exactly the fixed German text with the plain portal URL, nothing of the participant.
  const portalUrl = `${baseURL}/portal/`;
  await expect.poll(async () => (await outboxTo(staff, REACHABLE)).length).toBe(1);
  const [message] = await outboxTo(staff, REACHABLE);
  expect(message).toMatchObject({
    kind: "email",
    subject: "Im Teilnehmerportal ist noch etwas offen",
    text:
      "In Ihrem Teilnehmerportal ist noch etwas offen. Bitte melden Sie sich an und prüfen Sie " +
      `Ihre Angaben oder Unterlagen: ${portalUrl}\n\n` +
      "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.",
  });
  for (const value of ["Erika", "Beispiel", personnelNumber(reachable)]) {
    expect(`${message!.subject} ${message!.text}`).not.toContain(value);
  }
  expect(await outboxTo(staff, V1)).toEqual([]);

  // The v1 participant accepts consent v2 in "Meine Kontaktwege".
  const participant = await browser.newContext({ baseURL });
  const portal = await participant.newPage();
  await loggedInAsOwner(portal, baseURL!, v1);
  await portal.goto("/portal/channels");
  const offer = portal.getByRole("region", { name: "Neue Einwilligung für diesen Kontaktweg" });
  await expect(offer).toBeVisible();
  await expectAccessible(portal);
  await offer.getByRole("button", { name: "Zustimmen" }).click();
  await expect(portal.getByText("Danke, Ihre Einwilligung ist gespeichert.")).toBeVisible();
  await expect(offer).toBeHidden();

  // The PL's next reminder reaches them; the first one's participant is skipped as recent.
  await page.reload();
  await select(page, [personnelNumber(v1), personnelNumber(reachable)]);
  await page.getByRole("button", { name: "Erinnern (2)" }).click();
  await expect(counts.getByRole("listitem")).toHaveText([
    "1 per E-Mail",
    /^1 kürzlich erinnert \(wieder ab \d{2}\.\d{2}\.\d{4}\)$/,
  ]);
  const second = page.waitForResponse(
    (r) => r.url().endsWith(`/projects/${projectId}/reminders`) && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Senden" }).click();
  const skipped = ((await (await second).json()) as typeof result).skipped;
  expect(skipped).toEqual([{ participationId: reachable, code: "reminded_recently" }]);
  await dialog.getByRole("button", { name: "Schließen" }).click();
  await expect.poll(async () => (await outboxTo(staff, V1)).length).toBe(1);
  await expect.poll(async () => (await outboxTo(staff, REACHABLE)).length).toBe(1);

  // "Nachrichten" on the participant's page lists the sent reminder, by "Team".
  await page.goto(`/projects/${projectId}/participations/${reachable}?tab=messages`);
  const row = page.getByRole("row", { name: /Erinnerung an offene Punkte/ });
  await expect(row).toContainText("E-Mail");
  await expect(row).toContainText("gesendet");
  await expect(row).toContainText("Team");

  // The participant follows the link into the portal.
  const link = /https?:\/\/\S+/.exec(message!.text)![0];
  expect(link).toBe(portalUrl);
  await portal.goto(link);
  await expect(portal.getByRole("heading", { level: 1 })).toBeVisible();
  expect(new URL(portal.url()).pathname.startsWith("/portal")).toBe(true);
  await participant.close();
});
