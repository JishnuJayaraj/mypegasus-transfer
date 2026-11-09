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
  facts: {
    dsvGenerated: null,
    dsvScanReceived: null,
    dsvFullyExecuted: null,
    dsvCancellation: null,
  },
  cancellations: [],
  customerNotice: null,
  capabilities: {
    generate: false,
    offer: false,
    uploadScan: false,
    sign: false,
    recordOriginal: false,
    uploadCancellation: false,
    recordCustomerNotice: false,
  },
};

type Step = { kind: string; code: string; source: string; on: string };
const stepOf = (kind: string, code: string, source: string, on = "2026-11-03"): Step => ({
  kind,
  code,
  source,
  on,
});
const noted = stepOf("recorded", "awaiting_asu_proof", "Akte 12, Vermerk vom 3.4.");
const state = (
  clarification: { stage: string; revision: number; steps: Step[]; openedOn?: string } | null,
  actions: object = {},
  can = {},
) => ({
  participationId,
  statusVersion: 5,
  clarification: clarification && { id: clarificationId, openedOn: "2026-11-02", ...clarification },
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
        { stage: "documented", revision: 1, steps: [noted] },
        { escalate: true },
        { escalate: true },
      );
      return json(current);
    },
    [`POST ${detailPath}/entry-clarification/escalation`]: () => {
      current = state(
        {
          stage: "escalated",
          revision: 2,
          steps: [
            noted,
            stepOf("escalated", "awaiting_asu_proof", "Akte 12, Vermerk vom 3.4.", "2026-11-04"),
          ],
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
      (
        await panel.findAllByText(/Nachweis der Arbeitsuchendmeldung steht aus – Quelle: Akte 12/)
      )[0],
    ).toBeVisible();
    expect(calls).toContainEqual({
      key: `POST ${detailPath}/entry-clarification`,
      body: {
        code: "awaiting_asu_proof",
        source: "Akte 12, Vermerk vom 3.4.",
        statusVersion: 5,
        revision: 0,
      },
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
        body: { statusVersion: 5, revision: 1 },
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
          stage: "instructed",
          revision: 3,
          steps: [
            stepOf("recorded", "awaiting_legal_advice", "Anfrage"),
            stepOf("escalated", "awaiting_legal_advice", "Anfrage", "2026-11-04"),
            stepOf("instructed", "dpo_instruction", "DSB-Vermerk 7", "2026-11-05"),
          ],
        },
        { recordPending: false },
        { record: false },
      ),
    );
    const panel = await card();
    expect(
      panel.getByText(/Weisung der Datenschutzbeauftragten – Quelle: DSB-Vermerk 7 \(erfasst/),
    ).toBeVisible();
    expect(panel.getByTestId("entry-clarification-history").children).toHaveLength(3);
    expect(panel.queryByRole("button", { name: "Erfassen" })).toBeNull();
    expect(
      panel.queryByRole("button", { name: "An die Regionale Betriebsleitung eskalieren" }),
    ).toBeNull();
  });

  it("shows the manager's request, takes the PL's reply as a new note and escalates again", async () => {
    const returned = state(
      {
        stage: "returned",
        revision: 3,
        steps: [
          noted,
          stepOf("escalated", "awaiting_asu_proof", "Akte 12, Vermerk vom 3.4.", "2026-11-04"),
          stepOf("requested", "date_unclear", "Datum der Unterschrift unklar", "2026-11-05"),
        ],
      },
      { recordPending: true, escalate: false },
    );
    const { calls } = setup(returned);
    const panel = await card();
    expect(panel.getByText("Rückfrage der Regionalen Betriebsleitung")).toBeVisible();
    expect(panel.getByText(/Datum unklar – Quelle: Datum der Unterschrift unklar/)).toBeVisible();
    // The history keeps every step, the escalation of the old note included.
    expect(panel.getByTestId("entry-clarification-history").children).toHaveLength(3);
    // No escalation of the old note: the reply comes first.
    expect(
      panel.queryByRole("button", { name: "An die Regionale Betriebsleitung eskalieren" }),
    ).toBeNull();
    await userEvent.selectOptions(
      panel.getByLabelText("Antwort: Was steht jetzt aus?"),
      "Rechtsrat steht aus",
    );
    await userEvent.type(panel.getByLabelText(/^Quelle/), "Antwort der PL");
    await userEvent.click(panel.getByRole("button", { name: "Antworten" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/entry-clarification`,
        body: {
          code: "awaiting_legal_advice",
          source: "Antwort der PL",
          statusVersion: 5,
          revision: 3,
        },
      }),
    );
  });

  it("keeps an unresolved case on the tab when the planned start moved on", async () => {
    setup(
      state(
        {
          stage: "escalated",
          revision: 2,
          openedOn: "2026-11-02",
          steps: [
            noted,
            stepOf("escalated", "awaiting_asu_proof", "Akte 12, Vermerk vom 3.4.", "2026-11-04"),
          ],
        },
        // The start lies ahead again: nothing is derived, the case is carried.
        { recordPending: false, instruct: true, reconciliation: false },
      ),
    );
    const panel = await card();
    expect(panel.getByText(/offen seit 02.11.2026/)).toBeVisible();
    expect(panel.getByText("Die Weisung der Regionalen Betriebsleitung steht aus.")).toBeVisible();
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
        "Der Fall hat sich inzwischen geändert (eine andere Bearbeitung oder die Teilnahme). Er wurde neu geladen; bitte prüfen und erneut versuchen.",
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
  revision: 2,
  steps: [
    noted,
    stepOf("escalated", "awaiting_asu_proof", "Akte 12, Vermerk vom 3.4.", "2026-11-04"),
  ],
  statusVersion: 5,
  capabilities: { answer: true },
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
    // The steps so far, with their sources.
    expect(table).toHaveTextContent("Dokumentiert – Nachweis der Arbeitsuchendmeldung steht aus");
    expect(table).toHaveTextContent("Eskaliert – Nachweis der Arbeitsuchendmeldung steht aus");
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
          revision: 2,
        },
      }),
    );
    expect(await screen.findByText("Die Weisung wurde erfasst.")).toBeVisible();
  });

  it("asks the PL again in its own dialog with a request code, against the revision shown", async () => {
    const { calls } = reviews([item()], {
      [`POST /api/v1/entry-clarifications/${clarificationId}/request`]: () =>
        new Response(null, { status: 204 }),
    });
    const table = await screen.findByRole("table", { name: "Eskalierte Klärungen zum Eintritt" });
    await userEvent.click(within(table).getByRole("button", { name: /Rückfrage an die PL/ }));
    const dialog = await screen.findByRole("dialog", { name: "Rückfrage an die Projektleitung" });
    // Its own codes, never the instruction's.
    expect(within(dialog).queryByRole("option", { name: "Rechtsrat liegt vor" })).toBeNull();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Grund der Rückfrage"),
      "Datum unklar",
    );
    await userEvent.type(within(dialog).getByLabelText(/^Quelle/), "Datum fehlt im Scan");
    await userEvent.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST /api/v1/entry-clarifications/${clarificationId}/request`,
        body: {
          code: "date_unclear",
          source: "Datum fehlt im Scan",
          statusVersion: 5,
          revision: 2,
        },
      }),
    );
    expect(
      await screen.findByText(
        "Die Rückfrage wurde erfasst; der Fall liegt wieder bei der Projektleitung.",
      ),
    ).toBeVisible();
  });

  it("offers the person who escalated no instruction", async () => {
    reviews([item({ capabilities: { answer: false } })]);
    const table = await screen.findByRole("table", { name: "Eskalierte Klärungen zum Eintritt" });
    expect(within(table).queryByRole("button", { name: /Weisung erfassen/ })).toBeNull();
    expect(table).toHaveTextContent("Von Ihnen eskaliert");
  });

  it("says when the case moved since it was shown (another answer or tab)", async () => {
    reviews([item()], {
      [`POST /api/v1/entry-clarifications/${clarificationId}/instruction`]: () =>
        problem(409, "conflict", {
          errors: [{ pointer: "/revision", code: "stale_clarification", detail: "x" }],
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
        "Der Fall hat sich inzwischen geändert. Die Liste wurde neu geladen.",
      ),
    ).toBeVisible();
  });
});
