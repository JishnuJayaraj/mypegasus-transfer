import { act, screen, waitFor, within } from "@testing-library/react";
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

// "Ausnahme vom Profiling" on the tab "Profiling" and the queue "Freigaben"
// (process-and-lifecycle.md, profiling exceptions; data-protection.md, exception evidence; D30):
// every button by its capability, nothing chosen for the user, the evidence record first and then
// the request, the decision naming the record shown, the revocation the status shown. Synthetic
// data only.
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const documentId = "00000000-0000-4000-a000-0000000000d1";
const recordId = "00000000-0000-4000-a000-0000000000e1";
const requestId = "00000000-0000-4000-a000-0000000000f1";

const detail = {
  id: participationId,
  projectId: project.id,
  status: "informed",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  statusVersion: 3,
  entryWave: null,
  dates: {
    tgStart: "2092-03-01",
    tgEnd: null,
    effectiveTgStart: "2092-03-01",
    effectiveTgEnd: null,
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
  placementAgenturChoices: [
    { agenturKey: "beispielstadt-nord", label: { de: "Agentur Beispielstadt-Nord" }, pinned: true },
  ],
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
    viewProfiling: true,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
};

type Exception = {
  current: null | Record<string, unknown>;
  evidenceDocuments: Record<string, unknown>[];
  capabilities: { addEvidence: boolean; request: boolean; revoke: boolean };
};
const none: Exception = {
  current: null,
  evidenceDocuments: [],
  capabilities: { addEvidence: true, request: true, revoke: false },
};
const accepted = {
  documentId,
  addedAt: "2026-10-23T08:00:00.000Z",
  reviewState: "accepted",
  usable: true,
  quarantined: false,
  capabilities: { delete: false, quarantine: true, liftQuarantine: false },
};
const approved = {
  requestId,
  status: "approved",
  reason: "force_majeure",
  requestedOn: "2026-10-24",
  decidedOn: "2026-10-25",
  evidenceRecordId: recordId,
  evidenceKind: "ba_confirmation",
};

const view = (exception: Exception) => ({
  participationId,
  profilingStatus: "not_started",
  statusVersion: 3,
  profilingDoneOn: null,
  closed: false,
  revision: 1,
  sessions: [],
  tl407Forms: [],
  tl407Scans: [],
  tl407SignedOn: null,
  profilingDoneSupported: null,
  tl407Submission: { attempts: [], next: null },
  tl407Versions: ["08-2025"],
  exception,
  transitions: [],
  capabilities: {
    record: false,
    readAssessment: false,
    writeAssessment: false,
    readUnemploymentPeriod: false,
    generateTl407: false,
    readTl407Readiness: false,
    addTl407Scan: false,
  },
});

const selfService = {
  participationId,
  revision: 1,
  updatedAt: "2026-10-21T09:00:00.000000Z",
  notice: { version: "self-service-purposes:v1", acknowledgedAt: "2026-10-21T08:00:00.000000Z" },
  values: {},
  customValues: {},
  customLabels: {},
  participantMaintained: [],
  sensitive: {},
  sensitiveReadable: [],
  missing: [],
};

function setup(
  exception: Exception | (() => Exception),
  routes: Parameters<typeof mockApi>[0] = {},
) {
  const shown = typeof exception === "function" ? exception : () => exception;
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail),
    [`GET ${detailPath}/self-service`]: () => json(selfService),
    [`GET ${detailPath}/profiling`]: () => json(view(shown())),
    ...routes,
  });
  const { queryClient } = renderApp(
    `/projects/${project.id}/participations/${participationId}?tab=profiling`,
    mock.api,
  );
  return { ...mock, queryClient };
}
const callsTo = (calls: { key: string; body: unknown }[], key: string) =>
  calls.filter((call) => call.key === key).map((call) => call.body);

