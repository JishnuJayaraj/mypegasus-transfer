import { randomBytes, randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  createDb,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, call, pl, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// The project tab "Agentur" (process-and-lifecycle.md, Kug 200b batches; data-protection.md,
// exports; D24, D25, Q203): the Agentur confirmed its batch channel (an Agentur-scoped setting),
// two participants on the route Kug 200b have accepted Kug 200b scans; the PL builds the batch,
// downloads its work list (logged, re-authorized, nothing stored), records "Übermittelt am", and
// on "Arbeitsuche" the registration proven by the submission and "Bestätigung der Agentur am".
// Synthetic data only; the suite fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;
const agenturKey = "beispielstadt-ost";
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");

const ok = async <R extends { ok(): boolean; status(): number; text(): Promise<string> }>(
  response: Promise<R>,
) => {
  const res = await response;
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
  return res;
};

const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

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
 * An informed participation of Werk Nord placed with the Agentur, on the route Kug 200b, with an
 * accepted external-paper Kug 200b scan: fixtures written as the owner through the functions.
 */
async function readyParticipation(lastName: string) {
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
      lastName,
      birthDate: "1979-03-14",
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
    const documentId = await call(owner.$client, "add_document", {
      context: pl,
      participationId,
      id: randomUUID(),
      type: "kug200b_signed_scan",
      mediaType: "application/pdf",
      sizeBytes: 4096,
      contentSha256: hex(),
      fileName: null,
      keyId: hex(8),
      wrappedKey: randomBytes(60),
      scanOrigin: "external_paper",
      generationDocumentId: null,
    });
    await call(owner.$client, "review_document", {
      context: pl,
      documentId,
      decision: "accepted",
      reason: null,
      signedOn: berlin().iso,
      countersignedOn: null,
      confirmations: ["declarations_ticked", "mandatory_completed", "signature_present"],
      formVersion: "09-2021",
      declarations: null,
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/** The Agentur's confirmed batch channel, as the PL records it (an Agentur-scoped setting). */
async function agenturSetting(api: APIRequestContext, baseURL: string) {
  const config = (await (await ok(api.get(`/api/v1/projects/${projectId}/config`))).json()) as {
    override: { version: number };
  };
  // A retry finds the setting already recorded (`override_unchanged`).
  const res = await api.put(`/api/v1/projects/${projectId}/config/agentur-settings/${agenturKey}`, {
    headers: { Origin: baseURL },
    data: {
      expectedVersion: config.override.version,
      settings: { asu_registration: { batchSubmissionChannel: "scan_email" } },
      source: "email_agentur",
      confirmedOn: berlin().iso,
    },
  });
  expect([200, 422]).toContain(res.status());
}

test("slice 6-5a-1: a Kug 200b batch from building to the Agentur's confirmation", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const api = page.context().request;
  const first = await readyParticipation("Albers");
  await readyParticipation("Zander");
  await staffSession(api, baseURL!, projectLead);
  await agenturSetting(api, baseURL!);
  await page.goto(`/projects/${projectId}?tab=agentur`);

  // 1. The Agentur: its channel, the Kug 200a as the artifact, the ready scans.
  const agentur = page.getByRole("region", { name: agenturKey });
  await expect(agentur).toContainText("Übermittlungsweg Kug 200b: Scan per E-Mail");
  await expect(agentur.getByTestId("agentur-artifact")).toHaveText(
    "Vorblatt: Kug 200a (amtlicher Vordruck)",
  );
  await expect(agentur).toContainText("Albers, Mira");
  await expect(agentur).toContainText("Zander, Mira");
  await expectAccessible(page);
  await agentur.screenshot({ path: test.info().outputPath("1-ready.png") });

  // 2. "Sammelmeldung bilden": the batch takes both; the work list downloads as a CSV.
  await agentur.getByRole("button", { name: "Sammelmeldung bilden" }).click();
  await expect(page.getByText("Sammelmeldung gebildet.")).toBeVisible();
  const batch = page.getByRole("region", { name: new RegExp(`^${agenturKey} – gebildet`) }).first();
  await expect(batch).toContainText("Offen");
  await expect(batch).toContainText("Scan per E-Mail · Vorblatt Kug 200a · 2 Personen");
  const download = page.waitForEvent("download");
  await batch.getByRole("button", { name: "Arbeitsliste (CSV)" }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^kug200b-arbeitsliste-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  await expectAccessible(page);
  await batch.screenshot({ path: test.info().outputPath("2-batch.png") });

  // 3. "Übermittelt am": the actual sent date; the batch is submitted.
  await batch.getByLabel("Übermittelt am").fill(berlin().display);
  await batch.getByRole("button", { name: "Übermittlung erfassen" }).click();
  await expect(page.getByText("Übermittlung erfasst.")).toBeVisible();
  await expect(batch).toContainText("Übermittelt");
  await expect(batch).toContainText(`Übermittelt am ${berlin().display}`);
  await expect(batch.getByRole("button", { name: "Verwerfen" })).toHaveCount(0);
  await batch.screenshot({ path: test.info().outputPath("3-submitted.png") });

  // 4. "Arbeitsuche": the registration proven by the submission; the Agentur's confirmation.
  await page.goto(`/projects/${projectId}/participations/${first}?tab=asu`);
  const registration = page.getByRole("region", { name: "Meldung", exact: true });
  await expect(registration).toContainText("Nachweis: Kug 200b-Sammelmeldung");
  await registration.getByLabel("Bestätigung der Agentur am").fill(berlin().display);
  await registration.getByRole("button", { name: "Bestätigung erfassen" }).click();
  await expect(registration).toContainText(`Bestätigung der Agentur am ${berlin().display}`);
  await expectAccessible(page);
  await registration.screenshot({ path: test.info().outputPath("4-confirmed.png") });
});
