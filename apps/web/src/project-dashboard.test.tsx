import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { funnelFilters, projectFunnel } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import { featuredTiles } from "./components/project-dashboard";
import { tileViews } from "./components/worklist-views";
import de from "./locales/de/translation.json";
import {
  json,
  mockApi,
  project,
  renderApp,
  shownPersonnelNumbers,
  staffUsers,
  team,
  unpinnedConfig,
  worklist,
  worklistItem,
  worklistSection,
} from "./test-utils";

// The project page and its "Übersicht" (the plan of Slice 6b, 6b-4; ui-patterns.md, dashboard).
// Synthetic rows only.
const path = `/api/v1/projects/${project.id}`;
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

const dashboard = (rows: object[]) => ({
  scope: "project",
  generatedAt: "2026-10-22T08:42:00.000Z",
  counts: projectFunnel(rows as never, { type: "ta_tg", waves: [] }),
});

/** The viewer is staffUsers[1], with `roles` in the project's team. */
function setup(items: object[], roles = ["project_lead"], at = "") {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(unpinnedConfig),
    [`GET ${path}/members`]: () =>
      json({
        ...team,
        members: team.members.map((member) =>
          member.staffUserId === staffUsers[1]!.id ? { ...member, roles } : member,
        ),
      }),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`GET ${path}/worklist`]: () => json(worklist(items)),
    [`GET ${path}/dashboard`]: () => json(dashboard(items)),
  });
  return { ...mock, ...renderApp(`/projects/${project.id}${at}`, mock.api) };
}

const today = async () => within(await screen.findByRole("region", { name: "Heute zu tun" }));
const tileNames = async () =>
  (await today())
    .getAllByRole("listitem")
    .filter((item) => item.querySelector(".tp-tile"))
    .map((item) => within(item).getByRole("link").textContent);

describe("Heute zu tun", () => {
  // A participation that has left, with only a mandatory BA report open: none of the four views
  // counts it (process-and-lifecycle.md, BA reporting).
  const reportOnly = worklistItem({
    id: id(1),
    status: "exited",
    agenturItems: [{ kind: "ba_report_pending", date: "2026-10-01" }],
  });

  it("says 'Keine offenen Punkte in diesen Ansichten' with the four at zero, and keeps the other open work linked (AC 17)", async () => {
    const { router } = setup([reportOnly]);
    expect(await tileNames()).toEqual([
      "0 Überfällig",
      "0 In den nächsten 14 Tagen",
      "0 Angaben/Unterlagen fehlen",
      "0 Termine zu klären",
    ]);
    expect(
      (await today()).getByText("Keine offenen Punkte in diesen Ansichten"),
    ).toBeInTheDocument();
    // Never an all-clear: open work outside these views isn't counted there.
    expect(screen.queryByText(/Alles erledigt/i)).toBeNull();
    const more = within(screen.getByRole("region", { name: "Weitere offene Arbeit" }));
    const agentur = more.getByRole("link", { name: "1 Agentur offen" });
    expect(more.getByRole("link", { name: "0 Hinweise" })).toBeInTheDocument();
    await userEvent.click(agentur);
    await waitFor(() => expect(router.state.location.search).toEqual({ agentur: "open" }));
    await worklistSection();
    await waitFor(() => expect(shownPersonnelNumbers()).toEqual(["BSP-0001"]));
  });

  it("doesn't say it while a featured view has rows, and marks that tile by severity", async () => {
    setup([
      reportOnly,
      worklistItem({
        id: id(2),
        personnelNumber: "BSP-0002",
        deadlines: [{ kind: "privacy_notice", date: "2026-10-01", state: "overdue" }],
      }),
    ]);
    const overdue = (await today()).getByRole("link", { name: "1 Überfällig" });
    expect(overdue).toHaveClass("tp-tile--danger");
    expect((await today()).getByRole("link", { name: "0 Termine zu klären" })).toHaveClass(
      "tp-tile--neutral",
    );
    expect(overdue.getAttribute("href")).toContain("deadlineState=overdue");
    expect(screen.queryByText("Keine offenen Punkte in diesen Ansichten")).toBeNull();
  });

  it("features 'Hinweise' for anyone but the PL, each tile labelled like its quick view", async () => {
    setup([reportOnly], ["back_office"]);
    expect(await tileNames()).toEqual([
      "0 Überfällig",
      "0 In den nächsten 14 Tagen",
      "0 Angaben/Unterlagen fehlen",
      "0 Hinweise",
    ]);
    // "Termine zu klären" stays reachable under "Weitere offene Arbeit".
    const more = within(screen.getByRole("region", { name: "Weitere offene Arbeit" }));
    expect(more.getByRole("link", { name: "0 Termine zu klären" })).toBeInTheDocument();
    for (const projectLead of [true, false]) {
      for (const { key } of featuredTiles(projectLead)) {
        expect(tileViews[key]).toBeDefined();
        expect(de.worklist.views[tileViews[key]!]).toBeTruthy();
      }
    }
  });
});

