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
import {
  acceptDsvScan,
  activateAsOwner,
  call,
  externalDsvOffer,
  pl,
  testDatabaseUrls,
} from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// The cancellation of a signed DSV before the planned start (process-and-lifecycle.md, the
// cancellation; Q46 verify): the cancellation scan, its review with the three signatures, the PL's
// withdrawal with the confirmation (a date before the cancellation refused, then corrected), "Kunde
// informieren" on the work list and its record. Synthetic paper only.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-5/", import.meta.url));
const pdf = {
  name: "synthetic-aufhebung.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n% Synthetic cancellation fixture\n%%EOF"),
};
const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${screenshots}${name}.png`, fullPage: true });

/** An informed participation of Werk Nord in W1 whose DSV the participant signed on 01.01.2026. */
async function signedParticipation() {
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
      personnelNumber: `AUF-${participationId.slice(0, 8)}`,
      firstName: "Mirela",
      lastName: "Aufhebung",
      birthDate: "1984-09-21",
    });
    await owner.insert(participantDetails).values({ participationId, projectId });
    await externalDsvOffer(owner.$client, participationId);
    const scan = await acceptDsvScan(owner.$client, participationId, { participant: "2026-01-01" });
    const { rows } = await owner.$client.query(
      "select status_version from participation where id = $1",
      [participationId],
    );
    await call(owner.$client, "sign_dsv", {
      context: pl,
      participationId,
      scanId: scan,
      statusVersion: rows[0].status_version,
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

test("cancellation scan → review → withdrawal → Kunde informieren → recorded", async ({
  page,
  baseURL,
}) => {
  test.slow();
  page.setDefaultTimeout(10000);
  mkdirSync(screenshots, { recursive: true });
  const id = await signedParticipation();
  const personnelNumber = `AUF-${id.slice(0, 8)}`;
  await session(page, baseURL!, projectLead);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  const cancellation = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Aufhebungsvertrag", exact: true }) });

  // The scan of the cancellation, against the signed contract; nothing preset.
  await cancellation.getByRole("button", { name: "Aufhebungsvertrag hochladen" }).click();
  let panel = page.getByRole("dialog");
  await expect(panel.getByLabel("Entgegengenommen von")).toHaveValue("");
  await expect(panel.getByLabel(/Unterschrift Kunde/)).toHaveValue("");
  await panel.locator('input[type="file"]').setInputFiles(pdf);
  await panel.getByLabel("Entgegengenommen von").selectOption(projectLead);
  await panel.getByLabel(/Entgegengenommen am/).pressSequentially("06.01.2026");
  await panel.getByLabel(/Unterschrift Teilnehmer/).pressSequentially("05.01.2026");
  await panel.getByLabel(/Unterschrift Kunde/).pressSequentially("05.01.2026");
  await panel.getByLabel(/Unterschrift Transfer/).pressSequentially("05.01.2026");
  await expectAccessible(page);
  await shot(page, "cancellation-upload");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();

  // The review confirms the three signatures with their dates.
  await cancellation.getByRole("button", { name: "Prüfen", exact: true }).click();
  panel = page.getByRole("dialog");
  await expect(panel.getByLabel(/Unterschrift Teilnehmer/)).toHaveValue("");
  await panel.getByLabel(/Unterschrift Teilnehmer/).pressSequentially("05.01.2026");
  await panel.getByLabel(/Unterschrift Kunde/).pressSequentially("05.01.2026");
  await panel.getByLabel(/Unterschrift Transfer/).pressSequentially("05.01.2026");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(cancellation.getByText(/gültig ab 05\.01\.2026/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, "cancellation-reviewed");

  // "Zurückziehen": a date before the cancellation is refused, the corrected one taken.
  await page.getByRole("button", { name: "Aktionen" }).click();
  await page.getByRole("menuitem", { name: "Zurückziehen" }).click();
  panel = page.getByRole("dialog", { name: "Zurückziehen" });
  await expect(panel.getByText(/gültig ab 05\.01\.2026/)).toBeVisible();
  await expect(panel.getByLabel("Grund", { exact: true })).toHaveValue("");
  await panel.getByLabel("Grund", { exact: true }).selectOption("placed_direct");
  await panel.getByLabel(/Zurückgezogen am/).pressSequentially("04.01.2026");
  await panel.getByLabel(/Ich bestätige/).check({ force: true });
  await expectAccessible(page);
  await shot(page, "withdrawal-dialog");
  await panel.getByRole("button", { name: "Zurückziehen", exact: true }).click();
  await expect(
    panel.getByText("Das Datum liegt vor der Gültigkeit des Aufhebungsvertrags."),
  ).toBeVisible();
  await shot(page, "withdrawal-refused");
  await panel.getByLabel(/Zurückgezogen am/).fill("");
  await panel.getByLabel(/Zurückgezogen am/).pressSequentially("06.01.2026");
  await panel.getByRole("button", { name: "Zurückziehen", exact: true }).click();
  await expect(panel).toBeHidden();

  // "Kunde informieren" on the work list until it is recorded.
  await page.goto(`/projects/${projectId}?tab=participants&caseItem=dsv_customer_notice`);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  await expect(list.getByText(personnelNumber, { exact: true })).toBeVisible();
  await expect(list.getByText(/Kunde informieren/).first()).toBeVisible();
  await expectAccessible(page);
  await shot(page, "worklist-customer-notice");
  await page.goto(`/projects/${projectId}/participations/${id}`);
  await expect(page.getByText(/Kunde informieren \(zurückgezogen am 06\.01\.2026\)/)).toBeVisible();
  await shot(page, "overview-customer-notice");

  // "Kunde informiert am": once, on the tab "DSV".
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  const notice = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Kunde informieren", exact: true }) });
  await notice.getByRole("button", { name: "Kunde informiert am …" }).click();
  panel = page.getByRole("dialog");
  await expect(panel.getByLabel(/Kunde informiert am \(TT/)).toHaveValue("");
  await panel.getByLabel(/Kunde informiert am \(TT/).pressSequentially("07.01.2026");
  await panel.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(notice.getByText("Kunde informiert am 07.01.2026.")).toBeVisible();
  await expect(notice.getByRole("button", { name: "Kunde informiert am …" })).toBeHidden();
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectAccessible(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, `customer-notified-${width}`);
  }
  // The item is gone from the work list.
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/projects/${projectId}?tab=participants&caseItem=dsv_customer_notice`);
  await expect(
    page.getByRole("region", { name: "Teilnehmende" }).getByText(personnelNumber, { exact: true }),
  ).toBeHidden();
});
