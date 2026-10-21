import { randomUUID } from "node:crypto";
import {
  createDb,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// Slice 3 plan, PR 3e: the participant activates a letter's code in the built portal. The PL
// issues it through the API; the one-time code comes from the dev outbox (synthetic only).
test("portal: activate with a letter's code, the notice, birth date, email and one-time code", async ({
  page,
  baseURL,
}) => {
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  const participationId = randomUUID();
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
      personnelNumber: "E2E-ACT-1",
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

  const headers = { Origin: baseURL! };
  const staff = page.context().request;
  await staff.post("/api/v1/dev/session", {
    headers,
    data: { staffUserId: seedStaffUserIds.projectLead },
  });
  const issued = await staff.post(`/api/v1/projects/${projectId}/activation-codes`, {
    headers,
    data: { participationIds: [participationId], channel: "letter", language: "de" },
  });
  expect(issued.status()).toBe(201);
  const { items } = await issued.json();
  const link = new URL(items[0].activationUrl);

  // D22: the link's fragment carries the code; the page takes it out of the address bar.
  await page.goto(`/portal/activate${link.hash}`);
  await expect(page.getByLabel("Aktivierungscode")).toHaveValue(link.hash.slice(1));
  await expect(page).toHaveURL(/\/portal\/activate$/);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Code prüfen" }).click();

  await expect(
    page.getByRole("heading", { name: "Datenschutzhinweise nach Art. 14 DSGVO" }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Gelesen, weiter" }).click();

  await page.getByLabel("Geburtsdatum").fill("01.01.1970");
  await page.getByRole("button", { name: "Weiter" }).click();

  await page.getByLabel("Private E-Mail-Adresse").fill("erika.privat@example.org");
  await page.getByText("Ich willige ein.").click();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Bestätigungscode senden" }).click();
  await expect(page.getByLabel("Bestätigungscode")).toBeVisible();

  const outbox = await (await staff.get("/api/v1/dev/outbox")).json();
  const message = outbox.findLast((m: { to: string }) => m.to === "erika.privat@example.org");
  const oneTimeCode = /\b(\d{6})\b/.exec(message.text)![1]!;
  await page.getByLabel("Bestätigungscode").fill(oneTimeCode);
  await page.getByRole("button", { name: "Zugang aktivieren" }).click();
  await expect(page.getByRole("heading", { name: "Ihr Zugang ist aktiv" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Zur Startseite" }).click();
  await expect(page.getByRole("heading", { name: "Hallo Erika" })).toBeVisible();
  await expect(page.getByText(/E-Mail e…@example.org, bestätigt am/)).toBeVisible();
  await expectAccessible(page);

  // The PL sees the activation; the status moved to contacted by the participant (D25).
  const activation = await (
    await staff.get(`/api/v1/participations/${participationId}/activation`)
  ).json();
  expect(activation.status.account).toBe("activated");
  expect(JSON.stringify(activation)).not.toContain("erika.privat");
  const detail = await (await staff.get(`/api/v1/participations/${participationId}`)).json();
  expect(detail.status).toBe("contacted");

  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page.getByRole("link", { name: "Zugang aktivieren" })).toBeVisible();
});
