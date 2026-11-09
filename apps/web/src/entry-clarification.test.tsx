import { screen, waitFor, within } from "@testing-library/react";
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

// The entry clarification on the tab "DSV" and in "Freigaben" (process-and-lifecycle.md, the entry
// clarification): the PL documents what is pending (a code and one source line, nothing preset),
// sees only the paths whose guards pass, escalates once through a dialog; the regional operations
// manager records an instruction in a dialog that keeps the case it opened for. Synthetic data.
const ta = { ...project, type: "ta_tg" };
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const clarificationId = "00000000-0000-4000-e000-000000000001";

const detail = {
  id: participationId,
  projectId: project.id,
  status: "informed",
  profilingStatus: "profiling_done",
  dsvStatus: "dsv_signed",
  statusVersion: 5,
  entryWave: null,
  dates: {
    tgStart: null,
    tgEnd: null,
    effectiveTgStart: "2026-11-01",
    effectiveTgEnd: "2027-10-31",
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
  privacyNoticeState: { state: "provided", dueOn: "2026-10-15", providedAt: null },
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
const dsv = {
  scans: [],
  receivers: [],
  participationId,
  track: "dsv_signed",
  statusVersion: 5,
  offers: [],
  template: { version: "v1", approvedForLive: false },
  deadline: {
    waveSigningDeadline: null,
    explicitRequired: false,
    latestEntryDate: "2026-12-15",
    tgStart: "2026-11-01",
  },
  sourceToken: "a".repeat(64),
  checklist: [],
  blockers: ["dsv_already_signed"],
  generations: [],
  contract: null,
  facts: { dsvGenerated: null, dsvScanReceived: null, dsvFullyExecuted: null },
  capabilities: {
    generate: false,
    offer: false,
    uploadScan: false,
    sign: false,
    recordOriginal: false,
  },
};

type Clarification = {
  id: string;
  openedOn: string;
  pending: { code: string; source: string; recordedOn: string } | null;
  escalatedOn: string | null;
  instruction: { code: string; source: string; recordedOn: string } | null;
};
const state = (over: Partial<Clarification> | null, actions: object = {}, can = {}) => ({
  participationId,
  statusVersion: 5,
  clarification: over && {
    id: clarificationId,
    openedOn: "2026-11-02",
    pending: null,
    escalatedOn: null,
    instruction: null,
    ...over,
  },
  actions: {
    open: true,
    openedOn: "2026-11-02",
    reconciliation: false,
    newStartDate: true,
    recordPending: true,
    escalate: false,
    instruct: false,
    ...actions,
  },
  capabilities: { record: true, escalate: false, ...can },
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
    [`GET ${detailPath}/dsv`]: () => json(dsv),
    [`GET ${detailPath}/entry-clarification`]: () => json(current),
    [`POST ${detailPath}/entry-clarification`]: () => {
      current = state(
        {
          pending: {
            code: "awaiting_asu_proof",
            source: "Akte 12, Vermerk vom 3.4.",
            recordedOn: "2026-11-03",
          },
        },
        { escalate: true },
        { escalate: true },
      );
      return json(current);
    },
    [`POST ${detailPath}/entry-clarification/escalation`]: () => {
      current = state(
        {
          pending: { code: "awaiting_asu_proof", source: "Akte 12", recordedOn: "2026-11-03" },
          escalatedOn: "2026-11-04",
        },
        { recordPending: false, instruct: true },
      );
      return json(current);
    },
    ...routes,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=dsv`, mock.api);
  return mock;
}

const card = async () =>
  within((await screen.findByRole("heading", { name: "Eintritt klären" })).closest("section")!);

describe("Eintritt klären on the tab DSV", () => {
  it("names the case and only the paths whose guards pass; the PL documents, nothing preset", async () => {
    const { calls } = setup(state(null));
    const panel = await card();
    expect(panel.getByText(/offen seit 02.11.2026/)).toBeVisible();
    expect(panel.getByText(/Neuer Beginn mit Nachtrag/)).toBeVisible();
    expect(panel.queryByText(/Abstimmung des Eintritts/)).toBeNull();
    expect(panel.getByText("Noch nichts dokumentiert.")).toBeVisible();
    const save = panel.getByRole("button", { name: "Erfassen" });
    expect(save).toBeDisabled();
    expect(panel.getByText("Erst wählen, was aussteht.")).toBeVisible();
    await userEvent.selectOptions(
      panel.getByLabelText("Was steht aus?"),
      "Nachweis der Arbeitsuchendmeldung steht aus",
    );
    expect(panel.getByText("Erst die Quelle angeben.")).toBeVisible();
    await userEvent.type(panel.getByLabelText(/^Quelle/), "Akte 12, Vermerk vom 3.4.");
    await userEvent.click(save);
    expect(
      await panel.findByText(/Nachweis der Arbeitsuchendmeldung steht aus – Quelle: Akte 12/),
    ).toBeVisible();
    expect(calls).toContainEqual({
      key: `POST ${detailPath}/entry-clarification`,
      body: { code: "awaiting_asu_proof", source: "Akte 12, Vermerk vom 3.4.", statusVersion: 5 },
    });
    // The escalation is now possible, after the dialog's confirmation.
    await userEvent.click(
      panel.getByRole("button", { name: "An die Regionale Betriebsleitung eskalieren" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Fall eskalieren" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Eskalieren" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/entry-clarification/escalation`,
        body: { statusVersion: 5 },
      }),
    );
    expect(await panel.findByText(/Eskaliert am 04.11.2026/)).toBeVisible();
    expect(panel.getByText("Die Weisung der Regionalen Betriebsleitung steht aus.")).toBeVisible();
    expect(panel.queryByRole("button", { name: "Erfassen" })).toBeNull();
  });

  it("offers the reconciliation only when every fact held, and says so when no path is open", async () => {
    setup(state(null, { reconciliation: true, newStartDate: false }));
    const panel = await card();
    expect(panel.getByText(/Abstimmung des Eintritts/)).toBeVisible();
    expect(panel.queryByText(/Neuer Beginn/)).toBeNull();
  });

  it("names no path when none passes its guard", async () => {
    setup(state(null, { reconciliation: false, newStartDate: false }));
    const panel = await card();
    expect(panel.getByText(/Zurzeit erfüllt kein Weg seine Voraussetzungen/)).toBeVisible();
  });

  it("shows the instruction once recorded, and a read-only case to back office", async () => {
    setup(
      state(
        {
          pending: { code: "awaiting_legal_advice", source: "Anfrage", recordedOn: "2026-11-03" },
          escalatedOn: "2026-11-04",
          instruction: {
            code: "dpo_instruction",
            source: "DSB-Vermerk 7",
            recordedOn: "2026-11-05",
          },
        },
        { recordPending: false },
        { record: false },
      ),
    );
    const panel = await card();
    expect(
      panel.getByText(/Weisung der Datenschutzbeauftragten – Quelle: DSB-Vermerk 7/),
    ).toBeVisible();
    expect(panel.queryByRole("button", { name: "Erfassen" })).toBeNull();
    expect(
      panel.queryByRole("button", { name: "An die Regionale Betriebsleitung eskalieren" }),
    ).toBeNull();
  });

  it("reloads the case on a stale status version", async () => {
    const { calls } = setup(state(null), {
      [`POST ${detailPath}/entry-clarification`]: () =>
        problem(409, "conflict", {
          errors: [{ pointer: "/statusVersion", code: "stale_status_version", detail: "x" }],
        }),
    });
    const panel = await card();
    await userEvent.selectOptions(panel.getByLabelText("Was steht aus?"), "Profiling steht aus");
    await userEvent.type(panel.getByLabelText(/^Quelle/), "Akte 1");
    await userEvent.click(panel.getByRole("button", { name: "Erfassen" }));
    expect(
      await screen.findByText(
        "Die Teilnahme hat sich inzwischen geändert. Der Fall wurde neu geladen.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.key === `GET ${detailPath}/entry-clarification`).length,
      ).toBeGreaterThan(1),
    );
  });

  it("is not shown when the case is not open", async () => {
    setup(state(null, { open: false, openedOn: null }));
    await screen.findByRole("tab", { name: "DSV" });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Eintritt klären" })).toBeNull(),
    );
  });
});

