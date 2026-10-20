import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  consultant,
  json,
  mockApi,
  problem,
  project,
  regions,
  renderApp,
  staffUsers,
  team,
  unpinnedConfig,
} from "./test-utils";

// Teams, assignments and the project's region (Q62, Q126): what the PL and the global admin are
// offered follows the server's capabilities; the API decides again.
const path = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const backOffice = { id: "00000000-0000-4000-8000-000000000005", displayName: "Birgit Backoffice" };
const item = (id: string, personnelNumber: string, consultants: object[] = []) => ({
  id,
  status: "imported",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  entryWaveId: null,
  personnelNumber,
  lastName: "Mustermann",
  firstName: "Erika",
  consultants,
});

function setup(routes: Parameters<typeof mockApi>[0] = {}, me = staffUsers[1]) {
  return mockApi({
    "GET /api/v1/me": () => json(me),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(unpinnedConfig),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`GET ${path}/participations`]: () =>
      json({
        items: [
          item(participationId, "BSP-0001", [
            {
              staffUserId: consultant.id,
              displayName: consultant.displayName,
              assignedAt: "2026-10-20T08:00:00.000000Z",
            },
          ]),
          item("00000000-0000-4000-a000-000000000002", "BSP-0002"),
        ],
        nextCursor: null,
      }),
    ...routes,
  });
}

const openTeam = async () => {
  await userEvent.click(await screen.findByRole("tab", { name: "Team" }));
  return within(
    (await screen.findByRole("heading", { name: "Team", level: 2 })).closest("section")!,
  );
};

describe("the Team tab (Q126)", () => {
  it("lists the members with their roles and adds one found in the staff directory", async () => {
    const { api, calls } = setup({
      "GET /api/v1/staff-directory": ({ query }) =>
        json(query.get("search") === "Birgit" ? [backOffice] : []),
      [`POST ${path}/members`]: () => json(team, 201),
    });
    renderApp(`/projects/${project.id}`, api);
    const section = await openTeam();
    expect(section.getByRole("cell", { name: "Bernd Beratung" })).toBeInTheDocument();
    await userEvent.type(section.getByLabelText("Name suchen"), "Birgit");
    await userEvent.selectOptions(
      section.getByLabelText("Person"),
      await section.findByRole("option", { name: "Birgit Backoffice" }),
    );
    await userEvent.selectOptions(section.getByLabelText("Rolle"), "back_office");
    await userEvent.click(section.getByRole("button", { name: "Hinzufügen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${path}/members`,
        body: { staffUserId: backOffice.id, role: "back_office" },
      }),
    );
    expect(await screen.findByText("Mitglied hinzugefügt")).toBeInTheDocument();
  });

  it("removes a role, and explains why the last active PL stays", async () => {
    const { api, calls } = setup({
      [`DELETE ${path}/members/${staffUsers[1]!.id}/project_lead`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "", code: "last_project_lead", detail: "Refused" }],
        }),
      [`DELETE ${path}/members/${consultant.id}/consultant`]: () =>
        new Response(null, { status: 204 }),
    });
    renderApp(`/projects/${project.id}`, api);
    const section = await openTeam();
    await userEvent.click(
      section.getByRole("button", { name: "Projektleitung von Petra Projektleitung entfernen" }),
    );
    expect(
      await section.findByText("Das Projekt braucht mindestens eine aktive Projektleitung."),
    ).toBeInTheDocument();
    await userEvent.click(
      section.getByRole("button", { name: "Beratung von Bernd Beratung entfernen" }),
    );
    await waitFor(() =>
      expect(calls.map((c) => c.key)).toContain(
        `DELETE ${path}/members/${consultant.id}/consultant`,
      ),
    );
  });

  it("offers the global admin only a replacement PL, and no removals", async () => {
    const { api } = setup(
      {
        [`GET ${path}/members`]: () =>
          json({
            ...team,
            capabilities: {
              manageMembers: false,
              addReplacementLead: true,
              assignParticipations: false,
            },
          }),
      },
      staffUsers[0],
    );
    renderApp(`/projects/${project.id}`, api);
    const section = await openTeam();
    expect(
      section.getByRole("heading", { name: "Ersatz-Projektleitung hinzufügen" }),
    ).toBeInTheDocument();
    const roles = within(section.getByLabelText("Rolle")).getAllByRole("option");
    expect(roles.map((o) => o.textContent)).toEqual(["Projektleitung"]);
    expect(section.queryByRole("button", { name: /entfernen/ })).toBeNull();
  });

  it("offers nothing to change without the capabilities", async () => {
    const { api } = setup({
      [`GET ${path}/members`]: () =>
        json({
          ...team,
          capabilities: {
            manageMembers: false,
            addReplacementLead: false,
            assignParticipations: false,
          },
        }),
    });
    renderApp(`/projects/${project.id}`, api);
    const section = await openTeam();
    expect(section.queryByLabelText("Name suchen")).toBeNull();
    expect(section.queryByRole("button", { name: /entfernen/ })).toBeNull();
  });
});

