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
import { expect, expectAccessible, openCard, test } from "./helpers";

// A profiling exception with evidence (process-and-lifecycle.md, profiling exceptions;
// data-protection.md, exception evidence; D30, Q194): an informed participant of Werk Nord whose
// TG starts in 60 days can't be profiled in time. The PL uploads the evidence on the tab
// "Profiling" (never opening it), the assigned consultant reviews and accepts it on "Unterlagen",
// the PL requests the exception on the reviewed document, and the regional operations manager
// approves it from "Freigaben", which shows no name and no evidence. The participation is an owner
// fixture of its own (the seed's participants stay untouched). Synthetic data only; the suite
// fails on any CSP violation.

const projectId = seedProjectIds.werkNord;
const { projectLead, consultant, regionalOperationsManager } = seedStaffUserIds;

const ok = async <R extends { ok(): boolean; status(): number; text(): Promise<string> }>(
  response: Promise<R>,
) => {
  const res = await response;
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
  return res;
};

const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

/** Today in Berlin as `TT.MM.JJJJ`. */
const berlinToday = () =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());

/** An informed participation of Werk Nord with its TG start in 60 days, as the owner writes it. */
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
    await owner.$client.query(
      `update participation set tg_start = berlin_today() + 60, tg_end = berlin_today() + 425
       where id = $1`,
      [participationId],
    );
    await owner.insert(participantIdentity).values({
      participationId,
      projectId,
      personnelNumber: `E2E-${participationId.slice(0, 8)}`,
      firstName: "Mira",
      lastName: "Ausnahmefall",
      birthDate: "1979-03-08",
    });
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/** A synthetic one-page certificate. */
const certificate = {
  name: "bescheinigung.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Title (synthetic exception evidence ${randomUUID()}) >>\nendobj\n%%EOF\n`,
  ),
};

/** Carbon fades a closed dialog out; a screenshot waits until every one is transparent. */
const modalsFaded = (page: Page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll(".cds--modal")].every(
      (modal) => getComputedStyle(modal).opacity === "0",
    ),
  );

test("slice 6-7: a profiling exception on reviewed evidence, approved in Freigaben", async ({
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
  const tab = `/projects/${projectId}/participations/${participationId}?tab=profiling`;

  // 1. The PL uploads the evidence: listed by date and state, never with "Öffnen".
  await page.goto(tab);
  await openCard(page, "Ausnahme vom Profiling");
  const section = page.getByRole("region", { name: "Ausnahme vom Profiling" });
  await expect(section).toContainText("Keine Ausnahme beantragt.");
  await section.getByLabel("Nachweis hochladen").setInputFiles(certificate);
  await expect(section).toContainText("noch nicht geprüft");
  await expect(section.getByRole("button", { name: /Öffnen/ })).toHaveCount(0);
  await expectAccessible(page);
  await section.screenshot({ path: test.info().outputPath("1-uploaded.png") });

  // 2. The assigned consultant reviews and accepts it on "Unterlagen".
  await staffSession(api, baseURL!, consultant);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=documents`);
  await page.getByRole("button", { name: "Nachweis zur Ausnahme vom Profiling annehmen" }).click();
  await expect(page.getByText("Nachweis zur Ausnahme vom Profiling").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nachweis zur Ausnahme vom Profiling annehmen" }),
  ).toHaveCount(0);

  // 3. The PL requests the exception: the reason and the reviewed document, chosen explicitly.
  await staffSession(api, baseURL!, projectLead);
  await page.goto(tab);
  await openCard(page, "Ausnahme vom Profiling");
  await expect(section).toContainText("geprüft und angenommen");
  await section.getByRole("button", { name: "Ausnahme beantragen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Ausnahme vom Profiling beantragen" });
  await expect(dialog.getByRole("button", { name: "Beantragen", exact: true })).toBeDisabled();
  await dialog.getByLabel("Grund").selectOption("participant_prevented_documented");
  await dialog.getByText("Geprüfte Unterlagen (1 angenommen)").click();
  await dialog.getByText(/^Nachweis vom /).click();
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("2-request-dialog.png") });
  await dialog.getByRole("button", { name: "Beantragen", exact: true }).click();
  await expect(dialog).toBeHidden();
  await modalsFaded(page);
  await expect(section).toContainText("Beantragt");
  await expect(section).toContainText("Teilnahme nachweislich verhindert");
  await expect(section).toContainText("Geprüfte Unterlagen");

  // 4. The regional operations manager: "Freigaben" without a name or the evidence itself.
  await staffSession(api, baseURL!, regionalOperationsManager);
  await page.goto("/reviews");
  const row = page
    .getByRole("row")
    .filter({ hasText: "Teilnahme nachweislich verhindert" })
    .filter({ hasText: berlinToday() });
  await expect(row).toContainText("Restrukturierung Werk Nord");
  await expect(row).toContainText("Nachweis vorhanden (Geprüfte Unterlagen)");
  await expect(page.getByText("Ausnahmefall")).toHaveCount(0);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("3-freigaben.png") });
  await row.getByRole("button", { name: /^Genehmigen: / }).click();
  const approve = page.getByRole("dialog", { name: "Ausnahme genehmigen" });
  await approve.getByRole("button", { name: "Genehmigen", exact: true }).click();
  await expect(approve).toBeHidden();
  await expect(page.getByText("Ausnahme genehmigt.")).toBeVisible();
  await expect(row).toHaveCount(0);

  // 5. The PL sees the approval and may still revoke it before entry.
  await staffSession(api, baseURL!, projectLead);
  await page.goto(tab);
  await openCard(page, "Ausnahme vom Profiling");
  await expect(section).toContainText("Genehmigt");
  await expect(section).toContainText(`Entschieden am${berlinToday()}`);
  await expect(section.getByRole("button", { name: "Widerrufen", exact: true })).toBeVisible();
  await expectAccessible(page);
  await section.screenshot({ path: test.info().outputPath("4-approved.png") });
});
