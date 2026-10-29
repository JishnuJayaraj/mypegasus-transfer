import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  createDb,
  participantDetails,
  participantIdentity,
  participantProfile,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// The Kug 200b on the tab "Arbeitsuche" (process-and-lifecycle.md, the Kug 200b offer;
// data-protection.md, generated forms and signed scans; Q179, Q185, Q197): the PL generates the
// Kug 200b and sees the handwriting checklist before printing (the RV-Nummer and the other
// sensitive answers aren't recorded, so they stay blank for the participant's hand), opens it,
// uploads the signed scan printed from it and accepts it only with "16 und 17 angekreuzt,
// Pflichtangaben ausgefüllt, unterschrieben"; the offer is then signed and declaration 17 in force.
// Synthetic data only; the suite fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;

const ok = async (
  response: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>,
) => {
  const res = await response;
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};

const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

/** Today in Berlin as `TT.MM.JJJJ`, the date written in field 19 in this run. */
const berlinToday = () =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());

/** An informed participation of the `ta_tg` project Werk Nord with a name and an address. */
async function informedParticipation() {
  const participationId = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await activateAsOwner(owner.$client, [projectId]);
    await owner.insert(participation).values({
      id: participationId,
      projectId,
      status: "informed",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await owner.insert(participantIdentity).values({
      participationId,
      projectId,
      personnelNumber: `E2E-${participationId.slice(0, 8)}`,
      firstName: "Mira",
      lastName: "Kugel",
      birthDate: "1979-03-14",
    });
    await owner.insert(participantDetails).values({
      participationId,
      projectId,
      addressStreet: "Lindenweg 7",
      addressPostalCode: "10115",
      addressCity: "Berlin",
      addressCountry: "DE",
    });
    await owner.insert(participantProfile).values({
      participationId,
      projectId,
      maritalStatus: "married",
      revision: 1,
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/** A synthetic one-page scan of the signed paper. */
const scan = {
  name: "kug200b-unterschrieben.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<< /Title (synthetic Kug 200b scan) >>\nendobj\n%%EOF\n"),
};

test("slice 6-4b: the Kug 200b from generation to acceptance", async ({ page, baseURL }) => {
  test.slow();
  const api = page.context().request;
  const participationId = await informedParticipation();
  await staffSession(api, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=asu`);

  // 1. Generation: the checklist names what stays for the participant's hand, before printing.
  const kug = page.getByRole("region", { name: "Kug 200b" });
  await expect(kug).toContainText("Noch kein Kug 200b angeboten.");
  await kug.getByRole("button", { name: "Kug 200b erzeugen" }).click();
  await expect(page.getByText("Der Kug 200b wurde erzeugt.")).toBeVisible();
  const checklist = kug.getByTestId("kug200b-checklist");
  await expect(checklist).toContainText("Vor dem Druck");
  await expect(checklist).toContainText("11 Rentenversicherungsnummer: fehlt – von Hand eintragen");
  await expect(checklist).toContainText("10 Staatsangehörigkeit: fehlt – von Hand eintragen");
  const forms = kug.getByRole("table", { name: "Erzeugte Kug 200b" });
  await expect(forms).toContainText("09/2021");
  await expect(forms).toContainText("11 Rentenversicherungsnummer");
  await expect(kug).toContainText(`Angeboten am ${berlinToday()}`);
  await expectAccessible(page);
  await kug.screenshot({ path: test.info().outputPath("1-checklist.png") });

  // 2. "Öffnen": the logged opening, then the download.
  const download = page.waitForEvent("download");
  await forms.getByRole("button", { name: /Öffnen/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^kug200b-\d{4}-\d{2}-\d{2}\.pdf$/);

  // 3. The signed paper comes back: uploaded as printed from the generated form.
  await kug.getByLabel(/Scan auswählen/).setInputFiles(scan);
  await expect(page.getByText("Der Scan wurde hochgeladen.")).toBeVisible();
  const scans = kug.getByRole("table", { name: "Unterschriebene Kug 200b" });
  await expect(scans).toContainText("Aus der Anwendung gedruckt");
  await expect(scans).toContainText("Nicht geprüft");

  // 4. "Prüfen": the field-19 date and all three confirmations on the paper, none preselected.
  await scans.getByRole("button", { name: "Prüfen" }).click();
  const review = page.getByRole("dialog", { name: "Unterschriebenen Kug 200b prüfen" });
  const accept = review.getByRole("button", { name: "Annehmen" });
  await review.getByLabel("Datum in Feld 19 (TT.MM.JJJJ)").fill(berlinToday());
  await review.getByText("16 und 17 angekreuzt").click();
  await review.getByText("Pflichtangaben ausgefüllt").click();
  await expect(accept).toBeDisabled();
  await review.getByText("unterschrieben", { exact: true }).click();
  await expectAccessible(page);
  await review.screenshot({ path: test.info().outputPath("2-review.png") });
  await accept.click();
  await expect(page.getByText("Der Kug 200b wurde angenommen.")).toBeVisible();

  // 5. Accepted: the offer signed, declaration 17 in force since the date on the paper.
  await expect(scans).toContainText("Angenommen");
  await expect(scans).toContainText(berlinToday());
  await expect(kug.getByTestId("kug200b-outcome")).toHaveText("Unterschrieben (angenommen).");
  await expect(kug).toContainText(`Erklärt seit ${berlinToday()} (wie unterschrieben).`);
  await expect(kug.getByRole("button", { name: "Ablehnung erfassen" })).toHaveCount(0);
  await expectAccessible(page);
  await kug.screenshot({ path: test.info().outputPath("3-accepted.png") });
});
