import type { Page } from "@playwright/test";
import { seedStaffUserIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";

async function chooseDevUser(page: Page, label: string) {
  await page.getByRole("button", { name: "Entwicklungsbenutzer wechseln" }).click();
  await page.getByRole("button", { name: label }).click();
}

const me = async (page: Page) => (await page.request.get("/api/v1/me")).json();

test("choose a dev user, see the seeded projects, create a project", async ({ page }) => {
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
  await page.goto("/projects");
  await chooseDevUser(page, "Erika Musterfrau · Admin");
  await expect.poll(async () => (await me(page)).id).toBe(seedStaffUserIds.admin);
  // Slice 2 (Q106): the admin, a global org role, sees every project's metadata.
  await expect(page.getByRole("row")).toHaveCount(5);
});
