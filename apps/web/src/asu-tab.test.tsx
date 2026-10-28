import { screen, waitFor } from "@testing-library/react";
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

// The tab "Arbeitsuche" (process-and-lifecycle.md, Arbeitsuchendmeldung and dates;
// data-protection.md, the ASU record): the route with its version, the knowledge date and the due
// date or its orientation, the registration with the attestation's number masked and never kept,
// the consultant's link. Synthetic data only; the BA-Kundennummer is made up.
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const proofId = "00000000-0000-4000-a000-0000000000d1";
const registrationId = "00000000-0000-4000-a000-0000000000e1";
const number = "555X123456";

const detail = (viewAsu: boolean) => ({
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
    effectiveTgStart: null,
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
    viewAsu,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
});

const capabilities = {
  setRoute: false,
  recordRegistration: false,
  attest: false,
  linkProof: false,
  setKnowledgeDate: false,
  addProof: false,
};

type View = Record<string, unknown> & { capabilities?: Partial<typeof capabilities> };

const view = (overrides: View = {}) => ({
  participationId,
  applies: true,
  closed: false,
  route: { channel: null, version: 0, defaultChannel: "online_self" },
  knowledgeDate: null,
  oldEmploymentEndDate: "2027-06-30",
  dueDate: { kind: "orientation", date: "2027-03-30" },
  registration: null,
  proofDocuments: [],
  missing: [{ ruleId: "base-asu-proof", kind: "document", key: "asu_proof", reason: "missing" }],
  ...overrides,
  capabilities: { ...capabilities, ...overrides.capabilities },
});

