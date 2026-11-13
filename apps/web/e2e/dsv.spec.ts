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

// The DSV's generation (process-and-lifecycle.md, the DSV: generation): the PL pins
// the project's DSV template on "Einrichtung", then on the participant's tab "DSV" chooses the
// wave's signing deadline before "Erzeugen", sees what stays for the hand before printing, and
// opens the paper through the logged opening; back office sees and opens it too. The DSV is signed
// on paper: nothing here signs. Each width passes axe without a horizontal page scroll; screenshots
// and the zoom check (200 % and 400 % of a 1280×720 window) go to docs/screenshots/7-1/. The
// participation is an owner fixture of Werk Nord in W1. Synthetic data only; the suite fails on
// any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead, backOffice } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/7-1/", import.meta.url));
// 320px is a 1280px window at 400 % zoom (WCAG 1.4.10).
const widths = [1440, 768, 375, 320] as const;
const zooms = [
  { zoom: 200, width: 640, height: 360 },
  { zoom: 400, width: 320, height: 180 },
] as const;

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

/** A screenshot after Carbon's transitions have ended. */
async function shot(page: Page, name: string, fullPage = true) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}${name}.png`, fullPage });
}

/** No horizontal page scroll; only a table's own container may scroll sideways. */
async function expectNoPageScroll(page: Page) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, serialised whole
    const scrolls = (element: Element | null): boolean =>
      element !== null &&
      element !== document.documentElement &&
      (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(element).overflowX) ||
        scrolls(element.parentElement));
    return {
      overflow: document.documentElement.scrollWidth - width,
      offenders: [...document.body.querySelectorAll("*")]
        .filter((element) => element.getBoundingClientRect().right > width + 0.5)
        .filter((element) => !scrolls(element.parentElement))
        .slice(0, 5)
        .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`),
    };
  });
  expect(overflow, `horizontal page overflow in px (${offenders.join(", ")})`).toBeLessThanOrEqual(
    0,
  );
}

test("slice 7-1: the PL pins the DSV template, generates the DSV with the wave's deadline and opens it", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const participationId = await informedParticipation();
  await session(page, baseURL!, projectLead);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. "DSV-Vorlage" on "Einrichtung": the sample v1, pinned once (fixed from a first generation).
  await page.goto(`/projects/${projectId}?tab=setup#setup-dsv`);
  const template = page.getByRole("region", { name: "DSV-Vorlage" });
  await expect(template.getByText(/Noch keine Vorlage festgelegt|Festgelegt: v1/)).toBeVisible();
  if (await template.getByRole("button", { name: "Festlegen" }).isVisible()) {
    if (await template.getByText("Noch keine Vorlage festgelegt").isVisible()) {
      await template.getByLabel("Vorlage", { exact: true }).selectOption("v1");
      await template.getByRole("button", { name: "Festlegen" }).click();
      await expect(template.getByText("Die DSV-Vorlage ist festgelegt.")).toBeVisible();
    }
  }
  await expect(template).toContainText(
    "Festgelegt: v1 (Muster, nicht für den Live-Betrieb freigegeben)",
  );
  await expectAccessible(page);
  await template.screenshot({ path: `${screenshots}template-1440.png` });

  // 2. The tab "DSV": the deadline first, nothing preset; the hand's checklist before printing.
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=dsv`);
  await expect(page.getByRole("tab", { name: "DSV", selected: true })).toBeVisible();
  const generate = page.getByRole("region", { name: "Vertrag erzeugen" });
  await expect(generate.getByText("Erst eine Frist wählen.")).toBeVisible();
  await expect(generate.getByRole("button", { name: "Erzeugen" })).toBeDisabled();
  await expect(generate.getByTestId("dsv-checklist")).toContainText(
    "Anschrift: fehlt – von Hand eintragen",
  );
  await expectAccessible(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(generate).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `dsv-tab-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await generate.getByText("Unterschriftsfrist der Welle, 15.02.2091").click();
  await generate.getByRole("button", { name: "Erzeugen" }).click();
  await expect(page.getByText("Der Vertrag wurde erzeugt (Frist 15.02.2091).")).toBeVisible();
  const papers = page.getByRole("table", { name: "Erzeugte Verträge" });
  await expect(papers).toContainText("15.02.2091 (Frist der Welle)");
  await expect(papers).toContainText("aktuell");
  await expect(papers).toContainText("Anschrift");
  await expect(page.getByText(/Aktueller Vertrag erzeugt am/)).toBeVisible();
  await expectAccessible(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(papers).toBeVisible();
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, `dsv-generated-${width}`);
  }
  for (const { zoom, width, height } of zooms) {
    await page.setViewportSize({ width, height });
    await expect(papers).toBeAttached();
    await expectNoPageScroll(page);
    await shot(page, `zoom-${zoom}-dsv-tab`, false);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 3. "Öffnen": the logged opening, then the download.
  const download = page.waitForEvent("download");
  await papers.getByRole("button", { name: /^Öffnen: Vertrag vom/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^dsv-\d{4}-\d{2}-\d{2}\.pdf$/);

  // 4. The template is fixed from the first generation.
  await page.goto(`/projects/${projectId}?tab=setup#setup-dsv`);
  await expect(template).toContainText("Seit dem ersten erzeugten DSV unveränderlich");
  await expect(template.getByRole("button", { name: "Festlegen" })).toHaveCount(0);

  // 5. Back office works the DSV too and opens the same paper.
  await session(page, baseURL!, backOffice);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=dsv`);
  await expect(papers).toContainText("aktuell");
  const again = page.waitForEvent("download");
  await papers.getByRole("button", { name: /^Öffnen: Vertrag vom/ }).click();
  expect((await again).suggestedFilename()).toMatch(/^dsv-\d{4}-\d{2}-\d{2}\.pdf$/);
  // The exact generated paper becomes an offer; the participant can decline it.
  await papers.getByRole("button", { name: "Angebot erfassen", exact: true }).click();
  const offers = page.getByRole("region", { name: "Angebote", exact: true });
  await expect(offers).toContainText("Erzeugtes Papier");
  await expect(page.getByText("DSV: Angeboten", { exact: true })).toHaveCount(2);
  await expect(offers.getByRole("button", { name: "Abgelehnt erfassen" })).toBeVisible();
  await expectAccessible(page);
  const offerScreenshots = fileURLToPath(
    new URL("../../../docs/screenshots/7-2a/", import.meta.url),
  );
  mkdirSync(offerScreenshots, { recursive: true });
  await page.screenshot({ path: `${offerScreenshots}offered-1440.png`, fullPage: true });
  await offers.getByRole("button", { name: "Abgelehnt erfassen" }).click();
  await expect(offers.getByRole("button", { name: "Abgelehnt erfassen" })).toHaveCount(0);
  await expect(offers).toContainText("Abgelehnt");
});
