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

// The participant's signature, a countersigned original that disagrees with it (refused, the
// mistake recovered), the complete packet and the original's tracking. Synthetic paper only.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-3/", import.meta.url));
const pdf = {
  name: "synthetic-dsv.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n% Synthetic DSV fixture\n%%EOF"),
};
const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};

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
      personnelNumber: `PKT-${participationId.slice(0, 8)}`,
      firstName: "Aylin",
      lastName: "Gegenzeichnung",
      birthDate: "1981-06-02",
    });
    await owner.insert(participantDetails).values({ participationId, projectId });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

test("signature → countersigned original (mismatch refused, corrected) → fully executed → original", async ({
  page,
  baseURL,
}) => {
  test.slow();
  page.setDefaultTimeout(10000);
  mkdirSync(screenshots, { recursive: true });
  const id = await informedParticipation();
  await session(page, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);

  // The offer: external paper recorded from its printed metadata.
  await page.getByRole("button", { name: "Papierangebot ohne Erzeugung erfassen" }).click();
  let panel = page.getByRole("dialog");
  await panel.getByLabel(/Aufgedruckte Angebotsfrist/).pressSequentially("15.02.2091");
  await panel.getByLabel(/Aufgedruckter TG-Beginn/).pressSequentially("01.03.2091");
  await panel.getByLabel(/Aufgedrucktes TG-Ende/).pressSequentially("29.02.2092");
  await panel.getByRole("button", { name: "Angebot erfassen", exact: true }).click();
  await expect(panel).toBeHidden();

  // The participant's paper, then the signature.
  const upload = async (dates: Record<string, string>) => {
    await page.getByRole("button", { name: "Scan hochladen", exact: true }).click();
    panel = page.getByRole("dialog");
    await panel.locator('input[type="file"]').setInputFiles(pdf);
    await panel.getByLabel("Entgegengenommen von").selectOption(projectLead);
    await panel.getByLabel(/Entgegengenommen am/).pressSequentially("10.01.2026");
    for (const [label, value] of Object.entries(dates)) {
      await panel.getByLabel(new RegExp(label)).pressSequentially(value);
    }
    await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  };
  await upload({ "Unterschrift Teilnehmer": "05.01.2026" });
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Prüfen", exact: true }).click();
  panel = page.getByRole("dialog");
  await panel.getByLabel(/Unterschrift Teilnehmer/).pressSequentially("05.01.2026");
  await panel.getByText(/Das externe Papier/).click();
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Als unterschrieben erfassen" }).click();
  panel = page.getByRole("dialog");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText(/Noch nicht vollständig unterschrieben/)).toBeVisible();

  // The mistake: the countersigned original shows another participant date. Refused, the panel
  // keeps the input; the corrected date is accepted.
  await upload({ "Unterschrift Teilnehmer": "06.01.2026", "Unterschrift Kunde": "08.01.2026" });
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel.getByText(/Speichern nicht möglich/)).toBeVisible();
  await expect(panel.getByLabel(/Unterschrift Teilnehmer/)).toHaveValue("06.01.2026");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Verwerfen" }).click();
  await expect(panel).toBeHidden();

  await upload({
    "Unterschrift Teilnehmer": "05.01.2026",
    "Unterschrift Kunde": "08.01.2026",
    "Unterschrift Transfergesellschaft": "09.01.2026",
  });
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Prüfen", exact: true }).click();
  panel = page.getByRole("dialog");
  for (const [label, value] of Object.entries({
    "Unterschrift Teilnehmer": "05.01.2026",
    "Unterschrift Kunde": "08.01.2026",
    "Unterschrift Transfergesellschaft": "09.01.2026",
  })) {
    await panel.getByLabel(new RegExp(label)).pressSequentially(value);
  }
  await panel.getByText(/Das externe Papier/).click();
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText("Vollständig unterschrieben am 09.01.2026.")).toBeVisible();

  // The original.
  await page.getByRole("button", { name: /Erfassen.*Aufbewahrungsort/ }).click();
  panel = page.getByRole("dialog");
  await panel
    .getByRole("combobox", { name: "Aufbewahrungsort des Originals" })
    .selectOption("paper_personnel_file");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: /Erfassen.*Original eingegangen am/ }).click();
  panel = page.getByRole("dialog");
  await panel
    .getByRole("textbox", { name: /Original eingegangen am/ })
    .pressSequentially("12.01.2026");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText("In der Personalakte (Papier)")).toBeVisible();
  await expect(page.getByText("12.01.2026").first()).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectAccessible(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${screenshots}packet-${width}.png`, fullPage: true });
  }
});
