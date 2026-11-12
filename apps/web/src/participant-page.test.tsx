import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { forgetWorklistMemory } from "./components/worklist-state";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
  worklist,
  worklistItem,
} from "./test-utils";

// The participant page as the plan of Slice 6b lays it out (6b-5): the header and its way back to
// the work list (C6, AC 4), the three tracks (C3, AC 20), "Offen" in C2's order with its links and
// C1's prerequisites, "Handlungsbedarf" and the timeline's list and keyboard path (D12).

const participationId = "00000000-0000-4000-a000-000000000001";
const projectPath = `/api/v1/projects/${project.id}`;
const detailPath = `/api/v1/participations/${participationId}`;
const pagePath = `/projects/${project.id}/participations/${participationId}`;

const detail = {
  id: participationId,
  projectId: project.id,
  status: "informed",
  profilingStatus: "profiling_in_progress",
  dsvStatus: "dsv_offered",
  statusVersion: 3,
  entryWave: {
    id: "00000000-0000-4000-b000-000000000001",
    code: "W1",
    name: "Welle 1",
    signingDeadline: "2026-10-20",
    defaultTgStart: "2026-12-01",
    defaultTgEnd: "2027-11-30",
    latestEntryDate: "2026-12-15",
  },
  dates: {
    tgStart: null,
    tgEnd: null,
    effectiveTgStart: "2026-12-01",
    effectiveTgEnd: "2027-11-30",
    offerDeadline: "2026-10-20",
    tgEntryDate: null,
    exitDate: null,
    withdrawnOn: null,
    profilingDoneOn: null,
  },
  hints: [],
  placementAgenturKey: null,
  placementAgenturSetAt: null,
  submissionBlockers: [],
  placementAgenturChoices: [],
  person: {
    personnelNumber: "BSP-0001",
    lastName: "Beispiel",
    firstName: "Erika",
    birthDate: "1970-01-01",
    oldEmploymentEndDate: "2026-11-30",
    address: null,
    phone: null,
    mobile: null,
    privateEmail: null,
    workEmail: null,
  },
  assignments: [],
  activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
  privacyNoticeState: { state: "provided", dueOn: "2026-11-15", providedAt: null },
  capabilities: {
    assignEntryWave: false,
    setParticipationDates: false,
    assignParticipations: false,
    issueActivationCode: false,
    recordHandover: false,
    revokeActivationCode: false,
    providePrivacyNotice: false,
    setPlacementAgentur: false,
    startAssistedMode: false,
    viewProfiling: true,
    viewAsu: true,
  },
  refusals: { assignEntryWave: "dsv_already_offered", setParticipationDates: "dsv_offer_open" },
};

/** The work list's row: one item of each tier, deliberately not in their order. */
const row = worklistItem({
  status: "informed",
  profilingStatus: "profiling_in_progress",
  dsvStatus: "dsv_offered",
  actions: [{ kind: "field", key: "mobile", state: "missing" }],
  deadlines: [
    { kind: "asu_due", date: "2026-10-30", state: "upcoming" },
    { kind: "offer_deadline", date: "2026-10-20", state: "overdue" },
  ],
  caseItems: [{ kind: "evidence_invalidated", date: "2026-10-01" }],
  appointments: {
    next: { kind: "info_event", startsAt: "2026-11-03T09:00:00.000Z" },
    items: [],
  },
  capabilities: { remind: { allowed: true, code: null, channel: "email" } },
});

