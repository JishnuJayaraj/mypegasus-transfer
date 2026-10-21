import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
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

// PR 4a-4 (data-protection.md, self-service; ADR-0007, step-up): a participant logged in by code
// answers "Angaben für die Agentur" (encrypted, on its own logged routes) and, after entering the
// birth date again, "Gesundheit" (yes/no only). The suite fails on any CSP violation. Synthetic
// data only.

const PRIVATE = "angaben.privat@example.org";

async function lastCode(staff: APIRequestContext, to: string, after: number) {
  let code = "";
  await expect
    .poll(async () => {
      const outbox: { to: string; text: string }[] = await (
        await staff.get("/api/v1/dev/outbox")
      ).json();
      const messages = outbox.filter((m) => m.to === to);
      code = messages.length > after ? /\b(\d{6})\b/.exec(messages.at(-1)!.text)![1]! : "";
      return code;
    })
    .not.toBe("");
  return code;
}

const countTo = async (staff: APIRequestContext, to: string) =>
  ((await (await staff.get("/api/v1/dev/outbox")).json()) as { to: string }[]).filter(
    (m) => m.to === to,
  ).length;

const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

test("portal: the participant answers the sensitive pages, Gesundheit after the birth date", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  const participationId = randomUUID();
  const projectId = seedProjectIds.werkNord;
  try {
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
      personnelNumber: `E2E-${participationId.slice(0, 8)}`,
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

  // Set up over the API: a letter, the activation (the activation e2e drives these screens).
  const api = page.context().request;
  const headers = { Origin: baseURL! };
  await ok(
    api.post("/api/v1/dev/session", {
      headers,
      data: { staffUserId: seedStaffUserIds.projectLead },
    }),
  );
  const issued = await api.post(`/api/v1/projects/${projectId}/activation-codes`, {
    headers,
    data: { participationIds: [participationId], channel: "letter", language: "de" },
  });
  const { items } = (await issued.json()) as { items: { code: string }[] };
  await ok(api.post("/api/v1/portal/activation", { headers, data: { code: items[0]!.code } }));
  await ok(
    api.post("/api/v1/portal/activation/birth-date", {
      headers,
      data: { birthDate: "1970-01-01" },
    }),
  );
  await ok(
    api.post("/api/v1/portal/activation/channel", {
      headers,
      data: { kind: "email", address: PRIVATE, language: "de" },
    }),
  );
  await ok(
    api.post("/api/v1/portal/activation/completion", {
      headers,
      data: {
        oneTimeCode: await lastCode(api, PRIVATE, 0),
        noticeVersion: "art14-activation:v1",
        consent: true,
        consentVersion: "portal-contact-consent:v1",
        language: "de",
      },
    }),
  );
  await ok(api.post("/api/v1/portal/logout", { headers, data: {} }));

  // A login by code: this session has no step-up of its own.
  await page.goto("/portal/login");
  const before = await countTo(api, PRIVATE);
  await page.getByLabel("E-Mail-Adresse oder Mobilnummer").fill(PRIVATE);
  await page.getByRole("button", { name: "Code senden" }).click();
  await page.getByLabel("Anmeldecode").fill(await lastCode(api, PRIVATE, before));
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Hallo Erika" })).toBeVisible();
  await page.getByRole("link", { name: "Meine Angaben" }).click();
  await page.getByRole("button", { name: "Gelesen, weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Persönliches" })).toBeVisible();

  // Angaben für die Agentur: entry date and residence status only with another nationality.
  await page.goto("/portal/self-service?step=ba_details");
  const agentur = page.getByRole("heading", { level: 1, name: "Angaben für die Agentur" });
  await expect(agentur).toBeVisible();
  await expect(page.getByLabel("Einreisedatum")).toHaveCount(0);
  await page.getByLabel("Rentenversicherungsnummer *").fill("12 345678 a 123");
  await page.getByText("Eine andere", { exact: true }).click();
  await page.getByLabel("Land").selectOption("PL");
  await page.getByLabel("Einreisedatum").fill("05.09.2015");
  await page.getByLabel("Aufenthaltsstatus").selectOption("settlement_permit");
  await page
    .getByRole("group", { name: "Bürgergeld *" })
    .getByText("Nein", { exact: true })
    .click();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Schule und Ausbildung" }),
  ).toBeVisible();
  await expect(page.getByText("2 von 8 Seiten vollständig")).toBeVisible();

  // Back to it: the values are read again on their own route.
  await page.getByRole("button", { name: "Zurück" }).click();
  await expect(agentur).toBeVisible();
  await expect(page.getByLabel("Rentenversicherungsnummer *")).toHaveValue("12345678A123");
  await expect(page.getByLabel("Land")).toHaveValue("PL");
  await expect(page.getByLabel("Aufenthaltsstatus")).toHaveValue("settlement_permit");

  // Gesundheit: only the step-up until the birth date is entered again.
  await page.goto("/portal/self-service?step=health");
  await expect(page.getByRole("heading", { level: 1, name: "Gesundheit" })).toBeVisible();
  await expect(page.getByText(/einmal pro Anmeldung nötig/)).toBeVisible();
  await expect(page.getByRole("group", { name: /Gesundheitliche Einschränkungen/ })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByLabel("Ihr Geburtsdatum").fill("02.01.1970");
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page.getByText(/Das Geburtsdatum stimmt nicht/)).toBeVisible();
  await page.getByLabel("Ihr Geburtsdatum").fill("01.01.1970");
  await page.getByRole("button", { name: "Bestätigen" }).click();
  const restrictions = page.getByRole("group", { name: "Gesundheitliche Einschränkungen *" });
  await expect(restrictions).toBeVisible();
  await expect(page.getByText(/nur Ja oder Nein. Bitte nennen Sie keine Diagnosen/)).toBeVisible();
  await expectAccessible(page);
  await restrictions.getByText("Nein", { exact: true }).click();
  await page
    .getByRole("group", { name: "Schwerbehinderung oder Gleichstellung *" })
    .getByText("Nein", { exact: true })
    .click();
  await page.getByRole("button", { name: "Weiter" }).click();

  // The overview: both sensitive pages complete (Kontakt was, with the imported address).
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await expect(page.getByText("3 von 8 Seiten vollständig")).toBeVisible();
  for (const name of ["Angaben für die Agentur", "Gesundheit"]) {
    const item = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name }) });
    await expect(item.getByText("Vollständig")).toBeVisible();
  }
});
