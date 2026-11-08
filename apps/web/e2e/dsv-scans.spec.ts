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

// Synthetic external paper through review and quarantine recovery to the participant signature.
// Responsive and zoom-equivalent layouts are checked with axe and saved for review.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-2b/", import.meta.url));
const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};

/** An informed participation of Werk Nord in W1 with a name and no address (left for the hand). */
async function informedParticipation() {
  const participationId = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await activateAsOwner(owner.$client, [projectId]);
    await owner.insert(participation).values({
      id: participationId,
      projectId,
      entryWaveId: w1.id,
      status: "informed",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await owner.insert(participantIdentity).values({
      participationId,
      projectId,
      personnelNumber: `DSV-${participationId.slice(0, 8)}`,
      firstName: "Łucja",
      lastName: "Vertrag",
      birthDate: "1979-03-14",
    });
    await owner.insert(participantDetails).values({ participationId, projectId });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

test("offered paper → scan → review → quarantine recovery → signed", async ({ page, baseURL }) => {
  test.slow();
  page.setDefaultTimeout(10000);
  mkdirSync(screenshots, { recursive: true });
  const id = await informedParticipation();
  await session(page, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  await page.getByRole("button", { name: "Papierangebot ohne Erzeugung erfassen" }).click();
  let panel = page.getByRole("dialog");
  await panel.getByLabel(/Aufgedruckte Angebotsfrist/).pressSequentially("15.02.2091");
  await expect(panel.getByLabel(/Aufgedruckte Angebotsfrist/)).toHaveValue("15.02.2091");
  await panel.getByLabel(/Aufgedruckter TG-Beginn/).pressSequentially("01.03.2091");
  await panel.getByLabel(/Aufgedrucktes TG-Ende/).pressSequentially("29.02.2092");
  await panel.getByRole("button", { name: "Angebot erfassen", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Scan hochladen", exact: true }).click();
  panel = page.getByRole("dialog");
  await expect(panel.getByLabel("Entgegengenommen von")).toHaveValue("");
  await expect(panel.getByLabel(/Entgegengenommen am/)).toHaveValue("");
  await panel.locator('input[type="file"]').setInputFiles({
    name: "synthetic-dsv.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% Synthetic DSV fixture\n%%EOF"),
  });
  await panel.getByLabel("Entgegengenommen von").selectOption(projectLead);
  await panel.getByLabel(/Entgegengenommen am/).pressSequentially("02.01.2026");
  await panel.getByLabel(/Unterschrift Teilnehmer/).pressSequentially("01.01.2026");
  await expectAccessible(page);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.screenshot({ path: `${screenshots}upload.png` });
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Als unterschrieben erfassen" })).toBeDisabled();
  await page.getByRole("button", { name: "Prüfen", exact: true }).click();
  panel = page.getByRole("dialog");
  await expect(panel.getByLabel(/Unterschrift Teilnehmer/)).toHaveValue("");
  await panel.getByLabel(/Unterschrift Teilnehmer/).pressSequentially("01.01.2026");
  await panel.getByText(/Das externe Papier/).click();
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Unter Quarantäne stellen" }).click();
  panel = page.getByRole("dialog");
  await panel.getByLabel("Grund", { exact: true }).selectOption("suspected_wrong_acceptance");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Als unterschrieben erfassen" })).toBeDisabled();
  await page.getByRole("button", { name: "Quarantäne aufheben" }).click();
  await expect(page.getByRole("button", { name: "Als unterschrieben erfassen" })).toBeEnabled();
  await page.getByRole("button", { name: "Als unterschrieben erfassen" }).click();
  panel = page.getByRole("dialog");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText("DSV: Unterschrieben", { exact: true }).first()).toBeVisible();
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectAccessible(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${screenshots}signed-${width}.png`, fullPage: true });
  }
  for (const zoom of [2, 4]) {
    await page.setViewportSize({ width: 1280 / zoom, height: 720 / zoom });
    await expectAccessible(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${screenshots}zoom-${zoom * 100}.png`, fullPage: true });
  }
});
