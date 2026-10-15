import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApiClient } from "@transfer/api-client";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { createPortalRouter } from "./router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The portal at `path` over a fake fetch that answers GET /api/v1/health. */
function renderPortal(health: () => Response | Promise<Response>, path = "/portal/") {
  const calls: string[] = [];
  const api = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      calls.push(url.pathname);
      return url.pathname === "/api/v1/health" ? health() : json({}, 404);
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createPortalRouter(
    { api, queryClient },
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(<RouterProvider router={router} />);
  return { calls };
}

const healthy = () => json({ status: "ok", version: "1.2.3" });

afterEach(async () => {
  await i18n.changeLanguage("de");
});

describe("portal shell", () => {
  it("renders in German by default, with <html lang=de dir=ltr>", async () => {
    renderPortal(healthy);
    expect(await screen.findByRole("heading", { name: "Willkommen" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("de");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("shows the API status from /api/v1/health through the API client", async () => {
    const { calls } = renderPortal(healthy);
    expect(
      await screen.findByText("Verbindung zum Server besteht (Version 1.2.3)."),
    ).toBeInTheDocument();
    expect(calls).toEqual(["/api/v1/health"]);
  });

  it("says when the API cannot be reached", async () => {
    renderPortal(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await screen.findByText(/Der Server ist gerade nicht erreichbar/)).toBeInTheDocument();
  });

  it("switches to English: text and <html lang> change (AC-18)", async () => {
    renderPortal(healthy);
    await userEvent.selectOptions(await screen.findByLabelText("Sprache"), "en");

    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByLabelText("Language")).toHaveValue("en");
    expect(await screen.findByText("Connected to the server (version 1.2.3).")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("names each language in that language", async () => {
    renderPortal(healthy);
    const english = await screen.findByRole("option", { name: "English" });
    expect(english).toHaveAttribute("lang", "en");
    expect(screen.getByRole("option", { name: "Deutsch" })).toHaveAttribute("lang", "de");
  });

  it("shows a not-found message for unknown portal paths", async () => {
    renderPortal(healthy, "/portal/unknown");
    expect(await screen.findByText("Diese Seite gibt es nicht.")).toBeInTheDocument();
  });
});
