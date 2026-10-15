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
  await expect(page.getByRole("cell", { name: "15.02.2027" })).toBeVisible();
  await expectAccessible(page);

  // AC-3: create a project; it shows at the top without a reload, dates as TT.MM.JJJJ.
  await page.getByRole("link", { name: "Projekt anlegen" }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expectAccessible(page);
  await page.getByLabel("Projektname").fill("E2E Projekt Ost");
  await page.getByLabel("Kunde").fill("Beispiel Anlagenbau GmbH");
  await page.getByLabel("Unterschriftsfrist").fill("15.04.2027");
  await page.getByLabel("TG-Beginn").fill("01.05.2027");
  await page.getByLabel("TG-Ende").fill("30.04.2028");
  await page.getByRole("button", { name: "Projekt anlegen" }).click();

  await expect(page.getByText("Projekt angelegt")).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  const firstRow = page.getByRole("row").nth(1);
  await expect(firstRow).toContainText("E2E Projekt Ost");
  await expect(firstRow).toContainText("15.04.2027");
  await expect(page.getByRole("row")).toHaveCount(5);

  // AC-11: createdBy is the active user, and switching users changes /api/v1/me.
  const { items } = await (await page.request.get("/api/v1/projects?limit=1")).json();
  expect(items[0].createdBy).toBe(seedStaffUserIds.projectLead);
  expect((await me(page)).id).toBe(seedStaffUserIds.projectLead);
  await chooseDevUser(page, "Erika Musterfrau · Admin");
  await expect.poll(async () => (await me(page)).id).toBe(seedStaffUserIds.admin);
});
