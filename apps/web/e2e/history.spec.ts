import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { seedProjectIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";
import { activatedParticipant } from "./participants";

// The tab "Verlauf" (data-protection.md, audit metadata; Q157), without any code submission: the
// participant is set up by the owner fixture (participants.ts). The PL assigns a wave, reminds the
// participant and adds and opens a CV; the history lists the assignment, the reminder and the
// added CV with their actor, never the opening. The suite fails on any CSP violation. Synthetic
// data only.

const projectId = seedProjectIds.werkNord;
const W1 = "00000000-0000-4000-b000-000000000001"; // the seeded wave W1 of Werk Nord
const PRIVATE = "verlauf.privat@example.org";
const CV = fileURLToPath(
  new URL("../../../fixtures/documents/lebenslauf-beispiel.pdf", import.meta.url),
);

const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

const row = (page: Page, event: string) => page.getByRole("row").filter({ hasText: event });

test("history: the PL sees the wave assignment and the reminder with their actor, not the opening", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const api = page.context().request;
  const headers = { Origin: baseURL! };
  // The PL's session (activatedParticipant leaves it) acts throughout.
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: PRIVATE,
  });
  await ok(
    api.post(`/api/v1/projects/${projectId}/entry-wave-assignments`, {
      headers,
      data: { waveId: W1, participationIds: [participationId] },
    }),
  );
  await ok(
    api.post(`/api/v1/projects/${projectId}/reminders`, {
      headers,
      data: { kind: "open_items", participationIds: [participationId] },
    }),
  );
  await ok(
    api.post(`/api/v1/participations/${participationId}/documents`, {
      headers,
      data: {
        type: "cv",
        fileName: "lebenslauf-beispiel.pdf",
        content: (await readFile(CV)).toString("base64"),
      },
    }),
  );

  // The PL opens the CV on the tab "Unterlagen": a logged opening.
  await page.goto(`/projects/${projectId}/participations/${participationId}?tab=documents`);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }).click();
  await downloaded;

  // "Verlauf": the assignment, the reminder and the CV, each with its actor.
  const answer = page.waitForResponse((r) =>
    r.url().includes(`/participations/${participationId}/history`),
  );
  await page.getByRole("tab", { name: "Verlauf" }).click();
  const history = (await (await answer).json()) as { items: { type: string }[] };
  await expect(page.locator("#participant-history")).toHaveText("Verlauf");
  const assigned = row(page, "Eintrittswelle zugewiesen");
  await expect(assigned).toContainText("ohne Welle → W1");
  await expect(assigned).toContainText("Petra Projektleitung");
  const reminded = row(page, "Nachricht angefordert");
  await expect(reminded).toContainText("E-Mail");
  await expect(reminded).toContainText("Petra Projektleitung");
  const added = row(page, "Unterlage hinzugefügt");
  await expect(added).toContainText("Lebenslauf");
  await expect(added).toContainText("Petra Projektleitung");

  // The opening is a security event: neither in the answer nor on the page.
  expect(history.items.map((item) => item.type)).not.toContain("document_opened");
  expect(history.items.map((item) => item.type)).not.toContain("audit_history_opened");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(history.items.length + 1);
  await expect(page.getByText(/geöffnet/)).toHaveCount(0);
  await expectAccessible(page);
});
