import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { json, mockApi, project, renderApp, team, unpinnedConfig } from "./test-utils";

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

function open(viewer: (typeof viewers)[number], type: "ta_tg" | "ta_only") {
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
  });
  renderApp(`/projects/${project.id}`, api);
}

/** The links of the navigation, in order: the organisation's, then the project's sections. */
async function entries() {
  await screen.findByRole("heading", { name: project.name, level: 1 });
  // jsdom runs the narrow layout, where the navigation is in the closed menu.
  const nav = await screen.findByRole("navigation", { name: "Navigation", hidden: true });
  const names = within(nav)
    .getAllByRole("link", { hidden: true })
    .map((link) => link.textContent);
  const tabs = screen.queryAllByRole("tab").map((tab) => tab.textContent);
  return [...names, ...tabs];
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
