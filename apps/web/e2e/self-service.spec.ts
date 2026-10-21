import type { APIRequestContext } from "@playwright/test";
import { seedProjectIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant } from "./participants";

// Self-service (data-protection.md, self-service; regional-variation.md, "Self-service wizard"): an
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

test("portal: the self-service wizard saves pages, resumes and shows the progress", async ({
  page,
  baseURL,
}) => {
  test.slow();
  // Placed with Beispielstadt Nord, activated by letter (participants.ts; the activation e2e
  // drives those screens).
  const api = page.context().request;
  await activatedParticipant(page, baseURL!, {
    projectId: seedProjectIds.werkNord,
    address: PRIVATE,
    agenturKey: "beispielstadt-nord",
  });

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
  await expect(page.getByText("0 von 9 Seiten vollständig")).toBeVisible();
  await expect(page.getByRole("group", { name: "Geschlecht *" })).toBeVisible();
  await expectAccessible(page);
  await page.getByText("Weiblich", { exact: true }).click();
  await page.getByText("Ledig", { exact: true }).click();
  await page.getByRole("button", { name: "Weiter" }).click();

  // Kontakt: the imported address, names read-only; the Agentur requires mobile and email.
  await expect(page.getByRole("heading", { level: 1, name: "Kontakt" })).toBeVisible();
  await expect(page.getByText("1 von 9 Seiten vollständig")).toBeVisible();
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
  // The sensitive pages are in the sequence (sensitive.spec.ts fills them).
  const agentur = page.getByRole("heading", { level: 1, name: "Angaben für die Agentur" });
  await expect(agentur).toBeVisible();
  await expect(page.getByText("2 von 9 Seiten vollständig")).toBeVisible();

  // A reload keeps the page; coming back resumes at the first page with missing items.
  await page.reload();
  await expect(agentur).toBeVisible();
  await page.goto("/portal/");
  await page.getByRole("link", { name: "Meine Angaben" }).click();
  await expect(agentur).toBeVisible();
  await expect(page.getByText("2 von 9 Seiten vollständig")).toBeVisible();
  await page.getByRole("button", { name: "Zurück" }).click();
  await expect(page.getByLabel("Mobilnummer *")).toHaveValue("0171 3920000");

  // Weitere Angaben: the Agentur's custom field, validated in the browser without a CSP violation.
  await page.goto("/portal/self-service?step=further");
  const custom = page.getByLabel("Zusatznachweis-Nr. (Beispiel) *");
  await expect(custom).toBeVisible();
  await custom.fill("ZN-4711");
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await expect(page.getByText("3 von 9 Seiten vollständig")).toBeVisible();
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
