import type { Page, Request } from "@playwright/test";
import { expect, expectAccessible, test } from "./helpers";
import { seedProjectIds } from "@transfer/db";
import { worklistParticipations } from "./participants";

// Slice 5 (data-protection.md, the work list and the dashboard): the PL follows a count from
// "Übersicht" to the same rows in "Teilnehmende", searches a name in the browser and assigns a
// wave. No code submission: the participations are owner fixtures in seeded projects no other
// spec uses (Lager Süd, Verwaltung), the wave comes through the staff API. Synthetic data only.

/** Every request of the page, to prove the search term never leaves the browser. */
function recordRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (request: Request) =>
    requests.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`),
  );
  return requests;
}

/**
 * Runs in the page: types one character into the search and returns the milliseconds until the
 * status line shows `expected` matches.
 */
async function timeKeystroke({ key, expected }: { key: string; expected: number }) {
  const input = document.querySelector<HTMLInputElement>("#worklist-search")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const shown = () =>
    [...document.querySelectorAll("p")].some((p) =>
      p.textContent?.startsWith(`${expected} Treffer ·`),
    );
  const start = performance.now();
  setValue.call(input, input.value + key);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  while (!shown()) await new Promise((resolve) => requestAnimationFrame(resolve));
  return performance.now() - start;
}

const matches = (page: Page, count: number) => page.getByText(new RegExp(`^${count} Treffer ·`));

test("follow a count to its rows, search a name and assign a wave", async ({ page, baseURL }) => {
  const projectId = seedProjectIds.lagerSued;
  await worklistParticipations(page, baseURL!, {
    projectId,
    wave: true,
    prefix: "WL",
    count: 5,
    names: [
      ["Jürgen", "Größer"],
      ["Anna", "Muster"],
      ["Bernd", "Beispiel"],
      ["Clara", "Probe"],
      ["Dieter", "Fiktiv"],
    ],
  });
  const requests = recordRequests(page);
  await page.goto(`/projects/${projectId}`);
  // "Übersicht": five participations, none in a wave yet.
  await expect(page.getByRole("link", { name: "5 Teilnehmende" })).toBeVisible();
  const waves = page.getByRole("table", { name: "Nach Welle" });
  await expect(waves.getByRole("row", { name: /Ohne Welle/ })).toContainText("5");
  await expectAccessible(page);

  // The count opens the work list with the same filter: as many rows as counted.
  await waves
    .getByRole("row", { name: /Ohne Welle/ })
    .getByRole("link", { name: "5" })
    .click();
  await expect(page).toHaveURL(/tab=participants/);
  await expect(page).toHaveURL(/wave=none/);
  const list = page.getByRole("region", { name: "Teilnehmende" });
  await expect(matches(page, 5)).toBeVisible();
  await expect(list.getByRole("row")).toHaveCount(6);
  await expectAccessible(page);

  // The name search runs in the browser: folded, and never in a request or the URL.
  const search = list.getByLabel("Name oder Personalnummer suchen");
  await search.fill("grosser jurgen");
  await expect(matches(page, 1)).toBeVisible();
  await expect(list.getByRole("row")).toHaveCount(2);
  expect(page.url()).not.toMatch(/gross|jurgen/i);
  await expectAccessible(page);
  await search.fill("");

  // Two rows to W1; the list reloads and the filter "ohne Welle" now matches three.
  await list.getByRole("link", { name: "WL-0001" }).waitFor();
  await list.getByLabel("WL-0001 auswählen").check({ force: true });
  await list.getByLabel("WL-0002 auswählen").check({ force: true });
  await list.getByLabel("Eintrittswelle", { exact: true }).selectOption({ label: "W1 – Welle 1" });
  await list.getByRole("button", { name: "Eintrittswelle zuweisen (2)" }).click();
  await expect(page.getByText("2 zugewiesen, 0 unverändert")).toBeVisible();
  await expect(matches(page, 3)).toBeVisible();
  await expectAccessible(page);

  expect(requests.filter((r) => /gross|jurgen/i.test(r))).toEqual([]);
});

test("search 2,000 participations: under 3 s to the first result, 100 ms per keystroke", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const projectId = seedProjectIds.verwaltung;
  await worklistParticipations(page, baseURL!, {
    projectId,
    prefix: "PERF",
    count: 2000,
    names: [
      ["Erika", "Mustermann"],
      ["Max", "Beispiel"],
      ["Jürgen", "Größer"],
    ],
  });
  const requests = recordRequests(page);
  const started = Date.now();
  await page.goto(`/projects/${projectId}?tab=participants`);
  const search = page.getByLabel("Name oder Personalnummer suchen");
  await expect(search).toBeEnabled();
  await search.fill("PERF-1");
  await expect(matches(page, 1000)).toBeVisible();
  const firstResult = Date.now() - started;

  // Each further keystroke, timed in the page: from the input event to the new count.
  const keystrokes: number[] = [];
  for (const [char, count] of [
    ["9", 100],
    ["9", 10],
    ["9", 1],
  ] as const) {
    keystrokes.push(await page.evaluate(timeKeystroke, { key: char, expected: count }));
  }
  // oxlint-disable-next-line no-console -- the timings go into the PR (the performance criterion)
  console.info(
    `first result ${firstResult} ms; keystrokes ${keystrokes.map((ms) => `${Math.round(ms)} ms`).join(", ")}`,
  );
  expect(firstResult).toBeLessThan(3000);
  for (const ms of keystrokes) expect(ms).toBeLessThan(100);
  expect(requests.filter((r) => r.includes(`/projects/${projectId}/worklist`))).toHaveLength(1);
  expect(requests.filter((r) => /perf-1/i.test(r))).toEqual([]);
});
