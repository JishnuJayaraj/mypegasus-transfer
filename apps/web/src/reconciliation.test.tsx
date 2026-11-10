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

// The reconciliation of a missed TG entry (process-and-lifecycle.md, the reconciliation; Q68 case
// 2, Q80, Q216): "Eintritt nachträglich erfassen" lists the evidence with its days, presets nothing
// and sends what it showed when it opened; the PL replies to the manager's clarification on the tab
// "DSV"; "Freigaben" offers the viewer's outcomes only. Synthetic data.
const ta = { ...project, type: "ta_tg" };
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const reconciliationId = "00000000-0000-4000-e000-000000000002";

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
  signatureCorrections: { mayRequest: false, pending: [] },
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

const packetId = "00000000-0000-4000-d000-000000000001";
const evidence = [
  { kind: "dsv_packet", id: packetId, validOn: "2026-10-28", recordedAt: "2026-11-02T09:00:00Z" },
  {
    kind: "asu_registration",
    id: "00000000-0000-4000-d000-000000000002",
    validOn: "2026-10-20",
    recordedAt: "2026-10-20T09:00:00Z",
  },
  {
    kind: "tl407",
    id: "00000000-0000-4000-d000-000000000003",
    validOn: "2026-10-15",
    recordedAt: "2026-10-15T09:00:00Z",
  },
];
const open = (over: object = {}) => ({
  participationId,
  statusVersion: 5,
  tgStart: "2026-11-01",
  evidence,
  problems: [],
  reconciliation: null,
  capabilities: { reconcile: true, reply: false },
  refusal: null,
  ...over,
});
const recorded = (stage: string, steps: object[] = [], reply = false) =>
  open({
    capabilities: { reconcile: false, reply },
    refusal: "not_informed",
    reconciliation: {
      id: reconciliationId,
      effectiveDate: "2026-11-01",
      reconciledOn: "2026-11-03",
      reviewDueOn: "2026-11-04",
      evidence: evidence.map((e) => ({
        kind: e.kind,
        validOn: e.validOn,
        recordedOn: e.recordedAt.slice(0, 10),
      })),
      stage,
      revision: steps.length,
      steps,
    },
  });
const request = {
  kind: "clarification_requested",
  code: "date_unclear",
  source: "Vermerk Akte 12",
  on: "2026-11-04",
};

