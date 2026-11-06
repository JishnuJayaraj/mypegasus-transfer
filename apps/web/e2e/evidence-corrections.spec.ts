import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  createDb,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, auditContext, call, testDatabaseUrls } from "@transfer/db/testing";
import { expect, expectAccessible, test } from "./helpers";

// An approved correction of wrong evidence (data-protection.md, evidence corrections; D29, Q183):
// a BA confirmation of another person was accepted on an informed participant of Werk Nord. The PL
// requests its correction on "Unterlagen" ("Datei einer anderen Person", a reason and the
// documented source, nothing preset); the regional operations manager approves it from
// "Freigaben", which names the document's type, the reason, the source and the dates, never a
// name; the file is purged, the history stays, and the work list shows "Nachweis ungültig" while
// the status stays. The participation and its document are owner fixtures of their own (the
// seed's participants stay untouched). Synthetic data only; the suite fails on any CSP violation.

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

/**
 * An informed participation of Werk Nord assigned to the consultant, with a BA confirmation the
 * consultant added and accepted (its metadata only: no file is opened here); its ids.
 */
async function participationWithProof() {
  const participationId = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  const pl = auditContext({ actorType: "user", staffUserId: projectLead });
  const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
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
      lastName: "Korrekturfall",
      birthDate: "1981-06-14",
    });
    await call(owner.$client, "assign_participations", {
      projectId,
      participationIds: [participationId],
      staffUserId: consultant,
      context: pl,
    });
    const documentId = await call(owner.$client, "add_document", {
      context: asConsultant,
      participationId,
      id: randomUUID(),
      type: "asu_proof",
      mediaType: "application/pdf",
      sizeBytes: 2048,
      contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      fileName: null,
      keyId: randomBytes(8).toString("hex"),
      wrappedKey: randomBytes(60),
    });
    await call(owner.$client, "review_document", {
      context: asConsultant,
      documentId,
      decision: "accepted",
      reason: null,
    });
    return { participationId, documentId };
  } finally {
    await owner.$client.end();
  }
}

/** Carbon fades a closed dialog out; a screenshot waits until every one is transparent. */
const modalsFaded = (page: Page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll(".cds--modal")].every(
      (modal) => getComputedStyle(modal).opacity === "0",
    ),
  );

test("slice 6-8: a wrong person's file accepted by mistake, invalidated after approval", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const api = page.context().request;
  const { participationId } = await participationWithProof();
  const personnelNumber = `E2E-${participationId.slice(0, 8)}`;
  const documents = `/projects/${projectId}/participations/${participationId}?tab=documents`;
  const source = "Vermerk der PL vom heutigen Tag, Az. E2E-68";

  // 1. The PL requests the correction on "Unterlagen": every value chosen, none preset.
  await staffSession(api, baseURL!, projectLead);
  await page.goto(documents);
  const requestButton = page.getByRole("button", {
    name: "Korrektur beantragen: Nachweis der Arbeitsuchendmeldung",
  });
  await expect(requestButton).toBeVisible();
  await expectAccessible(page);
  await requestButton.click();
  const dialog = page.getByRole("dialog", { name: "Korrektur beantragen" });
  const confirm = dialog.getByRole("button", { name: "Beantragen", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByText(/^Ja – die Datei wird nach der Freigabe gelöscht/).click();
  await dialog.getByLabel("Grund").selectOption("documented_internal_error");
  await dialog.getByLabel("Dokumentierte Quelle").fill(source);
  // The pointer leaves the trigger behind the overlay: axe measures its hover colour otherwise.
  await page.mouse.move(0, 0);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("1-request-dialog.png") });
  await confirm.click();
  await expect(dialog).toBeHidden();
  await modalsFaded(page);
  await expect(page.getByText("Korrektur beantragt.", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Korrektur beantragt", { exact: true })).toBeVisible();

  // 2. The regional operations manager: the type, the reason, the source and the dates, no name.
  await staffSession(api, baseURL!, regionalOperationsManager);
  await page.goto("/reviews");
  const corrections = page.getByRole("table", { name: "Beantragte Korrekturen" });
  const row = corrections.getByRole("row").filter({ hasText: source });
  await expect(row).toContainText("Unterlage: Nachweis der Arbeitsuchendmeldung");
  await expect(row).toContainText("Datei einer anderen Person");
  await expect(row).toContainText("Dokumentierter interner Fehler");
  await expect(row).toContainText(berlinToday());
  await expect(page.getByText("Korrekturfall")).toHaveCount(0);
  await expectAccessible(page);
  await corrections.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("2-freigaben.png") });
  await row.getByRole("button", { name: /^Korrektur freigeben: / }).click();
  const approve = page.getByRole("dialog", { name: "Korrektur freigeben" });
  await expect(approve).toContainText("die Datei gelöscht; der Verlauf bleibt");
  await approve.getByRole("button", { name: "Freigeben", exact: true }).click();
  await expect(approve).toBeHidden();
  await expect(page.getByText("Korrektur freigegeben.")).toBeVisible();
  await expect(row).toHaveCount(0);

  // 3. The PL: the file is gone, the status stays, the work list shows "Nachweis ungültig".
  await staffSession(api, baseURL!, projectLead);
  await page.goto(documents);
  await expect(page.getByRole("button", { name: /Nachweis der Arbeitsuchendmeldung/ })).toHaveCount(
    0,
  );
  await page.goto(`/projects/${projectId}?tab=participants`);
  const item = page
    .getByRole("row")
    .filter({ has: page.getByText(personnelNumber, { exact: true }) });
  await expect(item).toContainText(`Nachweis ungültig (seit ${berlinToday()})`);
  await expect(item).toContainText("Informiert");
  await expectAccessible(page);
  await item
    .getByText(/^Nachweis ungültig/)
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("3-worklist.png") });

  // 4. The history keeps the request and the decision, by codes.
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=history`);
  await expect(page.getByText("Korrektur entschieden")).toBeVisible();
  await expect(page.getByText("Korrektur beantragt", { exact: true })).toBeVisible();
  await expect(page.getByText(/freigegeben/).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("4-history.png") });
});