describe("Verlauf", () => {
  it("is one row per track, each number opening exactly its rows (C3)", async () => {
    setup([
      worklistItem({ id: id(1), status: "informed" }),
      worklistItem({ id: id(2), personnelNumber: "BSP-0002", status: "informed" }),
      worklistItem({ id: id(3), personnelNumber: "BSP-0003", status: "contacted" }),
      worklistItem({ id: id(4), personnelNumber: "BSP-0004", status: "contacted" }),
    ]);
    const progress = within(await screen.findByRole("region", { name: "Verlauf" }));
    expect(progress.getByRole("link", { name: "4 Teilnehmende" })).toBeInTheDocument();
    // The main status is one row of stages; the DSV track is its own row, never one sequence.
    const statuses = progress.getByRole("list", { name: "Status" });
    expect(within(statuses).getByRole("link", { name: "2 Informiert" })).toHaveAttribute(
      "href",
      expect.stringContaining("status=informed"),
    );
    expect(within(statuses).getByRole("link", { name: "2 Kontaktiert" })).toBeInTheDocument();
    expect(within(statuses).getByText("Ausgetreten").closest("li")).toHaveTextContent(
      "0 Ausgetreten",
    );
    expect(progress.queryByRole("table", { name: "Status" })).toBeNull();
    expect(progress.getByRole("list", { name: "DSV" })).toBeInTheDocument();
  });

  it("links each stage of a track to exactly the rows its filter counts", async () => {
    setup([
      worklistItem({ id: id(1), status: "informed" }),
      worklistItem({ id: id(2), personnelNumber: "BSP-0002", status: "contacted" }),
    ]);
    const statuses = within(
      (await screen.findByRole("region", { name: "Verlauf" })).querySelector("ol")!,
    );
    const informed = statuses.getByRole("link", { name: "1 Informiert" });
    expect(new URL(informed.getAttribute("href")!, "http://x").search).toBe("?status=informed");
  });
});

describe("every number opens exactly its rows", () => {
  // The rows the page counts are the work list's, so a count and its list share one predicate
  // (data-protection.md, the dashboard): each link's search is the counted filter, and the
  // count is the number of rows that filter selects.
  const rows = [
    worklistItem({
      id: id(1),
      status: "informed",
      deadlines: [{ kind: "tg_start", date: "2026-10-30", state: "overdue" }],
    }),
    worklistItem({ id: id(2), personnelNumber: "BSP-0002", status: "informed" }),
    worklistItem({ id: id(3), personnelNumber: "BSP-0003", status: "contacted" }),
  ];

  it("links each Verlauf stage to the work list with its filter and the counted rows", async () => {
    setup(rows);
    const progress = within(await screen.findByRole("region", { name: "Verlauf" }));
    const funnel = funnelFilters({ type: "ta_tg", waves: [] }).statuses;
    const informed = progress.getByRole("link", { name: "2 Informiert" });
    const filter = funnel.find((f) => f.key === "informed")!.filter;
    const search = new URL(informed.getAttribute("href")!, "http://x").search;
    expect(search).toBe(`?status=${filter.status}`);
    const selected = rows.filter((row) => row.status === filter.status);
    expect(selected).toHaveLength(2);
  });

  it("links each today tile with the quick view's filter (the same rows as its list)", async () => {
    setup(rows);
    const tiles = within(await screen.findByRole("region", { name: "Heute zu tun" }));
    const overdue = tiles.getByRole("link", { name: "1 Überfällig" });
    expect(new URL(overdue.getAttribute("href")!, "http://x").search).toContain(
      "deadlineState=overdue",
    );
  });
});