describe("Ausnahme vom Profiling", () => {
  it("revokes the request the dialog opened for, even after a refresh shows another", async () => {
    const user = userEvent.setup();
    const replacement = {
      ...approved,
      requestId: "00000000-0000-4000-a000-0000000000f9",
      status: "requested",
    };
    let current: Record<string, unknown> = approved;
    const { calls, queryClient } = setup(
      () => ({
        current,
        evidenceDocuments: [],
        capabilities: { addEvidence: true, request: false, revoke: true },
      }),
      {
        [`POST /api/v1/profiling-exception-requests/${requestId}/revocation`]: () =>
          problem(409, "conflict", {
            errors: [{ pointer: "", code: "request_not_current", detail: "x" }],
          }),
      },
    );
    await user.click(await screen.findByRole("button", { name: "Widerrufen" }));
    const dialog = await screen.findByRole("dialog", { name: "Ausnahme widerrufen" });
    current = replacement;
    await act(() => queryClient.invalidateQueries());
    await screen.findByText("Beantragt", { selector: "dd" });
    expect(dialog).toHaveTextContent("Genehmigt");
    await user.click(within(dialog).getByRole("button", { name: "Ausnahme widerrufen" }));
    expect(await screen.findByText(/nicht mehr der aktuelle Antrag/)).toBeInTheDocument();
    expect(calls.filter((c) => c.key.endsWith("/revocation"))).toEqual([
      {
        key: `POST /api/v1/profiling-exception-requests/${requestId}/revocation`,
        body: { status: "approved" },
      },
    ]);
  });

  it("lets the PL quarantine or delete an upload with a reason, never open it", async () => {
    const user = userEvent.setup();
    const unreviewed = {
      ...accepted,
      reviewState: "unreviewed",
      usable: false,
      capabilities: { delete: true, quarantine: true, liftQuarantine: false },
    };
    const documentPath = `${detailPath}/documents/${documentId}`;
    const { calls } = setup(
      { ...none, evidenceDocuments: [unreviewed] },
      {
        [`POST ${documentPath}/quarantine`]: () => json({}),
        [`DELETE ${documentPath}`]: () => new Response(null, { status: 204 }),
      },
    );
    await user.click(await screen.findByRole("button", { name: /^Unter Quarantäne stellen: / }));
    let dialog = await screen.findByRole("dialog", { name: "Nachweis unter Quarantäne stellen" });
    const confirm = within(dialog).getByRole("button", { name: "Unter Quarantäne stellen" });
    expect(confirm).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Grund"), "suspected_wrong_person");
    await user.click(confirm);
    await waitFor(() =>
      expect(callsTo(calls, `POST ${documentPath}/quarantine`)).toEqual([
        { reasonCode: "suspected_wrong_person" },
      ]),
    );
    await user.click(screen.getByRole("button", { name: /^Löschen: / }));
    dialog = await screen.findByRole("dialog", { name: "Nachweis löschen" });
    expect(within(dialog).getByLabelText("Grund")).toHaveValue("");
    await user.selectOptions(within(dialog).getByLabelText("Grund"), "wrong_file");
    await user.click(within(dialog).getByRole("button", { name: "Nachweis löschen" }));
    await waitFor(() => expect(calls.some((c) => c.key === `DELETE ${documentPath}`)).toBe(true));
    expect(screen.queryByRole("button", { name: /Öffnen/ })).not.toBeInTheDocument();
  });

  it("offers the actions by capability and lists the evidence by date and state only", async () => {
    setup({
      current: approved,
      evidenceDocuments: [
        accepted,
        {
          ...accepted,
          documentId: "00000000-0000-4000-a000-0000000000d2",
          reviewState: "unreviewed",
          usable: false,
          capabilities: { delete: true, quarantine: true, liftQuarantine: false },
        },
      ],
      capabilities: { addEvidence: true, request: false, revoke: true },
    });
    const section = await screen.findByRole("region", { name: "Ausnahme vom Profiling" });
    expect(within(section).getByText("Genehmigt", { selector: "dd" })).toBeInTheDocument();
    expect(
      within(section).getByText("Bestätigung der Agentur", { selector: "dd" }),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/geprüft und angenommen/, { selector: "li > span" }),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/noch nicht geprüft/, { selector: "li > span" }),
    ).toBeInTheDocument();
    // No opening for the evidence: the PL can't open it (data-protection.md, exception evidence).
    expect(within(section).queryByRole("button", { name: /Öffnen/ })).not.toBeInTheDocument();
    expect(
      within(section).queryByRole("button", { name: "Ausnahme beantragen" }),
    ).not.toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Widerrufen" })).toBeInTheDocument();
  });

  it("records the BA confirmation, then the request; nothing is preselected", async () => {
    const user = userEvent.setup();
    const { calls } = setup(none, {
      [`POST ${detailPath}/exception-evidence`]: () => json({ evidenceRecordId: recordId }, 201),
      [`POST ${detailPath}/profiling-exception-requests`]: () => json({ requestId }, 201),
    });
    await user.click(await screen.findByRole("button", { name: "Ausnahme beantragen" }));
    const dialog = await screen.findByRole("dialog", { name: "Ausnahme vom Profiling beantragen" });
    const confirm = within(dialog).getByRole("button", { name: "Beantragen" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByLabelText("Grund")).toHaveValue("");
    // Without reviewed documents only the Agentur's confirmation can be chosen.
    expect(within(dialog).getByLabelText(/Geprüfte Unterlagen/)).toBeDisabled();
    expect(within(dialog).getByLabelText("Bestätigung der Agentur")).not.toBeChecked();
    await user.selectOptions(within(dialog).getByLabelText("Grund"), "ba_confirmed_other");
    await user.click(within(dialog).getByLabelText("Bestätigung der Agentur"));
    expect(within(dialog).getByLabelText("Agentur")).toHaveValue("");
    expect(within(dialog).getByLabelText(/Bestätigt am/)).toHaveValue("");
    await user.selectOptions(within(dialog).getByLabelText("Agentur"), "beispielstadt-nord");
    await user.type(within(dialog).getByLabelText("Ansprechperson oder Aktenzeichen"), "AZ 4711");
    await user.type(within(dialog).getByLabelText(/Bestätigt am/), "20.10.2026");
    await user.click(confirm);
    await waitFor(() =>
      expect(callsTo(calls, `POST ${detailPath}/profiling-exception-requests`)).toEqual([
        { reason: "ba_confirmed_other", evidenceRecordId: recordId },
      ]),
    );
    expect(callsTo(calls, `POST ${detailPath}/exception-evidence`)).toEqual([
      {
        kind: "ba_confirmation",
        agenturKey: "beispielstadt-nord",
        reference: "AZ 4711",
        confirmedOn: "2026-10-20",
      },
    ]);
    expect(await screen.findByText("Ausnahme beantragt.")).toBeInTheDocument();
  });

  it("requests from the documents chosen, and shows the unchanged-evidence refusal", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      { ...none, evidenceDocuments: [accepted] },
      {
        [`POST ${detailPath}/exception-evidence`]: () => json({ evidenceRecordId: recordId }, 201),
        [`POST ${detailPath}/profiling-exception-requests`]: () =>
          problem(422, "domain-error", {
            errors: [{ pointer: "", code: "evidence_unchanged", detail: "x" }],
          }),
      },
    );
    await user.click(await screen.findByRole("button", { name: "Ausnahme beantragen" }));
    const dialog = await screen.findByRole("dialog", { name: "Ausnahme vom Profiling beantragen" });
    await user.selectOptions(within(dialog).getByLabelText("Grund"), "force_majeure");
    await user.click(within(dialog).getByLabelText(/Geprüfte Unterlagen \(1 angenommen\)/));
    const document = within(dialog).getByLabelText(/Nachweis vom/);
    expect(document).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Beantragen" })).toBeDisabled();
    await user.click(document);
    await user.click(within(dialog).getByRole("button", { name: "Beantragen" }));
    expect(
      await screen.findByText(/Derselbe Nachweis wie beim letzten Antrag/),
    ).toBeInTheDocument();
    expect(callsTo(calls, `POST ${detailPath}/exception-evidence`)).toEqual([
      { kind: "documents", documentIds: [documentId] },
    ]);
  });

  it("revokes with the status shown, after a confirmation", async () => {
    const user = userEvent.setup();
    const path = `/api/v1/profiling-exception-requests/${requestId}/revocation`;
    const { calls } = setup(
      {
        current: approved,
        evidenceDocuments: [],
        capabilities: { addEvidence: true, request: false, revoke: true },
      },
      { [`POST ${path}`]: () => new Response(null, { status: 204 }) },
    );
    await user.click(await screen.findByRole("button", { name: "Widerrufen" }));
    const dialog = await screen.findByRole("dialog", { name: "Ausnahme widerrufen" });
    await user.click(within(dialog).getByRole("button", { name: "Ausnahme widerrufen" }));
    await waitFor(() => expect(callsTo(calls, `POST ${path}`)).toEqual([{ status: "approved" }]));
  });
});