describe("assignments (Q62)", () => {
  it("shows the consultants per participant and assigns the selected ones in bulk", async () => {
    const { api, calls } = setup({
      [`POST ${path}/assignments`]: () => json({ assigned: 1 }),
    });
    renderApp(`/projects/${project.id}`, api);
    await screen.findByRole("cell", { name: "BSP-0001" });
    const list = within(
      document.querySelector<HTMLElement>('[aria-labelledby="project-participants"]')!,
    );
    const row = (await list.findByRole("cell", { name: "BSP-0001" })).closest("tr")!;
    expect(within(row).getByRole("cell", { name: "Bernd Beratung" })).toBeInTheDocument();
    const assign = list.getByRole("button", { name: "Zuweisen (0)" });
    expect(assign).toBeDisabled();
    await userEvent.click(list.getByLabelText("BSP-0002 auswählen"));
    await userEvent.selectOptions(list.getByLabelText("Beraterin oder Berater"), consultant.id);
    await userEvent.click(list.getByRole("button", { name: "Zuweisen (1)" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${path}/assignments`,
        body: {
          staffUserId: consultant.id,
          participationIds: ["00000000-0000-4000-a000-000000000002"],
        },
      }),
    );
    expect(await screen.findByText("1 Teilnehmende zugewiesen")).toBeInTheDocument();
  });

  it("offers no selection without the capability", async () => {
    const { api } = setup({
      [`GET ${path}/members`]: () =>
        json({ ...team, capabilities: { ...team.capabilities, assignParticipations: false } }),
    });
    renderApp(`/projects/${project.id}`, api);
    expect(await screen.findByRole("cell", { name: "BSP-0001" })).toBeInTheDocument();
    expect(screen.queryByLabelText("BSP-0002 auswählen")).toBeNull();
    expect(screen.queryByRole("button", { name: /Zuweisen/ })).toBeNull();
  });
});

describe("the project's region (Q126)", () => {
  it("is changed with the capability, and shown without it", async () => {
    const { api, calls } = setup({
      [`PATCH ${path}`]: () => json({ ...project, regionId: regions[1]!.id }),
    });
    renderApp(`/projects/${project.id}`, api);
    await userEvent.selectOptions(
      await screen.findByLabelText("Region (Niederlassung)"),
      await screen.findByRole("option", { name: "Niederlassung Süd (SUED)" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Region ändern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ key: `PATCH ${path}`, body: { regionId: regions[1]!.id } }),
    );
  });

  it("is only shown when the viewer may not change it", async () => {
    const { api } = setup({
      [`GET ${path}/config`]: () =>
        json({
          ...unpinnedConfig,
          capabilities: { ...unpinnedConfig.capabilities, setProjectRegion: false },
        }),
    });
    renderApp(`/projects/${project.id}`, api);
    expect(await screen.findByText("Region: Niederlassung Nord (NORD)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Region ändern" })).toBeNull();
  });
});
