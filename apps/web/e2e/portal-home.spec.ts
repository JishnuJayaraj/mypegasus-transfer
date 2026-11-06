import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { seedProjectIds, seedStaffUserIds } from "@transfer/db";
import {
  choosePortalLanguage,
  expect,
  expectAccessible,
  openPortalAccountMenu,
  test,
} from "./helpers";
import { activatedParticipant, loggedInAsOwner } from "./participants";

// The portal's start page and header (ui-patterns.md, the portal and C5): logged out one
// choice between "Anmelden" and the activation code; logged in the checklist with its progress
// from GET /portal/progress, the next appointment and the areas; "Mein Konto" with the channels
// and "Abmelden"; the language switch and the account menu in the header. The start page
// makes no request to a sensitive-field endpoint. Screenshots at 1440, 768, 375 and 320px and
// the zoom check (200 % and 400 % of a 1280×720 window) go to docs/screenshots/6b-6/. Synthetic
// data only.

const projectId = seedProjectIds.werkNord;
const PRIVATE = "start.privat@example.org";
const DAY_MS = 24 * 60 * 60 * 1000;
const widths = [1440, 768, 375, 320] as const;
const screenshots = fileURLToPath(new URL("../../../docs/screenshots/6b-6/", import.meta.url));
const shot = (name: string) => `${screenshots}${name}.png`;

/** The full hour `days` from now. */
const at = (days: number) =>
  new Date(Math.ceil((Date.now() + days * DAY_MS) / 3_600_000) * 3_600_000);

