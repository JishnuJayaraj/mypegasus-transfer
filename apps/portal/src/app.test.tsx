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

/** The portal at `path` over a fake fetch that answers GET /api/v1/health and nothing else. */
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

/** Opens the header's language menu and picks a language. */
async function chooseLanguage(current: string, name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: current }));
  await user.click(screen.getByRole("button", { name }));
}

describe("portal shell", () => {
  it("renders in German by default, with <html lang=de dir=ltr>", async () => {
    renderPortal(healthy);
    expect(await screen.findByRole("heading", { name: "Willkommen" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("de");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("shows no API status on the start page and never asks the health endpoint", async () => {
    const { calls } = renderPortal(healthy);
    expect(await screen.findByRole("heading", { name: "Willkommen" })).toBeInTheDocument();
    expect(screen.queryByText(/Verbindung|Server/)).toBeNull();
    expect(calls).not.toContain("/api/v1/health");
  });

  it("switches to English in the header: text and <html lang> change, the focus returns (AC-18)", async () => {
    renderPortal(healthy);
    await chooseLanguage("Sprache: Deutsch", "English");

    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    const menu = screen.getByRole("button", { name: "Language: English" });
    expect(menu).toHaveFocus();
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("names each language in that language and marks the current one", async () => {
    const user = userEvent.setup();
    renderPortal(healthy);
    await user.click(await screen.findByRole("button", { name: "Sprache: Deutsch" }));
    const english = screen.getByRole("button", { name: "English" });
    expect(english).toHaveAttribute("lang", "en");
    expect(english).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Deutsch" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a not-found message for unknown portal paths", async () => {
    renderPortal(healthy, "/portal/unknown");
    expect(await screen.findByText("Diese Seite gibt es nicht.")).toBeInTheDocument();
  });
});

describe("public Article 14 notice", () => {
  const path = "/portal/notice/art14/art14-activation:v1";

  it("renders the versioned German notice without an API request or personal data", async () => {
    const { calls } = renderPortal(healthy, path);
    expect(
      await screen.findByRole("heading", { name: "Datenschutzhinweise nach Art. 14 DSGVO" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Beispiel Transfergesellschaft mbH/)).toBeInTheDocument();
    expect(screen.getByText(/automatisierte Entscheidung/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("switches the immutable notice to English in the header", async () => {
    renderPortal(healthy, path);
    await chooseLanguage("Sprache: Deutsch", "English");
    expect(
      await screen.findByRole("heading", { name: "Privacy information under Article 14 GDPR" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No automated decision-making/)).toBeInTheDocument();
  });

  it("does not serve an unknown notice version", async () => {
    renderPortal(healthy, "/portal/notice/art14/art14-activation:v2");
    expect(await screen.findByText("Diese Seite gibt es nicht.")).toBeInTheDocument();
  });
});
