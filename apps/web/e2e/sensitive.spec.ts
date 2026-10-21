import { seedProjectIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant, loggedInAsOwner } from "./participants";

// PR 4a-4 (data-protection.md, self-service; ADR-0007, step-up): a participant logged in by code
// answers "Angaben für die Agentur" (encrypted, on its own logged routes) and, after entering the
// birth date again, "Gesundheit" (yes/no only). The suite fails on any CSP violation. The
// activation and the login have their own spec; this one starts logged in (participants.ts).
// Synthetic data only.

test("portal: the participant answers the sensitive pages, Gesundheit after the birth date", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId: seedProjectIds.werkNord,
    address: "angaben.privat@example.org",
  });
  await loggedInAsOwner(page, baseURL!, participationId);

  await page.goto("/portal/");
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