/** How far the page scrolls sideways; the elements sticking out when it does. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const by = document.documentElement.scrollWidth - width;
    const out = by
      ? [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > width + 1)
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`)
      : [];
    return { by, out };
  });
}

async function expectReflow(page: Page) {
  expect(await overflow(page)).toEqual({ by: 0, out: [] });
}

/** The page settled: no Carbon transition or progress animation still running. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );

test("portal start page logged out: one choice, at every width", async ({ page }) => {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/portal/");
    await expect(page.getByRole("heading", { level: 1, name: "Willkommen" })).toBeVisible();
    const login = page.getByRole("region", { name: "Sie haben schon einen Zugang" });
    await expect(login.getByRole("link", { name: "Anmelden" })).toBeVisible();
    const activate = page.getByRole("region", { name: "Sie sind zum ersten Mal hier" });
    await expect(
      activate.getByRole("link", { name: "Mit Aktivierungscode starten" }),
    ).toBeVisible();
    // no API status, no account menu
    await expect(page.getByText(/Verbindung zum Server/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mein Konto" })).toHaveCount(0);
    await expectReflow(page);
    await expectAccessible(page);
    await settled(page);
    await page.screenshot({ path: shot(`home-logged-out-${width}`), fullPage: true });
  }
  await page.getByRole("link", { name: "Mit Aktivierungscode starten" }).click();
  await expect(page).toHaveURL(/\/portal\/activate$/);
});

test("portal start page logged in: checklist, next appointment, areas, Mein Konto", async ({
  page,
  baseURL,
  browser,
}) => {
  test.slow();
  const participationId = await activatedParticipant(page, baseURL!, {
    projectId,
    address: PRIVATE,
  });
  // The PL books an info event for the participant and invites them to a consultation.
  const staff = page.context().request;
  const headers = { Origin: baseURL! };
  async function appointment(data: Record<string, unknown>, days: number) {
    const startsAt = at(days);
    const res = await staff.post(`/api/v1/projects/${projectId}/appointments`, {
      headers,
      data: {
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
        capacity: 10,
        venue: "Kantine Werk 2",
        ...data,
      },
    });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  const infoEvent = await appointment(
    { kind: "info_event", title: "Infoveranstaltung Transfer" },
    4,
  );
  const consultation = await appointment(
    { kind: "consultation", hostStaffUserId: seedStaffUserIds.projectLead },
    6,
  );
  const booked = await staff.post(`/api/v1/appointments/${infoEvent}/bookings`, {
    headers,
    data: { participationId },
  });
  expect(booked.ok()).toBe(true);
  const invited = await staff.post(`/api/v1/appointments/${consultation}/invitations`, {
    headers,
    data: { participationIds: [participationId] },
  });
  expect(invited.ok()).toBe(true);

  const participant = await browser.newContext({ baseURL });
  const portal = await participant.newPage();
  await loggedInAsOwner(portal, baseURL!, participationId);
  // The notice and "Persönliches" done, through the participant's own routes.
  const own = portal.context().request;
  expect(
    (
      await own.post("/api/v1/portal/self-service/notice", {
        headers,
        data: { version: "self-service-purposes:v1", language: "de" },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await own.put("/api/v1/portal/self-service/pages/personal", {
        headers,
        data: { revision: 0, values: { gender: "female", maritalStatus: "single" } },
      })
    ).ok(),
  ).toBe(true);

  // Every request the start page makes, none to a sensitive-field endpoint (data-protection.md).
  const requested: string[] = [];
  portal.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/")) requested.push(pathname);
  });
  for (const width of widths) {
    await portal.setViewportSize({ width, height: 900 });
    await portal.goto("/portal/");
    await expect(portal.getByRole("heading", { level: 1, name: "Hallo Erika" })).toBeVisible();
    const checklist = portal.getByRole("region", { name: "Das fehlt noch" });
    // the notice, "Persönliches" and "Kontakt" (the imported address) are done
    await expect(checklist.getByText(/^3 von \d+ Aufgaben erledigt/)).toBeVisible();
    await expect(
      checklist.getByRole("link", { name: "Termin buchen: Beratungstermin" }),
    ).toBeVisible();
    await expect(checklist.getByRole("region", { name: "Freiwillig" })).toBeVisible();
    const next = portal.getByRole("region", { name: "Ihr nächster Termin" });
    await expect(next.getByText(/^Infoveranstaltung am /)).toBeVisible();
    await expect(next.getByText("Infoveranstaltung Transfer")).toBeVisible();
    await expect(
      portal.getByRole("navigation", { name: "Ihre Bereiche" }).getByRole("link"),
    ).toHaveCount(3);
    await expect(portal.getByText(/Verbindung zum Server/)).toHaveCount(0);
    await expectReflow(portal);
    await expectAccessible(portal);
    await settled(portal);
    await portal.screenshot({ path: shot(`home-${width}`), fullPage: true });
  }
  expect(requested.filter((path) => /\/self-service(\/|$)/.test(path))).toEqual([]);
  expect([...new Set(requested)].toSorted()).toEqual([
    "/api/v1/portal/appointments",
    "/api/v1/portal/me",
    "/api/v1/portal/progress",
  ]);

  // The done tasks open below the list.
  await portal.getByText(/^3 Aufgaben erledigt$/).click();
  await expect(
    portal.getByRole("link", { name: "Hinweise zu Ihren Angaben lesen und bestätigen" }),
  ).toBeVisible();

  // The header at 320px: the language switch and the account menu.
  await portal.setViewportSize({ width: 320, height: 900 });
  await portal.goto("/portal/");
  await expect(portal.getByRole("heading", { level: 1, name: "Hallo Erika" })).toBeVisible();
  await portal.getByRole("banner").getByRole("button", { name: "Sprache: Deutsch" }).click();
  await expect(portal.getByRole("button", { name: "English" })).toHaveAttribute("lang", "en");
  await expectReflow(portal);
  await expectAccessible(portal);
  await settled(portal);
  await portal.screenshot({ path: shot("language-menu-320") });
  await portal.keyboard.press("Escape");
  await expect(
    portal.getByRole("banner").getByRole("button", { name: "Sprache: Deutsch" }),
  ).toBeFocused();
  await openPortalAccountMenu(portal);
  // the header's panel, named by its button
  const accountMenu = portal.getByRole("banner").getByRole("region", { name: "Mein Konto" });
  await expect(accountMenu.getByRole("link", { name: "Mein Konto" })).toBeVisible();
  await expectReflow(portal);
  await expectAccessible(portal);
  await settled(portal);
  await portal.screenshot({ path: shot("account-menu-320") });

  // "Mein Konto": the masked channel, the link to manage it and "Abmelden".
  await accountMenu.getByRole("link", { name: "Mein Konto" }).click();
  for (const width of widths) {
    await portal.setViewportSize({ width, height: 900 });
    await expect(portal.getByRole("heading", { level: 1, name: "Mein Konto" })).toBeVisible();
    await expect(portal.getByText(/E-Mail s…@example.org, bestätigt am/)).toBeVisible();
    await expect(portal.getByRole("link", { name: "Kontaktwege verwalten" })).toBeVisible();
    await expectReflow(portal);
    await expectAccessible(portal);
    await settled(portal);
    await portal.screenshot({ path: shot(`account-${width}`), fullPage: true });
  }

  // English, at 375px.
  await portal.setViewportSize({ width: 375, height: 900 });
  await portal.goto("/portal/");
  await choosePortalLanguage(portal, "English");
  await expect(portal.getByRole("heading", { level: 1, name: "Hello Erika" })).toBeVisible();
  await expect(portal.getByRole("region", { name: "Still to do" })).toBeVisible();
  await expectReflow(portal);
  await expectAccessible(portal);
  await settled(portal);
  await portal.screenshot({ path: shot("home-en-375"), fullPage: true });
  await choosePortalLanguage(portal, "Deutsch");

  // The zoom check (ui-patterns.md, tables and reflow): a 1280×720 window at 200 % is 640×360 CSS px, at 400 % 320×180.
  for (const [zoom, width, height] of [
    [200, 640, 360],
    [400, 320, 180],
  ] as const) {
    await portal.setViewportSize({ width, height });
    await portal.goto("/portal/");
    await expect(portal.getByRole("heading", { level: 1, name: "Hallo Erika" })).toBeVisible();
    await expect(portal.getByText(/von \d+ Aufgaben erledigt/)).toBeVisible();
    await expectReflow(portal);
    await settled(portal);
    await portal.screenshot({ path: shot(`zoom-${zoom}-home`) });
    await portal.goto("/portal/account");
    await expect(portal.getByRole("heading", { level: 1, name: "Mein Konto" })).toBeVisible();
    await expectReflow(portal);
    await openPortalAccountMenu(portal);
    await expect(accountMenu.getByRole("button", { name: "Abmelden" })).toBeVisible();
    await expectReflow(portal);
    await settled(portal);
    await portal.screenshot({ path: shot(`zoom-${zoom}-account-menu`) });
  }

  // "Abmelden" in the account menu: back to the choice, nothing of the participant left.
  await accountMenu.getByRole("button", { name: "Abmelden" }).click();
  await expect(portal.getByRole("heading", { level: 1, name: "Willkommen" })).toBeVisible();
  await expect(portal.getByRole("button", { name: "Mein Konto" })).toHaveCount(0);
  await participant.close();
});