function setup(first: ReturnType<typeof view>, afterWrite = first, viewAsu = true) {
  let current = first;
  const answer = () => {
    current = afterWrite;
    return json(current);
  };
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail(viewAsu)),
    [`GET ${detailPath}/asu`]: () => json(current),
    [`PUT ${detailPath}/asu/route`]: answer,
    [`PUT ${detailPath}/knowledge-date`]: ({ body }) =>
      (body as { previous: string | null }).previous === "2027-01-01"
        ? problem(409, "conflict", { errors: [{ pointer: "", code: "stale_value" }] })
        : answer(),
    [`POST ${detailPath}/asu/registration`]: answer,
    [`POST ${detailPath}/asu/proof-link`]: answer,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=asu`, mock.api);
  return mock;
}

const callTo = (calls: { key: string; body: unknown }[], key: string) =>
  calls.filter((call) => call.key === key);

describe("the tab Arbeitsuche", () => {
  it("has no tab without the capability", async () => {
    setup(view(), view(), false);
    expect(await screen.findByRole("tab", { name: "Unterlagen" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Arbeitsuche" })).toBeNull();
  });

  it("preselects the Agentur's route and saves it with the version read", async () => {
    const user = userEvent.setup();
    const { calls } = setup(view({ capabilities: { setRoute: true } }));
    expect(
      await screen.findByText("Vorschlag der Vermittlungs-Agentur: Selbst online gemeldet"),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Weg" })).toHaveValue("online_self");
    await user.selectOptions(screen.getByRole("combobox", { name: "Weg" }), "in_person");
    await user.click(screen.getByRole("button", { name: "Weg speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/asu/route`)[0]?.body).toEqual({
        channel: "in_person",
        version: 0,
      }),
    );
  });

  it("shows the orientation without a knowledge date, never as overdue, and the statutory date with it", async () => {
    setup(view());
    expect(await screen.findByText("Orientierung 30.03.2027 – Kenntnisdatum klären")).toBeVisible();
    expect(screen.queryByText(/überfällig/i)).toBeNull();
  });

  it("names the statutory branch", async () => {
    setup(
      view({
        knowledgeDate: "2027-03-31",
        dueDate: { kind: "statutory", date: "2027-04-03", branch: "after_knowledge" },
      }),
    );
    expect(
      await screen.findByText("Fällig am 03.04.2027 (drei Tage nach der Kenntnis)"),
    ).toBeVisible();
  });

  it("sets the knowledge date against the one read and shows a conflict", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      view({ knowledgeDate: "2027-01-01", capabilities: { setKnowledgeDate: true } }),
    );
    const field = await screen.findByLabelText("Kenntnisdatum (TT.MM.JJJJ)");
    await user.clear(field);
    await user.type(field, "02.01.2027");
    await user.click(screen.getByRole("button", { name: "Kenntnisdatum speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/knowledge-date`)[0]?.body).toEqual({
        knowledgeDate: "2027-01-02",
        previous: "2027-01-01",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/Inzwischen geändert/);
  });

  it("records the PL's attestation with the number masked, and never shows it back", async () => {
    const user = userEvent.setup();
    const registered = view({
      route: { channel: "online_self", version: 1, defaultChannel: "online_self" },
      dueDate: null,
      missing: [],
      registration: {
        id: registrationId,
        channel: "online_self",
        registeredOn: "2026-11-02",
        recordedAt: "2026-11-03T09:00:00.000000Z",
        proof: {
          kind: "ba_customer_number",
          attestationSource: "ba_online_account_inspected",
          documentId: null,
          linkedAt: "2026-11-03T09:00:00.000000Z",
        },
        withProofSince: "2026-11-03T09:00:00.000000Z",
      },
    });
    const { calls } = setup(
      view({
        route: { channel: "online_self", version: 1, defaultChannel: "online_self" },
        capabilities: { recordRegistration: true, attest: true },
      }),
      registered,
    );
    await user.type(await screen.findByLabelText("Datum der Meldung (TT.MM.JJJJ)"), "02.11.2026");
    await user.click(screen.getByRole("radio", { name: "BA-Kundennummer mit Datum geprüft" }));
    const input = screen.getByLabelText("BA-Kundennummer");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, number);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Wo geprüft" }),
      "ba_online_account_inspected",
    );
    await user.click(screen.getByRole("button", { name: "Meldung speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/asu/registration`)[0]?.body).toEqual({
        registeredOn: "2026-11-02",
        attestation: { customerNumber: number, source: "ba_online_account_inspected" },
      }),
    );
    expect(
      await screen.findByText("Nachweis: BA-Kundennummer, geprüft – BA-Onlinekonto eingesehen"),
    ).toBeVisible();
    expect(document.body.innerHTML).not.toContain(number);
  });

  it("lets the consultant link an accepted BA confirmation to the registration", async () => {
    const user = userEvent.setup();
    const proof = {
      documentId: proofId,
      addedAt: "2026-11-04T10:00:00.000000Z",
      review: { state: "accepted", reasonCode: null, reviewedAt: "2026-11-04T11:00:00.000000Z" },
      quarantine: null,
      linked: false,
      capabilities: {
        open: true,
        review: false,
        delete: false,
        quarantine: true,
        liftQuarantine: false,
      },
    };
    const registration = {
      id: registrationId,
      channel: "in_person",
      registeredOn: "2026-11-01",
      recordedAt: "2026-11-01T09:00:00.000000Z",
      proof: null,
      withProofSince: null,
    };
    const { calls } = setup(
      view({ registration, proofDocuments: [proof], capabilities: { linkProof: true } }),
    );
    expect(
      await screen.findByText("Nachweis fehlt: eine geprüfte BA-Bestätigung verknüpfen."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Als Nachweis verknüpfen" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/asu/proof-link`)[0]?.body).toEqual({
        registrationId,
        documentId: proofId,
      }),
    );
  });

  it("names the missing items of the step, the Kug 200b ones on its route", async () => {
    setup(
      view({
        route: { channel: "kug_200b", version: 1, defaultChannel: null },
        missing: [
          { ruleId: "base-asu-proof", kind: "document", key: "asu_proof", reason: "missing" },
          {
            ruleId: "base-kug200b-signed-scan",
            kind: "document",
            key: "kug200b_signed_scan",
            reason: "missing",
          },
        ],
      }),
    );
    expect(await screen.findByText("ein angenommener, unterschriebener Kug 200b")).toBeVisible();
    expect(
      screen.getByText("Auf dem Weg Kug 200b erfasst die Sammelmeldung die Meldung."),
    ).toBeVisible();
  });

  it("says nothing applies in a ta_only project", async () => {
    setup(view({ applies: false }));
    expect(
      await screen.findByText("In diesem Projekt wird keine Arbeitsuchendmeldung erfasst."),
    ).toBeVisible();
  });
});
