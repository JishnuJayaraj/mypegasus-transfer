import type { Page } from "@playwright/test";
import { seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { expect, expectAccessible, test } from "./helpers";

// The staff shell at the widths below the preferred 1280px layout (UX foundation plan, D10 and
// 6b-1): the project "shell" in playwright.config.ts runs only this file. 375px stands in for
// 400 % zoom of a 1280px window (WCAG 1.4.10 Reflow); 1440px covers the login page and the rail.
// Read-only on the seeded synthetic data, so it runs beside the other specs.

const projectId = seedProjectIds.werkNord;

/** A dev session for the browser context (the dev switcher's route), then the page. */
async function logInAs(page: Page, baseURL: string, staffUserId: string, path: string) {
  const response = await page.request.post("/api/v1/dev/session", {
    headers: { Origin: baseURL },
    data: { staffUserId },
  });
  expect(response.ok()).toBe(true);
  await page.goto(path);
}

/** The page itself never scrolls sideways; a table may, inside its own container (D10). */
async function expectNoPageScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal page overflow in px").toBeLessThanOrEqual(0);
}

const menuButton = (page: Page) =>
  page.getByRole("banner").getByRole("button", { name: "Navigation öffnen oder schließen" });
const nav = (page: Page) => page.getByRole("navigation", { name: "Navigation" });

/** A screenshot of the viewport for the PR (docs/screenshots/6b-1/ takes a copy). */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** Nothing of the shell's state lands in browser storage (data-protection.md, page titles). */
async function expectNothingStored(page: Page) {
  const stored = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
  ]);
  expect(stored).toEqual([]);
}

