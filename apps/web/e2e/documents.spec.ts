import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import { seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant, loggedInAsOwner } from "./participants";

// The happy path of Slice 4b (data-protection.md, documents and uploads; ADR-0010, documents):
// the participant uploads a CV in the wizard's "Unterlagen" and downloads it; a file with the
// EICAR test string is refused and nothing is stored; the assigned consultant opens the CV and
// rejects a certificate as unreadable on the tab "Unterlagen"; the participant sees it rejected
// and deletes it. No code submission (the run's throttle, participants.ts); the suite fails on any
// CSP violation (the download is a same-origin navigation, no `blob:`). Synthetic files only
// (fixtures/documents/).

const PRIVATE = "unterlagen.privat@example.org";
const projectId = seedProjectIds.werkNord;
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/documents/${name}`, import.meta.url));
const CV = fixture("lebenslauf-beispiel.pdf");
const CERTIFICATE = fixture("zeugnis-unscharf-beispiel.png");

/**
 * A PDF carrying the EICAR anti-virus test string, assembled here and never committed: the type
 * check sees a PDF, the mock scanner the test string.
 */
const eicarPdf = () =>
  Buffer.from(
    [
      "%PDF-1.4",
      ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!", "$H+H*"].join(""),
      "%%EOF",
    ].join("\n"),
    "latin1",
  );

const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

/** A staff user's dev session in the browser context (the dev switcher's route). */
const staffSession = (api: APIRequestContext, baseURL: string, staffUserId: string) =>
  ok(api.post("/api/v1/dev/session", { headers: { Origin: baseURL }, data: { staffUserId } }));

/** Clicks the button and returns the download's bytes and suggested name. */
async function download(page: Page, click: () => Promise<void>) {
  const started = page.waitForEvent("download");
  await click();
  const file = await started;
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}

test("slice 4b: upload in the portal, refusal, review on the tab, deletion", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const api = page.context().request;
  const headers = { Origin: baseURL! };
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: PRIVATE,
  });
  // The PL (the session activatedParticipant left) assigns the consultant.
  await ok(
    api.post(`/api/v1/projects/${projectId}/assignments`, {
      headers,
      data: { staffUserId: seedStaffUserIds.consultant, participationIds: [participationId] },
    }),
  );

  // 1. The participant, on a phone: the notice, then "Unterlagen".
  await page.setViewportSize({ width: 390, height: 844 });
  await loggedInAsOwner(page, baseURL!, participationId);
  await page.goto("/portal/self-service?step=documents");
  await page.getByRole("button", { name: "Gelesen, weiter" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Unterlagen" })).toBeVisible();
  await expect(page.getByText(/keine Gesundheitsunterlagen hoch/)).toBeVisible();
  await expectAccessible(page);

  // The CV, listed as uploaded, downloads with the exact bytes.
  await page.getByLabel("Lebenslauf hochladen").setInputFiles(CV);
  await expect(page.getByText("Die Datei wurde hochgeladen.")).toBeVisible();
  const cv = page.getByRole("region", { name: "Lebenslauf" });
  await expect(cv.getByText("lebenslauf-beispiel.pdf")).toBeVisible();
  await expect(cv.getByText("hochgeladen", { exact: true })).toBeVisible();
  const downloaded = await download(page, () =>
    page.getByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }).click(),
  );
  expect(downloaded.bytes.equals(await readFile(CV))).toBe(true);
  await expectAccessible(page);

  // A file with the EICAR test string is refused; nothing is listed.
  await page.getByLabel("Lebenslauf hochladen").setInputFiles({
    name: "lebenslauf-test.pdf",
    mimeType: "application/pdf",
    buffer: eicarPdf(),
  });
  await expect(
    page.getByText("Die Datei wurde nicht angenommen, weil sie Schadsoftware enthalten könnte."),
  ).toBeVisible();
  await expect(cv.getByRole("listitem")).toHaveCount(1);
  const listed = await api.get("/api/v1/portal/documents");
  expect(((await listed.json()) as { documents: unknown[] }).documents).toHaveLength(1);

  // A certificate, for the consultant to look at.
  const certificates = page.getByRole("region", { name: "Zeugnisse und Nachweise" });
  await page.getByLabel("Zeugnisse und Nachweise hochladen").setInputFiles(CERTIFICATE);
  await expect(certificates.getByText("zeugnis-unscharf-beispiel.png")).toBeVisible();

  // 2. The assigned consultant: the tab "Unterlagen", opens the CV (logged), rejects the
  // certificate as unreadable.
  await page.setViewportSize({ width: 1280, height: 900 });
  await staffSession(api, baseURL!, seedStaffUserIds.consultant);
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=documents`);
  const cvRow = page.getByRole("row").filter({ hasText: "lebenslauf-beispiel.pdf" });
  await expect(cvRow.getByText("Teilnehmer·in")).toBeVisible();
  const opened = await download(page, () =>
    cvRow.getByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }).click(),
  );
  expect(opened.bytes.equals(await readFile(CV))).toBe(true);
  const certificateRow = page.getByRole("row").filter({ hasText: "zeugnis-unscharf-beispiel.png" });
  await certificateRow
    .getByRole("button", { name: "zeugnis-unscharf-beispiel.png ablehnen" })
    .click();
  const reject = page.getByRole("dialog", { name: "Unterlage ablehnen" });
  await reject.getByLabel("Grund").selectOption("unreadable");
  await reject.getByRole("button", { name: "Ablehnen" }).click();
  await expect(page.getByText("Die Unterlage wurde abgelehnt.")).toBeVisible();
  await expect(certificateRow.getByText("abgelehnt: nicht lesbar")).toBeVisible();
  // Reviewed once and finally: no second review.
  await expect(certificateRow.getByRole("button", { name: /ablehnen$/ })).toHaveCount(0);
  // Axe only once the dialog has faded out: mid-transition its colours are blended, and axe
  // reports a contrast violation for text nobody can see any more.
  await expect(reject).toBeHidden();
  await expectAccessible(page);

  // 3. The participant sees it rejected, deletes it after the confirmation.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/portal/self-service?step=documents");
  await expect(certificates.getByText("abgelehnt: nicht lesbar")).toBeVisible();
  await page.getByRole("button", { name: "zeugnis-unscharf-beispiel.png löschen" }).click();
  const confirm = page.getByRole("dialog", { name: "Unterlage löschen?" });
  await expect(confirm.getByText(/wird gelöscht/)).toBeVisible();
  await confirm.getByRole("button", { name: "Löschen" }).click();
  await expect(page.getByText("Die Unterlage wurde gelöscht.")).toBeVisible();
  await expect(certificates.getByText("Noch keine Unterlage.")).toBeVisible();
  await expect(cv.getByText("lebenslauf-beispiel.pdf")).toBeVisible();
});