const item = {
  requestId,
  projectId: project.id,
  projectName: "Restrukturierung Werk Nord",
  reason: "force_majeure",
  requestedOn: "2026-10-24",
  tgStart: "2092-03-01",
  evidenceRecordId: recordId,
  evidenceKind: "documents",
  evidencePresent: true,
  capabilities: { decide: true },
};

function reviews(items: object[], routes: Parameters<typeof mockApi>[0] = {}) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    "GET /api/v1/reviews": () => json({ items }),
    ...routes,
  });
  renderApp("/reviews", mock.api);
  return mock;
}

describe("Freigaben", () => {
  it("lists project, reason, dates and the evidence's presence; never a name", async () => {
    reviews([
      item,
      {
        ...item,
        requestId: "00000000-0000-4000-a000-0000000000f2",
        capabilities: { decide: false },
      },
    ]);
    expect(await screen.findAllByText("Restrukturierung Werk Nord")).toHaveLength(2);
    expect(screen.getAllByText("Nachweis vorhanden (Geprüfte Unterlagen)")).toHaveLength(2);
    expect(screen.getByText("Eigener Antrag")).toBeInTheDocument();
    expect(screen.queryByText(/Beispiel|Erika/)).not.toBeInTheDocument();
  });

  it("decides with the evidence record shown, after a confirmation", async () => {
    const user = userEvent.setup();
    const path = `/api/v1/profiling-exception-requests/${requestId}/decision`;
    const { calls } = reviews([item], {
      [`POST ${path}`]: () => new Response(null, { status: 204 }),
    });
    await user.click(await screen.findByRole("button", { name: /^Genehmigen: / }));
    const dialog = await screen.findByRole("dialog", { name: "Ausnahme genehmigen" });
    await user.click(within(dialog).getByRole("button", { name: "Genehmigen" }));
    await waitFor(() =>
      expect(callsTo(calls, `POST ${path}`)).toEqual([
        { decision: "approve", evidenceRecordId: recordId },
      ]),
    );
  });

  it("can't approve without usable evidence, and says so when the request changed", async () => {
    const user = userEvent.setup();
    const path = `/api/v1/profiling-exception-requests/${requestId}/decision`;
    reviews([{ ...item, evidencePresent: false }], {
      [`POST ${path}`]: () =>
        problem(409, "conflict", {
          errors: [{ pointer: "", code: "source_changed", detail: "x" }],
        }),
    });
    expect(await screen.findByRole("button", { name: /^Genehmigen: / })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^Ablehnen: / }));
    const dialog = await screen.findByRole("dialog", { name: "Ausnahme ablehnen" });
    await user.click(within(dialog).getByRole("button", { name: "Ablehnen" }));
    expect(
      await screen.findByText(/stützt sich inzwischen auf einen anderen Nachweis/),
    ).toBeInTheDocument();
  });

  it("is the regional operations manager's alone", async () => {
    const mock = mockApi({
      "GET /api/v1/me": () => json(staffUsers[1]),
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      "GET /api/v1/reviews": () => problem(403, "forbidden"),
    });
    renderApp("/reviews", mock.api);
    expect(
      await screen.findByText("Die Freigaben sind der Regionalen Betriebsleitung vorbehalten."),
    ).toBeInTheDocument();
  });
});
