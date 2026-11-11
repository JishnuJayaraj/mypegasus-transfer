import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  createDb,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
  seedWaves,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// Retention's inputs and a legal hold (data-protection.md, funding and settlement dates, legal
// holds; Q52, Q217, Q218): back office records the project's final Transfer-KuG settlement date in
// "Abrechnung" and the participation's §110 funding in "Förderung"; the PL places a hold on the DSV
// contract data and the health record in "Aufbewahrung"; the region's manager releases it in
// "Freigaben" with the instruction's source. The participation is this test's own owner fixture;
// the project's dates are cleared afterwards. Screenshots go to docs/screenshots/7-7b/.

const projectId = seedProjectIds.werkNord;
const { projectLead, backOffice, regionalOperationsManager } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-7b/", import.meta.url));
const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${screenshots}${name}.png`, fullPage: true });
const owner = () => createDb(testDatabaseUrls("transfer_e2e").owner);

async function fixture(): Promise<string> {
  const id = randomUUID();
  const db = owner();
  try {
    await activateAsOwner(db.$client, [projectId]);
    await db.insert(participation).values({
      id,
      projectId,
      entryWaveId: w1.id,
      status: "informed",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await db.insert(participantIdentity).values({
      participationId: id,
      projectId,
      personnelNumber: `AUF-${id.slice(0, 8)}`,
      firstName: "Lena",
      lastName: "Sperrfrist",
      birthDate: "1979-02-03",
    });
    await db.insert(participantDetails).values({ participationId: id, projectId });
  } finally {
    await db.$client.end();
  }
  return id;
}

test.afterAll(async () => {
  const db = owner();
  try {
    await db.$client.query(
      "update project set kug_final_settlement_date = null, measure110_settlement_date = null where id = $1",
      [projectId],
    );
  } finally {
    await db.$client.end();
  }
});

test("Abrechnung and Förderung by back office → a hold by the PL → released by the manager", async ({
  page,
  baseURL,
}) => {
  mkdirSync(screenshots, { recursive: true });
  const id = await fixture();

  // Back office: the project's final Transfer-KuG settlement date.
  await session(page, baseURL!, backOffice);
  await page.goto(`/projects/${projectId}?tab=setup#setup-settlement`);
  const settlement = page.getByRole("region", { name: "Abrechnung" });
  await expect(page.getByRole("heading", { name: "Abrechnung", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Abrechnungsdaten erfassen" }).click();
  const datesPanel = page.getByRole("dialog", { name: "Abrechnungsdaten erfassen" });
  await datesPanel.getByLabel("Schlussabrechnung Transfer-KuG").fill("30.06.2027");
  await datesPanel.getByRole("button", { name: "Speichern" }).click();
  await expect(datesPanel).toBeHidden();
  await expect(settlement).toContainText("30.06.2027");
  await page.getByRole("heading", { name: "Abrechnung", exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "settlement-dates");

  // Back office: the participation's §110 funding with its documented source.
  await page.goto(`/projects/${projectId}/participations/${id}?tab=retention`);
  await page.getByRole("button", { name: "Förderung erfassen" }).click();
  const fundingPanel = page.getByRole("dialog", { name: "Förderung erfassen" });
  await fundingPanel.getByText("Gefördert", { exact: true }).click();
  await fundingPanel.getByLabel("Beleg").fill("Bescheid AA Hamburg 123/26");
  await fundingPanel.getByRole("button", { name: "Speichern" }).click();
  await expect(fundingPanel).toBeHidden();
  await expect(page.getByText("Bescheid AA Hamburg 123/26")).toBeVisible();
  await expectAccessible(page);
  await shot(page, "funding");

  // The PL: a hold on the DSV contract data and the health record, never the whole participation.
  await session(page, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${id}?tab=retention`);
  await expect(page.getByText("Keine Aufbewahrungssperren.")).toBeVisible();
  await page.getByRole("button", { name: "Sperre setzen" }).click();
  const holdPanel = page.getByRole("dialog", { name: "Sperre setzen" });
  await holdPanel.getByText("DSV-Vertragsdaten", { exact: true }).click();
  await holdPanel.getByText("Gesundheitsangaben", { exact: true }).click();
  await holdPanel.getByLabel("Grund", { exact: true }).selectOption("litigation");
  await holdPanel.getByLabel("Grundlage").fill("ArbG Hamburg, Az. 1 Ca 12/26");
  await shot(page, "hold-dialog");
  await holdPanel.getByRole("button", { name: "Sperre setzen" }).click();
  await expect(holdPanel).toBeHidden();
  const holds = page.getByRole("table", { name: "Aufbewahrungssperren" });
  await expect(holds).toContainText("Gesundheitsangaben, DSV-Vertragsdaten");
  await expect(holds).toContainText("Aktiv");
  await expectAccessible(page);
  await shot(page, "hold-placed");

  // The region's manager: "Freigaben" without the participant, released with a source.
  await session(page, baseURL!, regionalOperationsManager);
  await page.goto("/reviews");
  const queue = page.getByRole("table", { name: "Aufbewahrungssperren" });
  const row = queue.getByRole("row").filter({ hasText: "Gesundheitsangaben, DSV-Vertragsdaten" });
  await expect(row).toContainText("Restrukturierung Werk Nord");
  await expect(queue).not.toContainText("Sperrfrist");
  await shot(page, "freigaben-hold");
  await row.getByRole("button", { name: /^Freigeben/ }).click();
  const dialog = page.getByRole("dialog", { name: "Freigeben" });
  await dialog.getByLabel(/^Weisung/).fill("Weisung DSB vom 05.11.2026");
  await dialog.getByRole("button", { name: "Freigeben" }).click();
  await expect(page.getByText("Die Sperre ist freigegeben.")).toBeVisible();
  await expect(row).toBeHidden();
  await expectAccessible(page);
  await shot(page, "hold-released");
});
