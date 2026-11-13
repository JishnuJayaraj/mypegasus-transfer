import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { funnelFilters, projectFunnel } from "@transfer/domain";
import { forgetWorklistMemory } from "./components/worklist-state";
import { quickViews, sameFilter, tileViews } from "./components/worklist-views";
import { describe, expect, it, vi } from "vitest";
import { documentNavigation } from "./components/documents-tab";
import {
  chooseBatchAction,
  consultant,
  json,
  mockApi,
  openSection,
  problem,
  project,
  renderApp,
  setWorklistFilter,
  shownPersonnelNumbers,
  staffUsers,
  team,
  unpinnedConfig,
  worklist,
  worklistItem,
  worklistRow,
  worklistSection,
} from "./test-utils";

// Slice 5 (data-protection.md, the work list and the dashboard): the "Übersicht" and
// "Teilnehmende" tabs over one snapshot. Synthetic rows only.
const path = `/api/v1/projects/${project.id}`;
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const wave = {
  id: "00000000-0000-4000-b000-000000000002",
  projectId: project.id,
  code: "W2",
  name: "Welle 2",
  signingDeadline: "2026-11-15",
  defaultTgStart: "2026-12-01",
  defaultTgEnd: "2027-11-30",
  latestEntryDate: "2026-12-15",
  participations: 0,
  createdAt: "2026-10-15T08:30:00.123456Z",
  updatedAt: "2026-10-15T08:30:00.123456Z",
};
const capable = {
  assignEntryWave: true,
  issueActivationCode: false,
  recordHandover: false,
  revokeActivationCode: false,
  providePrivacyNotice: false,
};
const items = [
  worklistItem({
    id: id(1),
    status: "informed",
    lastName: "Größer",
    firstName: "Jürgen",
    actions: [
      { kind: "field", key: "mobile", state: "missing" },
      { kind: "document", key: "cv", state: "rejected" },
    ],
    deadlines: [{ kind: "tg_start", date: "2026-10-30", state: "upcoming" }],
    capabilities: capable,
  }),
  worklistItem({
    id: id(2),
    personnelNumber: "BSP-0002",
    lastName: "Muster",
    firstName: "Anna",
    deadlines: [{ kind: "privacy_notice", date: "2026-10-01", state: "overdue" }],
    portal: "consent_required",
    // An escalated TL 407 and a missing original (process-and-lifecycle.md, TL 407 submission).
    placementAgenturKey: "beispielstadt-nord",
    agenturItems: [
      { kind: "tl407_escalated", date: "2026-10-15" },
      { kind: "tl407_original_missing", date: "2026-10-10" },
    ],
    // A missed consultation and an undelivered notice (process-and-lifecycle.md, appointments).
    appointments: {
      next: null,
      items: [
        {
          kind: "missed",
          appointmentId: id(20),
          appointmentKind: "consultation",
          startsAt: "2026-10-20T08:00:00.000Z",
        },
        {
          kind: "notice_undelivered",
          appointmentId: id(21),
          appointmentKind: "info_event",
          startsAt: "2026-10-27T08:00:00.000Z",
        },
      ],
    },
    capabilities: capable,
  }),
  worklistItem({
    id: id(3),
    personnelNumber: "BSP-0003",
    lastName: "Beispiel",
    firstName: "Bernd",
    status: "informed",
    // No knowledge date: the ASU reference date as an orientation (process-and-lifecycle.md, dates).
    caseItems: [{ kind: "knowledge_date_missing", date: "2026-12-31" }],
    appointments: {
      next: { kind: "info_event", startsAt: "2026-10-27T08:00:00.000Z" },
      items: [],
    },
    capabilities: capable,
  }),
];
const dashboard = (rows: typeof items) => ({
  scope: "project",
  generatedAt: "2026-10-22T08:42:00.000Z",
  counts: projectFunnel(rows as never, { type: "ta_tg", waves: [wave] }),
});

function setup(routes: Parameters<typeof mockApi>[0] = {}, at = "?tab=participants") {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [wave], nextCursor: null }),
    [`GET ${path}/config`]: () => json(unpinnedConfig),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`GET ${path}/worklist`]: () => json(worklist(items)),
    [`GET ${path}/dashboard`]: () => json(dashboard(items)),
    ...routes,
  });
  return { ...mock, ...renderApp(`/projects/${project.id}${at}`, mock.api) };
}

const list = () => within(screen.getByRole("region", { name: "Teilnehmende" }));
/** Waits for the work list's section, then queries in it. */
const ready = worklistSection;
/** The shown rows' Personalnummern, in the order of the default sort unless a test sorts. */
const personnelNumbers = () => shownPersonnelNumbers().toSorted();

/** Shows the Kennzahlen's zero values too ("Alle anzeigen"; the viewer's choice in memory). */
async function showAllFigures() {
  await userEvent.click(await screen.findByRole("button", { name: "Alle anzeigen" }));
  expect(screen.getByRole("button", { name: "Nur Werte über 0" })).toBeInTheDocument();
}

