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
const formId = "00000000-0000-4000-a000-0000000000f1";
const scanId = "00000000-0000-4000-a000-0000000000f2";
const consentId = "00000000-0000-4000-a000-0000000000f3";
const withdrawalId = "00000000-0000-4000-a000-0000000000f4";

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

const kugCapabilities = {
  generate: false,
  addScan: false,
  decline: false,
  recordWithdrawal: false,
  recordBaNotice: false,
};
type Kug = Record<string, unknown> & { capabilities?: Partial<typeof kugCapabilities> };

/** The Kug 200b block: nothing offered yet, no forms or scans. */
const kug200b = (overrides: Kug = {}) => ({
  offeredOn: null,
  outcome: null,
  declinedOn: null,
  profileAccess: null,
  withdrawals: [],
  forms: [],
  scans: [],
  versions: ["09-2021"],
  ...overrides,
  capabilities: { ...kugCapabilities, ...overrides.capabilities },
});

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
  kug200b: kug200b(),
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
    [`POST ${detailPath}/documents/${proofId}/quarantine`]: answer,
    [`POST ${detailPath}/documents/${proofId}/quarantine-lift`]: answer,
    [`POST ${detailPath}/forms/kug200b`]: () =>
      json(
        {
          participationId,
          documentId: formId,
          formVersion: "09-2021",
          checklist: [
            {
              code: "required_blank",
              key: "pensionInsuranceNumber",
              label: "11 Rentenversicherungsnummer",
            },
          ],
        },
        201,
      ),
    [`POST ${detailPath}/documents/${scanId}/review`]: answer,
    [`POST ${detailPath}/asu/kug200b-decline`]: answer,
    [`POST ${detailPath}/asu/withdrawal`]: answer,
    [`POST ${detailPath}/asu/withdrawal-ba-notice`]: answer,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=asu`, mock.api);
  return mock;
}

const callTo = (calls: { key: string; body: unknown }[], key: string) =>
  calls.filter((call) => call.key === key);

/** A section of the tab by its heading. */
const section = async (name: string) => within(await screen.findByRole("region", { name }));

/** A BA confirmation as the PL lists it: metadata only, quarantined at once if suspect. */
const plProof = (quarantined: boolean) => ({
  documentId: proofId,
  addedAt: "2026-11-04T10:00:00.000000Z",
  review: { state: "accepted", reasonCode: null, reviewedAt: "2026-11-04T11:00:00.000000Z" },
  quarantine: quarantined
    ? { reasonCode: "suspected_wrong_person", quarantinedAt: "2026-11-05T08:00:00.000000Z" }
    : null,
  linked: false,
  capabilities: {
    open: false,
    review: false,
    delete: false,
    quarantine: !quarantined,
    liftQuarantine: quarantined,
  },
});

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

  it("keeps a typed knowledge date with the date it was read against; a change elsewhere is a conflict", async () => {
    const user = userEvent.setup();
    const can = { setKnowledgeDate: true, setRoute: true };
    const { calls } = setup(
      view({ knowledgeDate: "2027-01-01", capabilities: can }),
      view({
        knowledgeDate: "2027-01-05",
        route: { channel: "in_person", version: 1, defaultChannel: "online_self" },
        capabilities: can,
      }),
    );
    const field = await screen.findByLabelText("Kenntnisdatum (TT.MM.JJJJ)");
    await user.clear(field);
    await user.type(field, "02.01.2027");
    // Another write reads the tab again: the date was changed elsewhere meanwhile.
    await user.click(screen.getByRole("button", { name: "Weg speichern" }));
    const knowledge = await section("Kenntnisdatum und Frist");
    expect(
      await knowledge.findByText(/Dieser Abschnitt wurde inzwischen an anderer Stelle gespeichert/),
    ).toBeVisible();
    expect(knowledge.getByLabelText("Kenntnisdatum (TT.MM.JJJJ)")).toHaveValue("02.01.2027");
    await user.click(knowledge.getByRole("button", { name: "Kenntnisdatum speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/knowledge-date`)[0]?.body).toEqual({
        knowledgeDate: "2027-01-02",
        previous: "2027-01-01",
      }),
    );
    await user.click(knowledge.getByRole("button", { name: "Neu laden" }));
    expect(knowledge.getByLabelText("Kenntnisdatum (TT.MM.JJJJ)")).toHaveValue("05.01.2027");
    expect(knowledge.queryByText(/an anderer Stelle gespeichert/)).toBeNull();
  });

  it("refreshes clean editors with the new state and its baseline", async () => {
    const user = userEvent.setup();
    const can = { setKnowledgeDate: true, setRoute: true };
    const { calls } = setup(
      view({ knowledgeDate: "2027-01-01", capabilities: can }),
      view({
        knowledgeDate: "2027-01-05",
        route: { channel: "in_person", version: 1, defaultChannel: "online_self" },
        capabilities: can,
      }),
    );
    // Another write reads the tab again; both editors are clean.
    await user.click(await screen.findByRole("button", { name: "Weg speichern" }));
    const knowledge = await section("Kenntnisdatum und Frist");
    expect(await knowledge.findByText("Kenntnisdatum: 05.01.2027")).toBeVisible();
    expect(knowledge.getByLabelText("Kenntnisdatum (TT.MM.JJJJ)")).toHaveValue("05.01.2027");
    expect((await section("Weg der Arbeitsuchendmeldung")).getByRole("combobox")).toHaveValue(
      "in_person",
    );
    await user.click(screen.getByRole("button", { name: "Weg speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/asu/route`)[1]?.body).toEqual({
        channel: "in_person",
        version: 1,
      }),
    );
  });

  it("keeps a chosen route with the version it was read with; a change elsewhere is a conflict", async () => {
    const user = userEvent.setup();
    const can = { setKnowledgeDate: true, setRoute: true };
    const { calls } = setup(
      view({ capabilities: can }),
      view({
        knowledgeDate: "2026-10-01",
        route: { channel: "kug_200b", version: 1, defaultChannel: "online_self" },
        capabilities: can,
      }),
    );
    const route = await section("Weg der Arbeitsuchendmeldung");
    await user.selectOptions(await route.findByRole("combobox", { name: "Weg" }), "in_person");
    const field = screen.getByLabelText("Kenntnisdatum (TT.MM.JJJJ)");
    await user.type(field, "01.10.2026");
    await user.click(screen.getByRole("button", { name: "Kenntnisdatum speichern" }));
    expect(
      await route.findByText(/Dieser Abschnitt wurde inzwischen an anderer Stelle gespeichert/),
    ).toBeVisible();
    expect(route.getByRole("combobox", { name: "Weg" })).toHaveValue("in_person");
    await user.click(route.getByRole("button", { name: "Weg speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/asu/route`)[0]?.body).toEqual({
        channel: "in_person",
        version: 0,
      }),
    );
  });

  it("records the registration against the route reviewed and shows a route changed meanwhile", async () => {
    const user = userEvent.setup();
    const can = { setKnowledgeDate: true, recordRegistration: true };
    const { calls } = setup(
      view({
        route: { channel: "online_self", version: 1, defaultChannel: "online_self" },
        capabilities: can,
      }),
      view({
        knowledgeDate: "2026-10-01",
        route: { channel: "in_person", version: 2, defaultChannel: "online_self" },
        capabilities: can,
      }),
    );
    await user.type(await screen.findByLabelText("Datum der Meldung (TT.MM.JJJJ)"), "02.11.2026");
    await user.type(screen.getByLabelText("Kenntnisdatum (TT.MM.JJJJ)"), "01.10.2026");
    await user.click(screen.getByRole("button", { name: "Kenntnisdatum speichern" }));
    const registration = await section("Meldung");
    expect(
      await registration.findByText(
        /Der Weg wurde inzwischen an anderer Stelle geändert \(jetzt: Persönlich/,
      ),
    ).toBeVisible();
    await user.click(registration.getByRole("button", { name: "Meldung speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/asu/registration`)[0]?.body).toMatchObject({
        routeVersion: 1,
      }),
    );
    await user.click(registration.getByRole("button", { name: "Geänderten Weg übernehmen" }));
    expect(registration.queryByText(/Der Weg wurde inzwischen/)).toBeNull();
    await user.click(registration.getByRole("button", { name: "Meldung speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/asu/registration`)[1]?.body).toMatchObject({
        registeredOn: "2026-11-02",
        routeVersion: 2,
      }),
    );
  });

  it("lets the PL quarantine a suspect BA confirmation at once and lift it, never open it", async () => {
    const user = userEvent.setup();
    const quarantined = view({ proofDocuments: [plProof(true)] });
    const { calls } = setup(view({ proofDocuments: [plProof(false)] }), quarantined);
    const proofs = await section("BA-Bestätigungen");
    expect(await proofs.findByText(/Hochgeladen am/)).toBeVisible();
    expect(proofs.queryByRole("button", { name: "Öffnen" })).toBeNull();
    await user.selectOptions(
      proofs.getByRole("combobox", { name: "Grund der Quarantäne" }),
      "suspected_wrong_acceptance",
    );
    await user.click(proofs.getByRole("button", { name: "Unter Quarantäne stellen" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/documents/${proofId}/quarantine`)[0]?.body).toEqual({
        reasonCode: "suspected_wrong_acceptance",
      }),
    );
    expect(await proofs.findByText(/Unter Quarantäne: Verdacht: andere Person/)).toBeVisible();
    await user.click(proofs.getByRole("button", { name: "Quarantäne aufheben" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/documents/${proofId}/quarantine-lift`)).toHaveLength(
        1,
      ),
    );
  });

  it("shows back office the registration's summary without the BA confirmations", async () => {
    const registration = {
      id: registrationId,
      channel: "in_person",
      registeredOn: "2026-11-01",
      recordedAt: "2026-11-01T09:00:00.000000Z",
      proof: {
        kind: "ba_confirmation",
        attestationSource: null,
        linkedAt: "2026-11-02T09:00:00.000000Z",
      },
      withProofSince: "2026-11-02T09:00:00.000000Z",
    };
    const { proofDocuments: _, ...summary } = view({ registration, missing: [] });
    setup(summary as ReturnType<typeof view>);
    expect(await screen.findByText("Nachweis: BA-Bestätigung")).toBeVisible();
    expect(screen.queryByRole("region", { name: "BA-Bestätigungen" })).toBeNull();
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
        routeVersion: 1,
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

/** A signed Kug 200b scan awaiting its review, printed from the generated form. */
const unreviewedScan = {
  documentId: scanId,
  origin: "generated",
  generationDocumentId: formId,
  formVersion: "09-2021",
  addedAt: "2026-11-04T10:00:00.000000Z",
  review: { state: "unreviewed", reasonCode: null, reviewedAt: null },
  signedOn: null,
  quarantine: null,
  capabilities: { open: true, review: true, delete: true, quarantine: true, liftQuarantine: false },
};

describe("the Kug 200b on the tab Arbeitsuche (Q185, Q197)", () => {
  it("shows the handwriting checklist of a generated form before printing", async () => {
    const user = userEvent.setup();
    const { calls } = setup(view({ kug200b: kug200b({ capabilities: { generate: true } }) }));
    const kug = await section("Kug 200b");
    await user.click(kug.getByRole("button", { name: "Kug 200b erzeugen" }));
    const checklist = await screen.findByTestId("kug200b-checklist");
    expect(checklist).toHaveTextContent("11 Rentenversicherungsnummer: fehlt – von Hand eintragen");
    expect(callTo(calls, `POST ${detailPath}/forms/kug200b`)).toHaveLength(1);
  });

  it("accepts a scan only with the field-19 date and all three confirmations, nothing preselected", async () => {
    const user = userEvent.setup();
    const { calls } = setup(view({ kug200b: kug200b({ scans: [unreviewedScan] }) }));
    const kug = await section("Kug 200b");
    await user.click(kug.getByRole("button", { name: "Prüfen" }));
    const dialog = await screen.findByRole("dialog", { name: "Unterschriebenen Kug 200b prüfen" });
    const accept = within(dialog).getByRole("button", { name: "Annehmen" });
    for (const name of ["16 und 17 angekreuzt", "Pflichtangaben ausgefüllt", "unterschrieben"]) {
      expect(within(dialog).getByLabelText(name)).not.toBeChecked();
    }
    await user.type(within(dialog).getByLabelText("Datum in Feld 19 (TT.MM.JJJJ)"), "04.11.2026");
    await user.click(within(dialog).getByLabelText("16 und 17 angekreuzt"));
    await user.click(within(dialog).getByLabelText("Pflichtangaben ausgefüllt"));
    expect(accept).toBeDisabled();
    await user.click(within(dialog).getByLabelText("unterschrieben"));
    await user.click(accept);
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/documents/${scanId}/review`)[0]?.body).toEqual({
        decision: "accepted",
        kug200bScan: {
          signedOn: "2026-11-04",
          confirmations: ["declarations_ticked", "mandatory_completed", "signature_present"],
        },
      }),
    );
  });

  it("records a decline with its date", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      view({ kug200b: kug200b({ offeredOn: "2026-11-02", capabilities: { decline: true } }) }),
    );
    const kug = await section("Kug 200b");
    expect(kug.getByTestId("kug200b-outcome")).toHaveTextContent("Angeboten am 02.11.2026");
    await user.type(kug.getByLabelText("Abgelehnt am (TT.MM.JJJJ)"), "03.11.2026");
    await user.click(kug.getByRole("button", { name: "Ablehnung erfassen" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/asu/kug200b-decline`)[0]?.body).toEqual({
        declinedOn: "2026-11-03",
      }),
    );
  });

  it('records a withdrawal and "BA informiert am", never claiming the BA\'s access was disabled', async () => {
    const user = userEvent.setup();
    const signed = kug200b({
      outcome: "signed",
      profileAccess: { consentId, givenOn: "2026-11-04" },
      capabilities: { recordWithdrawal: true },
    });
    const withdrawn = kug200b({
      outcome: "signed",
      withdrawals: [
        {
          id: withdrawalId,
          receivedOn: "2026-11-10",
          recordedAt: "2026-11-10T09:00:00.000000Z",
          baNotifiedOn: null,
        },
      ],
      capabilities: { recordBaNotice: true },
    });
    const { calls } = setup(view({ kug200b: signed }), view({ kug200b: withdrawn }));
    const kug = await section("Kug 200b");
    expect(kug.getByText("Erklärt seit 04.11.2026 (wie unterschrieben).")).toBeVisible();
    await user.type(kug.getByLabelText("Widerruf eingegangen am (TT.MM.JJJJ)"), "10.11.2026");
    await user.click(kug.getByRole("button", { name: "Widerruf erfassen" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/asu/withdrawal`)[0]?.body).toEqual({
        consentId,
        receivedOn: "2026-11-10",
      }),
    );
    expect(await kug.findByText(/BA noch nicht informiert/)).toBeVisible();
    expect(kug.getByText(/nicht, ob sie den Zugriff gesperrt hat/)).toBeVisible();
    await user.type(kug.getByLabelText("BA informiert am (TT.MM.JJJJ)"), "11.11.2026");
    await user.click(kug.getByRole("button", { name: "BA informiert am erfassen" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/asu/withdrawal-ba-notice`)[0]?.body).toEqual({
        withdrawalId,
        notifiedOn: "2026-11-11",
      }),
    );
  });

  it("shows back office the outcome only, no forms or scans (Q49)", async () => {
    setup(
      view({
        kug200b: { ...kug200b({ outcome: "signed" }), forms: undefined, scans: undefined },
      }),
    );
    const kug = await section("Kug 200b");
    expect(kug.getByText("Unterschrieben (angenommen).")).toBeVisible();
    expect(kug.queryByRole("table")).toBeNull();
    expect(kug.queryAllByRole("button").map((b) => b.textContent)).toEqual([]);
  });
});
