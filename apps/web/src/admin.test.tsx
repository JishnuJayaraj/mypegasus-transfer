import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  chooseRowAction,
  json,
  mockApi,
  problem,
  regions,
  renderApp,
  staffUsers,
} from "./test-utils";

// Org administration (Q126): the global admin's staff accounts, org roles and regions. The
// navigation shows them to the global admin only; the API refuses everyone else.
const [admin, lead] = staffUsers as [(typeof staffUsers)[0], (typeof staffUsers)[0]];
const account = (overrides: object = {}) => ({
  id: "00000000-0000-4000-8000-000000000004",
  displayName: "Bernd Beratung",
  email: "consultant@example.org",
  mayCreateProjects: false,
  orgRoles: [],
  identityBound: false,
  deactivatedAt: null,
  createdAt: "2026-10-15T08:00:00.000000Z",
  ...overrides,
});

function setup(routes: Parameters<typeof mockApi>[0] = {}, me: object = admin) {
  return mockApi({
    "GET /api/v1/me": () => json(me),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    "GET /api/v1/projects": () => json({ items: [], nextCursor: null }),
    "GET /api/v1/staff-users": () => json({ items: [account()], nextCursor: null }),
    ...routes,
  });
}

describe("the administration navigation", () => {
  it("shows staff and regions to the global admin only", async () => {
    renderApp("/projects", setup().api);
    expect(await screen.findByRole("link", { name: "Mitarbeitende" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Regionen" })).toBeInTheDocument();
  });

  it("hides them from a PL, and shows the PL 'Neues Projekt'", async () => {
    renderApp("/projects", setup({}, lead).api);
    expect(await screen.findByRole("link", { name: "Neues Projekt" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Mitarbeitende" })).toBeNull();
  });

  it("offers 'Neues Projekt' only to accounts that may create projects", async () => {
    renderApp("/projects", setup().api);
    expect(await screen.findByRole("link", { name: "Mitarbeitende" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Neues Projekt" })).toBeNull();
  });
});

describe("/admin/staff", () => {
  it("creates an account with the project-creation flag", async () => {
    const { api, calls } = setup({
      "POST /api/v1/staff-users": () =>
        json(account({ id: "00000000-0000-4000-8000-000000000009" }), 201),
    });
    renderApp("/admin/staff", api);
    await userEvent.click(await screen.findByRole("button", { name: "Konto anlegen" }));
    await userEvent.type(screen.getByLabelText("Name"), "Anna Beispiel");
    await userEvent.type(screen.getByLabelText("E-Mail"), "anna@example.org");
    await userEvent.click(screen.getByLabelText(/Darf Projekte anlegen/));
    const form = within(screen.getByRole("form", { name: "Konto" }));
    await userEvent.click(form.getByRole("button", { name: "Konto anlegen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: "POST /api/v1/staff-users",
        body: { displayName: "Anna Beispiel", email: "anna@example.org", mayCreateProjects: true },
      }),
    );
  });

  it("refuses an invalid email on the client and names a taken one", async () => {
    const { api, calls } = setup({
      "POST /api/v1/staff-users": () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "/email", code: "email_taken", detail: "Refused" }],
        }),
    });
    renderApp("/admin/staff", api);
    await userEvent.click(await screen.findByRole("button", { name: "Konto anlegen" }));
    await userEvent.type(screen.getByLabelText("Name"), "Anna Beispiel");
    await userEvent.type(screen.getByLabelText("E-Mail"), "anna");
    const form = within(screen.getByRole("form", { name: "Konto" }));
    await userEvent.click(form.getByRole("button", { name: "Konto anlegen" }));
    expect(await screen.findByText("Ungültige Eingabe")).toBeInTheDocument();
    expect(calls.some((c) => c.key === "POST /api/v1/staff-users")).toBe(false);
    await userEvent.type(screen.getByLabelText("E-Mail"), "@example.org");
    await userEvent.click(form.getByRole("button", { name: "Konto anlegen" }));
    expect(
      await screen.findByText("Diese E-Mail-Adresse gehört schon zu einem Konto."),
    ).toBeInTheDocument();
  });

  it("sets the org roles as one set: a regional role names its region", async () => {
    const { api, calls } = setup({
      [`PUT /api/v1/staff-users/${account().id}/org-roles`]: ({ body }) =>
        json(account(body as object)),
    });
    renderApp("/admin/staff", api);
    await chooseRowAction("Bernd Beratung", "Bearbeiten");
    const roles = within(
      (await screen.findByRole("heading", { name: "Organisationsrollen" })).closest("section")!,
    );
    const add = roles.getByRole("button", { name: "Rolle hinzufügen" });
    // Authorised but blocked: the prerequisite as text (ui-patterns.md, C1).
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription("Erst eine Region wählen.");
    await userEvent.selectOptions(
      roles.getByLabelText("Region (Niederlassung)"),
      await roles.findByRole("option", { name: "Niederlassung Süd (SUED)" }),
    );
    await userEvent.click(add);
    await userEvent.click(roles.getByRole("button", { name: "Rollen speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `PUT /api/v1/staff-users/${account().id}/org-roles`,
        body: { orgRoles: [{ role: "regional_admin", regionId: regions[1]!.id }] },
      }),
    );
  });

  it("deactivates after a confirmation and explains a refusal for the last PL", async () => {
    let refuse = true;
    const { api, calls } = setup({
      [`POST /api/v1/staff-users/${account().id}/deactivation`]: () =>
        refuse
          ? problem(422, "domain-error", {
              errors: [{ pointer: "", code: "last_project_lead", detail: "Refused" }],
            })
          : json(account({ deactivatedAt: "2026-10-20T08:00:00.000000Z" })),
    });
    renderApp("/admin/staff", api);
    await chooseRowAction("Bernd Beratung", "Bearbeiten");
    await userEvent.click(await screen.findByRole("button", { name: "Konto deaktivieren" }));
    expect(screen.getByText("Bernd Beratung wirklich deaktivieren?")).toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith("/deactivation"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Konto deaktivieren" }));
    expect(await screen.findByText(/letzte aktive Projektleitung/)).toBeInTheDocument();
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Konto deaktivieren" }));
    await userEvent.click(screen.getByRole("button", { name: "Konto deaktivieren" }));
    expect(await screen.findByText("Konto deaktiviert")).toBeInTheDocument();
  });
});

describe("/admin/staff side panel (ui-patterns.md, C4)", () => {
  it("asks before discarding an edited account; Escape keeps the input", async () => {
    renderApp("/admin/staff", setup().api);
    await chooseRowAction("Bernd Beratung", "Bearbeiten");
    const panel = await screen.findByRole("dialog", { name: "Bernd Beratung" });
    const name = within(panel).getByLabelText("Name");
    await userEvent.type(name, " Neu");
    await userEvent.keyboard("{Escape}");
    expect(
      await screen.findByRole("alertdialog", { name: "Änderungen verwerfen?" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Weiter bearbeiten" })).toHaveFocus(),
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(name).toHaveValue("Bernd Beratung Neu");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("closes an unchanged account without asking", async () => {
    renderApp("/admin/staff", setup().api);
    await chooseRowAction("Bernd Beratung", "Bearbeiten");
    const panel = await screen.findByRole("dialog", { name: "Bernd Beratung" });
    await userEvent.click(within(panel).getByLabelText("Name"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("offers no edit action for a deactivated account", async () => {
    const { api } = setup({
      "GET /api/v1/staff-users": () =>
        json({
          items: [
            account(),
            account({
              id: "00000000-0000-4000-8000-000000000008",
              displayName: "Dora Deaktiviert",
              deactivatedAt: "2026-10-20T08:00:00.000000Z",
            }),
          ],
          nextCursor: null,
        }),
    });
    renderApp("/admin/staff", api);
    expect(await screen.findByRole("cell", { name: "Dora Deaktiviert" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aktionen für Bernd Beratung" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Aktionen für Dora Deaktiviert" }),
    ).not.toBeInTheDocument();
  });
});

describe("/admin/regions", () => {
  it("lists, creates and renames regions", async () => {
    const { api, calls } = setup({
      "GET /api/v1/regions": () => json(regions),
      "POST /api/v1/regions": () => json({ ...regions[0], id: regions[0]!.id }, 201),
      [`PATCH /api/v1/regions/${regions[0]!.id}`]: () => json(regions[0]),
    });
    renderApp("/admin/regions", api);
    expect(await screen.findByRole("cell", { name: "Niederlassung Süd" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Region anlegen" }));
    await userEvent.type(screen.getByLabelText("Kürzel"), "ost");
    await userEvent.type(screen.getByLabelText("Name"), "Niederlassung Ost");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: "POST /api/v1/regions",
        body: { code: "OST", name: "Niederlassung Ost" },
      }),
    );
    await chooseRowAction("NORD", "Bearbeiten");
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Nord");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `PATCH /api/v1/regions/${regions[0]!.id}`,
        body: { name: "Nord" },
      }),
    );
  });
});

// The regional view of escalations (data-protection.md, the regional view; Q57): counts and PLs
// per project, never a participant.
describe("/admin/escalations", () => {
  const regionalAdmin = {
    id: "00000000-0000-4000-8000-000000000002",
    displayName: "Rita Region",
    role: "regional_admin",
    mayCreateProjects: false,
    orgRoles: [{ role: "regional_admin", regionId: regions[0]!.id }],
  };
  const escalations = {
    generatedAt: "2026-11-04T08:00:00.000Z",
    rows: [
      {
        projectId: "00000000-0000-4000-9000-000000000001",
        projectName: "Werk Nord",
        leads: ["Petra Projektleitung"],
        counts: [
          { type: "tl407_not_submitted", count: 3, oldestDaysOverdue: 5 },
          { type: "profiling_compliance", count: 1, oldestDaysOverdue: 0 },
        ],
      },
    ],
  };

  it("shows the regional admin the counts per project and type, with the PLs", async () => {
    const { api } = setup({ "GET /api/v1/escalations": () => json(escalations) }, regionalAdmin);
    renderApp("/projects", api);
    await userEvent.click(await screen.findByRole("link", { name: "Eskalationen" }));
    const table = await screen.findByRole("table", { name: "Eskalationen" });
    const row = within(table).getByRole("row", { name: /Werk Nord/ });
    expect(row).toHaveTextContent("Petra Projektleitung");
    expect(row).toHaveTextContent("3 × (älteste seit 5 Tagen)");
    expect(row).toHaveTextContent("1 × (älteste seit heute)");
    expect(screen.queryByRole("link", { name: "Mitarbeitende" })).toBeNull();
  });

  it("is not in a PL's navigation and says so when refused", async () => {
    const { api } = setup({ "GET /api/v1/escalations": () => problem(403, "forbidden") }, lead);
    renderApp("/admin/escalations", api);
    expect(
      await screen.findByText("Die Eskalationen sehen nur Regional-Admins und Admins."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Eskalationen" })).toBeNull();
  });
});
