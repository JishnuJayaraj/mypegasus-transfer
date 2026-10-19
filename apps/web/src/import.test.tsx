import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
} from "./test-utils";

// Slice 2 plan 5.11, 5.13 (PR 2g-2): the import wizard and the participant list.
const path = `/api/v1/projects/${project.id}`;
const token = "a".repeat(64);
const file = () =>
  new File(["Personalnummer;Nachname\nBSP-0001;Mustermann\n"], "teilnehmer.csv", {
    type: "text/csv",
  });

const headers = ["Personalnummer", "Nachname", "Vorname", "Geburtsdatum", "Austrittsdatum"];
const suggested = headers.map((_, column) => ({
  column,
  target: ["personnelNumber", "lastName", "firstName", "birthDate", "oldEmploymentEndDate"][column],
  source: "builtin",
}));
const mapping = suggested.map(({ column, target }) => ({ column, target }));
const counts = {
  rows: 4,
  create: 2,
  update: 1,
  unchanged: 0,
  skip: 0,
  error: 0,
  warnings: 0,
  missing: 3,
};
const first = {
  format: "csv",
  sheets: [],
  sheet: null,
  csv: { delimiter: ";", encoding: "utf-8" },
  headerRow: 1,
  headers,
  suggestedMapping: suggested,
  mapping: [],
  missingTargets: [],
  mappingIssues: [],
  report: null,
  previewToken: null,
};
const withReport = (rows: object[], extra: object = {}, count: object = {}) => ({
  ...first,
  mapping,
  report: { counts: { ...counts, ...count }, rows },
  previewToken: token,
  ...extra,
});
const issue = (row: number, code: string, severity = "error", target: string | null = null) => ({
  row,
  target,
  code,
  severity,
});

const wavesPage = { items: [], nextCursor: null };
const participant = (n: number, extra: object = {}) => ({
  id: `00000000-0000-4000-a000-0000000000${String(n).padStart(2, "0")}`,
  status: "imported",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  entryWaveId: null,
  personnelNumber: `BSP-000${n}`,
  lastName: "Mustermann",
  firstName: "Erika",
  ...extra,
});

function setup(routes: Parameters<typeof mockApi>[0] = {}, config: object = unpinnedConfig) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json(wavesPage),
    [`GET ${path}/config`]: () => json(config),
    [`GET ${path}/participations`]: () => json({ items: [], nextCursor: null }),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    ...routes,
  });
  renderApp(`/projects/${project.id}`, api);
  return calls;
}

const upload = async () =>
  userEvent.upload(await screen.findByLabelText("Datei auswählen"), file());
const bodyOf = (calls: ReturnType<typeof setup>, key: string, index = -1) =>
  calls.filter((c) => c.key === key).at(index)?.body as Record<string, unknown>;

