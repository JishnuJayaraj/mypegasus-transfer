import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { documentNavigation } from "./components/documents-tab";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
} from "./test-utils";

// The tab "DSV" (process-and-lifecycle.md, the DSV: generation) and the project's
// "DSV-Vorlage": the deadline chosen before "Erzeugen" with nothing preset, a blocked generation's
// prerequisite as text (ui-patterns.md, C1), the handwriting checklist before printing, the
// generated papers with "Öffnen" and "veraltet", a moved source as a conflict, and the PL's pin.
// Synthetic data only.
const ta = { ...project, type: "ta_tg" };
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const documentId = "00000000-0000-4000-a000-0000000000d1";
const generationId = "00000000-0000-4000-a000-0000000000f1";
const token = "a".repeat(64);

const detail = {
  id: participationId,
  projectId: project.id,
  status: "informed",
  profilingStatus: "profiling_accepted",
  dsvStatus: "not_offered",
  statusVersion: 3,
  entryWave: null,
  dates: {
    tgStart: null,
    tgEnd: null,
    effectiveTgStart: "2091-03-01",
    effectiveTgEnd: "2092-02-29",
    offerDeadline: null,
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
  person: { personnelNumber: "BSP-0001", lastName: "Beispiel", firstName: "Erika" },
  assignments: [],
  activationStatus: { account: "activated", code: "none", issuedAt: null, expiresAt: null },
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
    viewProfiling: false,
    viewAsu: false,
    viewDsv: true,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
};

const generation = (stale: boolean) => ({
  generationId,
  documentId,
  generatedAt: "2091-02-01T09:00:00.000000Z",
  templateVersion: "v1",
  offerDeadline: "2091-02-15",
  deadlineKind: "wave",
  checklist: [{ code: "required_blank", key: "address" }],
  stale,
  capabilities: { open: true },
});

const view = (overrides: object = {}) => ({
  scans: [],
  receivers: [],
  participationId,
  track: "not_offered",
  statusVersion: 3,
  offers: [],
  template: { version: "v1", approvedForLive: false },
  deadline: {
    waveSigningDeadline: "2091-02-15",
    explicitRequired: false,
    latestEntryDate: "2091-03-15",
    tgStart: "2091-03-01",
  },
  sourceToken: token,
  checklist: [{ code: "required_blank", key: "address" }],
  blockers: [],
  generations: [],
  facts: { dsvGenerated: null },
  capabilities: { generate: true, offer: true, uploadScan: true, sign: true },
  ...overrides,
});

function setup(first: object, routes: Parameters<typeof mockApi>[0] = {}) {
  let current = first;
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(ta),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail),
    [`GET ${detailPath}/dsv`]: () => json(current),
    [`POST ${detailPath}/dsv/generations`]: () => {
      current = view({ generations: [generation(false)] });
      return json(
        {
          documentId,
          templateVersion: "v1",
          offerDeadline: "2091-02-15",
          checklist: [{ code: "required_blank", key: "address" }],
        },
        201,
      );
    },
    [`POST ${detailPath}/documents/${documentId}/opening`]: () =>
      json({ url: "/api/v1/document-content/t1", expiresAt: "2091-02-01T09:01:00.000000Z" }, 201),
    ...routes,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=dsv`, mock.api);
  return mock;
}

const card = async (name: string) =>
  within((await screen.findByRole("heading", { name })).closest("section")!);

describe("the tab DSV", () => {
  it("is a tab for its readers; the deadline is chosen first, nothing preset", async () => {
    const { calls } = setup(view());
    expect(await screen.findByRole("tab", { name: "DSV" })).toBeInTheDocument();
    const generate = await card("Vertrag erzeugen");
    const button = generate.getByRole("button", { name: "Erzeugen" });
    expect(button).toBeDisabled();
    expect(generate.getByText("Erst eine Frist wählen.")).toBeInTheDocument();
    const wave = generate.getByRole("radio", { name: "Unterschriftsfrist der Welle, 15.02.2091" });
    expect(wave).not.toBeChecked();
    expect(generate.getByRole("radio", { name: "Frist eingeben" })).not.toBeChecked();
    // the checklist before printing names the key, never a value
    expect(generate.getByTestId("dsv-checklist")).toHaveTextContent(
      "Anschrift: fehlt – von Hand eintragen",
    );

    await userEvent.click(wave);
    await userEvent.click(button);
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/dsv/generations`,
        body: { deadline: { kind: "wave", shown: "2091-02-15" }, expectedSourceToken: token },
      }),
    );
    expect(await screen.findByText("Der Vertrag wurde erzeugt (Frist 15.02.2091).")).toBeVisible();
    const table = await screen.findByRole("table", { name: "Erzeugte Verträge" });
    expect(table).toHaveTextContent("15.02.2091 (Frist der Welle)");
    expect(table).toHaveTextContent("aktuell");
  });

  it("takes an explicit date, required before it is sent", async () => {
    const { calls } = setup(view());
    const generate = await card("Vertrag erzeugen");
    await userEvent.click(generate.getByRole("radio", { name: "Frist eingeben" }));
    expect(generate.getByText("Erst die Frist eingeben.")).toBeInTheDocument();
    await userEvent.type(generate.getByLabelText("Frist (TT.MM.JJJJ)"), "20.02.2091");
    await userEvent.click(generate.getByRole("button", { name: "Erzeugen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/dsv/generations`,
        body: { deadline: { kind: "explicit", date: "2091-02-20" }, expectedSourceToken: token },
      }),
    );
  });

  it("offers a re-offer no wave deadline", async () => {
    setup(view({ track: "dsv_expired", deadline: { ...view().deadline, explicitRequired: true } }));
    const generate = await card("Vertrag erzeugen");
    expect(generate.queryByRole("radio", { name: /Unterschriftsfrist der Welle/ })).toBeNull();
    expect(generate.getByText("Ein erneutes Angebot braucht eine eigene Frist.")).toBeVisible();
  });

  it("names a blocked generation's prerequisite next to the button (C1)", async () => {
    setup(
      view({
        template: null,
        blockers: ["dsv_template_not_pinned"],
        capabilities: { generate: false },
      }),
    );
    const generate = await card("Vertrag erzeugen");
    expect(generate.getByRole("button", { name: "Erzeugen" })).toBeDisabled();
    expect(
      generate.getByText("Erst die DSV-Vorlage des Projekts festlegen (Einrichtung)."),
    ).toBeVisible();
    expect(generate.queryByRole("radio")).toBeNull();
  });

  it("opens a paper through the logged opening and marks a stale one", async () => {
    const assign = vi.spyOn(documentNavigation, "assign").mockImplementation(() => {});
    const { calls } = setup(view({ generations: [generation(true)] }));
    const table = await screen.findByRole("table", { name: "Erzeugte Verträge" });
    expect(table).toHaveTextContent("veraltet");
    expect(table).toHaveTextContent("Anschrift");
    await userEvent.click(within(table).getByRole("button", { name: /^Öffnen: Vertrag vom/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/v1/document-content/t1"));
    expect(calls.map((call) => call.key)).toContain(
      `POST ${detailPath}/documents/${documentId}/opening`,
    );
    assign.mockRestore();
  });

  it("answers a moved source with the conflict, keeping the choice to try again", async () => {
    setup(view(), {
      [`POST ${detailPath}/dsv/generations`]: () =>
        problem(409, "conflict", {
          errors: [{ pointer: "/expectedSourceToken", code: "source_changed" }],
        }),
    });
    const generate = await card("Vertrag erzeugen");
    await userEvent.click(generate.getByRole("radio", { name: /Unterschriftsfrist der Welle/ }));
    await userEvent.click(generate.getByRole("button", { name: "Erzeugen" }));
    expect(
      await screen.findByText(
        "Die Angaben haben sich inzwischen geändert. Bitte die Ansicht prüfen und erneut erzeugen.",
      ),
    ).toBeVisible();
  });

  it("is no tab for a viewer without the DSV", async () => {
    const mock = mockApi({
      "GET /api/v1/me": () => json(staffUsers[1]),
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      [`GET ${projectPath}`]: () => json(ta),
      [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
      [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
      [`GET ${detailPath}`]: () =>
        json({ ...detail, capabilities: { ...detail.capabilities, viewDsv: false } }),
    });
    renderApp(`/projects/${project.id}/participations/${participationId}?tab=dsv`, mock.api);
    expect(await screen.findByRole("tab", { name: "Übersicht" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "DSV" })).toBeNull();
  });
});

const template = (overrides: object = {}) => ({
  version: null,
  fixed: false,
  versions: [{ version: "v1", approvedForLive: false }],
  capabilities: { pin: true },
  ...overrides,
});

function setupProject(first: object, routes: Parameters<typeof mockApi>[0] = {}) {
  let current = first;
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(ta),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`GET ${projectPath}/dsv-template`]: () => json(current),
    [`PUT ${projectPath}/dsv-template`]: () => {
      current = template({ version: "v1" });
      return json(current);
    },
    ...routes,
  });
  renderApp(`/projects/${project.id}?tab=setup`, mock.api);
  return mock;
}

