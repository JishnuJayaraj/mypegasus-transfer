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

// The cancellation of a signed DSV, "Zurückziehen", "Grund korrigieren" and "Kunde informieren"
// (process-and-lifecycle.md, the cancellation, manual withdrawal and the customer notice; Q46
// verify, Q72): nothing preset, the status version and the reason as read, a blocked action's
// prerequisite as text (ui-patterns.md, C1). Synthetic data only.
const ta = { ...project, type: "ta_tg" };
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const offerId = "00000000-0000-4000-a000-0000000000f1";
const documentId = "00000000-0000-4000-a000-0000000000d1";

const detail = (overrides: object = {}) => ({
  id: participationId,
  projectId: project.id,
  status: "informed",
  profilingStatus: "profiling_done",
  dsvStatus: "dsv_signed",
  statusVersion: 7,
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
  dsvSignedOn: "2091-01-10",
  dsvFullyExecutedOn: null,
  dsvCancellationValidOn: "2091-01-20",
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
    withdraw: true,
    correctEndReason: false,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null, withdraw: null },
  ...overrides,
});

const view = (overrides: object = {}) => ({
  participationId,
  track: "dsv_signed",
  statusVersion: 7,
  scans: [],
  cancellations: [],
  customerNotice: null,
  signatureCorrections: { mayRequest: false, pending: [] },
  receivers: [{ id: staffUsers[1]!.id, name: "Projektleitung" }],
  offers: [
    {
      id: offerId,
      origin: "external_paper",
      offerDeadline: "2091-01-15",
      offeredAt: "2091-01-01T10:00:00Z",
      endedAs: "signed",
      capabilities: { decline: false },
    },
  ],
  template: { version: "v1", approvedForLive: false },
  deadline: {
    waveSigningDeadline: "2091-01-15",
    explicitRequired: true,
    latestEntryDate: "2091-03-15",
    tgStart: "2091-03-01",
  },
  sourceToken: "a".repeat(64),
  checklist: [],
  blockers: [],
  generations: [],
  contract: null,
  facts: {
    dsvGenerated: null,
    dsvScanReceived: null,
    dsvFullyExecuted: null,
    dsvCancellation: null,
  },
  capabilities: {
    generate: false,
    offer: false,
    uploadScan: false,
    sign: false,
    recordOriginal: false,
    uploadCancellation: true,
    recordCustomerNotice: false,
  },
  ...overrides,
});

const cancellationDocument = {
  id: documentId,
  type: "dsv_cancellation",
  addedAt: "2091-01-21T10:00:00.000000Z",
  addedBy: "staff",
  source: "staff",
  mediaType: "application/pdf",
  sizeBytes: 100,
  review: { state: "unreviewed", reasonCode: null, reviewedAt: null },
  quarantine: null,
  invalidated: null,
  correction: { pending: false, mayRequest: false },
  capabilities: {
    open: true,
    review: true,
    delete: true,
    quarantine: true,
    liftQuarantine: false,
  },
};

function setup(
  first: { detail?: object; view?: object; tab?: string } = {},
  routes: Parameters<typeof mockApi>[0] = {},
) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(ta),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail(first.detail)),
    [`GET ${detailPath}/dsv`]: () => json(view(first.view)),
    ...routes,
  });
  renderApp(
    `/projects/${project.id}/participations/${participationId}${first.tab ? `?tab=${first.tab}` : ""}`,
    mock.api,
  );
  return mock;
}

const card = async (name: string) =>
  within((await screen.findByRole("heading", { name })).closest("section")!);

async function actionsMenu() {
  const menu = await screen.findByRole("button", { name: "Aktionen" });
  await userEvent.click(menu);
  const items = document.getElementById(menu.getAttribute("aria-controls")!)!;
  return within(items);
}

