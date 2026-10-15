import { expect, expectAccessible, test } from "./helpers";

// AC-18: the portal (built, served by the API at /portal/) renders in German, switches to
// English with <html lang>, and shows the API status. The web and portal SPAs are separate
// builds; this suite drives both over HTTP only.
test("portal: German by default, switch to English, API status", async ({ page }) => {
  await page.goto("/portal/");
  await expect(page.getByRole("heading", { name: "Willkommen" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByText(/Verbindung zum Server besteht/)).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Sprache").selectOption("en");
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText(/Connected to the server/)).toBeVisible();
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