describe("Übersicht", () => {
  it("shows the tiles, and each number opens the work list with the same filter", async () => {
    const { router } = setup({}, "");
    const tile = await screen.findByRole("link", { name: "1 In den nächsten 14 Tagen" });
    expect(screen.getByRole("link", { name: "3 Teilnehmende" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 Angaben/Unterlagen fehlen" })).toBeInTheDocument();
    await userEvent.click(tile);
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        deadlineState: "upcoming",
      }),
    );
    expect(await (await ready()).findByText(/^1 Treffer · 3 Teilnehmende/)).toBeInTheDocument();
    expect(personnelNumbers()).toEqual(["BSP-0001"]);
  });

  it("links every table count to its filter", async () => {
    setup({}, "");
    const statuses = await screen.findByRole("list", { name: "Status" });
    await showAllFigures();
    const link = within(statuses).getByRole("link", { name: "2 Informiert" });
    const filter = funnelFilters({ type: "ta_tg", waves: [wave] }).statuses.find(
      (f) => f.key === "informed",
    )!.filter;
    expect(link.getAttribute("href")).toContain(`status=${filter.status}`);
    expect(link.getAttribute("href")).toContain("/participants");
    const waves = screen.getByRole("table", { name: "Nach Welle" });
    expect(within(waves).getByRole("row", { name: /Ohne Welle/ })).toHaveTextContent("3");
  });

  it("has the tiles and the group Termine, each opening the work list's appointment filter", async () => {
    const { router } = setup({}, "");
    const tile = await screen.findByRole("link", { name: "1 Termine überfällig" });
    expect(screen.getByRole("link", { name: "1 Termine zu klären" })).toBeInTheDocument();
    await showAllFigures();
    const group = screen.getByRole("table", { name: "Termine" });
    expect(within(group).getByRole("row", { name: /Termin anstehend/ })).toHaveTextContent("1");
    expect(within(group).getByRole("row", { name: /Nicht erschienen/ })).toHaveTextContent("1");
    await userEvent.click(tile);
    await waitFor(() => expect(router.state.location.search).toEqual({ appointment: "overdue" }));
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0002"]));
  });

  it("has the tile Agentur offen and the group Agentur, each opening the work list's filter", async () => {
    const { router } = setup({}, "");
    const tile = await screen.findByRole("link", { name: "1 Agentur offen" });
    await showAllFigures();
    const group = screen.getByRole("table", { name: "Agentur" });
    expect(within(group).getByRole("row", { name: /TL 407 eskaliert/ })).toHaveTextContent("1");
    expect(
      within(group).getByRole("row", { name: /Bestätigung Kug 200b fehlt/ }),
    ).toHaveTextContent("0");
    await userEvent.click(tile);
    await waitFor(() => expect(router.state.location.search).toEqual({ agentur: "open" }));
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0002"]));
    const row = await worklistRow("BSP-0002");
    // The Agentur column is in the chooser (the plan of Slice 6b, D7).
    await userEvent.click(list().getByRole("button", { name: "Spalten" }));
    await userEvent.click(list().getByRole("checkbox", { name: "Agentur" }));
    expect(within(row).getByText("TL 407 eskaliert (seit 15.10.2026)")).toBeInTheDocument();
    expect(within(row).getByText(/beispielstadt-nord/)).toBeInTheDocument();
    // The filter shows as an active tag, and in the panel.
    expect(list().getByText("Agentur: Offen")).toBeInTheDocument();
  });

  it("says when the viewer may not see it", async () => {
    setup({ [`GET ${path}/dashboard`]: () => problem(403, "forbidden") }, "");
    expect(
      await screen.findByText("Sie dürfen die Übersicht dieses Projekts nicht sehen."),
    ).toBeInTheDocument();
  });
});

