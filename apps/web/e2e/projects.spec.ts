import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { seedStaffUserIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";

/** A synthetic import fixture (fixtures/imports/README.md). */
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/imports/${name}`, import.meta.url));

async function chooseDevUser(page: Page, label: string) {
  await page.getByRole("button", { name: "Entwicklungsbenutzer wechseln" }).click();
  await page.getByRole("button", { name: label }).click();
}

const me = async (page: Page) => (await page.request.get("/api/v1/me")).json();

test("choose a dev user, see the seeded projects, create a project", async ({ page }) => {
  // One long walk through the whole PL path of Slice 2 (setup, configuration, import).
  test.slow();
  await page.goto("/");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText("Bitte Entwicklungsbenutzer wählen").first()).toBeVisible();

  // AC-1: the three seeded projects, read from Postgres.
  await chooseDevUser(page, "Petra Projektleitung · Projektleitung");
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(page.getByRole("cell", { name: "Beispiel Maschinenbau GmbH" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Entwurf" }).first()).toBeVisible();
  await expectAccessible(page);

  // AC-3: create a project; it shows at the top without a reload, as a draft. Its contractual
  // dates belong to its entry waves (Slice 2, Q79), not to this form.
  await page.getByRole("link", { name: "Projekt anlegen" }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expectAccessible(page);
  await page.getByLabel("Projektname").fill("E2E Projekt Ost");
  await page.getByLabel("Kunde").fill("Beispiel Anlagenbau GmbH");
  await expect(page.getByLabel("TG-Beginn")).toHaveCount(0);
  await page.getByRole("button", { name: "Projekt anlegen" }).click();

  await expect(page.getByText("Projekt angelegt")).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  const firstRow = page.getByRole("row").nth(1);
  await expect(firstRow).toContainText("E2E Projekt Ost");
  await expect(firstRow).toContainText("Entwurf");
  await expect(page.getByRole("row")).toHaveCount(5);

  // AC-11: createdBy is the active user, and switching users changes /api/v1/me.
  const { items } = await (await page.request.get("/api/v1/projects?limit=1")).json();
  expect(items[0].createdBy).toBe(seedStaffUserIds.projectLead);
  expect((await me(page)).id).toBe(seedStaffUserIds.projectLead);

  // Slice 2 (PR 2b, AC-8): the PL opens the new project and adds an entry wave; a rule the API
  // refuses is shown at its field.
  await firstRow.getByRole("link", { name: "E2E Projekt Ost" }).click();
  await expect(page.getByText("Es gibt noch keine Eintrittswellen.")).toBeVisible();
  await page.getByRole("button", { name: "Welle anlegen" }).click();
  await page.getByLabel("Kürzel").fill("W1");
  await page.getByLabel("Bezeichnung").fill("Welle 1");
  await page.getByLabel("Unterschriftsfrist").fill("15.02.2091");
  await page.getByLabel("TG-Beginn (Standard)").fill("01.03.2091");
  await page.getByLabel("TG-Ende (Standard)").fill("29.02.2092");
  await page.getByLabel("Letztmöglicher Eintritt").fill("15.03.2091");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Eintrittswelle gespeichert")).toBeVisible();
  await expect(page.getByRole("row", { name: /Welle 1/ })).toContainText("15.03.2091");
  await page.getByRole("button", { name: "W1 bearbeiten" }).click();
  await page.getByLabel("TG-Ende (Standard)").fill("01.03.2092");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Die TG-Dauer darf zwölf Monate nicht überschreiten.")).toBeVisible();
  await expectAccessible(page);

  // Slice 2 (PR 2c-2, plan 5.8): without a Project Agentur the project is blocked; the PL pins the
  // sample Agentur from the catalog (the latest version is preselected; the PL takes version 1
  // here and migrates it later, PR 2e-2) and the blocker clears.
  // Listed with the blockers and again at the activation it blocks (PR 2e-1).
  await expect(
    page.getByText("Aktivierung blockiert: Es fehlt die Vorlage der Projekt-Agentur."),
  ).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Aktivieren" })).toBeDisabled();
  await expect(page.getByLabel("Version")).toHaveValue("2");
  await page.getByLabel("Version").selectOption("1");
  await page.getByRole("button", { name: "Als Projekt-Agentur festlegen" }).click();
  await expect(page.getByText("Vorlage gepinnt")).toBeVisible();
  await expect(
    page.getByText(
      "Projekt-Agentur: Agentur für Arbeit Beispielstadt Nord (Beispiel), Vorlage Version 1",
    ),
  ).toBeVisible();
  await expect(page.getByText("Keine Blocker.")).toBeVisible();
  await expectAccessible(page);

  // Slice 2 (PR 2e-1, AC-17): with the Project Agentur pinned and W1's latest entry date nothing
  // blocks, so the PL activates the project; activation is one-way, and the Project Agentur is
  // fixed from then on (R1).
  await expect(page.getByText("Status: Entwurf.", { exact: false })).toBeVisible();
  await expect(page.getByText(/Die Aktivierung ist endgültig/)).toBeVisible();
  await page.getByRole("button", { name: "Aktivieren" }).click();
  await expect(page.getByText("Projekt aktiviert", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Status: aktiv seit/)).toBeVisible();
  await expect(page.getByText(/· Aktiv$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Aktivieren" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Als Projekt-Agentur festlegen" })).toHaveCount(0);
  await expectAccessible(page);

  // Slice 2 (PR 2g-2, AC-35): the PL imports the sample CSV, confirms the suggested mapping, sees
  // the report and the participants; a second file updates them instead of duplicating.
  const importSection = page.getByRole("region", { name: "Import" });
  await importSection
    .getByLabel("Datei auswählen")
    .setInputFiles(fixture("teilnehmer-beispiel.csv"));
  await expect(importSection.getByLabel("Trennzeichen")).toHaveValue(";");
  await expect(importSection.getByLabel("Zeichencodierung")).toHaveValue("utf-8");
  await expect(importSection.getByLabel("Zuordnung für Spalte 1: Personalnummer")).toHaveValue(
    "personnelNumber",
  );
  await expectAccessible(page);
  await importSection.getByRole("button", { name: "Prüfen" }).click();
  await expect(importSection.getByText(/^12 Zeilen: 12 neu, 0 Aktualisierungen/)).toBeVisible();
  await expect(importSection.getByText("Keine Fehler.")).toBeVisible();
  await expectAccessible(page);
  await importSection.getByRole("button", { name: "Import durchführen" }).click();
  await expect(
    importSection.getByText("12 angelegt, 0 aktualisiert, 0 unverändert, 0 übersprungen."),
  ).toBeVisible();
  const participants = page.getByRole("region", { name: "Teilnehmende" });
  await expect(participants.getByRole("row")).toHaveCount(13);
  await expect(participants.getByRole("cell", { name: "BSP-0001", exact: true })).toBeVisible();
  await expect(participants.getByRole("cell", { name: "Importiert" }).first()).toBeVisible();
  await expectAccessible(page);

  await importSection.getByRole("button", { name: "Weitere Datei importieren" }).click();
  await importSection
    .getByLabel("Datei auswählen")
    .setInputFiles(fixture("teilnehmer-aktualisiert.csv"));
  await importSection.getByRole("button", { name: "Prüfen" }).click();
  await expect(
    importSection.getByText(/^12 Zeilen: 1 neu, 2 Aktualisierungen, 9 unverändert/),
  ).toBeVisible();
  await expect(
    importSection.getByText(
      "Zeile 2 (BSP-0001): Straße und Hausnummer: bisher Musterstraße 1, neu Neue Musterstraße 100",
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await importSection.getByRole("button", { name: "Import durchführen" }).click();
  await expect(
    importSection.getByText("1 angelegt, 2 aktualisiert, 9 unverändert, 0 übersprungen."),
  ).toBeVisible();
  await expect(participants.getByRole("row")).toHaveCount(14);
  await expectAccessible(page);

  const configuration = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Konfiguration" }) });

  // Slice 2 (PR 2e-2, AC-19, AC-20): a project-specific exception to the Project Agentur's
  // template (Q93), then the migration to version 2 with its review: the PL removes the setting,
  // so the new template's value applies.
  await configuration
    .getByRole("button", { name: "Agenturbezogene Einstellung hinzufügen" })
    .click();
  await configuration.getByLabel("Agentur der Einstellung").selectOption("beispielstadt-nord");
  await configuration.getByLabel("Vorlauf in Tagen").fill("12");
  await configuration.getByLabel("Quelle").selectOption("phone_call_agentur");
  await configuration.getByLabel("Bestätigt am").fill("01.10.2026");
  await configuration.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Einstellung gespeichert")).toBeVisible();
  const setupSection = page.getByRole("region", { name: "Einrichtung" });
  await setupSection
    .getByRole("button", { name: "Agentur für Arbeit Beispielstadt Nord (Beispiel) migrieren" })
    .click();
  await expect(setupSection.getByLabel("Neue Version")).toHaveValue("2");
  await setupSection.getByRole("button", { name: "Änderungen anzeigen" }).click();
  await expect(
    setupSection.getByText("Einstellung Vorlauf in Tagen: bisher 10, neu 14"),
  ).toBeVisible();
  await expect(
    setupSection.getByText("Neue Regel beispielstadt-nord-mobile (Datenerfassung)"),
  ).toBeVisible();
  const review = setupSection.getByRole("group", {
    name: "Vorlauf in Tagen: im Projekt 12; Vorlage bisher 10, neu 14",
  });
  await expectAccessible(page);
  await review.getByText("Entfernen (dann gilt die Vorlage)").click();
  await setupSection.getByRole("button", { name: "Migration bestätigen" }).click();
  await expect(
    setupSection.getByText(
      "Agentur für Arbeit Beispielstadt Nord (Beispiel) nutzt jetzt Version 2. Entfernte Einstellungen: Vorlauf in Tagen.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Projekt-Agentur: Agentur für Arbeit Beispielstadt Nord (Beispiel), Vorlage Version 2",
    ),
  ).toBeVisible();
  await expect(setupSection.getByRole("button", { name: /migrieren$/ })).toHaveCount(0);
  await expect(configuration.getByText("Stand der Projektkonfiguration: Version 2")).toBeVisible();
  await expect(configuration.getByRole("row", { name: /beispielstadt-nord/ })).toHaveCount(0);
  await expectAccessible(page);

  // Slice 2 (PR 2d-1, AC-14): an Agentur-scoped setting for an Agentur without a template, with
  // its source and confirmation date; the PL is the confirmer.
  await configuration
    .getByRole("button", { name: "Agenturbezogene Einstellung hinzufügen" })
    .click();
  await configuration.getByLabel("Agentur der Einstellung").selectOption("");
  await configuration.getByLabel("Schlüssel der Agentur").fill("beispielstadt-ost");
  await configuration.getByLabel("Übermittlungsweg TL 407").selectOption("upload");
  await configuration.getByLabel("Vorlauf in Tagen").fill("7");
  await configuration.getByLabel("Quelle").selectOption("email_agentur");
  await configuration.getByLabel("Bestätigt am").fill("01.10.2026");
  await expectAccessible(page);
  await configuration.getByRole("button", { name: "Speichern" }).click();
  // The first setting's toast can still be visible (they stay 6 s): wait for this Agentur's.
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Einstellung gespeichert" })
      .filter({ hasText: "beispielstadt-ost" }),
  ).toBeVisible();
  const setting = configuration.getByRole("row", { name: /beispielstadt-ost/ });
  await expect(setting).toContainText("Übermittlungsweg TL 407: Upload; Vorlauf in Tagen: 7");
  await expect(setting).toContainText("E-Mail der Agentur");
  await expect(setting).toContainText("Petra Projektleitung");
  await expect(configuration.getByText("Stand der Projektkonfiguration: Version 3")).toBeVisible();
  await expectAccessible(page);

  // Slice 2 (PR 2d-2, AC-15): the PL requests the relaxation of Nord's operational default rule
  // with a controlled reason code; it takes effect only once another person approves it.
  await configuration.getByLabel("Regel").selectOption("beispielstadt-nord-mobile");
  await configuration.getByLabel("Begründung").selectOption("collected_outside_platform");
  await configuration.getByRole("button", { name: "Beantragen" }).click();
  await expect(page.getByText("Lockerung beantragt")).toBeVisible();
  const request = configuration.getByRole("row", { name: /beispielstadt-nord-mobile/ });
  await expect(request).toContainText("Petra Projektleitung");
  await expect(request.getByRole("button", { name: /genehmigen/ })).toHaveCount(0);
  await expect(configuration.getByText("Es gibt keine genehmigten Lockerungen.")).toBeVisible();
  await expectAccessible(page);
  await page.goto("/projects");
  await chooseDevUser(page, "Erika Musterfrau · Admin");
  await expect.poll(async () => (await me(page)).id).toBe(seedStaffUserIds.admin);
  // Slice 2 (Q106): the admin, a global org role, sees every project's metadata.
  await expect(page.getByRole("row")).toHaveCount(5);
  // Round 26: the admin reads the project's setup but gets no pin form (only its PL pins).
  await page.getByRole("link", { name: "E2E Projekt Ost" }).click();
  await expect(page.getByText("Keine Blocker.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Als weitere Agentur pinnen" })).toHaveCount(0);
  // … and sees the Agentur-scoped settings without the actions to change them.
  await expect(page.getByRole("row", { name: /beispielstadt-ost/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Agenturbezogene Einstellung hinzufügen" }),
  ).toHaveCount(0);
  // … and the open request, without deciding it (only the regional operations manager does).
  await expect(page.getByRole("button", { name: /genehmigen|ablehnen/ })).toHaveCount(0);

  // AC-15: the regional operations manager, not the requester, approves; the relaxation enters
  // the next override version.
  await page.goto("/projects");
  await chooseDevUser(page, "Rolf Regionalbetrieb · Regionale Betriebsleitung");
  await expect
    .poll(async () => (await me(page)).id)
    .toBe(seedStaffUserIds.regionalOperationsManager);
  await page.getByRole("link", { name: "E2E Projekt Ost" }).click();
  await expect(page.getByRole("row", { name: /beispielstadt-nord-mobile/ })).toContainText(
    "Andere berechtigte Person",
  );
  await expectAccessible(page);
  await page.getByRole("button", { name: "beispielstadt-nord-mobile genehmigen" }).click();
  await expect(page.getByText("Lockerung genehmigt")).toBeVisible();
  await expect(page.getByText("Stand der Projektkonfiguration: Version 4")).toBeVisible();
  await expect(page.getByText("Es gibt keine offenen Anträge.")).toBeVisible();
  await expect(page.getByRole("row", { name: /beispielstadt-nord-mobile/ })).toContainText(
    "Rolf Regionalbetrieb",
  );
});
