import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { projectFunnel } from "@transfer/domain";
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
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ tab: "participants", agentur: "open" }),
    );
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
  it("draws each status as a bar of all participations, with the number as text", async () => {
    setup([
      worklistItem({ id: id(1), status: "informed" }),
      worklistItem({ id: id(2), personnelNumber: "BSP-0002", status: "informed" }),
      worklistItem({ id: id(3), personnelNumber: "BSP-0003", status: "contacted" }),
      worklistItem({ id: id(4), personnelNumber: "BSP-0004", status: "contacted" }),
    ]);
    const progress = within(await screen.findByRole("region", { name: "Verlauf" }));
    expect(progress.getByRole("link", { name: "4 Teilnehmende" })).toBeInTheDocument();
    const statuses = within(progress.getByRole("table", { name: "Status" }));
    const informed = statuses.getByRole("row", { name: /Informiert/ });
    expect(within(informed).getByRole("link", { name: "2" })).toBeInTheDocument();
    // A CSS width through React's style prop (CSP-safe); decorative, the number is the text.
    const bar = informed.querySelector<HTMLElement>(".tp-bar")!;
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar.querySelector<HTMLElement>(".tp-bar-fill")!.style.inlineSize).toBe("50%");
    const exited = statuses.getByRole("row", { name: /Ausgetreten/ });
    expect(exited.querySelector<HTMLElement>(".tp-bar-fill")!.style.inlineSize).toBe("0%");
    // The DSV track as its own bars (ta_tg; C3: never one sequence with the main status).
    expect(progress.getByRole("table", { name: "DSV" })).toBeInTheDocument();
  });
});

describe("the project page", () => {
  it("has one h1 with breadcrumb, tags and the region, and the tabs by frequency", async () => {
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
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Übersicht",
      "Teilnehmende",
      "Termine",
      "Agentur",
      "Einrichtung",
      "Team",
    ]);
    // No panel repeats its tab's label as a heading (principle 6, AC 3).
    await screen.findByRole("region", { name: "Heute zu tun" });
    expect(screen.queryByRole("heading", { name: "Übersicht" })).toBeNull();
  });

  it("opens each tab by its search value, whatever its position", async () => {
    setup([], ["project_lead"], "?tab=setup");
    expect(await screen.findByRole("tab", { name: "Einrichtung", selected: true })).toBeVisible();
    expect(await screen.findByRole("region", { name: "Projekt" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Einrichtung" })).toBeNull();
    // The anchor list names every card; the import keeps its id for "Datei importieren".
    const anchors = within(screen.getByRole("navigation", { name: "Auf dieser Seite" }));
    expect(anchors.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Projekt",
      "Agentur",
      "Eintrittswellen",
      "Kopf der Kug 200a",
      "DSV-Vorlage",
      "Abrechnung",
      "Import",
    ]);
    expect(anchors.getByRole("link", { name: "Import" }).getAttribute("href")).toMatch(
      /tab=setup#project-import$/,
    );
    expect(document.getElementById("project-import")).toHaveAccessibleName("Import");
  });
});
