import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  createDb,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, showColumn, test } from "./helpers";

// Closing BA reporting tasks (process-and-lifecycle.md, BA reporting; D28, Q207): a contacted
// participant of Werk Nord has two pending tasks, a later entry from two days ago and an early
// exit from today. The work list shows "BA-Meldung offen"; on the overview's "BA-Meldungen" the PL
// records the first as "Gemeldet am" and the second as "Nicht erforderlich", each confirmed in a
// dialog. The tasks are owner fixtures (the date change and the exit create them in their own
// specs). Synthetic data only; the suite fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead } = seedStaffUserIds;

const ok = async <R extends { ok(): boolean; status(): number; text(): Promise<string> }>(
  response: Promise<R>,
) => {
  const res = await response;
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
  return res;
};

const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

/** A Berlin day `offset` days from today as `TT.MM.JJJJ`. */
const berlin = (offset = 0) =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(Date.now() + offset * 86_400_000));

/** A contacted participation of Werk Nord with its two pending tasks, written as the owner. */
async function participationWithTasks() {
  const participationId = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await activateAsOwner(owner.$client, [projectId]);
    await owner.insert(participation).values({
      id: participationId,
      projectId,
      status: "contacted",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await owner.insert(participantIdentity).values({
      participationId,
      projectId,
      personnelNumber: `E2E-${participationId.slice(0, 8)}`,
      firstName: "Jonas",
      lastName: "Brinkhoff",
      birthDate: "1975-09-14",
    });
    await owner.$client.query(
      `insert into ba_reporting_task (participation_id, project_id, reporting_kind, subject_date,
         created_at)
       values ($1, $2, 'later_entry', berlin_today() + 14, now() - interval '2 days'),
              ($1, $2, 'early_exit', berlin_today() + 40, now())`,
      [participationId, projectId],
    );
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/** Carbon fades a closed dialog out; a screenshot waits until every one is transparent. */
const modalsFaded = (page: Page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll(".cds--modal")].every(
      (modal) => getComputedStyle(modal).opacity === "0",
    ),
  );

test("slice 6-6: two pending BA reports, one sent and one not required", async ({
  page,
  baseURL,
}) => {
  const api = page.context().request;
  const participationId = await participationWithTasks();
  await staffSession(api, baseURL!, projectLead);

  // 1. The work list: "BA-Meldung offen" since the older task's day, under "Agentur".
  await page.goto(`/projects/${projectId}?tab=participants&agentur=ba_report_pending`);
  await showColumn(page, "Agentur");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText(`E2E-${participationId.slice(0, 8)}`, { exact: true }) });
  await expect(row).toContainText(`BA-Meldung offen (seit ${berlin(-2)})`);
  await expectAccessible(page);
  await row
    .getByText(/^BA-Meldung offen/)
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("1-worklist.png") });

  // 2. The overview's "BA-Meldungen": both pending, each with its two actions.
  await page.goto(`/projects/${projectId}/participations/${participationId}`);
  const section = page.getByRole("region", { name: "BA-Meldungen" });
  const later = section.getByRole("row").filter({ hasText: "Späterer Eintritt" });
  const exit = section.getByRole("row").filter({ hasText: "Vorzeitiger Austritt" });
  await expect(later).toContainText("Ausstehend");
  await expect(exit).toContainText("Ausstehend");
  await expectAccessible(page);
  await section.screenshot({ path: test.info().outputPath("2-pending.png") });

  // 3. "Gemeldet am" for the later entry: the dialog names the task, the date is typed.
  await later.getByRole("button", { name: "Gemeldet am …" }).click();
  const reported = page.getByRole("dialog", { name: "Meldung als gesendet festhalten" });
  await expect(reported).toContainText("Meldung: Späterer Eintritt zum");
  await expect(reported.getByRole("button", { name: "Ergebnis übernehmen" })).toBeDisabled();
  await reported.getByLabel("Gemeldet am").fill(berlin(-1));
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("3-reported-dialog.png") });
  await reported.getByRole("button", { name: "Ergebnis übernehmen" }).click();
  await expect(reported).toBeHidden();
  await modalsFaded(page);
  await expect(later).toContainText(`Gemeldet am ${berlin(-1)}`);
  await expect(later.getByRole("button", { name: "Gemeldet am …" })).toHaveCount(0);

  // 4. "Nicht erforderlich" for the early exit, with its reason.
  await exit.getByRole("button", { name: "Nicht erforderlich …" }).click();
  const notRequired = page.getByRole("dialog", {
    name: "Meldung als nicht erforderlich festhalten",
  });
  await notRequired.getByLabel("Grund").selectOption("agentur_confirmed_not_required");
  await notRequired.getByRole("button", { name: "Ergebnis übernehmen" }).click();
  await expect(notRequired).toBeHidden();
  await modalsFaded(page);
  await expect(exit).toContainText(
    "Nicht erforderlich: Agentur hat bestätigt, dass keine Meldung nötig ist",
  );
  await expect(section.getByRole("button", { name: /…$/ })).toHaveCount(0);
  await expectAccessible(page);
  await section.screenshot({ path: test.info().outputPath("4-closed.png") });

  // Nothing is open on the work list any more.
  await page.goto(`/projects/${projectId}?tab=participants&agentur=ba_report_pending`);
  await expect(page.getByText(`E2E-${participationId.slice(0, 8)}`, { exact: true })).toHaveCount(
    0,
  );
});
