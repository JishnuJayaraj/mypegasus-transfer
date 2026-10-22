import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { funnelFilters, projectFunnel } from "@transfer/domain";
import { describe, expect, it } from "vitest";
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
    capabilities: capable,
  }),
  worklistItem({
    id: id(3),
    personnelNumber: "BSP-0003",
    lastName: "Beispiel",
    firstName: "Bernd",
    status: "informed",
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
const ready = async () => within(await screen.findByRole("region", { name: "Teilnehmende" }));
const personnelNumbers = () =>
  list()
    .queryAllByRole("link")
    .map((link) => link.textContent)
    .filter((text) => text?.startsWith("BSP-"));

describe("Übersicht", () => {
  it("shows the tiles, and each number opens the work list with the same filter", async () => {
    const { router } = setup({}, "");
    const tile = await screen.findByRole("link", { name: "1 Frist in 14 Tagen" });
    expect(screen.getByRole("link", { name: "3 Teilnehmende" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "1 mit offenen Angaben oder Unterlagen" }),
    ).toBeInTheDocument();
    await userEvent.click(tile);
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        tab: "participants",
        deadlineState: "upcoming",
      }),
    );
    expect(await (await ready()).findByText("1 Treffer", { exact: false })).toBeInTheDocument();
    expect(personnelNumbers()).toEqual(["BSP-0001"]);
  });

  it("links every table count to its filter", async () => {
    setup({}, "");
    const statuses = await screen.findByRole("table", { name: "Status" });
    const informed = within(statuses).getByRole("row", { name: /Informiert/ });
    const link = within(informed).getByRole("link", { name: "2" });
    const filter = funnelFilters({ type: "ta_tg", waves: [wave] }).statuses.find(
      (f) => f.key === "informed",
    )!.filter;
    expect(link.getAttribute("href")).toContain(`status=${filter.status}`);
    expect(link.getAttribute("href")).toContain("tab=participants");
    const waves = screen.getByRole("table", { name: "Nach Welle" });
    expect(within(waves).getByRole("row", { name: /Ohne Welle/ })).toHaveTextContent("3");
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
    const row = (await (await ready()).findByRole("link", { name: "BSP-0001" })).closest("tr")!;
    expect(within(row).getByText(/^2 offen/)).toBeInTheDocument();
    expect(within(row).getByText("Mobilnummer fehlt")).toBeInTheDocument();
    expect(within(row).getByRole("cell", { name: "TG-Beginn: in 8 Tagen" })).toBeInTheDocument();
    const other = list().getByRole("link", { name: "BSP-0002" }).closest("tr")!;
    expect(
      within(other).getByRole("cell", {
        name: "Datenschutzhinweis: überschritten seit 01.10.2026",
      }),
    ).toBeInTheDocument();
    expect(within(other).getByRole("cell", { name: "Einwilligung fehlt" })).toBeInTheDocument();
  });

  it("keeps the code filters in the route's search params, both ways", async () => {
    const { router } = setup({}, "?tab=participants&status=informed");
    expect(await (await ready()).findByLabelText("Status")).toHaveValue("informed");
    await waitFor(() => expect(personnelNumbers()).toEqual(["BSP-0001", "BSP-0003"]));
    await userEvent.selectOptions(list().getByLabelText("Offene Punkte"), "rejected_documents");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        tab: "participants",
        status: "informed",
        actions: "rejected_documents",
      }),
    );
    expect(personnelNumbers()).toEqual(["BSP-0001"]);
    await userEvent.click(list().getByRole("button", { name: "Filter zurücksetzen" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "participants" }));
  });

  it("while loading, shows no empty state and disables the search and select-all", async () => {
    const gate: { release?: () => void } = {};
    const pending = new Promise<void>((resolve) => (gate.release = resolve));
    setup({
      [`GET ${path}/worklist`]: async () => {
        await pending;
        return json(worklist(items));
      },
    });
    expect(await screen.findByText("Wird geladen…")).toBeInTheDocument();
    expect(screen.getByLabelText("Name oder Personalnummer suchen")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Alle Treffer auswählen" })).toBeNull();
    expect(screen.queryByText(/Es gibt noch keine Teilnehmenden/)).toBeNull();
    expect(screen.queryByText(/Keine Teilnehmenden entsprechen/)).toBeNull();
    gate.release!();
    expect(await screen.findByRole("button", { name: "Alle Treffer auswählen" })).toBeEnabled();
    expect(screen.getByLabelText("Name oder Personalnummer suchen")).toBeEnabled();
  });

  it("searches names in memory: folded, never in the URL, a query key, a request or storage", async () => {
    const { router, queryClient, calls } = setup();
    const search = await screen.findByLabelText("Name oder Personalnummer suchen");
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
      await (await ready()).findByRole("button", { name: "Alle Treffer auswählen" }),
    );
    await userEvent.selectOptions(list().getByLabelText("Eintrittswelle"), wave.id);
    await userEvent.click(list().getByRole("button", { name: "Eintrittswelle zuweisen (3)" }));
    await screen.findByRole("alert");
    const section = screen.getByRole("region", { name: "Eintrittswelle zuweisen" });
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
    await userEvent.selectOptions(list().getByLabelText("Eintrittswelle"), wave.id);
    await userEvent.click(list().getByRole("button", { name: "Eintrittswelle zuweisen (1)" }));
    expect(await screen.findByText("1 zugewiesen, 0 unverändert")).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.key === `GET ${path}/worklist`)).toHaveLength(2),
    );
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