describe("Teilnehmende", () => {
  it("shows what is open, the most urgent deadline and the portal", async () => {
    setup();
    const row = await worklistRow("BSP-0001");
    // The next step and how many more are open (C2): the upcoming deadline before the actions.
    const step = within(row).getByText("+2 weitere").closest("td")!;
    await userEvent.click(within(step).getByRole("button", { name: "+2 weitere" }));
    expect(within(step).getByText("Mobilnummer fehlt")).toBeInTheDocument();
    expect(
      within(row).getByRole("cell", { name: "TG-Beginn: in 8 Tagen · 30.10.2026" }),
    ).toBeInTheDocument();
    await userEvent.click(list().getByRole("button", { name: "Spalten" }));
    await userEvent.click(list().getByRole("checkbox", { name: "Portal" }));
    const other = await worklistRow("BSP-0002");
    expect(
      within(other).getByRole("cell", {
        name: "Datenschutzhinweis: seit 21 Tagen überfällig · 01.10.2026",
      }),
    ).toBeInTheDocument();
    expect(within(other).getByRole("cell", { name: "Einwilligung fehlt" })).toBeInTheDocument();
    // Without a dated deadline the ASU orientation, never as overdue (process-and-lifecycle.md, dates).
    const orientation = await worklistRow("BSP-0003");
    // Its only open item, so also its next step.
    expect(
      within(orientation).getAllByRole("cell", {
        name: "Orientierung 31.12.2026 – Kenntnisdatum klären",
      }),
    ).toHaveLength(2);
  });

  it("shows the most urgent appointment item, else the next booking, and filters by Termine", async () => {
    const { router } = setup();
    await worklistRow("BSP-0002");
    await userEvent.click(list().getByRole("button", { name: "Spalten" }));
    await userEvent.click(list().getByRole("checkbox", { name: "Termin" }));
    const missed = await worklistRow("BSP-0002");
    expect(
      within(missed).getByRole("cell", {
        name: "Nicht erschienen Beratungstermin vom 20.10.2026 +1 weitere",
      }),
    ).toBeInTheDocument();
    const next = await worklistRow("BSP-0003");
    expect(
      within(next).getByRole("cell", { name: "Infoveranstaltung am 27.10.2026, 09:00 Uhr" }),
    ).toBeInTheDocument();
    await setWorklistFilter("Termine", "upcoming");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        appointment: "upcoming",
      }),
    );
    expect(personnelNumbers()).toEqual(["BSP-0003"]);
    await setWorklistFilter("Termine", "to_resolve");
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0002"]));
  });

  it("keeps the code filters in the route's search params, both ways", async () => {
    const { router } = setup({}, "?tab=participants&status=informed");
    expect(await (await ready()).findByText("Status: Informiert")).toBeInTheDocument();
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0001", "BSP-0003"]));
    await setWorklistFilter("Offene Punkte", "rejected_documents");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        status: "informed",
        actions: "rejected_documents",
      }),
    );
    expect(personnelNumbers()).toEqual(["BSP-0001"]);
    // Each active filter is a tag that removes it.
    await userEvent.click(
      list().getByRole("button", {
        name: "Filter entfernen: Offene Punkte: Abgelehnte Unterlagen",
      }),
    );
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "informed" }));
    await userEvent.click(list().getByRole("button", { name: "Filter (1)" }));
    const panel = await screen.findByRole("dialog", { name: "Filter" });
    expect(within(panel).getByLabelText("Status")).toHaveValue("informed");
    await userEvent.click(within(panel).getByRole("button", { name: "Filter zurücksetzen" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("while loading, shows a skeleton with the headers and no empty state, search or selection", async () => {
    const gate: { release?: () => void } = {};
    const pending = new Promise<void>((resolve) => (gate.release = resolve));
    setup({
      [`GET ${path}/worklist`]: async () => {
        await pending;
        return json(worklist(items));
      },
    });
    expect(await screen.findByText("Wird geladen…")).toBeInTheDocument();
    const skeleton = screen.getByRole("table");
    expect(
      within(skeleton)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Teilnehmende", "Status", "Nächster Schritt", "Frist", "Beratung", "Welle"]);
    expect(screen.queryByRole("searchbox", { name: "Name oder Personalnummer suchen" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Alle Zeilen auswählen" })).toBeNull();
    expect(screen.queryByText(/Es gibt noch keine Teilnehmenden/)).toBeNull();
    expect(screen.queryByText(/Keine Teilnehmenden entsprechen/)).toBeNull();
    gate.release!();
    expect(await screen.findByRole("checkbox", { name: "Alle Zeilen auswählen" })).toBeEnabled();
    expect(
      screen.getByRole("searchbox", { name: "Name oder Personalnummer suchen" }),
    ).toBeEnabled();
  });

  it("searches names in memory: folded, never in the URL, a query key, a request or storage", async () => {
    const { router, queryClient, calls } = setup();
    const search = await screen.findByRole("searchbox", {
      name: "Name oder Personalnummer suchen",
    });
    await waitFor(() => expect(search).toBeEnabled());
    expect(search).toHaveAttribute("autocomplete", "off");
    await userEvent.type(search, "GROSSER jur");
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0001"]));
    const term = /gross|jur/i;
    expect(router.state.location.href).not.toMatch(term);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.queryKey),
      ),
    ).not.toMatch(term);
    expect(calls.map((c) => `${c.key} ${JSON.stringify(c.body ?? "")}`).join("\n")).not.toMatch(
      term,
    );
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(term);
    expect(calls.filter((c) => c.key === `GET ${path}/worklist`)).toHaveLength(1);
  });

  it("selects all matches, assigns a wave, and on refusal says first that nothing was assigned", async () => {
    const { calls } = setup({
      [`POST ${path}/entry-wave-assignments`]: () =>
        problem(422, "domain-error", {
          errors: [
            { pointer: "/participationIds/1", code: "individual_dates_set", detail: "Refused" },
          ],
        }),
    });
    await userEvent.click(
      await (await ready()).findByRole("checkbox", { name: "Alle Zeilen auswählen" }),
    );
    await chooseBatchAction("Welle zuweisen");
    const panel = await screen.findByRole("dialog", { name: "Welle zuweisen" });
    await userEvent.selectOptions(within(panel).getByLabelText("Eintrittswelle"), wave.id);
    await userEvent.click(
      within(panel).getByRole("button", { name: "Eintrittswelle zuweisen (3)" }),
    );
    await within(panel).findByText("Keine Zuweisung vorgenommen");
    const section = panel.querySelector(".cds--modal-content > div")!;
    expect(section.textContent).toMatch(
      /^(error icon)?Keine Zuweisung vorgenommen.*Diese Teilnehmenden verhindern die Zuweisung:.*BSP-0002: Die Person hat individuelle Vertragsdaten/,
    );
    expect(calls).toContainEqual({
      key: `POST ${path}/entry-wave-assignments`,
      body: { waveId: wave.id, participationIds: [id(1), id(2), id(3)] },
    });
  });

  it("reports the assigned and unchanged rows and reloads the snapshot", async () => {
    const { calls } = setup({
      [`POST ${path}/entry-wave-assignments`]: () => json({ assigned: 1, unchanged: 0 }),
    });
    await userEvent.click(await (await ready()).findByLabelText("BSP-0003 auswählen"));
    await chooseBatchAction("Welle zuweisen");
    const panel = await screen.findByRole("dialog", { name: "Welle zuweisen" });
    await userEvent.selectOptions(within(panel).getByLabelText("Eintrittswelle"), wave.id);
    await userEvent.click(
      within(panel).getByRole("button", { name: "Eintrittswelle zuweisen (1)" }),
    );
    expect(await screen.findByText("1 zugewiesen, 0 unverändert")).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.key === `GET ${path}/worklist`)).toHaveLength(2),
    );
  });

  it("tells no participants from no matches, which resets the filters and the search", async () => {
    const { router } = setup({}, "?tab=participants&status=exited");
    const section = await ready();
    const empty = (
      await section.findByText("Keine Teilnehmenden entsprechen der Suche und den Filtern.")
    ).closest(".tp-empty-state")! as HTMLElement;
    await userEvent.click(within(empty).getByRole("button", { name: "Filter zurücksetzen" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(personnelNumbers()).toHaveLength(items.length));
  });

  it("says there are no participants yet, with the next step", async () => {
    setup({ [`GET ${path}/worklist`]: () => json(worklist([])) });
    const section = await ready();
    expect(await section.findByText("Noch keine Teilnehmenden")).toBeInTheDocument();
    expect(section.getByText(/Importieren Sie eine Datei/)).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Filter zurücksetzen" })).not.toBeInTheDocument();
  });

  it("offers a retry when the list failed to load", async () => {
    let fail = true;
    setup({
      [`GET ${path}/worklist`]: () => (fail ? problem(500, "internal") : json(worklist(items))),
    });
    const section = await ready();
    const alert = (
      await section.findByText("Die Teilnehmenden konnten nicht geladen werden.")
    ).closest<HTMLElement>("[role=alert]")!;
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));
    expect(await section.findByText("BSP-0001")).toBeInTheDocument();
  });

  it("shows the three tracks as separate status tags (C3)", async () => {
    setup();
    const row = await worklistRow("BSP-0001");
    const tags = [...row.querySelectorAll(".tp-status-tag")].map((tag) => tag.textContent);
    expect(tags).toHaveLength(3);
    expect(tags[0]).toBe("Informiert");
  });

  it("says when the list is too large or not allowed", async () => {
    setup({
      [`GET ${path}/worklist`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "", code: "worklist_too_large", detail: "Too large" }],
        }),
    });
    expect(await screen.findByText(/mehr Teilnehmende, als diese Liste/)).toBeInTheDocument();
  });
});

