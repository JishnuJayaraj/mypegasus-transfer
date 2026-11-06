import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { json, mockApi, problem, project, renderApp, staffUsers } from "./test-utils";

// The staff shell (UX foundation plan, 6b-1). jsdom has no layout and its matchMedia never
// matches, so these run the narrow layout (overlay navigation); the rail is covered by the e2e
// shell project at its widths.

const projects = { "GET /api/v1/projects": () => json({ items: [project], nextCursor: null }) };
const as = (user: (typeof staffUsers)[number]) => ({
  "GET /api/v1/me": () => json(user),
  "GET /api/v1/dev/staff-users": () => json(staffUsers),
  ...projects,
});
const lead = staffUsers[1]!;
const admin = staffUsers[0]!;
const banner = () => screen.getByRole("banner");
const menuButton = async () =>
  within(await screen.findByRole("banner")).findByRole("button", {
    name: "Navigation öffnen oder schließen",
  });
const userMenu = async (name: string) =>
  within(await screen.findByRole("banner")).findByRole("button", { name: `Benutzermenü: ${name}` });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** Nothing of the shell's state is kept in browser storage (data-protection.md, page titles). */
const expectNothingStored = () => {
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
};

describe("staff shell", () => {
  it("shows the login page without navigation or menu button, titled", async () => {
    renderApp("/login", mockApi({ "GET /api/v1/dev/staff-users": () => json(staffUsers) }).api);
    expect(await screen.findByRole("heading", { name: "Anmelden", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(
      within(banner()).queryByRole("button", { name: /Navigation öffnen/ }),
    ).not.toBeInTheDocument();
    expect(within(banner()).getByRole("link", { name: "Transferplattform" })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Anmelden – Transferplattform"));
  });

  it("groups the navigation and marks the active route", async () => {
    renderApp("/projects", mockApi(as(admin)).api);
    const nav = await screen.findByRole("navigation", { name: "Navigation" });
    const work = within(nav).getByRole("list", { name: "Arbeit" });
    const administration = within(nav).getByRole("list", { name: "Verwaltung" });
    expect(within(work).getByRole("link", { name: "Projekte" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(administration).getByRole("link", { name: "Mitarbeitende" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(administration).getByRole("link", { name: "Regionen" })).toBeInTheDocument();
    expect(within(administration).getByRole("link", { name: "Eskalationen" })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Projekte – Transferplattform"));
  });

  it("shows no 'Verwaltung' to a project lead", async () => {
    renderApp("/projects", mockApi(as(lead)).api);
    const nav = await screen.findByRole("navigation", { name: "Navigation" });
    expect(within(nav).getByRole("list", { name: "Arbeit" })).toBeInTheDocument();
    expect(within(nav).queryByRole("list", { name: "Verwaltung" })).not.toBeInTheDocument();
  });

  it("opens the navigation as an overlay with the focus inside, closes on Escape, returns the focus", async () => {
    renderApp("/projects", mockApi(as(admin)).api);
    const button = await menuButton();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "Navigation" });
    const links = within(nav).getAllByRole("link");
    await waitFor(() => expect(links[0]).toHaveFocus());
    // The page behind the overlay is out of reach.
    expect(document.getElementById("main-content")).toHaveAttribute("inert");

    // The focus trap: Shift+Tab from the first link goes to the last, Tab from the last to the first.
    await userEvent.tab({ shift: true });
    expect(links.at(-1)).toHaveFocus();
    await userEvent.tab();
    expect(links[0]).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(document.getElementById("main-content")).not.toHaveAttribute("inert");
    expectNothingStored();
  });

  it("closes the overlay when a link is followed", async () => {
    const { router } = renderApp(
      "/projects",
      mockApi({ ...as(admin), "GET /api/v1/admin/regions": () => json([]) }).api,
    );
    await userEvent.click(await menuButton());
    await userEvent.click(screen.getByRole("link", { name: "Regionen" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/regions"));
    expect(await menuButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("puts name, role, 'Abmelden' and the dev switcher in the user menu", async () => {
    renderApp("/projects", mockApi(as(admin)).api);
    const button = await userMenu("Erika Musterfrau");
    // Closed, the panel holds nothing (nothing hidden in the tab order).
    expect(within(banner()).queryByRole("button", { name: "Abmelden" })).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = within(banner()).getByRole("region", { name: "Benutzermenü: Erika Musterfrau" });
    expect(within(panel).getByText("Erika Musterfrau")).toBeInTheDocument();
    expect(within(panel).getByText("Admin")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Abmelden" })).toBeInTheDocument();
    expect(
      await within(panel).findByRole("list", { name: "Entwicklungsbenutzer wechseln" }),
    ).toBeInTheDocument();
  });

  it("closes the user menu on Escape and returns the focus to its button", async () => {
    renderApp("/projects", mockApi(as(lead)).api);
    const button = await userMenu("Petra Projektleitung");
    await userEvent.click(button);
    const panel = within(banner()).getByRole("region", { name: /Benutzermenü/ });
    // Without an organisation role, the project roles are named per project.
    expect(within(panel).getByText("Rollen je Projekt (siehe Team)")).toBeInTheDocument();
    await userEvent.tab();
    expect(within(panel).getByRole("button", { name: "Abmelden" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(
      within(banner()).queryByRole("region", { name: /Benutzermenü/ }),
    ).not.toBeInTheDocument();
    expectNothingStored();
  });

  it("shows no dev switcher where the dev routes don't answer (OIDC)", async () => {
    renderApp(
      "/projects",
      mockApi({
        "GET /api/v1/me": () => json(lead),
        "GET /api/v1/dev/staff-users": () => problem(404, "not-found"),
        ...projects,
      }).api,
    );
    await userEvent.click(await userMenu("Petra Projektleitung"));
    const panel = within(banner()).getByRole("region", { name: /Benutzermenü/ });
    expect(within(panel).getByRole("button", { name: "Abmelden" })).toBeInTheDocument();
    expect(within(panel).queryByRole("list")).not.toBeInTheDocument();
  });
});
