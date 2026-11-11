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

// The manual contact statuses (process-and-lifecycle.md, the manual contact statuses; Q215): the
// PL sets an imported participant to "Kontaktiert", then "Nicht erreichbar", then back. Each
// step offers only the allowed target, nothing preset. Synthetic data only.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-9/", import.meta.url));
const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${screenshots}${name}.png`, fullPage: true });

/** This spec's own imported participation of Werk Nord in W1. */
async function importedParticipation() {
  const participationId = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await activateAsOwner(owner.$client, [projectId]);
    await owner.insert(participation).values({
      id: participationId,
      projectId,
      entryWaveId: w1.id,
      status: "imported",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await owner.insert(participantIdentity).values({
      participationId,
      projectId,
      personnelNumber: `KON-${participationId.slice(0, 8)}`,
      firstName: "Jonas",
      lastName: "Kontaktprobe",
      birthDate: "1979-04-11",
    });
    await owner.insert(participantDetails).values({ participationId, projectId });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

test("PL: imported → Kontaktiert → Nicht erreichbar → Kontaktiert", async ({ page, baseURL }) => {
  test.slow();
  page.setDefaultTimeout(10000);
  mkdirSync(screenshots, { recursive: true });
  const id = await importedParticipation();
  await session(page, baseURL!, projectLead);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/projects/${projectId}/participations/${id}`);
  await expect(page.getByRole("heading", { name: "Kontaktprobe, Jonas" })).toBeVisible();

  const step = async (current: string, target: string, name: string) => {
    await page.getByRole("button", { name: "Aktionen" }).click();
    await page.getByRole("menuitem", { name: "Kontaktstatus" }).click();
    const panel = page.getByRole("dialog", { name: "Kontaktstatus" });
    await expect(panel.getByText(`Aktueller Status: ${current}`)).toBeVisible();
    // Only the allowed target, nothing preset.
    await expect(panel.getByRole("radio")).toHaveCount(1);
    await expect(panel.getByRole("radio", { name: target })).not.toBeChecked();
    await expect(panel.getByRole("button", { name: "Speichern" })).toBeDisabled();
    await panel.getByText(target, { exact: true }).click();
    await expectAccessible(page);
    await shot(page, name);
    await panel.getByRole("button", { name: "Speichern" }).click();
    await expect(panel).toBeHidden();
  };

  await step("Importiert", "Kontaktiert", "1-imported-to-contacted");
  await step("Kontaktiert", "Nicht erreichbar", "2-contacted-to-unreachable");
  await step("Nicht erreichbar", "Kontaktiert", "3-unreachable-to-contacted");
  await page.getByRole("button", { name: "Aktionen" }).click();
  await expect(page.getByRole("menuitem", { name: "Kontaktstatus" })).toBeVisible();
  await page.keyboard.press("Escape");
  await shot(page, "4-contacted");
});