describe("Kug 200b erzeugen (data-protection.md, generated forms and exports)", () => {
  const kugItems = [
    worklistItem({
      id: id(4),
      personnelNumber: "BSP-0004",
      lastName: "Neumann",
      firstName: "Lea",
      caseItems: [{ kind: "kug200b_offer_open", date: "2026-11-02" }],
      capabilities: { ...capable, generateKug200b: true },
    }),
    worklistItem({
      id: id(5),
      personnelNumber: "BSP-0005",
      lastName: "Arslan",
      firstName: "Deniz",
      capabilities: { ...capable, generateKug200b: true },
    }),
  ];
  const generation = (n: number, checklist: object[]) => ({
    participationId: id(n),
    documentId: id(n + 40),
    formVersion: "09-2021",
    checklist,
  });

  it("generates for the selection, shows each checklist before printing and opens one print file", async () => {
    const assign = vi.spyOn(documentNavigation, "assign").mockImplementation(() => {});
    const { calls } = setup({
      [`GET ${path}/worklist`]: () => json(worklist(kugItems)),
      [`POST ${path}/forms/kug200b`]: () =>
        json(
          {
            generations: [
              generation(4, [
                {
                  code: "required_blank",
                  key: "pensionInsuranceNumber",
                  label: "11 Rentenversicherungsnummer",
                },
              ]),
              generation(5, []),
            ],
          },
          201,
        ),
      "POST /api/v1/exports/kug200b_print": () =>
        json(
          {
            url: `/api/v1/export-content/${"a".repeat(43)}`,
            expiresAt: "2026-11-02T09:01:00.000Z",
          },
          201,
        ),
    });
    const section = await ready();
    expect(await section.findByText("Kug 200b offen (angeboten am 02.11.2026)")).toBeVisible();
    await userEvent.click(section.getByRole("checkbox", { name: "Alle Zeilen auswählen" }));
    await chooseBatchAction("Kug 200b erzeugen");
    const panel = await screen.findByRole("dialog", { name: "Kug 200b erzeugen" });
    await userEvent.click(within(panel).getByRole("button", { name: "Kug 200b erzeugen" }));
    const result = await screen.findByTestId("kug200b-bulk-result");
    expect(result).toHaveTextContent("2 Kug 200b erzeugt.");
    expect(result).toHaveTextContent("Neumann, Lea: 11 Rentenversicherungsnummer");
    expect(calls).toContainEqual({
      key: `POST ${path}/forms/kug200b`,
      body: { participationIds: [id(4), id(5)] },
    });
    await userEvent.click(within(result).getByRole("button", { name: "Druckdatei öffnen" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`/api/v1/export-content/${"a".repeat(43)}`),
    );
    expect(calls).toContainEqual({
      key: "POST /api/v1/exports/kug200b_print",
      body: { documentIds: [id(44), id(45)] },
    });
    assign.mockRestore();
  });

  it("says that nothing was generated on a refusal", async () => {
    setup({
      [`GET ${path}/worklist`]: () => json(worklist(kugItems)),
      [`POST ${path}/forms/kug200b`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "/participationIds/1", code: "participation_closed", detail: "x" }],
        }),
    });
    const section = await ready();
    await userEvent.click(await section.findByRole("checkbox", { name: "Alle Zeilen auswählen" }));
    await chooseBatchAction("Kug 200b erzeugen");
    const panel = await screen.findByRole("dialog", { name: "Kug 200b erzeugen" });
    await userEvent.click(within(panel).getByRole("button", { name: "Kug 200b erzeugen" }));
    expect(
      await screen.findByText(
        "Die Kug 200b konnten nicht erzeugt werden; es wurde keiner erzeugt.",
      ),
    ).toBeVisible();
  });
});

