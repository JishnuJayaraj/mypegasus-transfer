import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  createDb,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

const PRIVATE = "erika.privat@example.org";

/** The newest message to `to` in the dev outbox (synthetic only), once it has arrived. */
async function lastMessageTo(staff: APIRequestContext, to: string, after = 0) {
  let text = "";
  await expect
    .poll(async () => {
      const outbox: { to: string; text: string }[] = await (
        await staff.get("/api/v1/dev/outbox")
      ).json();
      const messages = outbox.filter((m) => m.to === to);
      text = messages.length > after ? messages.at(-1)!.text : "";
      return text;
    })
    .not.toBe("");
  return text;
}

const countTo = async (staff: APIRequestContext, to: string) =>
  ((await (await staff.get("/api/v1/dev/outbox")).json()) as { to: string }[]).filter(
    (m) => m.to === to,
  ).length;

// PRs 3e and 3f (the 3f acceptance path): the PL logs in with the dev switcher and
// prints a letter; the participant activates it in the built portal with the one-time code from
// the dev outbox; the PL sees the account activated, the notice provided and `contacted`; the
// participant logs out and logs in again by code through the email's link.
test("portal: activate a printed letter, then log out and log in again by code", async ({
  page,
}) => {
  test.slow();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  const participationId = randomUUID();
  const personnelNumber = `E2E-${participationId.slice(0, 8)}`;
  const projectId = seedProjectIds.werkNord;
  try {
    // A synthetic participation of an active project, as an import leaves it.
    await activateAsOwner(owner.$client, [projectId]);
    await owner.insert(participation).values({
      id: participationId,
      projectId,
      status: "imported",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await owner.insert(participantIdentity).values({
      participationId,
      projectId,
      personnelNumber,
      firstName: "Erika",
      lastName: "Beispiel",
      birthDate: "1970-01-01",
    });
    await owner.insert(participantDetails).values({
      participationId,
      projectId,
      addressStreet: "Musterweg 1",
      addressPostalCode: "10115",
      addressCity: "Berlin",
      addressCountry: "DE",
    });
  } finally {
    await owner.$client.end();
  }
  const staff = page.context().request;

  // The PL logs in with the dev switcher and prints the letter from the participants list.
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "Petra Projektleitung · Projektleitung" }).click();
  await page.getByRole("tab", { name: "Teilnehmende" }).click();
  await page.getByLabel(`${personnelNumber} auswählen`).check({ force: true });
  await page.getByRole("button", { name: "Aktivierungsbriefe drucken" }).click();
  const printed = page.getByLabel("Aktivierungscode");
  await expect(printed).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const code = (await printed.textContent())!;
  await page.getByRole("button", { name: "Druckansicht schließen und Codes verwerfen" }).click();
  await expect(page.getByText(code)).toHaveCount(0);

  // The participant types the letter's code (the portal tests cover the link's fragment).
  await page.goto("/portal/activate");
  await page.getByLabel("Aktivierungscode").fill(code);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Code prüfen" }).click();
  await expect(
    page.getByRole("heading", { name: "Datenschutzhinweise nach Art. 14 DSGVO" }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Gelesen, weiter" }).click();
  await page.getByLabel("Geburtsdatum").fill("01.01.1970");
  await page.getByRole("button", { name: "Weiter" }).click();
  await page.getByLabel("Private E-Mail-Adresse").fill(PRIVATE);
  await page.getByText("Ich willige ein.").click();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Bestätigungscode senden" }).click();
  await expect(page.getByLabel("Bestätigungscode")).toBeVisible();
  const verification = await lastMessageTo(staff, PRIVATE);
  await page.getByLabel("Bestätigungscode").fill(/\b(\d{6})\b/.exec(verification)![1]!);
  await page.getByRole("button", { name: "Zugang aktivieren" }).click();
  await expect(page.getByRole("heading", { name: "Ihr Zugang ist aktiv" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Zur Startseite" }).click();
  await expect(page.getByRole("heading", { name: "Hallo Erika" })).toBeVisible();
  await expect(page.getByText(/E-Mail e…@example.org, bestätigt am/)).toBeVisible();
  await expectAccessible(page);

  // The PL sees "aktiviert", the notice provided and the status moved to contacted (Q121).
  await page.goto(`/projects/${projectId}/participations/${participationId}`);
  const panel = page.getByRole("region", { name: "Portalaktivierung und Datenschutzhinweis" });
  await expect(panel.getByText("Konto aktiviert")).toBeVisible();
  await expect(panel.getByText("Bereitgestellt")).toBeVisible();
  await expect(page.getByRole("region", { name: "Status" }).getByText("Kontaktiert")).toBeVisible();
  await expect(page.getByText(PRIVATE)).toHaveCount(0);
  await expectAccessible(page);

  // The participant logs out and logs in again by code, through the email's link (ADR-0007).
  await page.goto("/portal/");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await page.getByRole("link", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/\/portal\/login$/);
  await expectAccessible(page);
  const before = await countTo(staff, PRIVATE);
  await page.getByLabel("E-Mail-Adresse oder Mobilnummer").fill(PRIVATE);
  await page.getByRole("button", { name: "Code senden" }).click();
  await expect(page.getByText(/Wenn diese Adresse zu einem Zugang gehört/)).toBeVisible();
  const loginMessage = await lastMessageTo(staff, PRIVATE, before);
  const link = new URL(/(https?:\/\/\S+\/login#\d{6})/.exec(loginMessage)![1]!);
  await page.goto(`/portal/login${link.hash}`);
  await expect(page.getByLabel("Anmeldecode")).toHaveValue(link.hash.slice(1));
  await expect(page).toHaveURL(/\/portal\/login$/);
  await page.getByLabel("E-Mail-Adresse oder Mobilnummer").fill(PRIVATE);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Hallo Erika" })).toBeVisible();

  // Channels (Q123): the masked list; the last one warns before it goes.
  await page.getByRole("link", { name: "Kontaktwege verwalten" }).click();
  await expect(page.getByRole("heading", { name: "Ihre Kontaktwege" })).toBeVisible();
  await page.getByRole("button", { name: "Entfernen" }).click();
  await expect(page.getByText(/Das ist Ihr letzter Kontaktweg/)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Abbrechen" }).click();
});