describe("the project's DSV-Vorlage", () => {
  it("lets the PL pin a version, said to be a sample", async () => {
    const { calls } = setupProject(template());
    const section = await card("DSV-Vorlage");
    expect(await section.findByText(/Noch keine Vorlage festgelegt/)).toBeVisible();
    expect(section.getByRole("button", { name: "Festlegen" })).toBeDisabled();
    await userEvent.selectOptions(section.getByLabelText("Vorlage"), "v1");
    await userEvent.click(section.getByRole("button", { name: "Festlegen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `PUT ${projectPath}/dsv-template`,
        body: { version: "v1" },
      }),
    );
    expect(
      await section.findByText("Festgelegt: v1 (Muster, nicht für den Live-Betrieb freigegeben)."),
    ).toBeVisible();
  });

  it("shows a fixed pin without the form, and who may see it", async () => {
    setupProject(template({ version: "v1", fixed: true, capabilities: { pin: false } }));
    const section = await card("DSV-Vorlage");
    expect(await section.findByText(/Seit dem ersten erzeugten DSV unveränderlich/)).toBeVisible();
    expect(section.queryByRole("button", { name: "Festlegen" })).toBeNull();
  });

  it("tells a consultant who may see it", async () => {
    setupProject(template(), {
      [`GET ${projectPath}/dsv-template`]: () => problem(403, "forbidden"),
    });
    const section = await card("DSV-Vorlage");
    expect(
      await section.findByText("Die DSV-Vorlage sehen die Projektleitung und das Back Office."),
    ).toBeVisible();
  });
});