const open = async () => {
  const section = await ready();
  await userEvent.click(await section.findByRole("checkbox", { name: "Alle Zeilen auswählen" }));
  await chooseBatchAction("DSV erzeugen");
  return screen.findByRole("dialog", { name: "DSV erzeugen" });
};

describe("DSV erzeugen (process-and-lifecycle.md, the DSV: generation as built)", () => {
  const dsvItems = [
    worklistItem({
      id: id(4),
      personnelNumber: "BSP-0004",
      lastName: "Neumann",
      firstName: "Lea",
      entryWaveId: wave.id,
      dsvStatus: "not_offered",
      capabilities: { ...capable, generateDsv: true },
    }),
    worklistItem({
      id: id(5),
      personnelNumber: "BSP-0005",
      lastName: "Arslan",
      firstName: "Deniz",
      entryWaveId: wave.id,
      dsvStatus: "not_offered",
      capabilities: { ...capable, generateDsv: true },
    }),
  ];
  const generated = (n: number, checklist: object[]) => ({
    participationId: id(n),
    documentId: id(n + 40),
    templateVersion: "v1",
    offerDeadline: wave.signingDeadline,
    checklist,
  });

  it("chooses one deadline first, generates for the selection and lists what stays for the hand", async () => {
    const { calls } = setup({
      [`GET ${path}/worklist`]: () => json(worklist(dsvItems)),
      [`POST ${path}/dsv/generations`]: () =>
        json(
          {
            generations: [
              generated(4, [{ code: "required_blank", key: "address" }]),
              generated(5, []),
            ],
          },
          201,
        ),
    });
    const panel = await open();
    const button = within(panel).getByRole("button", { name: "Erzeugen" });
    // Nothing preset: the button names its prerequisite (C1).
    expect(button).toBeDisabled();
    expect(within(panel).getByText("Erst eine Frist wählen.")).toBeVisible();
    await userEvent.click(
      within(panel).getByRole("radio", {
        name: `Unterschriftsfrist der Welle, ${new Date(wave.signingDeadline).toLocaleDateString("de-DE", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" })}`,
      }),
    );
    await userEvent.click(button);
    const result = await screen.findByTestId("dsv-bulk-result");
    expect(result).toHaveTextContent("2 DSV erzeugt.");
    expect(result).toHaveTextContent("Neumann, Lea: Anschrift");
    expect(calls).toContainEqual({
      key: `POST ${path}/dsv/generations`,
      body: {
        deadline: { kind: "wave", shown: wave.signingDeadline },
        items: [{ participationId: id(4) }, { participationId: id(5) }],
      },
    });
  });

  it("takes an explicit date, required before it is sent, when the rows don't share a wave deadline", async () => {
    const mixed = [dsvItems[0]!, { ...dsvItems[1]!, entryWaveId: null }];
    const { calls } = setup({
      [`GET ${path}/worklist`]: () => json(worklist(mixed)),
      [`POST ${path}/dsv/generations`]: () =>
        json({ generations: [generated(4, []), generated(5, [])] }, 201),
    });
    const panel = await open();
    expect(within(panel).queryByRole("radio", { name: /Unterschriftsfrist der Welle/ })).toBeNull();
    await userEvent.click(within(panel).getByRole("radio", { name: "Frist eingeben" }));
    expect(within(panel).getByText("Erst die Frist eingeben.")).toBeVisible();
    await userEvent.type(within(panel).getByLabelText("Frist (TT.MM.JJJJ)"), "20.02.2091");
    await userEvent.click(within(panel).getByRole("button", { name: "Erzeugen" }));
    await screen.findByTestId("dsv-bulk-result");
    expect(calls).toContainEqual({
      key: `POST ${path}/dsv/generations`,
      body: {
        deadline: { kind: "explicit", date: "2091-02-20" },
        items: [{ participationId: id(4) }, { participationId: id(5) }],
      },
    });
  });

  it("never submits a date typed before the choice changed: the field is blank again and the button waits for a date", async () => {
    const { calls } = setup({
      [`GET ${path}/worklist`]: () => json(worklist(dsvItems)),
      [`POST ${path}/dsv/generations`]: () =>
        json({ generations: [generated(4, []), generated(5, [])] }, 201),
    });
    const panel = await open();
    await userEvent.click(within(panel).getByRole("radio", { name: "Frist eingeben" }));
    await userEvent.type(within(panel).getByLabelText("Frist (TT.MM.JJJJ)"), "20.02.2091");
    await userEvent.click(
      within(panel).getByRole("radio", { name: /Unterschriftsfrist der Welle/ }),
    );
    await userEvent.click(within(panel).getByRole("radio", { name: "Frist eingeben" }));
    expect(within(panel).getByLabelText("Frist (TT.MM.JJJJ)")).toHaveValue("");
    const button = within(panel).getByRole("button", { name: "Erzeugen" });
    expect(button).toBeDisabled();
    expect(within(panel).getByText("Erst die Frist eingeben.")).toBeVisible();
    await userEvent.click(button);
    expect(calls.some((call) => call.key === `POST ${path}/dsv/generations`)).toBe(false);
  });

  it("says that nothing was generated, naming each refused row with its reason", async () => {
    setup({
      [`GET ${path}/worklist`]: () => json(worklist(dsvItems)),
      [`POST ${path}/dsv/generations`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "/items/1", code: "dsv_offer_open", detail: "x" }],
        }),
    });
    const panel = await open();
    await userEvent.click(within(panel).getByRole("radio", { name: "Frist eingeben" }));
    await userEvent.type(within(panel).getByLabelText("Frist (TT.MM.JJJJ)"), "20.02.2091");
    await userEvent.click(within(panel).getByRole("button", { name: "Erzeugen" }));
    const alert = (await screen.findByText("Es wurde keiner erzeugt. Nicht möglich für:")).closest(
      "[role=alert]",
    )!;
    expect(alert).toHaveTextContent(
      "Arslan, Deniz: Ein Angebot ist offen: den erzeugten Vertrag öffnen statt neu erzeugen.",
    );
    expect(screen.queryByTestId("dsv-bulk-result")).toBeNull();
  });

  it("offers nothing to a viewer whose rows can't be generated", async () => {
    setup({
      [`GET ${path}/worklist`]: () =>
        json(
          worklist(
            dsvItems.map((item) => ({
              ...item,
              capabilities: { ...item.capabilities, generateDsv: false },
            })),
          ),
        ),
    });
    const section = await ready();
    await userEvent.click(await section.findByRole("checkbox", { name: "Alle Zeilen auswählen" }));
    // The bar offers the wave assignment, whose capability the rows keep, but not the DSV.
    const bar = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cds--batch-actions");
      if (!element) throw new Error("No batch bar");
      return element;
    });
    expect(within(bar).getByRole("button", { name: "Welle zuweisen" })).toBeVisible();
    expect(within(bar).queryByText("DSV erzeugen")).toBeNull();
  });
});

