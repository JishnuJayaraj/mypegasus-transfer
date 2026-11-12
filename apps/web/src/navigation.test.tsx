import { screen, waitFor, within } from "@testing-library/react";
import { projectFunnel } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  team,
  unpinnedConfig,
  worklist,
  worklistItem,
} from "./test-utils";

// The navigation shows exactly the entries each role had as links and project tabs before the
// project's sections became routes (ui-patterns.md, navigation): the organisation entries by
// organisation role, the project's sections for everyone who opens the project, "Agentur" only in
// a `ta_tg` project. Synthetic users only.

const id = (n: number) => `00000000-0000-4000-8000-0000000000${n}`;
const region = "00000000-0000-4000-b000-000000000101";
type OrgRole = { role: string; regionId: string | null };
const viewers: { name: string; orgRoles: OrgRole[]; projectRoles: string[]; top: string[] }[] = [
  {
    name: "admin",
    orgRoles: [{ role: "admin", regionId: null }],
    projectRoles: [],
    top: ["Projekte", "Mitarbeitende", "Regionen", "Eskalationen"],
  },
  {
    name: "admin of one region",
    orgRoles: [{ role: "admin", regionId: region }],
    projectRoles: [],
    top: ["Projekte", "Mitarbeitende", "Regionen"],
  },
  {
    name: "regional admin",
    orgRoles: [{ role: "regional_admin", regionId: region }],
    projectRoles: [],
    top: ["Projekte", "Eskalationen"],
  },
  {
    name: "regional operations manager",
    orgRoles: [{ role: "regional_operations_manager", regionId: region }],
    projectRoles: [],
    top: ["Projekte", "Freigaben"],
  },
  { name: "project lead", orgRoles: [], projectRoles: ["project_lead"], top: ["Projekte"] },
  { name: "consultant", orgRoles: [], projectRoles: ["consultant"], top: ["Projekte"] },
  { name: "back office", orgRoles: [], projectRoles: ["back_office"], top: ["Projekte"] },
];

const sections = (taTg: boolean) => [
  "Übersicht",
  "Teilnehmende",
  "Termine",
  ...(taTg ? ["Agentur"] : []),
  "Einrichtung",
  "Team",
];

function open(
  viewer: (typeof viewers)[number],
  type: "ta_tg" | "ta_only",
  at = "",
  routes: Parameters<typeof mockApi>[0] = {},
) {
  const me = {
    id: id(40),
    displayName: "Vera Beispiel",
    mayCreateProjects: false,
    orgRoles: viewer.orgRoles,
  };
  const members = [
    ...team.members,
    { staffUserId: me.id, displayName: me.displayName, roles: viewer.projectRoles },
  ];
  const { api } = mockApi({
    "GET /api/v1/me": () => json(me),
    [`GET /api/v1/projects/${project.id}`]: () => json({ ...project, type }),
    [`GET /api/v1/projects/${project.id}/config`]: () => json(unpinnedConfig),
    [`GET /api/v1/projects/${project.id}/members`]: () => json({ ...team, members }),
    [`GET /api/v1/projects/${project.id}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET /api/v1/projects/${project.id}/worklist`]: () => json(worklist([])),
    ...routes,
  });
  return renderApp(`/projects/${project.id}${at}`, api);
}

/** The links of the navigation, in order: the organisation's, then the project's sections. */
async function entries() {
  await screen.findByRole("heading", { name: project.name, level: 1 });
  // jsdom runs the narrow layout, where the navigation is in the closed menu.
  const nav = await screen.findByRole("navigation", { name: "Navigation", hidden: true });
  const names = within(nav)
    .getAllByRole("link", { hidden: true })
    .map((link) => link.textContent);
  // The sections are no longer tabs.
  expect(screen.queryAllByRole("tab")).toEqual([]);
  return names;
}

describe.each(viewers)("the navigation of the $name", (viewer) => {
  it("shows the organisation's entries and every section, with Agentur, in a ta_tg project", async () => {
    open(viewer, "ta_tg");
    expect(await entries()).toEqual([...viewer.top, ...sections(true)]);
  });

  it("shows no Agentur in a ta_only project", async () => {
    open(viewer, "ta_only");
    expect(await entries()).toEqual([...viewer.top, ...sections(false)]);
  });
});

