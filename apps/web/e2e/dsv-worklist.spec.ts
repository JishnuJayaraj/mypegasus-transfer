import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { createDb, seedRegionIds, seedStaffUserIds } from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// The signed DSV on the work list (process-and-lifecycle.md, the entry clarification): the PL filters "DSV: unterschrieben, nicht vollständig" and sees the item, the filter and
// the tile agree, generates two DSV in one call, documents what is pending on a signed DSV that
// has not entered, and escalates it; the regional operations manager records the instruction in
// "Freigaben" (never the PL), and the case stays open. The project is this test's own (created
// through the staff API) and its participations are owner fixtures, so no other spec's rows change
// its counts. Synthetic data only; screenshots go to docs/screenshots/7-4/.

const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-4/", import.meta.url));
const { projectLead, regionalOperationsManager } = seedStaffUserIds;

const session = async (page: Page, baseURL: string, staffUserId: string) => {
  const res = await page
    .context()
    .request.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};

/** A screenshot of the page after Carbon's transitions have ended. */
async function shot(page: Page, name: string) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}${name}.png`, fullPage: true });
}

/** The project with its wave and template, two informed participants and one signed DSV. */
async function fixture(page: Page, baseURL: string) {
  await session(page, baseURL, projectLead);
  const api = page.context().request;
  const headers = { Origin: baseURL };
  const created = await api.post("/api/v1/projects", {
    headers,
    data: {
      name: "E2E DSV Arbeitsliste",
      customerName: "Beispiel GmbH",
      type: "ta_tg",
      regionId: seedRegionIds.nord,
    },
  });
  expect(created.status()).toBe(201);
  const { id: projectId } = (await created.json()) as { id: string };
  const wave = await api.post(`/api/v1/projects/${projectId}/entry-waves`, {
    headers,
    data: {
      code: "W1",
      name: "Welle 1",
      signingDeadline: "2091-02-15",
      defaultTgStart: "2091-03-01",
      defaultTgEnd: "2092-02-29",
      latestEntryDate: "2091-03-15",
    },
  });
  expect(wave.status()).toBe(201);
  const { id: waveId } = (await wave.json()) as { id: string };
  const pin = await api.put(`/api/v1/projects/${projectId}/dsv-template`, {
    headers,
    data: { version: "v1" },
  });
  expect(pin.ok(), await pin.text()).toBe(true);

  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  const signedId = randomUUID();
  try {
    await activateAsOwner(owner.$client, [projectId]);
    const person = async (
      id: string,
      number: string,
      first: string,
      last: string,
      values: { dsv: string; start?: string },
    ) => {
      await owner.$client.query(
        `insert into participation (id, project_id, entry_wave_id, status, profiling_status,
           dsv_status, offer_deadline, tg_start)
         values ($1, $2, $3, 'informed', 'not_started', $4,
           case when $5::int is null then null else berlin_today() - 30 end,
           case when $5::int is null then null else berlin_today() - $5::int end)`,
        [
          id,
          projectId,
          waveId,
          values.dsv,
          values.start === undefined ? null : Number(values.start),
        ],
      );
      await owner.$client.query(
        `insert into participant_identity (participation_id, project_id, personnel_number,
           first_name, last_name, birth_date) values ($1, $2, $3, $4, $5, '1979-03-14')`,
        [id, projectId, number, first, last],
      );
      await owner.$client.query(
        `insert into participant_details (participation_id, project_id) values ($1, $2)`,
        [id, projectId],
      );
    };
    await person(randomUUID(), "DSV-0001", "Aylin", "Arslan", { dsv: "not_offered" });
    await person(randomUUID(), "DSV-0002", "Bernd", "Beispiel", { dsv: "not_offered" });
    await person(signedId, "DSV-0003", "Clara", "Gegenzeichnung", {
      dsv: "dsv_signed",
      start: "2",
    });
    const {
      rows: [offer],
    } = await owner.$client.query(
      `insert into dsv_offer (project_id, participation_id, origin, template_version,
         offer_deadline, printed_tg_start, printed_tg_end, offered_by, ended_as, ended_at)
       values ($1, $2, 'external_paper', 'external_unknown', berlin_today() - 30,
         berlin_today() - 2, berlin_today() + 363, $3, 'signed', now())
       returning id`,
      [projectId, signedId, projectLead],
    );
    await owner.$client.query(
      `insert into dsv_contract (project_id, participation_id, dsv_offer_id, participant_signed_on)
       values ($1, $2, $3, berlin_today() - 25)`,
      [projectId, signedId, offer.id],
    );
  } finally {
    await owner.$client.end();
  }
  return { projectId, signedId };
}

test("filter and tile agree; bulk DSV; documenting, escalating and the manager's instruction", async ({
  page,
  baseURL,
}) => {
  test.slow();
  page.setDefaultTimeout(10000);
  const { projectId, signedId } = await fixture(page, baseURL!);

  // The item, the filter and the tile count the same participation.
  await page.goto(`/projects/${projectId}?tab=participants&caseItem=dsv_not_fully_executed`);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  await expect(list.getByText("DSV-0003", { exact: true })).toBeVisible();
  await expect(list.getByText("DSV-0001", { exact: true })).toBeHidden();
  await expect(
    page.getByText("Offene Arbeit: DSV: unterschrieben, nicht vollständig", { exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  await shot(page, "worklist-filter");
  // The participant's overview names both items and points to the tab "DSV".
  await page.goto(`/projects/${projectId}/participations/${signedId}`);
  await expect(page.getByText(/DSV nicht vollständig unterschrieben \(Teilnehmende/)).toBeVisible();
  // "Als Nächstes" shows three items; the rest are behind "Alle n anzeigen".
  await page.getByRole("button", { name: /^Alle \d+ anzeigen$/ }).click();
  await expect(page.getByText(/Eintritt klären \(geplanter Beginn überschritten/)).toBeVisible();
  await shot(page, "overview-open-items");
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText(/1 DSV: unterschrieben, nicht vollständig/)).toBeVisible();
  await expect(page.getByText(/1 Klärungsfälle Stichtag|0 Klärungsfälle Stichtag/)).toBeVisible();
  await shot(page, "dashboard-tiles");

  // Two DSV in one call, with the wave's deadline for both.
  await page.goto(`/projects/${projectId}?tab=participants`);
  await page.getByRole("checkbox", { name: /DSV-0001/ }).check({ force: true });
  await page.getByRole("checkbox", { name: /DSV-0002/ }).check({ force: true });
  await page.getByRole("button", { name: "Weitere Aktionen" }).click();
  await page.getByText("DSV erzeugen", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "DSV erzeugen" });
  await expect(panel.getByRole("button", { name: "Erzeugen" })).toBeDisabled();
  await panel
    .getByRole("radio", { name: /Unterschriftsfrist der Welle, 15.02.2091/ })
    .check({ force: true });
  await shot(page, "bulk-dsv-dialog");
  await panel.getByRole("button", { name: "Erzeugen" }).click();
  await expect(panel.getByTestId("dsv-bulk-result")).toContainText("2 DSV erzeugt.");
  await expect(panel.getByTestId("dsv-bulk-result")).toContainText("Anschrift");
  await shot(page, "bulk-dsv-result");
  await page.keyboard.press("Escape");

  // The PL documents what is pending and escalates.
  await page.goto(`/projects/${projectId}/participations/${signedId}?tab=dsv`);
  const card = page
    .getByRole("heading", { name: "Eintritt klären" })
    .locator("xpath=ancestor::section[1]");
  await expect(card.getByText(/Neuer Beginn mit Nachtrag/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Erfassen" })).toBeDisabled();
  await card
    .getByLabel("Was steht aus?")
    .selectOption({ label: "Nachweis der Arbeitsuchendmeldung steht aus" });
  await card.getByLabel(/^Quelle/).fill("Akte 12, Vermerk vom 3.4.");
  await card.getByRole("button", { name: "Erfassen" }).click();
  await expect(card.getByText(/Quelle: Akte 12, Vermerk vom 3.4./).first()).toBeVisible();
  await card.getByRole("button", { name: "An die Regionale Betriebsleitung eskalieren" }).click();
  await page
    .getByRole("dialog", { name: "Fall eskalieren" })
    .getByRole("button", { name: "Eskalieren" })
    .click();
  await expect(card.getByText(/Eskaliert am/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, "entry-clarification-escalated");

  // The manager asks the PL again; the PL replies and escalates again.
  await session(page, baseURL!, regionalOperationsManager);
  await page.goto("/reviews");
  let table = page.getByRole("table", { name: "Eskalierte Klärungen zum Eintritt" });
  await expect(table).toContainText("E2E DSV Arbeitsliste");
  await expect(table).toContainText("Akte 12, Vermerk vom 3.4.");
  await expect(table).not.toContainText("Gegenzeichnung");
  await shot(page, "reviews-clarification");
  await table.getByRole("button", { name: /Rückfrage an die PL/ }).click();
  let dialog = page.getByRole("dialog", { name: "Rückfrage an die Projektleitung" });
  await dialog.getByLabel("Grund der Rückfrage").selectOption({ label: "Datum unklar" });
  await dialog.getByLabel(/^Quelle/).fill("Datum der Unterschrift fehlt");
  await dialog.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.getByText(/Die Rückfrage wurde erfasst/)).toBeVisible();
  await expect(table.getByRole("button", { name: /Weisung erfassen/ })).toBeHidden();
  await session(page, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${signedId}?tab=dsv`);
  await expect(card.getByText("Rückfrage der Regionalen Betriebsleitung")).toBeVisible();
  await shot(page, "entry-clarification-returned");
  await card
    .getByLabel("Antwort: Was steht jetzt aus?")
    .selectOption({ label: "Rechtsrat steht aus" });
  await card.getByLabel(/^Quelle/).fill("Datum nachgereicht, Rechtsrat angefragt");
  await card.getByRole("button", { name: "Antworten" }).click();
  await card.getByRole("button", { name: "An die Regionale Betriebsleitung eskalieren" }).click();
  await page
    .getByRole("dialog", { name: "Fall eskalieren" })
    .getByRole("button", { name: "Eskalieren" })
    .click();
  await expect(card.getByTestId("entry-clarification-history").locator("li")).toHaveCount(5);

  // The manager records the instruction; the case stays open and nothing changed.
  await session(page, baseURL!, regionalOperationsManager);
  await page.goto("/reviews");
  table = page.getByRole("table", { name: "Eskalierte Klärungen zum Eintritt" });
  await table.getByRole("button", { name: /Weisung erfassen/ }).click();
  dialog = page.getByRole("dialog", { name: "Weisung erfassen" });
  await dialog.getByLabel("Weisung").selectOption({ label: "Rechtsrat liegt vor" });
  await dialog.getByLabel(/^Quelle/).fill("Rechtsrat Kanzlei, Az. 77");
  await dialog.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.getByText("Die Weisung wurde erfasst.")).toBeVisible();
  await expect(table.getByRole("button", { name: /Weisung erfassen/ })).toBeHidden();

  await session(page, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${signedId}?tab=dsv`);
  await expect(
    page.getByText(/Rechtsrat liegt vor – Quelle: Rechtsrat Kanzlei, Az. 77/),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await shot(page, "entry-clarification-instructed-375");
});
