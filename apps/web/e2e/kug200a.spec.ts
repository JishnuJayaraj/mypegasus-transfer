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
import { activateAsOwner, call, pl, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// A Kug 200b batch's official artifact (ba-forms.md, the Kug 200a as built; data-protection.md,
// exports; Q197, Q203 (6), Q205): the PL records the Kug 200a's header on "Einrichtung", builds a
// batch on the tab "Agentur", reads the handwriting checklist before printing, downloads the
// Kug 200a (the RV-Nummern read, audited, nothing stored) and the members' scans as one PDF, then
// discards the batch. Synthetic data only; the suite fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;
// An Agentur of its own: "Sammelmeldung bilden" takes all its ready scans, and specs run in parallel.
const agenturKey = "beispielstadt-west";
/** A synthetic one-pixel scan (PNG), turned into an A4 page in the scans PDF. */
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ok = async <R extends { ok(): boolean; status(): number; text(): Promise<string> }>(
  response: Promise<R>,
) => {
  const res = await response;
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
  return res;
};

/** Today in Berlin as `TT.MM.JJJJ` and as an ISO date. */
const berlin = () => {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());
  const [d, m, y] = parts.split(".");
  return { display: parts, iso: `${y}-${m}-${d}` };
};

/**
 * An informed participation of Werk Nord with a name and an address, placed with the Agentur on
 * the route Kug 200b (fixtures written as the owner through the functions).
 */
async function placedParticipation(lastName: string) {
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
      firstName: "Łucja",
      lastName,
      birthDate: "1979-03-14",
    });
    await owner.insert(participantDetails).values({
      participationId,
      projectId,
      addressStreet: "Großer Weg 7",
      addressPostalCode: "10115",
      addressCity: "Berlin",
      addressCountry: "DE",
    });
    await owner.$client.query(
      `update participation set placement_agentur_key = $2, placement_agentur_set_at = now()
       where id = $1`,
      [participationId, agenturKey],
    );
    await call(owner.$client, "set_asu_route", {
      context: pl,
      participationId,
      channel: "kug_200b",
      version: 0,
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/** The PL uploads the signed Kug 200b (external paper) and accepts it, through the API. */
async function acceptedScan(api: APIRequestContext, baseURL: string, participationId: string) {
  const headers = { Origin: baseURL };
  const uploaded = await ok(
    api.post(`/api/v1/participations/${participationId}/documents`, {
      headers,
      data: {
        type: "kug200b_signed_scan",
        fileName: "kug200b-unterschrieben.png",
        content: png,
        origin: "external_paper",
      },
    }),
  );
  const { id } = (await uploaded.json()) as { id: string };
  await ok(
    api.post(`/api/v1/participations/${participationId}/documents/${id}/review`, {
      headers,
      data: {
        decision: "accepted",
        kug200bScan: {
          signedOn: berlin().iso,
          confirmations: ["declarations_ticked", "mandatory_completed", "signature_present"],
          formVersion: "09-2021",
        },
      },
    }),
  );
}

/**
 * The Agentur's confirmed batch channel, as the PL records it (an Agentur-scoped setting). Other
 * specs write the project's override in parallel: a stale version (409) reads it again.
 */
async function agenturSetting(api: APIRequestContext, baseURL: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const config = (await (await ok(api.get(`/api/v1/projects/${projectId}/config`))).json()) as {
      override: { version: number };
    };
    // A retry finds the setting already recorded (`override_unchanged`).
    const res = await api.put(
      `/api/v1/projects/${projectId}/config/agentur-settings/${agenturKey}`,
      {
        headers: { Origin: baseURL },
        data: {
          expectedVersion: config.override.version,
          settings: { asu_registration: { batchSubmissionChannel: "scan_email" } },
          source: "email_agentur",
          confirmedOn: berlin().iso,
        },
      },
    );
    if (res.status() !== 409) {
      expect([200, 422]).toContain(res.status());
      return;
    }
  }
  throw new Error("The project's override kept changing");
}

test("slice 6-5a-2: a batch's Kug 200a and scans, with the checklist before printing", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const api = page.context().request;
  await ok(
    api.post("/api/v1/dev/session", {
      headers: { Origin: baseURL! },
      data: { staffUserId: projectLead },
    }),
  );
  for (const lastName of ["Doğan-Großmann", "Yılmaz"]) {
    await acceptedScan(api, baseURL!, await placedParticipation(lastName));
  }
  await agenturSetting(api, baseURL!);

  // 1. "Einrichtung": the header the Kug 200a prints; the employer's numbers stay open for now.
  await page.goto(`/projects/${projectId}?tab=setup`);
  const header = page.getByRole("region", { name: "Kopf der Kug 200a" });
  await header.getByLabel("T-Kug-Nummer").fill("TK-123");
  await header.getByRole("button", { name: "Angaben übernehmen" }).click();
  await expect(header).toContainText("Ohne „TK-“ eingeben: das Formular druckt es schon.");
  await header.getByLabel("T-Kug-Nummer").fill("123-456-7890");
  await header.getByRole("button", { name: "Angaben übernehmen" }).click();
  await expect(header).toContainText("Gespeichert.");
  await expectAccessible(page);
  await header.screenshot({ path: test.info().outputPath("1-header.png") });

  // 2. "Agentur": the batch, its checklist before printing and the two downloads.
  await page.goto(`/projects/${projectId}?tab=agentur`);
  const agentur = page.getByRole("region", { name: agenturKey });
  await expect(agentur).toContainText("Doğan-Großmann, Łucja");
  await agentur.getByRole("button", { name: "Sammelmeldung bilden" }).click();
  await expect(page.getByText("Sammelmeldung gebildet.")).toBeVisible();
  const batch = page.getByRole("region", { name: new RegExp(`^${agenturKey} – gebildet`) }).first();
  await expect(batch).toContainText("Offen");
  const checklist = batch.getByTestId("kug200a-checklist");
  await expect(checklist).toContainText("Vor dem Druck der Kug 200a von Hand ergänzen");
  await expect(checklist).toContainText(
    "Betriebsnummer des personalabgebenden Betriebes: nicht erfasst",
  );
  await expect(checklist).toContainText(
    "Zuletzt ausgeübte Tätigkeit beim Arbeitgeber: aus den Daten nicht eindeutig – bei allen 2 Personen",
  );
  await expect(checklist).not.toContainText("T-Kug-Nummer");
  await expectAccessible(page);
  await batch.screenshot({ path: test.info().outputPath("2-checklist.png") });

  const kug200a = page.waitForEvent("download");
  await batch.getByRole("button", { name: "Kug 200a (PDF)" }).click();
  expect((await kug200a).suggestedFilename()).toMatch(/^kug200a-\d{4}-\d{2}-\d{2}\.pdf$/);
  const scans = page.waitForEvent("download");
  await batch.getByRole("button", { name: "Scans (PDF)" }).click();
  expect((await scans).suggestedFilename()).toMatch(/^kug200b-scans-\d{4}-\d{2}-\d{2}\.pdf$/);
  await expect(page.getByText("Die Scans werden heruntergeladen.")).toBeVisible();
  await batch.screenshot({ path: test.info().outputPath("3-downloaded.png") });

  // 3. The batch goes no further here: discarded, its members free again.
  await batch.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.getByText("Sammelmeldung verworfen.")).toBeVisible();
});