function page(reconciliation: object, routes: Parameters<typeof mockApi>[0] = {}, entered = false) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(ta),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () =>
      json({
        ...detail,
        ...(entered && { status: "active_in_tg" }),
        capabilities: {
          ...detail.capabilities,
          withdraw: false,
          correctEndReason: false,
          reconcileTgEntry: !entered,
        },
        refusals: { ...detail.refusals, withdraw: null },
      }),
    [`GET ${detailPath}/dsv`]: () => json(dsv),
    [`GET ${detailPath}/entry-clarification`]: () =>
      json({
        participationId,
        statusVersion: 5,
        clarification: null,
        actions: {
          open: !entered,
          openedOn: entered ? null : "2026-11-02",
          reconciliation: !entered,
          newStartDate: false,
          recordPending: !entered,
          escalate: false,
          instruct: false,
        },
        capabilities: { record: true, escalate: false },
      }),
    [`GET ${detailPath}/tg-entry-reconciliation`]: () => json(reconciliation),
    ...routes,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=dsv`, mock.api);
  return mock;
}

describe("Eintritt nachträglich erfassen", () => {
  it("lists the evidence with its days, presets nothing and sends what it showed", async () => {
    const { calls } = page(open(), {
      [`POST ${detailPath}/tg-entry-reconciliation`]: () => json(recorded("requested"), 201),
    });
    const card = within(
      (await screen.findByRole("heading", { name: "Eintritt klären" })).closest("section")!,
    );
    await userEvent.click(
      await card.findByRole("button", { name: "Eintritt nachträglich erfassen" }),
    );
    const panel = await screen.findByRole("dialog", { name: "Eintritt nachträglich erfassen" });
    const list = await within(panel).findByTestId("reconciliation-evidence");
    expect(list).toHaveTextContent("DSV vollständig unterschrieben: gültig ab 28.10.2026");
    expect(list).toHaveTextContent("Arbeitsuchendmeldung mit Nachweis: gültig ab 20.10.2026");
    expect(list).toHaveTextContent(
      "TL 407 unterschrieben (Profiling erledigt): gültig ab 15.10.2026",
    );
    const confirm = within(panel).getByRole("checkbox", { name: /Ich bestätige/ });
    expect(confirm).not.toBeChecked();
    expect(calls.some((c) => c.key.startsWith("POST"))).toBe(false);
    await userEvent.click(within(panel).getByRole("button", { name: "Eintritt erfassen" }));
    expect(calls.some((c) => c.key.startsWith("POST"))).toBe(false);
    await userEvent.click(confirm);
    await userEvent.click(within(panel).getByRole("button", { name: "Eintritt erfassen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/tg-entry-reconciliation`,
        body: {
          evidence: evidence.map(({ kind, id, validOn }) => ({ kind, id, validOn })),
          statusVersion: 5,
          confirmed: true,
        },
      }),
    );
  });

  it("is in the page header by its capability, and says when the evidence moved (409)", async () => {
    page(open(), {
      [`POST ${detailPath}/tg-entry-reconciliation`]: () =>
        problem(409, "conflict", {
          errors: [{ pointer: "/evidence", code: "source_changed", detail: "x" }],
        }),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Aktionen|Weitere Aktionen/ }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Eintritt nachträglich erfassen" }),
    );
    const panel = await screen.findByRole("dialog", { name: "Eintritt nachträglich erfassen" });
    await userEvent.click(await within(panel).findByRole("checkbox", { name: /Ich bestätige/ }));
    await userEvent.click(within(panel).getByRole("button", { name: "Eintritt erfassen" }));
    expect(
      await within(panel).findByText(/Die Teilnahme oder ihre Nachweise haben sich geändert/),
    ).toBeVisible();
  });
});

describe("the PL's reply on the tab DSV", () => {
  it("shows the manager's request and records the reply against the revision read", async () => {
    const { calls } = page(
      recorded("clarification_requested", [request], true),
      {
        [`POST /api/v1/reconciliations/${reconciliationId}/reply`]: () =>
          new Response(null, { status: 204 }),
      },
      true,
    );
    const card = within(
      (await screen.findByRole("heading", { name: "Nachträglich erfasster Eintritt" })).closest(
        "section",
      )!,
    );
    expect(card.getByText(/Stand: Rückfrage an die Projektleitung/)).toBeVisible();
    expect(card.getByTestId("reconciliation-steps")).toHaveTextContent(
      "04.11.2026: Rückfrage – Datum unklar – Vermerk Akte 12",
    );
    await userEvent.selectOptions(card.getByLabelText("Antwort"), "Erläutert");
    await userEvent.type(card.getByLabelText(/^Quelle/), "Eingangsbuch 7");
    await userEvent.click(card.getByRole("button", { name: "Antwort erfassen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST /api/v1/reconciliations/${reconciliationId}/reply`,
        body: { code: "explained", source: "Eingangsbuch 7", revision: 1 },
      }),
    );
  });

  it("offers no reply without the capability", async () => {
    page(recorded("clarification_requested", [request], false), {}, true);
    const card = within(
      (await screen.findByRole("heading", { name: "Nachträglich erfasster Eintritt" })).closest(
        "section",
      )!,
    );
    expect(card.queryByRole("button", { name: "Antwort erfassen" })).toBeNull();
  });
});

const item = (over: object = {}) => ({
  id: reconciliationId,
  projectId: project.id,
  projectName: "Restrukturierung Werk Nord",
  tgStart: "2026-11-01",
  reconciledOn: "2026-11-03",
  reviewDueOn: "2026-11-04",
  evidence: [{ kind: "dsv_packet", validOn: "2026-10-28", recordedOn: "2026-11-02" }],
  stage: "requested",
  revision: 0,
  steps: [],
  capabilities: { outcomes: ["no_objection", "clarification_requested"] },
  ...over,
});