describe("the signed DSV in the filters and items (the DSV work list and the entry clarification)", () => {
  it("names the items and filters by 'DSV: unterschrieben, nicht vollständig'", async () => {
    const signed = worklistItem({
      id: id(4),
      personnelNumber: "BSP-0004",
      lastName: "Neumann",
      firstName: "Lea",
      dsvStatus: "dsv_signed",
      caseItems: [
        { kind: "dsv_not_fully_executed", date: "2026-10-02" },
        { kind: "entry_clarification", date: "2026-11-02" },
      ],
      flags: ["dsv_signed_not_entered_at_cutoff"],
      capabilities: capable,
    });
    const other = worklistItem({ id: id(5), personnelNumber: "BSP-0005", capabilities: capable });
    setup(
      { [`GET ${path}/worklist`]: () => json(worklist([signed, other])) },
      "?tab=participants&caseItem=dsv_not_fully_executed",
    );
    const row = await worklistRow("BSP-0004");
    expect(row).toHaveTextContent(
      "DSV nicht vollständig unterschrieben (Teilnehmende unterschrieben am 02.10.2026)",
    );
    expect(list().queryByText("BSP-0005")).toBeNull();
    expect(
      screen.getAllByText(/Offene Arbeit: DSV: unterschrieben, nicht vollständig/).length,
    ).toBeGreaterThan(0);
  });
});

