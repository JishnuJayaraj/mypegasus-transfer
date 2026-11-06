import { randomBytes, randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  createDb,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, call, pl, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, showColumn, test } from "./helpers";

// The TL 407's submission and the escalations (process-and-lifecycle.md, TL 407 submission;
// data-protection.md, the regional view; D26, D27, Q57, Q189): an informed participant of Werk Nord
// placed with its own Agentur (`beispielstadt-west`, all four settings as an Agentur-scoped setting)
// has an accepted TL 407 and a TG start 15 days ago, unsubmitted. The regional admin sees the
// escalation as a count with the PL, no name; the PL records the submission, the Agentur's
// rejection, the new submission and "Original versandt am" on "Profiling". Synthetic data only;
// the suite fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead, regionalAdmin } = seedStaffUserIds;
const agenturKey = "beispielstadt-west";
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

/** A Berlin day `offset` days from today as `TT.MM.JJJJ` and as an ISO date. */
const berlin = (offset = 0) => {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(Date.now() + offset * 86_400_000));
  const [d, m, y] = parts.split(".");
  return { display: parts, iso: `${y}-${m}-${d}` };
};

/**
 * An informed participation of Werk Nord placed with the Agentur, its TG start 15 days ago, with an
 * accepted external-paper TL 407 signed two days ago: fixtures written as the owner through the
 * functions.
 */
async function readyParticipation() {
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
      firstName: "Lene",
      lastName: "Westphal",
      birthDate: "1981-06-02",
    });
    await owner.$client.query(
      `update participation set placement_agentur_key = $2, placement_agentur_set_at = now(),
         tg_start = berlin_today() - 15, tg_end = berlin_today() + 350
       where id = $1`,
      [participationId, agenturKey],
    );
    const documentId = await call(owner.$client, "add_document", {
      context: pl,
      participationId,
      id: randomUUID(),
      type: "tl407_signed_scan",
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
      signedOn: berlin(-2).iso,
      countersignedOn: berlin(-2).iso,
      confirmations: ["signatures_present", "all_pages_present"],
      formVersion: "08-2025",
      declarations: JSON.stringify({
        kind: "as_marked",
        jobboerseChoice: "none",
        baContactConsent: false,
      }),
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/**
 * The Agentur's confirmed submission settings, all four (Q92), as the PL records them. Other specs
 * write the project's override in parallel: a stale version (409) reads it again.
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
          settings: {
            agentur_submission: {
              submissionChannel: "email",
              originalRequired: true,
              leadTimeDays: 10,
              rejectsOutdatedFormVersions: false,
            },
          },
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

/** Carbon fades a closed dialog out; a screenshot waits until every one is transparent. */
const modalsFaded = (page: Page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll(".cds--modal")].every(
      (modal) => getComputedStyle(modal).opacity === "0",
    ),
  );

test("slice 6-5b: the TL 407 from the escalation through a rejection to the original", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const api = page.context().request;
  const participationId = await readyParticipation();
  await staffSession(api, baseURL!, projectLead);
  await agenturSetting(api, baseURL!);

  // 1. The regional admin: Werk Nord with its PL and "TL 407 nicht eingereicht", no name.
  await staffSession(api, baseURL!, regionalAdmin);
  await page.goto("/projects");
  await page.getByRole("link", { name: "Eskalationen" }).click();
  const escalations = page.getByRole("table", { name: "Eskalationen" });
  const werkNord = escalations.getByRole("row", { name: /Werk Nord/ });
  await expect(werkNord).toContainText(/\d+ × \(älteste seit (heute|\d+ Tag(en)?)\)/);
  await expect(escalations).not.toContainText("Westphal");
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("1-escalations.png"), fullPage: true });

  // 2. The PL records "An Agentur übermittelt am" by the Agentur's channel.
  await staffSession(api, baseURL!, projectLead);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=profiling`);
  const section = page.getByRole("region", { name: "Übermittlung an die Agentur" });
  await expect(section).toContainText(`TL 407 08/2025 an ${agenturKey}, Weg: E-Mail.`);
  await section.getByLabel("An Agentur übermittelt am").fill(berlin(-1).display);
  await section.getByRole("button", { name: "Übermittlung an die Agentur erfassen" }).click();
  await expect(section.getByText("Gespeichert.")).toBeVisible();
  const attempts = section.getByRole("table", { name: "Übermittlungen" });
  await expect(attempts.getByRole("row")).toHaveCount(2);
  await expect(attempts).toContainText(berlin(-1).display);
  await expectAccessible(page);
  await section.screenshot({ path: test.info().outputPath("2-submitted.png") });

  // 3. "Von der Agentur abgelehnt (unvollständig)": the submission is open again.
  await section.getByRole("button", { name: "Agentur-Ablehnung eintragen" }).click();
  const rejection = page.getByRole("dialog", { name: "Von der Agentur abgelehnt" });
  await rejection.getByLabel("Abgelehnt am").fill(berlin().display);
  await rejection.getByLabel("Grund").selectOption("incomplete");
  await rejection.getByRole("button", { name: "Erfassen" }).click();
  await expect(rejection).toBeHidden();
  // Carbon fades the dialog out; the screenshot waits until it is gone.
  await modalsFaded(page);
  await expect(section.getByLabel("An Agentur übermittelt am")).toHaveValue("");
  await expect(attempts).toContainText(`am ${berlin().display} (unvollständig)`);
  await expect(section.getByLabel("An Agentur übermittelt am")).toBeVisible();
  await section.screenshot({ path: test.info().outputPath("3-rejected.png") });

  // The work list: "TL 407 eskaliert" first, the resubmission open (still unsubmitted).
  await page.goto(`/projects/${projectId}?tab=participants&agentur=tl407_resubmission_open`);
  await showColumn(page, "Agentur");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText(`E2E-${participationId.slice(0, 8)}`, { exact: true }) });
  await expect(row).toContainText(agenturKey);
  await expect(row).toContainText("TL 407 eskaliert");
  await expectAccessible(page);
  // A long tag carries a tooltip with its text as well.
  await row
    .getByText(/^TL 407 eskaliert \(seit/)
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("4-worklist.png") });

  // 4. The new submission, then "Original versandt am": nothing is open any more.
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=profiling`);
  await section.getByLabel("An Agentur übermittelt am").fill(berlin().display);
  await section.getByRole("button", { name: "Übermittlung an die Agentur erfassen" }).click();
  await expect(attempts.getByRole("row")).toHaveCount(3);
  await section.getByRole("button", { name: "Original versandt" }).click();
  const original = page.getByRole("dialog", { name: "Original versandt am" });
  await original.getByLabel("Original versandt am").fill(berlin().display);
  await original.getByRole("button", { name: "Erfassen" }).click();
  await expect(original).toBeHidden();
  await modalsFaded(page);
  await expect(section.getByRole("button", { name: "Original versandt" })).toHaveCount(0);
  await expect(attempts.getByRole("row").nth(1)).toContainText(berlin().display);
  await expectAccessible(page);
  await section.screenshot({ path: test.info().outputPath("5-original.png") });
});