for (const width of [1440, 375]) {
  test.describe(`login at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("no side navigation, the form centred", async ({ page }) => {
      await page.goto("/login");
      const heading = page.getByRole("heading", { name: "Anmelden", level: 1 });
      await expect(heading).toBeVisible();
      await expect(page).toHaveTitle("Anmelden – Transferplattform");
      await expect(page.getByRole("navigation")).toHaveCount(0);
      await expect(menuButton(page)).toHaveCount(0);
      // Centred: the card's margins on both sides are equal (within a pixel).
      const card = await page.locator(".tp-login").boundingBox();
      const viewport = page.viewportSize()!;
      expect(card).not.toBeNull();
      const left = card!.x;
      const right = viewport.width - card!.x - card!.width;
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      if (width >= 1440) expect(left).toBeGreaterThan(200);
      await expectNoPageScroll(page);
      await expectAccessible(page);
      await shot(page, `login-${width}`);
    });
  });
}

for (const width of [768, 375]) {
  test.describe(`staff shell at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the menu opens the navigation as an overlay and closes it again", async ({
      page,
      baseURL,
    }) => {
      await logInAs(page, baseURL!, seedStaffUserIds.admin, "/projects");
      await expect(page.getByRole("heading", { name: "Projekte", level: 1 })).toBeVisible();
      await expect(page).toHaveTitle("Projekte – Transferplattform");
      await expect(nav(page)).toBeHidden();
      // Below 66rem the content takes the full width: no rail offset beside it.
      expect((await page.locator("#main-content").boundingBox())!.x).toBe(0);
      await expectNoPageScroll(page);
      await expectAccessible(page);
      await shot(page, `projects-${width}`);

      // Open: the focus goes to the first link, the groups show, axe passes on the overlay.
      await menuButton(page).click();
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
      await expect(nav(page)).toBeVisible();
      await expect(nav(page).getByRole("link", { name: "Projekte" })).toBeFocused();
      await expect(nav(page).getByRole("link", { name: "Projekte" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(nav(page).getByText("Arbeit", { exact: true })).toBeVisible();
      await expect(nav(page).getByText("Verwaltung", { exact: true })).toBeVisible();
      // An overlay: the content behind it doesn't move.
      expect((await page.locator("#main-content").boundingBox())!.x).toBe(0);
      await expectNoPageScroll(page);
      await expectAccessible(page);
      await shot(page, `nav-open-${width}`);

      // The focus stays inside: Shift+Tab from the first link reaches the last.
      await page.keyboard.press("Shift+Tab");
      await expect(nav(page).getByRole("link", { name: "Eskalationen" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(nav(page).getByRole("link", { name: "Projekte" })).toBeFocused();

      // Escape closes and returns the focus to the menu button.
      await page.keyboard.press("Escape");
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
      await expect(menuButton(page)).toBeFocused();
      await expect(nav(page)).toBeHidden();

      // A link in the overlay navigates and closes it.
      await menuButton(page).click();
      await nav(page).getByRole("link", { name: "Regionen" }).click();
      await expect(page).toHaveURL(/\/admin\/regions$/);
      await expect(page).toHaveTitle("Regionen – Transferplattform");
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
      await expect(nav(page)).toBeHidden();
      await expectNoPageScroll(page);
      await expectNothingStored(page);
    });

    test("the user menu, the project page and its title", async ({ page, baseURL }) => {
      await logInAs(page, baseURL!, seedStaffUserIds.projectLead, `/projects/${projectId}`);
      await expect(page).toHaveTitle("Übersicht · Restrukturierung Werk Nord – Transferplattform");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expectNoPageScroll(page);
      await expectAccessible(page);

      const user = page
        .getByRole("banner")
        .getByRole("button", { name: "Benutzermenü: Petra Projektleitung" });
      await user.click();
      const panel = page.getByRole("region", { name: "Benutzermenü: Petra Projektleitung" });
      await expect(panel.getByRole("button", { name: "Abmelden" })).toBeVisible();
      await expect(
        panel.getByRole("list", { name: "Entwicklungsbenutzer wechseln" }),
      ).toBeVisible();
      await expectNoPageScroll(page);
      await expectAccessible(page);
      await shot(page, `user-menu-${width}`);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Escape");
      await expect(user).toBeFocused();
      await expect(panel).toHaveCount(0);

      await page.getByRole("tab", { name: "Teilnehmende" }).click();
      await expect(page).toHaveTitle(
        "Teilnehmende · Restrukturierung Werk Nord – Transferplattform",
      );
      // The work list with its filters (the seed's Werk Nord has no participants yet).
      await expect(page.getByRole("region", { name: "Teilnehmende" })).toBeVisible();
      await expectNoPageScroll(page);
      await expectNothingStored(page);
    });
  });
}

test.describe("staff shell at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the rail beside the content; the menu button pins it open", async ({ page, baseURL }) => {
    await logInAs(page, baseURL!, seedStaffUserIds.admin, "/projects");
    await expect(page.getByRole("heading", { name: "Projekte", level: 1 })).toBeVisible();
    // The rail: icons visible beside the content, which starts after it.
    const rail = await nav(page).boundingBox();
    const main = await page.locator("#main-content").boundingBox();
    expect(rail!.width).toBeLessThanOrEqual(48);
    expect(main!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width);
    // The content is centred within its max-width (99rem = 1584px at 16px).
    const inner = await page.locator(".tp-content-inner").boundingBox();
    expect(inner!.width).toBeLessThanOrEqual(1584);
    await shot(page, "projects-1440");
    // Hovering expands the rail over the content; the content doesn't jump.
    await nav(page).hover();
    await expect(nav(page).getByText("Verwaltung", { exact: true })).toBeVisible();
    expect((await page.locator("#main-content").boundingBox())!.x).toBe(main!.x);
    await page.mouse.move(800, 600);

    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(nav(page).getByText("Verwaltung", { exact: true })).toBeVisible();
    await expect.poll(async () => (await nav(page).boundingBox())!.width).toBe(256);
    await expect
      .poll(async () => (await page.locator("#main-content").boundingBox())!.x)
      .toBeGreaterThanOrEqual(256);
    await expectNoPageScroll(page);
    await expectAccessible(page);
    await shot(page, "nav-pinned-1440");
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    await expectNothingStored(page);
  });
});