describe("Kennzahlen", () => {
  it("shows only values above zero, and 'Alle anzeigen' the rest, in the viewer's own choice", async () => {
    const { router } = setup([
      worklistItem({ id: id(1), status: "informed" }),
      worklistItem({ id: id(2), personnelNumber: "BSP-0002", status: "contacted" }),
    ]);
    await screen.findByRole("region", { name: "Verlauf" });
    const figures = screen.getByRole("region", { name: "Kennzahlen" });
    // Only the counts above zero: the two "Nicht begonnen" rows are listed, the zeros are not.
    const profiling = within(figures).getByRole("table", { name: "Profiling" });
    expect(within(profiling).getByRole("row", { name: /Nicht begonnen/ })).toHaveTextContent("2");
    expect(within(figures).queryByRole("row", { name: /Abgelehnt/ })).toBeNull();
    const more = within(figures).getByRole("button", { name: "Alle anzeigen" });
    await userEvent.click(more);
    expect(within(figures).getByRole("row", { name: /Abgelehnt/ })).toBeInTheDocument();
    expect(within(figures).getByRole("button", { name: "Nur Werte über 0" })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({});
  });
});

describe("the project page", () => {
  it("has one h1 with breadcrumb, tags and the region, and names the section once", async () => {
    setup([]);
    const header = (await screen.findByRole("heading", { level: 1 })).closest(".tp-page-header")!;
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(header as HTMLElement).getByRole("heading", { level: 1 })).toHaveTextContent(
      project.name,
    );
    const crumbs = within(screen.getByRole("navigation", { name: "Navigationspfad" }));
    const crumb = crumbs.getByRole("link", { name: "Projekte" });
    expect(crumb).toHaveAttribute("href", "/projects");
    expect(crumb).not.toHaveAttribute("aria-current");
    const inHeader = within(header as HTMLElement);
    expect(inHeader.getByText("Kunde: Beispiel Maschinenbau GmbH")).toBeInTheDocument();
    expect(inHeader.getByText("Transferagentur und Transfergesellschaft")).toBeInTheDocument();
    expect(inHeader.getByText("Entwurf")).toBeInTheDocument();
    expect(await inHeader.findByText("Region: Niederlassung Nord (NORD)")).toBeInTheDocument();
    // The section is named by one heading under the header (principle 6); navigation.test.tsx
    // covers the entries.
    await screen.findByRole("region", { name: "Heute zu tun" });
    expect(screen.getAllByRole("heading", { name: "Übersicht" })).toHaveLength(1);
  });

  it("opens a section by its old tab address", async () => {
    setup([], ["project_lead"], "?tab=setup");
    expect(await screen.findByRole("region", { name: "Projekt" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Einrichtung" })).toHaveLength(1);
    // The anchor list names every card; the import keeps its id for "Datei importieren".
    const anchors = within(screen.getByRole("navigation", { name: "Auf dieser Seite" }));
    expect(anchors.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Projekt",
      "Agentur",
      "Eintrittswellen",
      "Kopf der Kug 200a",
      "DSV-Vorlage",
      "Import",
      "Abrechnung",
    ]);
    expect(anchors.getByRole("link", { name: "Import" }).getAttribute("href")).toMatch(
      /\/setup#project-import$/,
    );
    expect(document.getElementById("project-import")).toHaveAccessibleName("Import");
  });
});
