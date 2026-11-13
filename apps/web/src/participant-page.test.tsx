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

// The participant page (ui-patterns.md, the participant page): the header with its way back to
// the work list (C6), its key facts and the one primary action, the three tracks as three bars
// (C3), "Als Nächstes" in C2's order with its links and C1's prerequisites, the cards collapsed
// to their summary, "Handlungsbedarf" and the timeline's list and keyboard path.

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
    const header = document.querySelector(".tp-detail-header")!;
    expect([...header.querySelectorAll(".tp-status-tag")].map((tag) => tag.textContent)).toEqual([
      "Status: Informiert",
      "Profiling: In Arbeit",
      "DSV: Angeboten",
    ]);
  });

  it("shows at most five key facts, each from what the page already loads", async () => {
    setup({}, { ...detail, assignments: [{ staffUserId: "s1", displayName: "Bernd Beratung" }] });
    await screen.findByRole("heading", { level: 1, name: "Beispiel, Erika" });
    const header = document.querySelector<HTMLElement>(".tp-detail-header")!;
    // The next appointment is the work list's row; it joins the facts once the row is there.
    await within(header).findByText("Nächster Termin");
    const facts = within(header)
      .getAllByRole("term")
      .map((term) => `${term.textContent}: ${term.nextElementSibling!.textContent}`);
    expect(facts).toEqual([
      "TG-Beginn: 01.12.2026",
      "DSV-Angebotsfrist: seit 2 Tagen überfällig · 20.10.2026",
      "Beratung: Bernd Beratung",
      "Nächster Termin: 03.11.2026, 10:00",
      "Portal: Kein Code",
    ]);
  });

  it("has one primary action: the next step where the viewer may take it, else none", async () => {
    // The next step is the overdue offer deadline, resolved in "Welle und Vertragsdaten", whose
    // change is blocked for this viewer: no primary action, never the second item's.
    const { router } = setup();
    const open = await region("Als Nächstes");
    await within(open).findAllByRole("listitem");
    const header = document.querySelector<HTMLElement>(".tp-detail-header")!;
    expect(within(header).queryByRole("button", { name: /Nächster Schritt/ })).toBeNull();
    expect(header.querySelectorAll(".cds--btn--primary")).toHaveLength(0);
    expect(router.state.location.hash).toBe("");
  });

  it("opens the place of the next step from the primary action", async () => {
    const asu = { ...row, deadlines: [{ kind: "asu_due", date: "2026-10-20", state: "overdue" }] };
    const { router } = setup({ [`GET ${projectPath}/worklist`]: () => json(worklist([asu])) });
    const primary = await screen.findByRole("button", { name: "Nächster Schritt: Arbeitsuche" });
    const header = document.querySelector<HTMLElement>(".tp-detail-header")!;
    expect(header.querySelectorAll(".cds--btn--primary")).toHaveLength(1);
    await userEvent.click(primary);
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "asu" }));
  });

  it("offers the next step of a card only with the capability its action needs", async () => {
    setup({}, { ...detail, capabilities: { ...detail.capabilities, setParticipationDates: true } });
    await userEvent.click(
      await screen.findByRole("button", { name: "Nächster Schritt: Welle und Vertragsdaten" }),
    );
    // The card the step points to opens.
    const card = await region("Welle und Vertragsdaten");
    expect(await within(card).findByText("Unterschriftsfrist")).toBeVisible();
  });

  it("has no primary action without the tab of the next step, or without the work list", async () => {
    const asu = { ...row, deadlines: [{ kind: "asu_due", date: "2026-10-20", state: "overdue" }] };
    setup(
      { [`GET ${projectPath}/worklist`]: () => json(worklist([asu])) },
      { ...detail, capabilities: { ...detail.capabilities, viewAsu: false } },
    );
    await within(await region("Als Nächstes")).findAllByRole("listitem");
    expect(screen.queryByRole("button", { name: /Nächster Schritt/ })).toBeNull();
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
  it("shows the three tracks as three separate bars, never one sequence across them", async () => {
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
    expect(within(profiling).getByText(/Schritt 3 von 4/)).toBeInTheDocument();
    const steps = within(profiling).getByRole("list", { name: "Schritte: Profiling" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((step) => step.textContent),
    ).toEqual(["Nicht begonnen (erledigt)", "Angenommen (erledigt)", "In Arbeit", "Abgeschlossen"]);
    expect(within(steps).getByText("In Arbeit").closest("li")).toHaveAttribute(
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
        /Außerhalb der regulären Schrittfolge/,
      ),
    ).toBeInTheDocument();
  });
});

describe("the overview's Als Nächstes (C2, C1)", () => {
  it("lists the open items in the work list's order, each linking to its tab", async () => {
    const { router } = setup();
    const open = await region("Als Nächstes");
    const items = await within(open).findAllByRole("listitem");
    // Three of the four, each with what its tone means as text and its date as the detail.
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Überfällig: DSV-Angebotsfristseit 2 Tagen überfällig · 20\.10\.2026/),
      expect.stringMatching(/^Offen: Nachweis ungültig \(seit 01\.10\.2026\)/),
      expect.stringMatching(/^Anstehend: Arbeitsuche fälligin 8 Tagen/),
    ]);
    expect(within(open).getByText("3 von 4 offenen Punkten")).toBeVisible();
    await userEvent.click(within(open).getByRole("button", { name: "Alle 4 anzeigen" }));
    items.push(within(open).getAllByRole("listitem")[3]!);
    expect(items[3]).toHaveTextContent(/^Angabe oder Unterlage fehlt: Mobilnummer fehlt/);
    expect(within(items[1]!).getByRole("link", { name: "Zu „Unterlagen“" })).toBeInTheDocument();
    expect(within(items[3]!).getByRole("link", { name: "Zu „Selbstauskunft“" })).toBeVisible();
    await userEvent.click(within(items[2]!).getByRole("link", { name: "Zu „Arbeitsuche“" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "asu" }));
  });

  it("shows three items, each with its own action, and the rest behind a disclosure", async () => {
    const many = {
      ...row,
      actions: ["a", "b", "c", "d", "e", "f"].map((key) => ({
        kind: "field",
        key,
        state: "missing",
      })),
    };
    setup({ [`GET ${projectPath}/worklist`]: () => json(worklist([many])) });
    const open = await region("Als Nächstes");
    const first = await within(open).findAllByRole("listitem");
    expect(first).toHaveLength(3);
    for (const item of first) expect(within(item).getAllByRole("link")).toHaveLength(1);
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
    const open = await region("Als Nächstes");
    const [overdue] = await within(open).findAllByRole("listitem");
    // The offer deadline is resolved in "Welle und Vertragsdaten", whose change is blocked.
    expect(
      within(overdue!).getByRole("link", { name: "Zu „Welle und Vertragsdaten“" }),
    ).toBeVisible();
    expect(within(overdue!).getByText(/Ein DSV-Angebot ist offen/)).toBeVisible();
  });

  it("links no tab the viewer doesn't have", async () => {
    setup({}, { ...detail, capabilities: { ...detail.capabilities, viewAsu: false } });
    const open = await region("Als Nächstes");
    const items = await within(open).findAllByRole("listitem");
    expect(within(items[2]!).queryByRole("link")).toBeNull();
  });

  it("says why there is nothing to list without the work list (403)", async () => {
    setup({ [`GET ${projectPath}/worklist`]: () => problem(403, "forbidden") });
    expect(
      await within(await region("Als Nächstes")).findByText(/die Ihre Rolle nicht sieht/),
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
