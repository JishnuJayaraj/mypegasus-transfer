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

// PR 4a-3 (data-protection.md, self-service; regional-variation.md, "Self-service wizard"): an
// activated participant logs in, acknowledges the purposes notice, fills Persönliches and
// Kontakt, reloads, resumes at the first page with missing items and sees the progress. Placed
// with the sample Agentur Beispielstadt Nord, whose template adds a custom field: the portal
// compiles its field schema in the browser, and the suite fails on any CSP violation (jitless,
// ADR-0004). Synthetic data only.

const PRIVATE = "selbstauskunft.privat@example.org";

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

/** Fails the test unless the set-up request succeeded. */
const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

test("portal: the self-service wizard saves pages, resumes and shows the progress", async ({
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

  // Set up over the API: the PL places the participation with Beispielstadt Nord and prints a
  // letter; the participant activates it (the activation e2e drives these screens).
  const api = page.context().request;
  const headers = { Origin: baseURL! };
  await ok(
    api.post("/api/v1/dev/session", {
      headers,
      data: { staffUserId: seedStaffUserIds.projectLead },
    }),
  );
  await ok(
    api.put(`/api/v1/participations/${participationId}/placement-agentur`, {
      headers,
      data: { agenturKey: "beispielstadt-nord" },
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

  // The participant logs in by code.
  await page.goto("/portal/login");
  const before = await countTo(api, PRIVATE);
  await page.getByLabel("E-Mail-Adresse oder Mobilnummer").fill(PRIVATE);
  await page.getByRole("button", { name: "Code senden" }).click();
  await page.getByLabel("Anmeldecode").fill(await lastCode(api, PRIVATE, before));
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Hallo Erika" })).toBeVisible();

  // The purposes notice comes first.
  await page.getByRole("link", { name: "Meine Angaben" }).click();
  await expect(
    page.getByRole("heading", { name: "Wofür wir Ihre Angaben verwenden" }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Gelesen, weiter" }).click();

  // Persönliches, saved on "Weiter".
  await expect(page.getByRole("heading", { level: 1, name: "Persönliches" })).toBeVisible();
  await expect(page.getByText("0 von 7 Seiten vollständig")).toBeVisible();
  await expect(page.getByRole("group", { name: "Geschlecht *" })).toBeVisible();
  await expectAccessible(page);
  await page.getByText("Weiblich", { exact: true }).click();
  await page.getByText("Ledig", { exact: true }).click();
  await page.getByRole("button", { name: "Weiter" }).click();

  // Kontakt: the imported address, names read-only; the Agentur requires mobile and email.
  await expect(page.getByRole("heading", { level: 1, name: "Kontakt" })).toBeVisible();
  await expect(page.getByText("1 von 7 Seiten vollständig")).toBeVisible();
  await expect(page.getByLabel("Straße und Hausnummer")).toHaveValue("Musterweg 1");
  await expect(page.getByText("Erika Beispiel")).toBeVisible();
  await expect(
    page.getByText(/Diese Agentur schreibt Ihnen an Ihre private E-Mail-Adresse/),
  ).toBeVisible();
  await page.getByLabel("Mobilnummer *").fill("0171 3920000");
  await page.getByLabel("Private E-Mail-Adresse *").fill("kein-at-zeichen");
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByText("Bitte geben Sie eine gültige E-Mail-Adresse ein.")).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Private E-Mail-Adresse *").fill(PRIVATE);
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Schule und Ausbildung" }),
  ).toBeVisible();
  await expect(page.getByText("2 von 7 Seiten vollständig")).toBeVisible();

  // A reload keeps the page; coming back resumes at the first page with missing items.
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Schule und Ausbildung" }),
  ).toBeVisible();
  await page.goto("/portal/");
  await page.getByRole("link", { name: "Meine Angaben" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Schule und Ausbildung" }),
  ).toBeVisible();
  await expect(page.getByText("2 von 7 Seiten vollständig")).toBeVisible();
  await page.getByRole("button", { name: "Zurück" }).click();
  await expect(page.getByLabel("Mobilnummer *")).toHaveValue("0171 3920000");

  // Weitere Angaben: the Agentur's custom field, validated in the browser without a CSP violation.
  await page.goto("/portal/self-service?step=further");
  const custom = page.getByLabel("Zusatznachweis-Nr. (Beispiel) *");
  await expect(custom).toBeVisible();
  await custom.fill("ZN-4711");
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await expect(page.getByText("3 von 7 Seiten vollständig")).toBeVisible();
  await expectAccessible(page);

  // English, then the consents.
  await page.getByLabel("Sprache").selectOption("en");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.getByLabel("Language").selectOption("de");
  await page.goto("/portal/consents");
  await expect(
    page.getByRole("heading", { name: "Kontakt über das Teilnehmerportal" }),
  ).toBeVisible();
  await expectAccessible(page);
});