describe("Aufhebungsvertrag on the tab DSV", () => {
  it("uploads against the signed offer with the dates on the paper, nothing preset", async () => {
    const { calls } = setup(
      { tab: "dsv" },
      {
        [`POST ${detailPath}/dsv/cancellation-scans`]: () => json(cancellationDocument, 201),
      },
    );
    const section = await card("Aufhebungsvertrag");
    await userEvent.click(section.getByRole("button", { name: "Aufhebungsvertrag hochladen" }));
    const panel = within(screen.getByRole("dialog"));
    expect(panel.getByLabelText("Entgegengenommen von")).toHaveValue("");
    expect(panel.getByLabelText(/Entgegengenommen am/)).toHaveValue("");
    for (const label of [
      /Unterschrift Teilnehmer/,
      /Unterschrift Kunde/,
      /Unterschrift Transfer/,
    ]) {
      expect(panel.getByLabelText(label)).toHaveValue("");
    }
    await userEvent.selectOptions(panel.getByLabelText("Entgegengenommen von"), staffUsers[1]!.id);
    await userEvent.type(panel.getByLabelText(/Entgegengenommen am/), "21.01.2091");
    await userEvent.type(panel.getByLabelText(/Unterschrift Teilnehmer/), "20.01.2091");
    const input = screen.getByRole("dialog").querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(
      input,
      new File(["%PDF synthetic"], "a.pdf", { type: "application/pdf" }),
    );
    await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST ${detailPath}/dsv/cancellation-scans`)?.body,
      ).toMatchObject({
        offerId,
        receivedBy: staffUsers[1]!.id,
        receivedOn: "2091-01-21",
        signatures: { participant: "2091-01-20" },
      }),
    );
  });

  it("is accepted only with all three signatures confirmed, never with the offer's terms", async () => {
    const { calls } = setup(
      {
        tab: "dsv",
        view: {
          cancellations: [
            {
              document: cancellationDocument,
              metadata: {
                offerId,
                receivedBy: staffUsers[1]!.id,
                receivedOn: "2091-01-21",
                signatures: { participant: "2091-01-20" },
              },
              counting: false,
            },
          ],
        },
      },
      {
        [`POST ${detailPath}/documents/${documentId}/review`]: () =>
          json({ ...cancellationDocument, review: { state: "accepted" } }),
      },
    );
    const section = await card("Aufhebungsvertrag");
    await userEvent.click(section.getByRole("button", { name: "Prüfen" }));
    const panel = within(screen.getByRole("dialog"));
    expect(panel.queryByLabelText(/übereinstimmt|stimmt mit den erfassten/)).toBeNull();
    await userEvent.type(panel.getByLabelText(/Unterschrift Teilnehmer/), "20.01.2091");
    await userEvent.type(panel.getByLabelText(/Unterschrift Kunde/), "19.01.2091");
    await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
    expect(calls.some((c) => c.key.endsWith("/review"))).toBe(false);
    await userEvent.type(panel.getByLabelText(/Unterschrift Transfer/), "18.01.2091");
    await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(calls.find((c) => c.key.endsWith("/review"))?.body).toEqual({
        decision: "accepted",
        dsv: {
          signatures: {
            participant: "2091-01-20",
            customer: "2091-01-19",
            transfergesellschaft: "2091-01-18",
          },
        },
      }),
    );
  });

  it("shows when the counting cancellation is valid from", async () => {
    setup({
      tab: "dsv",
      view: {
        facts: {
          dsvGenerated: null,
          dsvScanReceived: null,
          dsvFullyExecuted: null,
          dsvCancellation: { validOn: "2091-01-20", recordedAt: "2091-01-21T10:00:00.000000Z" },
        },
      },
    });
    const section = await card("Aufhebungsvertrag");
    expect(section.getByText(/gültig ab 20\.01\.2091/)).toBeVisible();
  });
});

describe("Kunde informieren", () => {
  const withdrawn = {
    detail: { status: "withdrawn", capabilities: { ...detail().capabilities, withdraw: false } },
    view: {
      customerNotice: { dueSince: "2091-01-22", notifiedOn: null },
      capabilities: {
        ...view().capabilities,
        uploadCancellation: false,
        recordCustomerNotice: true,
      },
    },
    tab: "dsv",
  };

  it("records the day the PL informed the customer, nothing preset", async () => {
    const { calls } = setup(withdrawn, {
      [`POST ${detailPath}/dsv/customer-notice`]: () => json(view()),
    });
    const section = await card("Kunde informieren");
    expect(section.getByText(/noch nicht über die Aufhebung informiert/)).toBeVisible();
    await userEvent.click(section.getByRole("button", { name: "Kunde informiert am …" }));
    const panel = within(screen.getByRole("dialog"));
    expect(panel.getByLabelText(/Kunde informiert am \(TT/)).toHaveValue("");
    await userEvent.type(panel.getByLabelText(/Kunde informiert am \(TT/), "23.01.2091");
    await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/dsv/customer-notice`,
        body: { notifiedOn: "2091-01-23" },
      }),
    );
  });

  it("names a date before the withdrawal and keeps the input", async () => {
    setup(withdrawn, {
      [`POST ${detailPath}/dsv/customer-notice`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "/notifiedOn", code: "notice_before_withdrawal", detail: "x" }],
        }),
    });
    const section = await card("Kunde informieren");
    await userEvent.click(section.getByRole("button", { name: "Kunde informiert am …" }));
    const panel = within(screen.getByRole("dialog"));
    await userEvent.type(panel.getByLabelText(/Kunde informiert am \(TT/), "21.01.2091");
    await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
    expect(await panel.findByText("Das Datum liegt vor dem Rückzug.")).toBeVisible();
    expect(panel.getByLabelText(/Kunde informiert am \(TT/)).toHaveValue("21.01.2091");
  });

  it("is read-only for a viewer who may not record it", async () => {
    setup({
      ...withdrawn,
      view: {
        ...withdrawn.view,
        customerNotice: { dueSince: "2091-01-22", notifiedOn: "2091-01-23" },
        capabilities: view().capabilities,
      },
    });
    const section = await card("Kunde informieren");
    expect(section.getByText("Kunde informiert am 23.01.2091.")).toBeVisible();
    expect(section.queryByRole("button", { name: "Kunde informiert am …" })).toBeNull();
  });
});