const item = (over: object = {}) => ({
  id: clarificationId,
  projectId: project.id,
  projectName: "Restrukturierung Werk Nord",
  tgStart: "2026-11-01",
  openedOn: "2026-11-02",
  escalatedOn: "2026-11-04",
  pendingCode: "awaiting_asu_proof",
  pendingSource: "Akte 12, Vermerk vom 3.4.",
  statusVersion: 5,
  capabilities: { instruct: true },
  ...over,
});

describe("the escalated clarifications in Freigaben", () => {
  const manager = {
    ...staffUsers[1],
    grants: [{ role: "regional_operations_manager", scope: "region", regionId: null }],
  };

  function reviews(items: object[], routes: Parameters<typeof mockApi>[0] = {}) {
    const mock = mockApi({
      "GET /api/v1/me": () => json(manager),
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      "GET /api/v1/reviews": () => json({ items: [], corrections: [], clarifications: items }),
      ...routes,
    });
    renderApp("/reviews", mock.api);
    return mock;
  }

  it("lists the case without a name and records the instruction in a dialog against the version shown", async () => {
    const { calls } = reviews([item()], {
      [`POST /api/v1/entry-clarifications/${clarificationId}/instruction`]: () =>
        new Response(null, { status: 204 }),
    });
    const table = await screen.findByRole("table", { name: "Eskalierte Klärungen zum Eintritt" });
    expect(table).toHaveTextContent("Restrukturierung Werk Nord");
    expect(table).toHaveTextContent("Nachweis der Arbeitsuchendmeldung steht aus");
    expect(table).toHaveTextContent("Akte 12, Vermerk vom 3.4.");
    expect(table).not.toHaveTextContent("Beispiel");
    await userEvent.click(within(table).getByRole("button", { name: /Weisung erfassen/ }));
    const dialog = await screen.findByRole("dialog", { name: "Weisung erfassen" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    expect(await within(dialog).findByText("Erst die Weisung wählen.")).toBeVisible();
    await userEvent.selectOptions(within(dialog).getByLabelText("Weisung"), "Rechtsrat liegt vor");
    await userEvent.type(within(dialog).getByLabelText(/^Quelle/), "Rechtsrat Kanzlei, Az. 77");
    await userEvent.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST /api/v1/entry-clarifications/${clarificationId}/instruction`,
        body: {
          code: "legal_advice_obtained",
          source: "Rechtsrat Kanzlei, Az. 77",
          statusVersion: 5,
        },
      }),
    );
    expect(await screen.findByText("Die Weisung wurde erfasst.")).toBeVisible();
  });

  it("offers the person who escalated no instruction", async () => {
    reviews([item({ capabilities: { instruct: false } })]);
    const table = await screen.findByRole("table", { name: "Eskalierte Klärungen zum Eintritt" });
    expect(within(table).queryByRole("button", { name: /Weisung erfassen/ })).toBeNull();
    expect(table).toHaveTextContent("Von Ihnen eskaliert");
  });

  it("says when a case is gone, and when the version moved", async () => {
    reviews([item()], {
      [`POST /api/v1/entry-clarifications/${clarificationId}/instruction`]: () =>
        problem(409, "conflict", {
          errors: [{ pointer: "/statusVersion", code: "stale_status_version", detail: "x" }],
        }),
    });
    const table = await screen.findByRole("table", { name: "Eskalierte Klärungen zum Eintritt" });
    await userEvent.click(within(table).getByRole("button", { name: /Weisung erfassen/ }));
    const dialog = await screen.findByRole("dialog", { name: "Weisung erfassen" });
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Weisung"),
      "Einigung der Vertragsparteien",
    );
    await userEvent.type(within(dialog).getByLabelText(/^Quelle/), "Vereinbarung 5");
    await userEvent.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    expect(
      await screen.findByText(
        "Die Teilnahme hat sich inzwischen geändert. Die Liste wurde neu geladen.",
      ),
    ).toBeVisible();
  });
});
