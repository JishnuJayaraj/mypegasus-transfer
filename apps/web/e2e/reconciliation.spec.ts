import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  changeStatus,
  externalDsvOffer,
  pl,
  testDatabaseUrls,
} from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// A missed TG entry reconciled (process-and-lifecycle.md, the reconciliation; Q68 case 2, Q80,
// Q216): every entry fact held on the planned start but the run didn't enter the participation;
// the PL records "Eintritt nachträglich erfassen" from the entry clarification with the evidence
// and its days, the region's manager asks "Rückfrage: Datum unklar" in "Freigaben", the PL replies
// "Erläutert" on the tab "DSV", the manager records "Erledigt". The participation is this test's
// own owner fixture. Synthetic paper only; screenshots go to docs/screenshots/7-6/.

const projectId = seedProjectIds.werkNord;
const { projectLead, regionalOperationsManager } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-6/", import.meta.url));
const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${screenshots}${name}.png`, fullPage: true });

/**
 * An informed participation of Werk Nord in W1 with every entry fact, recorded through the
 * functions: the TL 407 signed 15 days ago with profiling done on it, the ASU registration attested
 * ten days ago (through the staff API, which encrypts the customer number), and the complete DSV
 * packet signed five days ago; its planned start was yesterday, so the scheduled run is past.
 */
async function missedEntry(page: Page, baseURL: string) {
  const id = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  const day = async (offset: number) =>
    (await owner.$client.query("select (berlin_today() + $1::int)::text as d", [offset])).rows[0]
      .d as string;
  try {
    await activateAsOwner(owner.$client, [projectId]);
    await owner.insert(participation).values({
      id,
      projectId,
      entryWaveId: w1.id,
      status: "informed",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await owner.insert(participantIdentity).values({
      participationId: id,
      projectId,
      personnelNumber: `EIN-${id.slice(0, 8)}`,
      firstName: "Jonas",
      lastName: "Nachtrag",
      birthDate: "1981-04-11",
    });
    await owner.insert(participantDetails).values({ participationId: id, projectId });
    // The TL 407 on external paper, accepted, and profiling done on its date.
    for (const [from, to] of [
      ["not_started", "profiling_accepted"],
      ["profiling_accepted", "profiling_in_progress"],
    ] as const) {
      await changeStatus(owner.$client, id, { field: "profiling_status", from, to });
    }
    const tl407 = randomUUID();
    const signed = await day(-15);
    await call(owner.$client, "add_document", {
      context: pl,
      participationId: id,
      id: tl407,
      type: "tl407_signed_scan",
      mediaType: "application/pdf",
      sizeBytes: 4096,
      contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      fileName: null,
      keyId: randomBytes(8).toString("hex"),
      wrappedKey: randomBytes(60),
      scanOrigin: "external_paper",
    });
    await call(owner.$client, "review_document", {
      context: pl,
      documentId: tl407,
      decision: "accepted",
      reason: null,
      signedOn: signed,
      countersignedOn: signed,
      confirmations: ["signatures_present", "all_pages_present"],
      formVersion: "08-2025",
      declarations: JSON.stringify({
        kind: "as_marked",
        jobboerseChoice: "full",
        baContactConsent: true,
      }),
    });
    await changeStatus(owner.$client, id, {
      field: "profiling_status",
      from: "profiling_in_progress",
      to: "profiling_done",
      effectiveDate: signed,
    });
    // The complete DSV packet, then "Als unterschrieben erfassen".
    await externalDsvOffer(owner.$client, id);
    const on = await day(-5);
    const packet = await acceptDsvScan(owner.$client, id, {
      participant: on,
      customer: on,
      transfergesellschaft: on,
    });
    const { rows } = await owner.$client.query(
      "select status_version from participation where id = $1",
      [id],
    );
    await call(owner.$client, "sign_dsv", {
      context: pl,
      participationId: id,
      scanId: packet,
      statusVersion: rows[0].status_version,
    });
    // The ASU registration with the PL's attestation, through the API.
    await session(page, baseURL, projectLead);
    const api = page.context().request;
    const headers = { Origin: baseURL };
    const asu = async () =>
      (await (await api.get(`/api/v1/participations/${id}/asu`)).json()) as {
        route: { version: number };
      };
    const routed = await api.put(`/api/v1/participations/${id}/asu/route`, {
      headers,
      data: { channel: "online_self", version: (await asu()).route.version },
    });
    expect(routed.ok(), await routed.text()).toBe(true);
    const registered = await api.post(`/api/v1/participations/${id}/asu/registration`, {
      headers,
      data: {
        routeVersion: (await asu()).route.version,
        registeredOn: await day(-10),
        attestation: { customerNumber: "123A456789", source: "ba_online_account_inspected" },
      },
    });
    expect(registered.ok(), await registered.text()).toBe(true);
    // The planned start was yesterday: its run is past, the entry was missed.
    await owner.$client.query(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 1 where id = $1",
      [id],
    );
  } finally {
    await owner.$client.end();
  }
  return id;
}

test("missed entry → reconciliation → Rückfrage → the PL's reply → Erledigt", async ({
  page,
  baseURL,
}) => {
  test.slow();
  page.setDefaultTimeout(10000);
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  const id = await missedEntry(page, baseURL!);
  const personnelNumber = `EIN-${id.slice(0, 8)}`;

  // The entry clarification names the reconciliation and offers its button.
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  const clarification = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Eintritt klären", exact: true }) });
  const button = clarification.getByRole("button", { name: "Eintritt nachträglich erfassen" });
  await expect(button).toBeVisible();
  await expectAccessible(page);
  await shot(page, "entry-clarification-path");

  // The dialog lists the evidence with its days; nothing is preset.
  await button.click();
  const panel = page.getByRole("dialog", { name: "Eintritt nachträglich erfassen" });
  const evidence = panel.getByTestId("reconciliation-evidence");
  await expect(evidence).toContainText("DSV vollständig unterschrieben: gültig ab");
  await expect(evidence).toContainText("Arbeitsuchendmeldung mit Nachweis: gültig ab");
  await expect(evidence).toContainText("TL 407 unterschrieben");
  await expect(panel.getByLabel(/Ich bestätige/)).not.toBeChecked();
  await panel.getByLabel(/Ich bestätige/).check({ force: true });
  await expectAccessible(page);
  await shot(page, "reconciliation-dialog");
  await panel.getByRole("button", { name: "Eintritt erfassen" }).click();
  await expect(panel).toBeHidden();
  const reconciled = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Nachträglich erfasster Eintritt", exact: true }),
  });
  await expect(reconciled.getByText(/Stand: Prüfung offen/)).toBeVisible();
  await expect(page.getByText("In der TG").first()).toBeVisible();
  await expectAccessible(page);
  await shot(page, "reconciled");

  // The region's manager asks: "Rückfrage", Datum unklar, with its source.
  await session(page, baseURL!, regionalOperationsManager);
  await page.goto("/reviews");
  let table = page.getByRole("table", { name: "Nachträglich erfasste Eintritte" });
  await expect(table.getByText("Prüfung offen", { exact: false })).toBeVisible();
  await expect(table).not.toContainText("Nachtrag");
  await expectAccessible(page);
  await shot(page, "reviews-requested");
  await table.getByRole("button", { name: /^Rückfrage/ }).click();
  let dialog = page.getByRole("dialog", { name: "Rückfrage" });
  await dialog.getByLabel("Grund der Rückfrage").selectOption("date_unclear");
  await dialog.getByLabel(/^Quelle/).fill("Scan-Datum prüfen, Vermerk 12");
  await shot(page, "reviews-clarification-dialog");
  await dialog.getByRole("button", { name: "Erfassen" }).click();
  await expect(
    page.getByText("Die Rückfrage ist erfasst; sie liegt bei der Projektleitung."),
  ).toBeVisible();

  // The PL sees "Rückfrage zum Eintritt" and replies on the tab "DSV".
  await session(page, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}?tab=participants&caseItem=reconciliation_clarification`);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  await expect(list.getByText(personnelNumber, { exact: true })).toBeVisible();
  await shot(page, "worklist-clarification");
  // The participant's open items name it.
  await page.goto(`/projects/${projectId}/participations/${id}`);
  await expect(page.getByText(/Rückfrage zum Eintritt \(seit/).first()).toBeVisible();
  await shot(page, "overview-clarification");
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  const card = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Nachträglich erfasster Eintritt", exact: true }),
  });
  await expect(card.getByText(/Rückfrage vom .*Datum unklar/)).toBeVisible();
  await card.getByLabel("Antwort", { exact: true }).selectOption("explained");
  await card.getByLabel(/^Quelle/).fill("Eingangsbuch 7, Datum bestätigt");
  await expectAccessible(page);
  await shot(page, "reply");
  await card.getByRole("button", { name: "Antwort erfassen" }).click();
  await expect(card.getByText(/Stand: Beantwortet, Prüfung offen/)).toBeVisible();
  // Still on the list until the manager resolves it.
  await page.goto(`/projects/${projectId}?tab=participants&caseItem=reconciliation_clarification`);
  await expect(
    page.getByRole("region", { name: "Teilnehmende" }).getByText(personnelNumber, { exact: true }),
  ).toBeVisible();

  // The manager records "Erledigt" with its source.
  await session(page, baseURL!, regionalOperationsManager);
  await page.goto("/reviews");
  table = page.getByRole("table", { name: "Nachträglich erfasste Eintritte" });
  await expect(table).toContainText("Antwort – Erläutert – Eingangsbuch 7");
  await expectAccessible(page);
  await shot(page, "reviews-replied");
  await table.getByRole("button", { name: /^Erledigt/ }).click();
  dialog = page.getByRole("dialog", { name: "Erledigt" });
  await dialog.getByLabel(/^Quelle/).fill("Rücksprache PL, Vermerk 13");
  await dialog.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.getByText("Die Prüfung ist erledigt.")).toBeVisible();
  await expect(page.getByText("Keine offenen nachträglichen Eintritte.")).toBeVisible();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectAccessible(page);
    await shot(page, `reviews-resolved-${width}`);
  }

  // The item is gone from the PL's list.
  await session(page, baseURL!, projectLead);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/projects/${projectId}?tab=participants&caseItem=reconciliation_clarification`);
  await expect(
    page.getByRole("region", { name: "Teilnehmende" }).getByText(personnelNumber, { exact: true }),
  ).toBeHidden();
});