describe("Zurückziehen in the page header", () => {
  it("withdraws a signed DSV with reason, date and confirmation against the version read", async () => {
    const { calls } = setup({}, { [`POST ${detailPath}/withdrawal`]: () => json(detail()) });
    await userEvent.click((await actionsMenu()).getByText("Zurückziehen"));
    const panel = within(await screen.findByRole("dialog", { name: "Zurückziehen" }));
    expect(panel.getByText(/gültig ab 20\.01\.2091/)).toBeVisible();
    expect(panel.getByLabelText("Grund")).toHaveValue("");
    expect(panel.getByLabelText(/Zurückgezogen am/)).toHaveValue("");
    await userEvent.selectOptions(panel.getByLabelText("Grund"), "placed_direct");
    await userEvent.type(panel.getByLabelText(/Zurückgezogen am/), "21.01.2091");
    await userEvent.click(panel.getByRole("button", { name: "Zurückziehen" }));
    // Not without the confirmation.
    expect(calls.some((c) => c.key === `POST ${detailPath}/withdrawal`)).toBe(false);
    await userEvent.click(panel.getByLabelText(/Ich bestätige/));
    await userEvent.click(panel.getByRole("button", { name: "Zurückziehen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/withdrawal`,
        body: {
          endReason: "placed_direct",
          effectiveDate: "2091-01-21",
          statusVersion: 7,
          confirmed: true,
        },
      }),
    );
  });

  it("names the missing cancellation and offers no save (C1)", async () => {
    setup({
      detail: {
        dsvCancellationValidOn: null,
        capabilities: { ...detail().capabilities, withdraw: false },
        refusals: {
          assignEntryWave: null,
          setParticipationDates: null,
          withdraw: "dsv_cancellation_missing",
        },
      },
    });
    await userEvent.click((await actionsMenu()).getByText("Zurückziehen"));
    const panel = within(await screen.findByRole("dialog", { name: "Zurückziehen" }));
    expect(panel.getByText(/erst mit einem geprüften, von allen drei Parteien/)).toBeVisible();
    expect(panel.queryByRole("button", { name: "Zurückziehen" })).toBeNull();
  });

  it("is not offered to a viewer without the capability", async () => {
    setup({
      detail: {
        capabilities: { ...detail().capabilities, withdraw: false },
        refusals: { assignEntryWave: null, setParticipationDates: null, withdraw: "forbidden" },
      },
    });
    expect(await screen.findByRole("heading", { name: "Beispiel, Erika" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Aktionen" })).toBeNull();
  });
});

describe("Grund korrigieren", () => {
  it("corrects the system's reason against the reason read", async () => {
    const { calls } = setup(
      {
        detail: {
          status: "withdrawn",
          dsvStatus: "not_offered",
          endReason: "no_response",
          endReasonSource: "system",
          capabilities: { ...detail().capabilities, withdraw: false, correctEndReason: true },
          refusals: {
            assignEntryWave: null,
            setParticipationDates: null,
            withdraw: "status_not_withdrawable",
          },
        },
      },
      { [`PUT ${detailPath}/end-reason`]: () => json(detail()) },
    );
    await userEvent.click((await actionsMenu()).getByText("Grund korrigieren"));
    const panel = within(await screen.findByRole("dialog", { name: "Grund korrigieren" }));
    expect(panel.getByText(/vom System ermittelt\): Keine Rückmeldung/)).toBeVisible();
    expect(panel.queryByLabelText(/trifft ebenfalls zu/)).toBeNull();
    await userEvent.selectOptions(panel.getByLabelText("Neuer Grund"), "placed_direct");
    await userEvent.click(panel.getByRole("button", { name: "Grund korrigieren" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `PUT ${detailPath}/end-reason`,
        body: { endReason: "placed_direct", expected: "no_response" },
      }),
    );
  });
});

describe("where the open items link to", () => {
  it("sends the customer notice and the signed DSV with a declined profiling to the tab DSV", async () => {
    const { stepTarget } = await import("./components/open-steps");
    expect(
      stepTarget({ tier: 2, source: "case", kind: "dsv_customer_notice", date: "2091-01-22" }),
    ).toEqual({
      tab: "dsv",
    });
    expect(
      stepTarget({ tier: 2, source: "flag", kind: "conflict_dsv_signed_profiling_declined" }),
    ).toEqual({ tab: "dsv" });
  });
});
