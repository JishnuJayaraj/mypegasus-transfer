import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  createDb,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// The tab "Arbeitsuche" (process-and-lifecycle.md, Arbeitsuchendmeldung and dates;
// data-protection.md, the ASU record): the PL records the knowledge date (after correcting an
// impossible one) and sees the statutory due date, chooses the route, records the registration
// with its date; the assigned consultant uploads the BA confirmation, accepts it and links it as
// the proof, after which the registration counts with proof and the due date is gone. Synthetic
// data only; the suite fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead, consultant } = seedStaffUserIds;

const ok = async (
  response: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>,
) => {
  const res = await response;
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};

const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

/** Today in Berlin as `TT.MM.JJJJ`, the actual registration date of this run. */
const berlinToday = () =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());

/** An informed participation of the `ta_tg` project Werk Nord, its end of employment known. */
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
      firstName: "Jonas",
      lastName: "Meldung",
      birthDate: "1980-05-20",
    });
    await owner.insert(participantDetails).values({
      participationId,
      projectId,
      oldEmploymentEndDate: "2091-06-30",
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/** A synthetic one-page BA confirmation. */
const confirmation = {
  name: "ba-bestaetigung.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /Title (synthetic BA confirmation) >>\nendobj\n%%EOF\n",
  ),
};

test("slice 6-4a: a registration with proof on the tab Arbeitsuche", async ({ page, baseURL }) => {
  test.slow();
  const api = page.context().request;
  const participationId = await informedParticipation();
  await staffSession(api, baseURL!, projectLead);
  await ok(
    api.post(`/api/v1/projects/${projectId}/assignments`, {
      headers: { Origin: baseURL! },
      data: { staffUserId: consultant, participationIds: [participationId] },
    }),
  );
  const tab = `/projects/${projectId}/participations/${participationId}?tab=asu`;

  // 1. The PL: without a knowledge date only an orientation, never overdue.
  await page.goto(tab);
  const knowledge = page.getByRole("region", { name: "Kenntnisdatum und Frist" });
  await expect(knowledge).toContainText("Orientierung 30.03.2091 – Kenntnisdatum klären");

  // 2. An impossible date is refused, then corrected: due on the reference date.
  await knowledge.getByLabel("Kenntnisdatum (TT.MM.JJJJ)").fill("31.02.2026");
  await knowledge.getByRole("button", { name: "Kenntnisdatum speichern" }).click();
  await expect(knowledge).toContainText("Bitte ein gültiges Datum im Format TT.MM.JJJJ eingeben.");
  await knowledge.getByLabel("Kenntnisdatum (TT.MM.JJJJ)").fill("15.01.2026");
  await knowledge.getByRole("button", { name: "Kenntnisdatum speichern" }).click();
  await expect(knowledge).toContainText("Fällig am 30.03.2091 (drei Monate vor dem Austritt)");

  // 3. The route, then the registration with its actual date; the proof follows.
  const route = page.getByRole("region", { name: "Weg der Arbeitsuchendmeldung" });
  await route.getByLabel("Weg").selectOption("online_self");
  await route.getByRole("button", { name: "Weg speichern" }).click();
  await expect(route).toContainText("Selbst online gemeldet");
  const registration = page.getByRole("region", { name: "Meldung", exact: true });
  await registration.getByLabel("Datum der Meldung (TT.MM.JJJJ)").fill(berlinToday());
  await registration.getByRole("button", { name: "Meldung speichern" }).click();
  await expect(registration).toContainText(`Gemeldet am ${berlinToday()}`);
  await expect(registration).toContainText("Nachweis fehlt");
  await expect(
    page.getByRole("region", { name: "Für die Arbeitsuchendmeldung fehlt" }),
  ).toContainText("eine Meldung mit Nachweis");
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("1-registered.png"), fullPage: true });

  // 4. The assigned consultant: the BA confirmation uploaded, accepted and linked.
  await staffSession(api, baseURL!, consultant);
  await page.goto(tab);
  const proofs = page.getByRole("region", { name: "BA-Bestätigungen" });
  await proofs.getByLabel(/BA-Bestätigung hochladen/).setInputFiles(confirmation);
  await expect(page.getByText("Die BA-Bestätigung wurde hochgeladen.")).toBeVisible();
  await proofs.getByRole("button", { name: "Annehmen" }).click();
  await expect(proofs).toContainText("angenommen");
  await proofs.getByRole("button", { name: "Als Nachweis verknüpfen" }).click();
  await expect(proofs).toContainText("verknüpft");
  await expect(page.getByRole("region", { name: "Meldung", exact: true })).toContainText(
    "Nachweis: BA-Bestätigung",
  );
  await expect(page.getByRole("region", { name: "Meldung", exact: true })).toContainText(
    "Mit Nachweis erfasst am",
  );

  // 5. The PL again: registered with proof, nothing missing, no due date left.
  await staffSession(api, baseURL!, projectLead);
  await page.goto(tab);
  await expect(page.getByRole("region", { name: "Kenntnisdatum und Frist" })).toContainText(
    "Keine Frist offen.",
  );
  await expect(
    page.getByRole("region", { name: "Für die Arbeitsuchendmeldung fehlt" }),
  ).toContainText("Für die Arbeitsuchendmeldung fehlt nichts.");
  // The PL sees the confirmation's metadata, never an "Öffnen"; nothing is left to upload.
  const proofsForLead = page.getByRole("region", { name: "BA-Bestätigungen" });
  await expect(proofsForLead).toContainText("angenommen – verknüpft");
  await expect(proofsForLead.getByRole("button", { name: "Öffnen" })).toHaveCount(0);
  await expect(proofsForLead.getByText("BA-Bestätigung hochladen")).toHaveCount(0);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("2-with-proof.png"), fullPage: true });
});
