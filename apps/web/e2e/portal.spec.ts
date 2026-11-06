import { choosePortalLanguage, expect, expectAccessible, test } from "./helpers";

// AC-18: the portal (built, served by the API at /portal/) renders in German and switches to
// English with <html lang> in its header. The web and portal SPAs are separate builds; this suite
// drives both over HTTP only. The start page shows no API status (ui-patterns.md, the portal).
test("portal: German by default, switch to English in the header, no API status", async ({
  page,
}) => {
  await page.goto("/portal/");
  await expect(page.getByRole("heading", { name: "Willkommen" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByText(/Verbindung zum Server/)).toHaveCount(0);
  await expectAccessible(page);

  await choosePortalLanguage(page, "English");
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expectAccessible(page);
});

test("portal: /portal redirects to /portal/, client routes fall back to the portal", async ({
  page,
}) => {
  await page.goto("/portal");
  await expect(page).toHaveURL(/\/portal\/$/);
  await page.goto("/portal/unknown");
  await expect(page.getByText("Diese Seite gibt es nicht.")).toBeVisible();
});