function setup(
  routes: Parameters<typeof mockApi>[0] = {},
  shown: object = detail,
  path = pagePath,
) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${projectPath}/worklist`]: () => json(worklist([row])),
    [`GET ${detailPath}`]: () => json(shown),
    ...routes,
  });
  const { router } = renderApp(path, api);
  return { calls, router };
}

const region = (name: string) => screen.findByRole("region", { name });

afterEach(() => forgetWorklistMemory());

describe("the participant page header", () => {
  it("links back to the work list with the codes and the sort it was left with (C6, AC 4)", async () => {
    const { router } = setup(
      {},
      detail,
      `/projects/${project.id}?tab=participants&deadlineState=overdue&sort=-name`,
    );
    await userEvent.click(await screen.findByRole("link", { name: "Beispiel, Erika" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Beispiel, Erika" })).toBeVisible();
    const breadcrumb = screen.getByRole("navigation", { name: "Navigationspfad" });
    const crumbs = within(breadcrumb).getAllByRole("link");
    expect(crumbs.map((link) => link.textContent)).toEqual([
      "Projekte",
      project.name,
      "Teilnehmende",
    ]);
    // Ancestors only: none of them is marked as the current page.
    for (const crumb of crumbs) expect(crumb).not.toHaveAttribute("aria-current");
    const back = within(breadcrumb).getByRole("link", { name: "Teilnehmende" });
    expect(back.getAttribute("href")).toContain("deadlineState=overdue");
    expect(back.getAttribute("href")).toContain("sort=-name");
    await userEvent.click(back);
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        deadlineState: "overdue",
        sort: "-name",
      }),
    );
    expect(await screen.findByRole("button", { name: "Überfällig (1)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("names neither the person in the document title; shows the number, the wave and three tags", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Beispiel, Erika" });
    await waitFor(() => expect(document.title).toContain("Teilnehmende Person"));
    expect(document.title).not.toMatch(/Beispiel|Erika|BSP-0001/);
    expect(screen.getByText("Personalnummer BSP-0001 · Welle W1")).toBeInTheDocument();
    const header = document.querySelector(".tp-page-header")!;
    expect([...header.querySelectorAll(".tp-status-tag")].map((tag) => tag.textContent)).toEqual([
      "Status: Informiert",
      "Profiling: In Arbeit",
      "DSV: Angeboten",
    ]);
  });

  it("puts the actions the capabilities allow under Aktionen, and reminds this one person", async () => {
    const { calls } = setup({
      [`POST ${projectPath}/reminders`]: () => json({ queued: [], skipped: [] }),
    });
    const menu = await screen.findByRole("button", { name: "Aktionen" });
    await userEvent.click(menu);
    const items = document.getElementById(menu.getAttribute("aria-controls")!)!;
    // The row may be reminded; nothing else is allowed here (no activation, no assisted mode).
    expect(
      within(items)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Erinnern"]);
    await userEvent.click(within(items).getByText("Erinnern"));
    const dialog = await screen.findByRole("dialog", { name: "An offene Punkte erinnern" });
    expect(within(dialog).getByText("Betrifft 1 von 1 ausgewählten Teilnehmenden.")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Senden" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${projectPath}/reminders`,
        body: { kind: "open_items", participationIds: [participationId] },
      }),
    );
  });

  it("lists the hints in one Handlungsbedarf notification", async () => {
    setup({}, { ...detail, hints: ["tg_start_missed", "placement_agentur_check"] });
    const notices = await screen.findAllByText("Handlungsbedarf");
    expect(notices).toHaveLength(1);
    const notice = notices[0]!.closest(".cds--inline-notification")!;
    expect(within(notice as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps the capability rules of the tabs and puts Verlauf last", async () => {
    setup({}, { ...detail, capabilities: { ...detail.capabilities, viewProfiling: false } });
    const tabs = within(await screen.findByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).not.toContain("Profiling");
    expect(tabs.at(-1)).toHaveTextContent("Verlauf");
    // No panel repeats its tab's name as a heading (principle 6).
    expect(screen.queryByRole("heading", { name: "Übersicht" })).toBeNull();
  });
});