describe("the reconciliations in Freigaben", () => {
  const manager = {
    ...staffUsers[1],
    grants: [{ role: "regional_operations_manager", scope: "region", regionId: null }],
  };
  function reviews(items: object[], routes: Parameters<typeof mockApi>[0] = {}) {
    const mock = mockApi({
      "GET /api/v1/me": () => json(manager),
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      "GET /api/v1/reviews": () =>
        json({ items: [], corrections: [], clarifications: [], reconciliations: items }),
      ...routes,
    });
    renderApp("/reviews", mock.api);
    return mock;
  }

  it("lists project, TG start and the evidence's days without a name; asks with a reason and a source", async () => {
    const { calls } = reviews([item()], {
      [`POST /api/v1/reconciliations/${reconciliationId}/review`]: () =>
        new Response(null, { status: 204 }),
    });
    const table = await screen.findByRole("table", { name: "Nachträglich erfasste Eintritte" });
    expect(table).toHaveTextContent("Restrukturierung Werk Nord");
    expect(table).toHaveTextContent(
      "DSV vollständig unterschrieben: gültig ab 28.10.2026, erfasst am 02.11.2026",
    );
    expect(table).toHaveTextContent("Prüfung vorgesehen bis 04.11.2026");
    expect(table).not.toHaveTextContent("Beispiel");
    expect(within(table).queryByRole("button", { name: /Erledigt/ })).toBeNull();
    await userEvent.click(within(table).getByRole("button", { name: /^Rückfrage/ }));
    const dialog = await screen.findByRole("dialog", { name: "Rückfrage" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    expect(await within(dialog).findByText("Erst den Grund wählen.")).toBeVisible();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Grund der Rückfrage"),
      "Datum unklar",
    );
    await userEvent.type(within(dialog).getByLabelText(/^Quelle/), "Vermerk Akte 12");
    await userEvent.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST /api/v1/reconciliations/${reconciliationId}/review`,
        body: {
          outcome: "clarification_requested",
          code: "date_unclear",
          source: "Vermerk Akte 12",
          revision: 0,
        },
      }),
    );
  });

  it("after a reply offers Erledigt and An DSB eskaliert, each with a source", async () => {
    const { calls } = reviews(
      [
        item({
          stage: "replied",
          revision: 2,
          steps: [
            request,
            { kind: "replied", code: "explained", source: "Eingangsbuch 7", on: "2026-11-05" },
          ],
          capabilities: {
            outcomes: ["resolved_no_objection", "escalated_to_dpo", "clarification_requested"],
          },
        }),
      ],
      {
        [`POST /api/v1/reconciliations/${reconciliationId}/review`]: () =>
          new Response(null, { status: 204 }),
      },
    );
    const table = await screen.findByRole("table", { name: "Nachträglich erfasste Eintritte" });
    expect(table).toHaveTextContent("05.11.2026: Antwort – Erläutert – Eingangsbuch 7");
    expect(within(table).queryByRole("button", { name: /Ohne Einwand/ })).toBeNull();
    await userEvent.click(within(table).getByRole("button", { name: /Erledigt/ }));
    const dialog = await screen.findByRole("dialog", { name: "Erledigt" });
    await userEvent.type(within(dialog).getByLabelText(/^Quelle/), "Rücksprache PL");
    await userEvent.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST /api/v1/reconciliations/${reconciliationId}/review`,
        body: { outcome: "resolved_no_objection", source: "Rücksprache PL", revision: 2 },
      }),
    );
    expect(within(table).getByRole("button", { name: /An DSB eskaliert/ })).toBeVisible();
  });

  it("offers the PL who reconciled nothing", async () => {
    reviews([item({ capabilities: { outcomes: [] } })]);
    const table = await screen.findByRole("table", { name: "Nachträglich erfasste Eintritte" });
    expect(within(table).queryByRole("button")).toBeNull();
    expect(table).toHaveTextContent("Von Ihnen erfasst");
  });
});