const lead = viewers[4]!;
const path = (router: { state: { location: { pathname: string } } }) =>
  router.state.location.pathname.replace(`/projects/${project.id}`, "");

describe("the project's routes", () => {
  it.each([
    ["", "/overview"],
    ["?tab=participants", "/participants"],
    ["?tab=appointments", "/appointments"],
    ["?tab=agentur", "/agentur"],
    ["?tab=setup", "/setup"],
    ["?tab=team", "/team"],
    ["?tab=unknown", "/overview"],
  ])("redirects the old address '%s' to %s", async (old, route) => {
    const { router } = open(lead, "ta_tg", old);
    await waitFor(() => expect(path(router)).toBe(route));
    expect(router.state.location.search).toEqual({});
  });

  it("keeps the work list's codes and sort, and an anchor, through the redirect", async () => {
    const { router } = open(lead, "ta_tg", "?tab=participants&deadlineState=overdue&sort=-name");
    await waitFor(() => expect(path(router)).toBe("/participants"));
    expect(router.state.location.search).toEqual({ deadlineState: "overdue", sort: "-name" });
    await router.navigate({ href: `/projects/${project.id}?tab=setup#project-import` });
    await waitFor(() => expect(path(router)).toBe("/setup"));
    expect(router.state.location.hash).toBe("project-import");
  });

  it("names the section in a heading, the title and the current navigation entry", async () => {
    open(lead, "ta_tg", "/team");
    expect(await screen.findByRole("heading", { name: "Team", level: 2 })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe(`Team · ${project.name} – Transferplattform`));
    const nav = screen.getByRole("navigation", { name: "Navigation", hidden: true });
    const current = within(nav)
      .getAllByRole("link", { hidden: true })
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Team"]);
  });

  it("shows the overview on the Agentur route of a ta_only project", async () => {
    const { router } = open(lead, "ta_only", "?tab=agentur");
    expect(await screen.findByRole("heading", { name: "Übersicht", level: 2 })).toBeInTheDocument();
    expect(path(router)).toBe("/agentur");
    await waitFor(() =>
      expect(document.title).toBe(`Übersicht · ${project.name} – Transferplattform`),
    );
  });
});

describe("the navigation's badge", () => {
  const overdue = worklistItem({
    deadlines: [{ kind: "privacy_notice", date: "2026-10-01", state: "overdue" }],
  });
  const dashboard = (rows: object[]) => ({
    scope: "project",
    generatedAt: "2026-10-22T08:42:00.000Z",
    counts: projectFunnel(rows as never, { type: "ta_tg", waves: [] }),
  });
  const participants = async () =>
    within(await screen.findByRole("navigation", { name: "Navigation", hidden: true })).findByRole(
      "link",
      { name: /^Teilnehmende/, hidden: true },
    );

  it("shows the overdue count of the dashboard the viewer gets", async () => {
    const rows = [overdue];
    const count = dashboard(rows).counts.tiles.find((t) => t.key === "deadline_overdue")!.count;
    expect(count).toBe(1);
    open(lead, "ta_tg", "/team", {
      [`GET /api/v1/projects/${project.id}/dashboard`]: () => json(dashboard(rows)),
    });
    await waitFor(async () =>
      expect(await participants()).toHaveAccessibleName("Teilnehmende 1 überfällig"),
    );
  });

  it("shows none at zero", async () => {
    open(lead, "ta_tg", "/team", {
      [`GET /api/v1/projects/${project.id}/dashboard`]: () => json(dashboard([])),
    });
    await screen.findByRole("heading", { name: "Team", level: 2 });
    expect(await participants()).toHaveAccessibleName("Teilnehmende");
  });

  it("shows none to a viewer the dashboard refuses", async () => {
    const { queryClient } = open(lead, "ta_tg", "/team", {
      [`GET /api/v1/projects/${project.id}/dashboard`]: () => problem(403, "forbidden"),
    });
    await screen.findByRole("heading", { name: "Team", level: 2 });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(await participants()).toHaveAccessibleName("Teilnehmende");
  });
});
