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

// Date corrections (data-protection.md, evidence corrections: field targets and the DSV
// signature-date supersession). (1) A wrong `profilingDoneOn` blocked the entry: the PL requests
// the correction on the tab "Profiling" with the TL 407's date, the region's manager approves it in
// "Freigaben", and the missed start is reconciled with the corrected fact (recorded at the
// approval, after the run). (2) Back office typed the participant's DSV date as 14.04. instead of
// 14.03.: a signature-date correction, approved, supersedes it on both scans. The participations
// are this test's own owner fixtures. Synthetic paper only; screenshots go to
// docs/screenshots/7-8/.

const projectId = seedProjectIds.werkNord;
const { projectLead, backOffice, regionalOperationsManager } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-8/", import.meta.url));
const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${screenshots}${name}.png`, fullPage: true });

/**
 * An informed participation of Werk Nord in W1 with every entry fact but one, recorded through the
 * functions: the TL 407 signed 15 days ago, profiling done recorded as today (the typing mistake:
 * after the planned start), the ASU registration attested ten days ago (through the staff API,
 * which encrypts the customer number), and the complete DSV packet signed five days ago; its
 * planned start was yesterday, so the scheduled run is past.
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
      personnelNumber: `KOR-${id.slice(0, 8)}`,
      firstName: "Jonas",
      lastName: "Korrektur",
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
      effectiveDate: await day(0),
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

/**
 * A signed DSV of Werk Nord in W1, recorded through the functions: the participant's scan and then
 * the countersigned packet, both with the participant's date typed as 14.04.2026 (the paper shows
 * 14.03.2026); received by the PL today.
 */
async function signedWithWrongDate() {
  const id = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
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
      personnelNumber: `SIG-${id.slice(0, 8)}`,
      firstName: "Mila",
      lastName: "Datumsfehler",
      birthDate: "1979-09-02",
    });
    await owner.insert(participantDetails).values({ participationId: id, projectId });
    await externalDsvOffer(owner.$client, id);
    const first = await acceptDsvScan(owner.$client, id, { participant: "2026-04-14" });
    const { rows } = await owner.$client.query(
      "select status_version from participation where id = $1",
      [id],
    );
    await call(owner.$client, "sign_dsv", {
      context: pl,
      participationId: id,
      scanId: first,
      statusVersion: rows[0].status_version,
    });
    await acceptDsvScan(owner.$client, id, {
      participant: "2026-04-14",
      customer: "2026-04-20",
      transfergesellschaft: "2026-04-20",
    });
  } finally {
    await owner.$client.end();
  }
  return id;
}

/** "Korrektur beantragen" filled in: the date, a reason and the documented source; submitted. */
async function requestCorrection(page: Page, button: string, date: string, source: string) {
  await page.getByRole("button", { name: button }).first().click();
  const dialog = page.getByRole("dialog", { name: "Korrektur beantragen" });
  await expect(dialog.getByLabel("Richtiges Datum")).toHaveValue("");
  await expect(dialog.getByLabel("Grund")).toHaveValue("");
  await dialog.getByLabel("Richtiges Datum").fill(date);
  await dialog.getByLabel("Grund").selectOption("documented_internal_error");
  await dialog.getByLabel("Dokumentierte Quelle").fill(source);
  return dialog;
}

/** The manager approves the one correction of `label` in "Freigaben". */
async function approve(page: Page, baseURL: string, label: string, name: string) {
  await session(page, baseURL, regionalOperationsManager);
  await page.goto("/reviews");
  const table = page.getByRole("table", { name: "Beantragte Korrekturen" });
  await expect(table.getByText(label)).toBeVisible();
  // No participant name and no corrected value in the queue.
  await expect(table).not.toContainText("Korrektur, Jonas");
  await expect(table).not.toContainText("Datumsfehler");
  await expectAccessible(page);
  await shot(page, `${name}-freigaben`);
  await table
    .getByRole("button", { name: /^Korrektur freigeben: / })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Korrektur freigeben" });
  await dialog.getByRole("button", { name: "Freigeben" }).click();
  await expect(page.getByText("Korrektur freigegeben.")).toBeVisible();
}

test("a wrong profilingDoneOn: requested, approved, the missed start reconciled", async ({
  page,
  baseURL,
}) => {
  test.slow();
  page.setDefaultTimeout(10000);
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  const id = await missedEntry(page, baseURL!);

  // The reconciliation isn't offered: the completion is recorded after the planned start.
  await page.goto(`/projects/${projectId}/participations/${id}?tab=profiling`);
  const correctionButton = "Korrektur beantragen: Profiling abgeschlossen am";
  await expect(page.getByRole("button", { name: correctionButton })).toBeVisible();
  await expectAccessible(page);
  await shot(page, "profiling-done-on");
  const dialog = await requestCorrection(
    page,
    correctionButton,
    // The TL 407's signature date, 15 days ago.
    new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(Date.now() - 15 * 86_400_000)),
    "TL 407 Seite 2, Vermerk 21",
  );
  await expectAccessible(page);
  await shot(page, "profiling-done-on-dialog");
  await dialog.getByRole("button", { name: "Beantragen" }).click();
  await expect(
    page.getByText("Korrektur beantragt. Sie wird in den Freigaben entschieden."),
  ).toBeVisible();
  await expect(page.getByText(/Korrektur beantragt$/).first()).toBeVisible();

  await approve(page, baseURL!, "Datum: Profiling abgeschlossen am", "profiling-done-on");

  // The PL reconciles the missed start with the corrected fact.
  await session(page, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  const clarification = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Eintritt klären", exact: true }) });
  await clarification.getByRole("button", { name: "Eintritt nachträglich erfassen" }).click();
  const panel = page.getByRole("dialog", { name: "Eintritt nachträglich erfassen" });
  await expect(panel.getByTestId("reconciliation-evidence")).toContainText("TL 407 unterschrieben");
  await panel.getByLabel(/Ich bestätige/).check({ force: true });
  await shot(page, "profiling-done-on-reconciliation");
  await panel.getByRole("button", { name: "Eintritt erfassen" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText("In der TG").first()).toBeVisible();
  await expectAccessible(page);
  await shot(page, "profiling-done-on-reconciled");

  // The manager closes this review ("Ohne Einwand"), leaving the shared queue as it was.
  const api = page.context().request;
  const mine = (await (
    await api.get(`/api/v1/participations/${id}/tg-entry-reconciliation`)
  ).json()) as { reconciliation: { id: string; revision: number } };
  await session(page, baseURL!, regionalOperationsManager);
  const reviewed = await api.post(`/api/v1/reconciliations/${mine.reconciliation.id}/review`, {
    headers: { Origin: baseURL! },
    data: { outcome: "no_objection", revision: mine.reconciliation.revision },
  });
  expect(reviewed.ok(), await reviewed.text()).toBe(true);
});

test("back office supersedes a wrong participant date (14.04. → 14.03.) on both scans", async ({
  page,
  baseURL,
}) => {
  test.slow();
  page.setDefaultTimeout(10000);
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  const id = await signedWithWrongDate();

  await session(page, baseURL!, backOffice);
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  await expect(page.getByText(/Unterschrift Teilnehmer·in: 14\.04\.2026/)).toHaveCount(2);
  await expectAccessible(page);
  await shot(page, "signature-before");
  const dialog = await requestCorrection(
    page,
    "Korrektur beantragen: Unterschrift Teilnehmer·in (14.04.2026)",
    "14.03.2026",
    "Papier-DSV, Unterschriftsfeld S. 4",
  );
  await expect(dialog).toContainText("auf jedem angenommenen Scan");
  await shot(page, "signature-dialog");
  // Two buttons exist (one per scan); the first one's dialog is open.
  await dialog.getByRole("button", { name: "Beantragen" }).click();
  await expect(
    page.getByText("Korrektur beantragt. Sie wird in den Freigaben entschieden."),
  ).toBeVisible();

  await approve(
    page,
    baseURL!,
    "Unterschriftsdatum: Vertrag (unterschrieben), Unterschrift Teilnehmer·in",
    "signature",
  );

  await session(page, baseURL!, backOffice);
  await page.goto(`/projects/${projectId}/participations/${id}?tab=dsv`);
  await expect(page.getByText(/Unterschrift Teilnehmer·in: 14\.03\.2026/)).toHaveCount(2);
  await expect(page.getByText(/Unterschrift Teilnehmer·in: 14\.04\.2026/)).toHaveCount(0);
  await expectAccessible(page);
  await shot(page, "signature-after");
});
