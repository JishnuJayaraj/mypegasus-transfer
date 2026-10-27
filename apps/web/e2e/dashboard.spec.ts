import type { Page, Request } from "@playwright/test";
import { expect, expectAccessible, expectWithinBudget, test } from "./helpers";
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
 * status line shows `expected` matches, or until `giveUp` ms passed (the count is asserted after).
 */
async function timeKeystroke({
  key,
  expected,
  giveUp,
}: {
  key: string;
  expected: number;
  giveUp: number;
}) {
  const input = document.querySelector<HTMLInputElement>("#worklist-search")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const shown = () =>
    [...document.querySelectorAll("p")].some((p) =>
      p.textContent?.startsWith(`${expected} Treffer ·`),
    );
  const start = performance.now();
  setValue.call(input, input.value + key);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  while (!shown() && performance.now() - start < giveUp) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
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

// The performance criterion as a hard gate and a soft budget (architecture/overview.md,
// performance approach; CLAUDE.md, how we work). The gate is deterministic and asserted first:
// one request, the term never sent, one page of rows. The timings are reported, fail above a
// generous ceiling, and fail at the budget (3 s to the first result, 100 ms per keystroke) only
// with PERF_BUDGET=strict (.env.example).
test("search 2,000 participations in the browser: one request, one page of rows, timing budget", async ({
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
  const list = page.getByRole("region", { name: "Teilnehmende" });
  const search = list.getByLabel("Name oder Personalnummer suchen");
  await expect(search).toBeEnabled();
  await search.fill("PERF-1");
  await expect(matches(page, 1000)).toBeVisible();
  const firstResult = Date.now() - started;
  // The work list renders 25 matching rows at a time (architecture/overview.md, performance
  // approach): 25 rows and the header while 1,000 match.
  await expect(list.getByRole("row")).toHaveCount(26);

  // Each further keystroke, timed in the page from the input event to the new count; the count
  // and the rows are asserted after each one, whatever the time.
  const keystrokes: number[] = [];
  for (const [char, count] of [
    ["9", 100],
    ["9", 10],
    ["9", 1],
  ] as const) {
    keystrokes.push(
      await page.evaluate(timeKeystroke, { key: char, expected: count, giveUp: 5000 }),
    );
    await expect(matches(page, count)).toBeVisible();
    await expect(list.getByRole("row")).toHaveCount(Math.min(count, 25) + 1);
  }
  const reported = `first result ${firstResult} ms; keystrokes ${keystrokes.map((ms) => `${Math.round(ms)} ms`).join(", ")}`;
  test.info().annotations.push({ type: "performance", description: reported });
  // oxlint-disable-next-line no-console -- the timings go into the PR
  console.info(reported);

  // The hard gate. One snapshot answers the whole session, whatever was typed (ADR-0010, the
  // bounded snapshot; architecture/overview.md, the project page).
  const snapshots = requests.filter((r) => r.includes(`/projects/${projectId}/worklist`));
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatch(/^GET /);
  // The search runs in the browser: the term is in no request URL or body (data-protection.md,
  // the work list and the dashboard).
  expect(requests.filter((r) => /perf-1/i.test(r))).toEqual([]);

  // The soft budget, last.
  expectWithinBudget("first result of 2,000", firstResult, {
    budget: 3000,
    ceiling: 15_000,
    causes: "a slow work-list query, rendering every row instead of one page",
  });
  for (const ms of keystrokes) {
    expectWithinBudget("keystroke over 2,000", ms, {
      budget: 100,
      ceiling: 1000,
      causes: "a request per keystroke, rendering every row instead of one page",
    });
  }
});