it("offers the selected generation with the displayed status version", async () => {
  const { calls } = setup(view({ generations: [generation(false)] }), {
    [`POST ${detailPath}/dsv/offers`]: () => json(view(), 201),
  });
  await userEvent.click(await screen.findByRole("button", { name: "Angebot erfassen" }));
  await waitFor(() =>
    expect(calls.some((call) => call.key === `POST ${detailPath}/dsv/offers`)).toBe(true),
  );
  expect(calls.find((call) => call.key === `POST ${detailPath}/dsv/offers`)?.body).toEqual({
    generationId,
    statusVersion: 3,
  });
});

it("records external paper in a panel with required dates and draft protection", async () => {
  const { calls } = setup(view(), {
    [`POST ${detailPath}/dsv/offers`]: () => json(view(), 201),
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Papierangebot ohne Erzeugung erfassen" }),
  );
  const panel = within(
    screen.getByRole("dialog", { name: "Papierangebot ohne Erzeugung erfassen" }),
  );
  expect(panel.getByRole("button", { name: "Angebot erfassen" })).toBeDisabled();
  expect(
    panel.getByText("Erst alle drei Angaben vom Papier als gültige Daten eingeben."),
  ).toBeVisible();
  await userEvent.type(panel.getByLabelText(/Aufgedruckte Angebotsfrist/), "15.02.2091");
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByText("Änderungen verwerfen?")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Weiter bearbeiten" }));
  await userEvent.type(panel.getByLabelText(/Aufgedruckter TG-Beginn/), "01.03.2091");
  await userEvent.type(panel.getByLabelText(/Aufgedrucktes TG-Ende/), "29.02.2092");
  await userEvent.click(panel.getByRole("button", { name: "Angebot erfassen" }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      key: `POST ${detailPath}/dsv/offers`,
      body: {
        external: {
          deadline: "2091-02-15",
          printedTgStart: "2091-03-01",
          printedTgEnd: "2092-02-29",
        },
        statusVersion: 3,
      },
    }),
  );
});

it("keeps scan receipt blank and preserves the draft after closing and a refused upload", async () => {
  const { calls } = setup(
    view({
      track: "dsv_offered",
      capabilities: { generate: false, offer: false, uploadScan: true, sign: true },
      offers: [
        {
          id: generationId,
          origin: "external_paper",
          offerDeadline: "2091-02-15",
          offeredAt: "2026-01-01T10:00:00Z",
          endedAs: null,
          capabilities: { decline: true },
        },
      ],
      receivers: [{ id: staffUsers[1]!.id, name: "Projektleitung" }],
    }),
    { [`POST ${detailPath}/dsv/scans`]: () => problem(409, "conflict") },
  );
  await userEvent.click(await screen.findByRole("button", { name: "Scan hochladen" }));
  const panel = within(screen.getByRole("dialog"));
  expect(panel.getByLabelText("Entgegengenommen von")).toHaveValue("");
  expect(panel.getByLabelText(/Entgegengenommen am/)).toHaveValue("");
  expect(panel.getByLabelText(/Unterschrift Teilnehmer/)).toHaveValue("");
  await userEvent.type(panel.getByLabelText(/Entgegengenommen am/), "02.01.2026");
  await userEvent.keyboard("{Escape}");
  expect(
    await screen.findByRole("alertdialog", { name: "Änderungen verwerfen?" }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Weiter bearbeiten" }));
  expect(panel.getByLabelText(/Entgegengenommen am/)).toHaveValue("02.01.2026");
  await userEvent.selectOptions(panel.getByLabelText("Entgegengenommen von"), staffUsers[1]!.id);
  const input = screen.getByRole("dialog").querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(
    input,
    new File(["%PDF synthetic"], "synthetic.pdf", { type: "application/pdf" }),
  );
  await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
  await waitFor(() =>
    expect(calls.some((call) => call.key === `POST ${detailPath}/dsv/scans`)).toBe(true),
  );
  expect(panel.getByLabelText(/Entgegengenommen am/)).toHaveValue("02.01.2026");
  expect(panel.getByLabelText("Entgegengenommen von")).toHaveValue(staffUsers[1]!.id);
  expect(screen.getByRole("dialog")).toBeVisible();
});
