import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  createDb,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// The tab "Profiling" (process-and-lifecycle.md and data-protection.md, the profiling record):
// the assigned consultant agrees the track, records a session, the pending declarations and
// section C with the health line's rating only; the PL then sees the status and the sessions,
// never the profiler's blocks. Synthetic data only; the suite fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead, consultant } = seedStaffUserIds;

const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

/** A staff user's dev session in the browser context (the dev switcher's route). */
const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

/** An informed participation of Werk Nord, as the import and an info event leave it. */
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
      firstName: "Paul",
      lastName: "Profil",
      birthDate: "1975-05-05",
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

test("slice 6-2: the profiler's tab, then the PL's view of it", async ({ page, baseURL }) => {
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

  // 1. The assigned consultant agrees the track and starts it.
  await staffSession(api, baseURL!, consultant);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=profiling`);
  await expect(page.getByRole("heading", { name: "Profiling-Status" })).toBeVisible();
  await page.getByRole("button", { name: "Teilnahme zugestimmt" }).click();
  await page.getByRole("button", { name: "Profiling begonnen" }).click();
  const status = page.getByRole("region", { name: "Profiling-Status" });
  await expect(status).toContainText("In Arbeit");

  // 2. A session, written whole.
  await page.getByRole("button", { name: "Termin hinzufügen" }).click();
  const row = page.getByRole("group", { name: "Termin 1" });
  await row.getByLabel("Datum").fill("20.10.2026");
  await row.getByLabel("von").fill("09:00");
  await row.getByLabel("bis").fill("10:30");
  await page.getByRole("button", { name: "Termine speichern" }).click();
  await expect(page.getByText("Die Termine wurden gespeichert.")).toBeVisible();

  // 3. The pending declarations to the BA.
  await page
    .getByLabel("Veröffentlichung in der Jobbörse (Feld 50)")
    .selectOption("anonymous_callme");
  await page
    .getByRole("group", { name: /Kontaktaufnahme durch die BA/ })
    .getByText("nein", { exact: true })
    .click();
  await page.getByRole("button", { name: "Erklärungen speichern" }).click();
  await expect(page.getByText("Die Erklärungen wurden gespeichert.")).toBeVisible();

  // 4. Section C on "Anzeigen": a rating and a text, the health line's rating only.
  const assessment = page.getByRole("region", { name: "Handlungsbedarf (Abschnitt C)" });
  await assessment.getByRole("button", { name: /Anzeigen/ }).click();
  const school = assessment.getByRole("group", { name: "Schulische Qualifikation" });
  await school.getByText("vermittlungsrelevant", { exact: true }).click();
  await assessment
    .getByLabel("Schulische Qualifikation: Handlungsbedarf (Text)")
    .fill("Hauptschulabschluss nachholen");
  await assessment
    .getByRole("group", { name: "Vermittlungsrelevante gesundheitliche Einschränkungen" })
    .getByText("kein", { exact: true })
    .click();
  await assessment.getByLabel("Weiteres Vorgehen").fill("Bewerbungstraining, dann Vermittlung");
  await assessment.getByRole("button", { name: "Einschätzung speichern" }).click();
  await expect(page.getByText("Die Einschätzung wurde gespeichert.")).toBeVisible();
  await expect(assessment).toContainText("3 von 16 Angaben erfasst");
  await expectAccessible(page);
  await assessment.screenshot({ path: test.info().outputPath("2-section-c.png") });
  await assessment.getByRole("button", { name: /Ausblenden/ }).click();
  await page.screenshot({ path: test.info().outputPath("1-profiler.png"), fullPage: true });

  // 5. The PL sees the status and the sessions, not section C, the period or the declarations.
  await staffSession(api, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=profiling`);
  await expect(page.getByRole("table", { name: "Termine des Profilings" })).toContainText(
    "20.10.2026",
  );
  await expect(page.getByRole("heading", { name: "Handlungsbedarf (Abschnitt C)" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Arbeitslos seit / bis" })).toHaveCount(0);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("3-project-lead.png"), fullPage: true });
});