describe("the import wizard", () => {
  it("is offered only with the server's capability", async () => {
    const calls = setup(
      {},
      {
        ...unpinnedConfig,
        capabilities: { ...unpinnedConfig.capabilities, importParticipations: false },
      },
    );
    expect(await screen.findByRole("heading", { name: "Import" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Datei auswählen")).toBeNull();
    expect(calls.some((c) => c.key.includes("/imports"))).toBe(false);
  });

  it("uploads, suggests a mapping, checks it and imports with the token and the decisions", async () => {
    const calls = setup({
      [`POST ${path}/imports/preview`]: ({ body }) =>
        json((body as { mapping?: unknown }).mapping ? withReport([]) : first),
      [`POST ${path}/imports`]: () => json({ created: 4, updated: 0, unchanged: 0, skipped: 0 }),
    });
    await upload();
    // Sheet, header row and the CSV facts the PL checks (umlauts).
    expect(await screen.findByLabelText("Zeile der Spaltenüberschriften")).toHaveValue("1");
    expect(screen.getByLabelText("Trennzeichen")).toHaveValue(";");
    expect(screen.getByLabelText("Zeichencodierung")).toHaveValue("utf-8");
    const sent = bodyOf(calls, `POST ${path}/imports/preview`);
    expect(sent).toMatchObject({ headerRow: 1 });
    expect(typeof sent.file).toBe("string");
    expect(sent).not.toHaveProperty("fileName");
    // The suggestions are preselected, labelled as suggestions, and stay changeable.
    expect(screen.getByLabelText("Zuordnung für Spalte 1: Personalnummer")).toHaveValue(
      "personnelNumber",
    );
    expect(screen.getAllByText("Vorschlag: nach der Überschrift")).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "Prüfen" }));
    expect(await screen.findByText(/4 Zeilen: 2 neu, 1 Aktualisierungen/)).toBeInTheDocument();
    expect(bodyOf(calls, `POST ${path}/imports/preview`)).toMatchObject({ mapping });
    await userEvent.click(screen.getByRole("button", { name: "Import durchführen" }));
    expect(await screen.findByText(/4 angelegt, 0 aktualisiert/)).toBeInTheDocument();
    expect(bodyOf(calls, `POST ${path}/imports`)).toMatchObject({
      mapping,
      previewToken: token,
      decisions: { confirmWarnings: false, possibleDuplicates: {} },
    });
    // The new participants are read again.
    expect(calls.filter((c) => c.key === `GET ${path}/participations`).length).toBeGreaterThan(1);
  });

  it("sends the whole-import country and the header row the PL chose", async () => {
    const calls = setup({
      [`POST ${path}/imports/preview`]: () => json(first),
    });
    await upload();
    await userEvent.selectOptions(await screen.findByLabelText("Land für alle Zeilen"), "DE");
    await userEvent.selectOptions(screen.getByLabelText("Zeile der Spaltenüberschriften"), "3");
    const sent = bodyOf(calls, `POST ${path}/imports/preview`);
    expect(sent).toMatchObject({ headerRow: 3 });
    await userEvent.click(screen.getByRole("button", { name: "Prüfen" }));
    expect(bodyOf(calls, `POST ${path}/imports/preview`)).toMatchObject({
      country: "DE",
      headerRow: 3,
    });
  });

  it("shows what the mapping lacks, with a message per code", async () => {
    setup({
      [`POST ${path}/imports/preview`]: () =>
        json({
          ...first,
          missingTargets: ["birthDate"],
          mappingIssues: [
            issue(null as never, "required_missing", "error", "birthDate"),
            issue(null as never, "country_required", "error", "addressCountry"),
          ],
        }),
    });
    await upload();
    await userEvent.click(await screen.findByRole("button", { name: "Prüfen" }));
    const alert = await screen.findByText("Probleme bei der Zuordnung");
    const list = within(alert.parentElement!);
    expect(list.getByText("Geburtsdatum: Pflichtangabe fehlt")).toBeInTheDocument();
    expect(list.getByText(/Land \(Spalte\): Für die Anschrift fehlt das Land/)).toBeInTheDocument();
  });

  it("blocks a file with errors and lists them by row", async () => {
    setup({
      [`POST ${path}/imports/preview`]: ({ body }) =>
        json(
          (body as { mapping?: unknown }).mapping
            ? withReport(
                [
                  {
                    row: 5,
                    outcome: "error",
                    personnelNumber: "BSP-0005",
                    issues: [issue(5, "invalid_date", "error", "birthDate")],
                  },
                ],
                { previewToken: null },
                { error: 1 },
              )
            : first,
        ),
    });
    await upload();
    await userEvent.click(await screen.findByRole("button", { name: "Prüfen" }));
    expect(
      await screen.findByText(
        "Zeile 5 (BSP-0005): Geburtsdatum: Kein gültiges Datum (erwartet TT.MM.JJJJ)",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import durchführen" })).toBeDisabled();
  });

  it("needs a decision for every possible duplicate and the warnings confirmed", async () => {
    const calls = setup({
      [`POST ${path}/imports/preview`]: ({ body }) =>
        json(
          (body as { mapping?: unknown }).mapping
            ? withReport([
                {
                  row: 14,
                  outcome: "create",
                  personnelNumber: "BSP-0777",
                  issues: [issue(14, "possible_duplicate", "warning")],
                },
                {
                  row: 15,
                  outcome: "create",
                  personnelNumber: "BSP-0888",
                  issues: [issue(15, "age_implausible", "warning", "birthDate")],
                },
              ])
            : first,
        ),
      [`POST ${path}/imports`]: () => json({ created: 3, updated: 0, unchanged: 0, skipped: 0 }),
    });
    await upload();
    await userEvent.click(await screen.findByRole("button", { name: "Prüfen" }));
    const confirmButton = await screen.findByRole("button", { name: "Import durchführen" });
    expect(confirmButton).toBeDisabled();
    expect(
      screen.getByText("Bitte entscheiden Sie zuerst über alle möglichen Dubletten."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Trotzdem anlegen"));
    expect(confirmButton).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Ich habe die Warnungen zur Kenntnis genommen."));
    expect(confirmButton).toBeEnabled();
    await userEvent.click(confirmButton);
    await screen.findByText(/3 angelegt/);
    expect(bodyOf(calls, `POST ${path}/imports`)).toMatchObject({
      decisions: { confirmWarnings: true, possibleDuplicates: { "14": "create" } },
    });
  });

  it("shows updates with the old and the new value and the values an empty cell kept", async () => {
    setup({
      [`POST ${path}/imports/preview`]: ({ body }) =>
        json(
          (body as { mapping?: unknown }).mapping
            ? withReport([
                {
                  row: 2,
                  outcome: "update",
                  personnelNumber: "BSP-0001",
                  issues: [issue(2, "kept_existing", "warning", "phone")],
                  changes: [
                    { target: "addressStreet", old: "Musterstraße 1", new: "Neue Straße 100" },
                    { target: "mobile", old: null, new: "0171 3920 001" },
                  ],
                  kept: [{ target: "phone", value: "030 23125 001" }],
                },
              ])
            : first,
        ),
    });
    await upload();
    await userEvent.click(await screen.findByRole("button", { name: "Prüfen" }));
    expect(
      await screen.findByText(
        "Zeile 2 (BSP-0001): Straße und Hausnummer: bisher Musterstraße 1, neu Neue Straße 100; Mobil: bisher leer, neu 0171 3920 001",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Zeile 2 (BSP-0001): Telefon bleibt: 030 23125 001"),
    ).toBeInTheDocument();
  });

  it("keeps a refusal visible after the wizard went away, and reads the state again", async () => {
    let config: object = unpinnedConfig;
    const calls = setup({
      [`GET ${path}/config`]: () => json(config),
      [`POST ${path}/imports/preview`]: ({ body }) =>
        json((body as { mapping?: unknown }).mapping ? withReport([]) : first),
      [`POST ${path}/imports`]: () => {
        // The PL's role was withdrawn meanwhile: the API refuses and the capability is gone.
        config = {
          ...unpinnedConfig,
          capabilities: { ...unpinnedConfig.capabilities, importParticipations: false },
        };
        return problem(403, "forbidden");
      },
    });
    await upload();
    await userEvent.click(await screen.findByRole("button", { name: "Prüfen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Import durchführen" }));
    expect(
      await screen.findByText("Sie dürfen in diesem Projekt keinen Import durchführen."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Import" })).toBeInTheDocument();
    await screen.findByText("Import abgelehnt");
    expect(screen.queryByRole("button", { name: "Import durchführen" })).toBeNull();
    expect(screen.queryByLabelText("Datei auswählen")).toBeNull();
    expect(calls.filter((c) => c.key === `GET ${path}/config`).length).toBeGreaterThan(1);
  });

  it("replaces a stale preview by a new one to check", async () => {
    let previews = 0;
    const calls = setup({
      [`POST ${path}/imports/preview`]: ({ body }) => {
        if (!(body as { mapping?: unknown }).mapping) return json(first);
        previews += 1;
        return json(withReport([], {}, { create: previews === 1 ? 2 : 3 }));
      },
      [`POST ${path}/imports`]: () =>
        problem(409, "conflict", {
          errors: [{ pointer: "", code: "import_preview_stale", detail: "x" }],
        }),
    });
    await upload();
    await userEvent.click(await screen.findByRole("button", { name: "Prüfen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Import durchführen" }));
    expect(await screen.findByText(/Die Prüfung wurde erneuert/)).toBeInTheDocument();
    expect(await screen.findByText(/4 Zeilen: 3 neu/)).toBeInTheDocument();
    expect(calls.filter((c) => c.key === `POST ${path}/imports/preview`)).toHaveLength(3);
  });

  it("shows a refusal of the file by its code", async () => {
    setup({
      [`POST ${path}/imports/preview`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "/file", code: "too_many_rows", detail: "x" }],
        }),
    });
    await upload();
    expect(
      await screen.findByText(
        "Die Datei hat mehr als 5.000 Datenzeilen. Bitte teilen Sie sie auf.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Datei auswählen")).toBeInTheDocument();
  });
});

describe("the participant list", () => {
  it("shows the participations page by page", async () => {
    setup({
      [`GET ${path}/participations`]: ({ query }) =>
        json(
          query.get("cursor")
            ? {
                items: [participant(2, { lastName: "Musterfrau", status: "contacted" })],
                nextCursor: null,
              }
            : { items: [participant(1)], nextCursor: "next" },
        ),
    });
    const section = await screen.findByRole("region", { name: "Teilnehmende" });
    expect(await within(section).findByText("BSP-0001")).toBeInTheDocument();
    expect(within(section).getByText("Importiert")).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Weitere laden" }));
    expect(await within(section).findByText("Musterfrau")).toBeInTheDocument();
    expect(within(section).getByText("Kontaktiert")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Weitere laden" })).toBeNull();
  });

  it("says so when the API refuses the list, and when there is nobody", async () => {
    setup({ [`GET ${path}/participations`]: () => problem(403, "forbidden") });
    expect(
      await screen.findByText("Sie dürfen die Teilnehmenden dieses Projekts nicht sehen."),
    ).toBeInTheDocument();
  });

  it("says that there is nobody yet", async () => {
    setup();
    expect(await screen.findByText(/Es gibt noch keine Teilnehmenden/)).toBeInTheDocument();
  });
});