describe("the work list's order, views and columns (ui-patterns.md; the plan of Slice 6b, D5–D8)", () => {
  it("opens in the next step's order, sorts by a header into the URL, and a reload keeps it", async () => {
    const { router } = setup();
    await worklistRow("BSP-0002");
    // Overdue first (BSP-0002), then the undated orientation (BSP-0003), then the upcoming
    // deadline (BSP-0001): process-and-lifecycle.md, the work list's next step.
    expect(shownPersonnelNumbers()).toEqual(["BSP-0002", "BSP-0003", "BSP-0001"]);
    await userEvent.click(list().getByRole("button", { name: /Teilnehmende/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ sort: "name" }));
    // Beispiel, Größer, Muster.
    expect(shownPersonnelNumbers()).toEqual(["BSP-0003", "BSP-0001", "BSP-0002"]);
    await userEvent.click(list().getByRole("button", { name: /Teilnehmende/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ sort: "-name" }));
    cleanup();
    setup({}, "?tab=participants&sort=-name");
    await worklistRow("BSP-0002");
    expect(shownPersonnelNumbers()).toEqual(["BSP-0002", "BSP-0001", "BSP-0003"]);
  });

  it("drops an unknown sort code, so a stale link still opens", async () => {
    setup({}, "?tab=participants&sort=lastName");
    await worklistRow("BSP-0002");
    expect(shownPersonnelNumbers()).toEqual(["BSP-0002", "BSP-0003", "BSP-0001"]);
  });

  it("renders no bulk control without a selection, then only the actions the capabilities allow", async () => {
    setup();
    await worklistRow("BSP-0001");
    for (const label of [
      "Berater zuweisen",
      "Welle zuweisen",
      "Erinnern",
      "Einladen",
      "Kug 200b erzeugen",
      "Aktivierung drucken",
    ]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("checkbox", { name: "BSP-0001 auswählen" }));
    const bar = within(screen.getByText("1 ausgewählt").closest(".cds--batch-actions")!);
    // The PL may assign consultants (the team's capability) and waves (the rows'), nothing else.
    expect(
      bar
        .getAllByRole("button")
        .map((b) => b.textContent)
        .filter((text) => text !== "Auswahl aufheben"),
    ).toEqual(["Berater zuweisen", "Welle zuweisen"]);
  });

  it("offers no selection when the capabilities allow no batch action", async () => {
    setup({
      [`GET ${path}/worklist`]: () =>
        json(
          worklist(items.map((item) => ({ ...item, capabilities: worklistItem().capabilities }))),
        ),
      [`GET ${path}/members`]: () =>
        json({ ...team, capabilities: { ...team.capabilities, assignParticipations: false } }),
    });
    await worklistRow("BSP-0001");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows six columns in ta_tg, more through the chooser, kept in memory only", async () => {
    setup();
    await worklistRow("BSP-0001");
    const headers = () =>
      within(list().getByRole("table"))
        .getAllByRole("columnheader")
        .map((h) => h.textContent?.replace(/^Nach .* sortieren/, ""))
        .filter((text) => text && text !== "Alle Zeilen auswählen");
    expect(headers()).toEqual([
      "Teilnehmende",
      "Status",
      "Nächster Schritt",
      "Frist",
      "Beratung",
      "Welle",
      "Aktionen",
    ]);
    await userEvent.click(list().getByRole("button", { name: "Spalten" }));
    await userEvent.click(list().getByRole("checkbox", { name: "Portal" }));
    expect(headers()).toContain("Portal");
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/portal/i);
    expect(window.location.href).not.toMatch(/portal|column/i);
    // Another tab and back keeps the choice (memory); a reload restores the defaults.
    await openSection("Termine");
    await openSection("Teilnehmende");
    await worklistRow("BSP-0001");
    expect(headers()).toContain("Portal");
    cleanup();
    forgetWorklistMemory();
    setup();
    await worklistRow("BSP-0001");
    expect(headers()).not.toContain("Portal");
  });

  it("keeps the search term in memory for the way back, never in the URL", async () => {
    const { router } = setup();
    const search = await screen.findByRole("searchbox", {
      name: "Name oder Personalnummer suchen",
    });
    await userEvent.type(search, "muster");
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0002"]));
    await openSection("Termine");
    await openSection("Teilnehmende");
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0002"]));
    expect(screen.getByRole("searchbox", { name: "Name oder Personalnummer suchen" })).toHaveValue(
      "muster",
    );
    expect(router.state.location.href).not.toMatch(/muster/i);
  });

  it("opens the participant on a row click", async () => {
    const { router } = setup();
    const row = await worklistRow("BSP-0003");
    await userEvent.click(within(row).getAllByRole("cell")[3]!);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/projects/${project.id}/participations/${id(3)}`,
      ),
    );
  });

  it("shows the quick views with their counts; one replaces the filters, a count of 0 stays", async () => {
    const { router } = setup({}, "?tab=participants&status=informed");
    await worklistRow("BSP-0001");
    const views = within(list().getByRole("list", { name: "Schnellansichten" }));
    // The PL of the project: the PL's views, without "Mir zugewiesen" (not a consultant).
    expect(views.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Alle (3)",
      "Überfällig (1)",
      "In den nächsten 14 Tagen (1)",
      "Angaben/Unterlagen fehlen (1)",
      "Hinweise (0)",
      "Termine zu klären (1)",
      "Ohne Beratung (3)",
    ]);
    expect(views.getByRole("button", { name: "Alle (3)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(views.getByRole("button", { name: "Überfällig (1)" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        deadlineState: "overdue",
      }),
    );
    expect(views.getByRole("button", { name: "Überfällig (1)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(personnelNumbers()).toEqual(["BSP-0002"]);
    await userEvent.click(views.getByRole("button", { name: "Hinweise (0)" }));
    expect(
      await list().findByText("Keine Teilnehmenden entsprechen der Suche und den Filtern."),
    ).toBeInTheDocument();
  });

  it("shows a consultant who is not the PL only the views for everyone", async () => {
    setup({
      "GET /api/v1/me": () => json({ ...staffUsers[1], id: consultant.id }),
    });
    await worklistRow("BSP-0001");
    const views = within(list().getByRole("list", { name: "Schnellansichten" }));
    expect(views.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Alle (3)",
      "Überfällig (1)",
      "In den nächsten 14 Tagen (1)",
      "Angaben/Unterlagen fehlen (1)",
      "Hinweise (0)",
    ]);
    expect(
      list().getByText(/3 Ihrer zugewiesenen Teilnehmenden · Stand 10:42/),
    ).toBeInTheDocument();
  });
});

describe("quick views and dashboard tiles (the plan of Slice 6b, D6)", () => {
  const pl = { staffUserId: consultant.id, projectLead: true, backOffice: false, consultant: true };

  it("selects exactly D6's filters, by role", () => {
    expect(quickViews(pl)).toEqual([
      { key: "all", filter: {} },
      { key: "overdue", filter: { deadlineState: "overdue" } },
      { key: "upcoming", filter: { deadlineState: "upcoming" } },
      { key: "actions", filter: { actions: "any" } },
      { key: "flags", filter: { flag: "any" } },
      { key: "appointmentsToResolve", filter: { appointment: "to_resolve" } },
      { key: "noConsultant", filter: { consultant: "none" } },
      { key: "mine", filter: { consultant: consultant.id } },
    ]);
    const backOffice = { ...pl, projectLead: false, backOffice: true, consultant: false };
    expect(quickViews(backOffice).map((v) => v.key)).toEqual([
      "all",
      "overdue",
      "upcoming",
      "actions",
      "flags",
      "noConsultant",
    ]);
  });

  it("gives each tile that is a quick view the quick view's filter and label", () => {
    const tiles = funnelFilters({ type: "ta_tg", waves: [wave] }).tiles;
    const views = quickViews(pl);
    const pairs = Object.entries(tileViews).map(([tile, view]) => ({
      tile,
      equal: sameFilter(
        tiles.find((entry) => entry.key === tile)!.filter,
        views.find((entry) => entry.key === view)!.filter,
      ),
    }));
    expect(pairs).toEqual([
      { tile: "deadline_overdue", equal: true },
      { tile: "deadline_upcoming", equal: true },
      { tile: "open_actions", equal: true },
      { tile: "flags", equal: true },
      { tile: "appointments_to_resolve", equal: true },
    ]);
    // Every tile with a quick view's filter is paired, except "Teilnehmende" ({}).
    const sharing = tiles.flatMap((tile) => {
      const view = views.find((entry) => sameFilter(entry.filter, tile.filter));
      return view && view.key !== "all" ? [[tile.key, view.key]] : [];
    });
    expect(Object.fromEntries(sharing)).toEqual(tileViews);
  });

  it("compares filters as sets of conditions", () => {
    expect(
      sameFilter({ status: "informed", flag: "any" }, { flag: "any", status: "informed" }),
    ).toBe(true);
    expect(sameFilter({ status: "informed" }, { status: "contacted" })).toBe(false);
    expect(sameFilter({ status: "informed" }, {})).toBe(false);
  });
});
