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

// The TL 407 on the tab "Profiling" (data-protection.md, generated forms and the readiness
// projection): the assigned consultant completes section B with the participant in assisted mode,
// records a session, the unemployment period and the declarations, checks the readiness, confirms
// "no school qualification" and generates the form; it opens through the logged opening. The PL
// then sees the summary and the generated form. Synthetic data only; the suite fails on any CSP
// violation. The signed scan, its review and `profiling_done` follow with the scans.

const projectId = seedProjectIds.verwaltung;
const { projectLead, consultant } = seedStaffUserIds;

const ok = async (
  response: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>,
) => {
  const res = await response;
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
};

const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

/** An informed participation of the `ta_only` project Verwaltung. */
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
      firstName: "Tamara",
      lastName: "Bogen",
      birthDate: "1972-03-14",
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/** Section B with the participant present, through the assisted mode's routes. */
async function completeSectionB(api: APIRequestContext, baseURL: string, participationId: string) {
  const headers = { Origin: baseURL };
  const base = `/api/v1/participations/${participationId}`;
  const started = await api.post(`${base}/assisted-mode`, {
    headers,
    data: { confirmed: true, how: "in_person" },
  });
  expect(started.ok()).toBe(true);
  const { assistedModeId } = (await started.json()) as { assistedModeId: string };
  const query = `?assistedModeId=${assistedModeId}`;
  await ok(
    api.post(`${base}/assisted/self-service/notice${query}`, {
      headers,
      data: { version: "self-service-purposes:v1", language: "de" },
    }),
  );
  const revision = async () =>
    (
      (await (await api.get(`${base}/assisted/self-service${query}`)).json()) as {
        revision: number;
      }
    ).revision;
  const save = async (kind: "pages" | "sensitive", page: string, values: object) =>
    ok(
      api.put(`${base}/assisted/self-service/${kind}/${page}${query}`, {
        headers,
        data: { revision: await revision(), values },
      }),
    );
  await save("pages", "personal", { gender: "female", maritalStatus: "single" });
  await save("pages", "contact", {
    address: { street: "Lindenweg 4", postalCode: "10115", city: "Berlin", country: "DE" },
    phone: null,
    mobile: "0171 3920000",
    privateEmail: null,
  });
  await save("sensitive", "ba_details", {
    pensionInsuranceNumber: "12140372B008",
    nationality: { kind: "german" },
    entryToGermanyDate: null,
    residenceStatus: null,
    buergergeld: false,
  });
  // A school row that isn't marked as the highest school qualification: the profiler clarifies.
  await save("pages", "education", {
    educationHistory: [
      {
        from: "1978-08-01",
        to: "1988-07-15",
        institution: "Gesamtschule Nord",
        qualification: "ohne Abschluss",
        completed: false,
      },
    ],
  });
  await save("pages", "work_history", {
    workHistory: [
      {
        from: "2010-04-01",
        to: null,
        employer: "Beispiel Verwaltung GmbH",
        activity: "Sachbearbeitung",
      },
    ],
  });
  await save("pages", "languages_mobility", {
    languageSkills: { german: "business_fluent", others: [] },
    drivingLicence: ["B"],
    vehicleAvailable: true,
  });
  await save("pages", "job_wish", {
    workingTimePreferences: {
      employmentType: "full_time",
      weeklyHours: null,
      distribution: "Tagschicht",
    },
    jobWishes: { desired: "Sachbearbeitung", alternative: null },
    desiredWorkLocations: "Berlin",
    maxCommuteDistance: { kind: "km", km: 25 },
    earliestStartDate: "2027-01-01",
  });
  await save("sensitive", "health", { healthRestrictions: false, severeDisability: false });
  await ok(api.delete(`${base}/assisted-mode${query}`, { headers }));
}

test("slice 6-3a: the profiler generates the TL 407, the PL sees the summary", async ({
  page,
  baseURL,
}) => {
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

  // 1. The assigned consultant: section B with the participant, then the tab.
  await staffSession(api, baseURL!, consultant);
  await completeSectionB(api, baseURL!, participationId);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=profiling`);
  await page.getByRole("button", { name: "Teilnahme zugestimmt" }).click();
  await page.getByRole("button", { name: "Profiling begonnen" }).click();
  await expect(page.getByRole("region", { name: "Profiling-Status" })).toContainText("In Arbeit");

  // 2. A session, the unemployment period and the declarations to the BA.
  await page.getByRole("button", { name: "Termin hinzufügen" }).click();
  const row = page.getByRole("group", { name: "Termin 1" });
  await row.getByLabel("Datum").fill("20.10.2026");
  await row.getByLabel("von").fill("09:00");
  await row.getByLabel("bis").fill("10:30");
  await page.getByRole("button", { name: "Termine speichern" }).click();
  await expect(page.getByText("Die Termine wurden gespeichert.")).toBeVisible();
  const period = page.getByRole("region", { name: "Arbeitslos seit / bis" });
  await period.getByRole("button", { name: /Anzeigen/ }).click();
  await period.getByRole("textbox", { name: "Arbeitslos seit" }).fill("01.07.2026");
  await period.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert.", { exact: true })).toBeVisible();
  await page.getByLabel("Veröffentlichung in der Jobbörse (Feld 50)").selectOption("full");
  await page
    .getByRole("group", { name: /Kontaktaufnahme durch die BA/ })
    .getByText("nein", { exact: true })
    .click();
  await page.getByRole("button", { name: "Erklärungen speichern" }).click();
  await expect(page.getByText("Die Erklärungen wurden gespeichert.")).toBeVisible();

  // 3. The readiness on "Prüfen", the explicit "no school qualification", the generation.
  const tl407 = page.getByRole("region", { name: "Profilingbogen (TL 407)" });
  await tl407.getByRole("button", { name: "Prüfen" }).click();
  await expect(tl407).toContainText("Der Bogen (Fassung 08/2025) kann erzeugt werden.");
  const generate = tl407.getByRole("button", { name: "Erzeugen" });
  await expect(generate).toBeDisabled();
  await tl407.getByText(/Kein Schulabschluss: mit der teilnehmenden Person geklärt/).click();
  await expectAccessible(page);
  await tl407.screenshot({ path: test.info().outputPath("1-readiness.png") });
  await generate.click();
  await expect(page.getByText("Profilingbogen erzeugt.")).toBeVisible();
  const forms = tl407.getByRole("table", { name: "Erzeugte Bögen" });
  await expect(forms).toContainText("08/2025");
  await expect(forms).toContainText("aktuell");

  // 4. "Öffnen": a logged opening, then the download.
  const download = page.waitForEvent("download");
  await forms.getByRole("button", { name: /Öffnen/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^tl407-\d{4}-\d{2}-\d{2}\.pdf$/);
  await tl407.screenshot({ path: test.info().outputPath("2-generated.png") });

  // 5. The PL: the summary from presence and the generated form, never the profiler's check.
  await staffSession(api, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=profiling`);
  const lead = page.getByRole("region", { name: "Profilingbogen (TL 407)" });
  await expect(lead).toContainText("Aus Ihrer Sicht fehlt keine Pflichtangabe.");
  await expect(lead.getByRole("button", { name: "Prüfen" })).toHaveCount(0);
  await expect(lead.getByRole("button", { name: /erzeugen/i })).toHaveCount(0);
  await expect(lead.getByRole("table", { name: "Erzeugte Bögen" })).toContainText("08/2025");
  await expectAccessible(page);
  await lead.screenshot({ path: test.info().outputPath("3-project-lead.png") });
});
