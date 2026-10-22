import type { APIRequestContext } from "@playwright/test";
import { seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant, loggedInAsOwner } from "./participants";

// The happy path of Slice 4a (ADR-0007, assisted mode; data-protection.md, self-service; Q136,
// Q139): the PL sets the placement Agentur, the participant fills the wizard including the
// sensitive pages, the assigned consultant opens assisted mode by phone, completes the missing
// page and ends it, and the tab "Selbstauskunft" shows no missing items. No code submission (the
// run's throttle, participants.ts); the suite fails on any CSP violation. Synthetic data only.

const PRIVATE = "assistiert.privat@example.org";
const projectId = seedProjectIds.werkNord;

const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

/** A staff user's dev session in the browser context (the dev switcher's route). */
const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

test("slice 4a: placement Agentur, the participant's wizard, assisted mode by phone", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const api = page.context().request;
  const headers = { Origin: baseURL! };
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: PRIVATE,
    oldEmploymentEndDate: "2091-02-28",
  });
  const detail = `/projects/${projectId}/participations/${participationId}`;

  // 1. The PL sets the placement Agentur; Beispielstadt Nord requires mobile, private email and
  // its custom field.
  await page.goto(detail);
  await expect(page.getByRole("heading", { name: "Beispiel, Erika" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Vermittlungs-Agentur festlegen" })
    .fill("beispielstadt-nord");
  await page.getByRole("button", { name: "Vermittlungs-Agentur speichern" }).click();
  const placement = page.getByRole("region", { name: "Vermittlungs-Agentur" });
  await expect(placement).toContainText("beispielstadt-nord");
  await ok(
    api.post(`/api/v1/projects/${projectId}/assignments`, {
      headers,
      data: { staffUserId: seedStaffUserIds.consultant, participationIds: [participationId] },
    }),
  );

  // 2. The participant fills the wizard, including the sensitive pages; "Arbeitswunsch" stays
  // open for the consultant.
  await loggedInAsOwner(page, baseURL!, participationId, { afterActivation: true });
  await page.goto("/portal/self-service");
  await page.getByRole("button", { name: "Gelesen, weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Persönliches" })).toBeVisible();
  await page.getByText("Weiblich", { exact: true }).click();
  await page.getByText("Ledig", { exact: true }).click();
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Kontakt" })).toBeVisible();
  await page.getByLabel("Mobilnummer *").fill("0171 3920000");
  await page.getByLabel("Private E-Mail-Adresse *").fill(PRIVATE);
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Angaben für die Agentur" }),
  ).toBeVisible();
  await page.getByLabel("Rentenversicherungsnummer *").fill("65 170839 J 003");
  await page.locator("form").getByText("Deutsch", { exact: true }).click();
  await page
    .getByRole("group", { name: "Bürgergeld *" })
    .getByText("Nein", { exact: true })
    .click();
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Schule und Ausbildung" }),
  ).toBeVisible();

  // The row tables, saved as the portal saves them (the wizard's own routes; sensitive.spec.ts and
  // the component tests drive their screens).
  const state = async () =>
    (await (await api.get("/api/v1/portal/self-service")).json()) as {
      revision: number;
    };
  const save = async (wizardPage: string, values: object) =>
    ok(
      api.put(`/api/v1/portal/self-service/pages/${wizardPage}`, {
        headers,
        data: { revision: (await state()).revision, values },
      }),
    );
  await save("education", {
    educationHistory: [
      {
        from: "2005-09-01",
        to: "2008-06-30",
        institution: "Berufsschule Beispielstadt",
        qualification: "Fachkraft für Lagerlogistik",
        completed: true,
      },
    ],
  });
  await save("work_history", {
    workHistory: [
      { from: "2008-07-01", to: null, employer: "Beispiel Maschinenbau GmbH", activity: "Lager" },
    ],
  });
  await save("languages_mobility", {
    languageSkills: { german: "business_fluent", others: [] },
    drivingLicence: ["B"],
    vehicleAvailable: true,
  });

  // Gesundheit: this session follows an activation with the birth-date step, so no step-up.
  await page.goto("/portal/self-service?step=health");
  const restrictions = page.getByRole("group", { name: "Gesundheitliche Einschränkungen *" });
  await expect(restrictions).toBeVisible();
  await restrictions.getByText("Nein", { exact: true }).click();
  await page
    .getByRole("group", { name: "Schwerbehinderung oder Gleichstellung *" })
    .getByText("Ja", { exact: true })
    .click();
  await page.getByRole("button", { name: "Weiter" }).click();
  await page.getByLabel("Zusatznachweis-Nr. (Beispiel) *").fill("ZN-4711");
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  const jobWish = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Arbeitswunsch" }) });
  await expect(jobWish.getByText(/Es fehlen noch 5 Pflichtangaben/)).toBeVisible();

  // 3. The assigned consultant opens assisted mode by phone and completes the missing page.
  await staffSession(api, baseURL!, seedStaffUserIds.consultant);
  await page.goto(`${detail}?tab=self-service`);
  const missing = page.getByRole("region", { name: "Fehlende Angaben" });
  await expect(missing.getByText("Berufswunsch")).toBeVisible();
  // Presence only, until a logged "Anzeigen".
  const agentur = page.getByRole("region", { name: "Angaben für die Agentur" });
  await expect(agentur.getByText("65170839J003")).toHaveCount(0);
  await agentur.getByRole("button", { name: "Rentenversicherungsnummer anzeigen" }).click();
  await expect(agentur.getByText("65170839J003")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Assistierte Erfassung starten" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Starten" })).toBeDisabled();
  await dialog
    .getByText("Die Person ist anwesend oder am Telefon und hat um Unterstützung gebeten")
    .click();
  await dialog.getByText("Am Telefon", { exact: true }).click();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Starten" }).click();

  const banner = page.getByRole("region", { name: "Assistierte Erfassung" });
  await expect(banner).toContainText("Assistierte Erfassung für Erika Beispiel (am Telefon)");
  // It resumes at the first page with missing items; the consultant needs no step-up.
  await expect(page.getByRole("heading", { level: 1, name: "Arbeitswunsch" })).toBeVisible();
  await page.getByText("Vollzeit", { exact: true }).click();
  await page.getByLabel("Gewünschte Tätigkeit").fill("Fachkraft für Lagerlogistik");
  await page.getByLabel("Gewünschte Arbeitsorte").fill("Beispielstadt und Umgebung");
  await page.getByText("Bundesweit", { exact: true }).click();
  await page.getByLabel("Frühester Arbeitsbeginn").fill("01.03.2091");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Gesundheit" })).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Schwerbehinderung oder Gleichstellung *" })
      .getByRole("radio", { name: "Ja" }),
  ).toBeChecked();
  await banner.getByRole("button", { name: "Beenden" }).click();

  // 4. Back on the tab: nothing is missing any more.
  await expect(page.getByRole("tab", { name: "Selbstauskunft", selected: true })).toBeVisible();
  await expect(page.getByText("Keine fehlenden Angaben.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Arbeitswunsch" }).getByText("Fachkraft für Lagerlogistik"),
  ).toBeVisible();
  await expectAccessible(page);
});