describe("the overview's Stand (C3)", () => {
  it("shows the three tracks as separate summaries, never one sequence across them", async () => {
    setup();
    const stand = await region("Stand");
    const tracks = within(stand).getAllByRole("region");
    expect(tracks.map((track) => track.getAttribute("aria-label"))).toEqual([
      "Status",
      "Profiling",
      "DSV",
    ]);
    // Each track has its own tag and its own steps; no ProgressIndicator spans them (AC 20).
    for (const track of tracks) {
      expect(track.querySelectorAll(".tp-status-tag")).toHaveLength(1);
      expect(within(track).getAllByRole("list")).toHaveLength(1);
    }
    expect(document.querySelector(".cds--progress")).toBeNull();
    const profiling = tracks[1]!;
    expect(within(profiling).getByText("Schritt 3 von 4")).toBeInTheDocument();
    expect(within(profiling).getByText("In Arbeit", { selector: "li" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    // Each its key date: the DSV's offer deadline, relative and absolute.
    await waitFor(() =>
      expect(tracks[2]).toHaveTextContent(/Angebotsfrist.*seit 2 Tagen überfällig · 20\.10\.2026/),
    );
  });

  it("has no DSV track in a ta_only project and says when a status is off the path", async () => {
    setup(
      { [`GET ${projectPath}`]: () => json({ ...project, type: "ta_only" }) },
      { ...detail, status: "unreachable", dsvStatus: "not_offered" },
    );
    const stand = await region("Stand");
    expect(
      within(stand)
        .getAllByRole("region")
        .map((t) => t.getAttribute("aria-label")),
    ).toEqual(["Status", "Profiling"]);
    expect(
      within(within(stand).getByRole("region", { name: "Status" })).getByText(
        "Außerhalb der regulären Schrittfolge",
      ),
    ).toBeInTheDocument();
  });
});

describe("the overview's Offen (C2, C1)", () => {
  it("lists the open items in the work list's order, each linking to its tab", async () => {
    const { router } = setup();
    const open = await region("Offen");
    const items = await within(open).findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Überfällig.*DSV-Angebotsfrist: seit 2 Tagen überfällig/),
      expect.stringMatching(/^Nachweis ungültig \(seit 01\.10\.2026\)/),
      expect.stringMatching(/^Arbeitsuche fällig: in 8 Tagen/),
      expect.stringMatching(/^Mobilnummer fehlt/),
    ]);
    expect(within(items[1]!).getByRole("link", { name: "Zu „Unterlagen“" })).toBeInTheDocument();
    expect(within(items[3]!).getByRole("link", { name: "Zu „Selbstauskunft“" })).toBeVisible();
    await userEvent.click(within(items[2]!).getByRole("link", { name: "Zu „Arbeitsuche“" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "asu" }));
  });

  it("shows five items and the rest behind a disclosure", async () => {
    const many = {
      ...row,
      actions: ["a", "b", "c", "d", "e", "f"].map((key) => ({
        kind: "field",
        key,
        state: "missing",
      })),
    };
    setup({ [`GET ${projectPath}/worklist`]: () => json(worklist([many])) });
    const open = await region("Offen");
    expect(await within(open).findAllByRole("listitem")).toHaveLength(5);
    const more = within(open).getByRole("button", { name: "Alle 9 anzeigen" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(within(open).getAllByRole("listitem")).toHaveLength(9);
    expect(within(open).getByRole("button", { name: "Weniger anzeigen" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("names the prerequisite of a blocked action as text (C1)", async () => {
    setup();
    const open = await region("Offen");
    const [overdue] = await within(open).findAllByRole("listitem");
    // The offer deadline is resolved in "Welle und Vertragsdaten", whose change is blocked.
    expect(
      within(overdue!).getByRole("link", { name: "Zu „Welle und Vertragsdaten“" }),
    ).toBeVisible();
    expect(within(overdue!).getByText(/Ein DSV-Angebot ist offen/)).toBeVisible();
  });

  it("links no tab the viewer doesn't have", async () => {
    setup({}, { ...detail, capabilities: { ...detail.capabilities, viewAsu: false } });
    const open = await region("Offen");
    const items = await within(open).findAllByRole("listitem");
    expect(within(items[2]!).queryByRole("link")).toBeNull();
  });

  it("says why there is nothing to list without the work list (403)", async () => {
    setup({ [`GET ${projectPath}/worklist`]: () => problem(403, "forbidden") });
    expect(
      await within(await region("Offen")).findByText(/die Ihre Rolle nicht sieht/),
    ).toBeInTheDocument();
  });

  it("shows the next appointment under Termine & Zuständigkeit", async () => {
    setup();
    const next = await region("Nächster Termin");
    expect(
      await within(next).findByText(/Infoveranstaltung, 03\.11\.2026, 10:00 Uhr\./),
    ).toBeInTheDocument();
  });
});

describe("the timeline (D12, stage 1)", () => {
  it("lists the same events as text in date order", async () => {
    setup();
    const card = await region("Zeitstrahl");
    const list = await within(card).findByRole("list", { name: "" });
    const entries = within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(entries).toEqual([
      expect.stringMatching(/^20\.10\.2026 DSV-Angebotsfrist.*Überschritten/),
      expect.stringMatching(/^30\.10\.2026 Arbeitsuche fällig.*In 14 Tagen/),
      expect.stringMatching(/^03\.11\.2026 Infoveranstaltung, 10:00 Uhr · gebucht/),
      expect.stringMatching(/^01\.12\.2026 Geplanter TG-Beginn/),
      expect.stringMatching(/^30\.11\.2027 Geplantes TG-Ende/),
    ]);
  });

  it("makes every marker a link the keyboard reaches, with a tooltip on focus", async () => {
    const { router } = setup();
    const card = await region("Zeitstrahl");
    const svg = card.querySelector("svg.tp-timeline-svg")!;
    const markers = await waitFor(() => {
      const found = [...svg.querySelectorAll("a")];
      if (found.length < 5) throw new Error("markers not drawn yet");
      return found;
    });
    expect(markers.map((marker) => marker.getAttribute("aria-label"))).toEqual([
      "DSV-Angebotsfrist · 20.10.2026 · Überschritten – Welle und Vertragsdaten",
      "Arbeitsuche fällig · 30.10.2026 · In 14 Tagen – Arbeitsuche",
      "Infoveranstaltung, 10:00 Uhr · 03.11.2026 · gebucht – Termine",
      "Geplanter TG-Beginn · 01.12.2026 – Welle und Vertragsdaten",
      "Geplantes TG-Ende · 30.11.2027 – Welle und Vertragsdaten",
    ]);
    markers[1]!.focus();
    expect(markers[1]).toHaveFocus();
    expect(
      await within(card).findByText("Arbeitsuche fällig · 30.10.2026 · In 14 Tagen", {
        selector: ".tp-timeline-tooltip",
      }),
    ).toBeInTheDocument();
    // The browser follows the focused link on Enter (the e2e); jsdom only clicks it.
    await userEvent.click(markers[1]!);
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "asu" }));
  });
});
