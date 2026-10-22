import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  consultant,
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
} from "./test-utils";

// A participant's page (data-protection.md, "Participation detail") and the PL's wave choice.
const participationId = "00000000-0000-4000-a000-000000000001";
const projectPath = `/api/v1/projects/${project.id}`;
const detailPath = `/api/v1/participations/${participationId}`;
const activationPath = `${detailPath}/activation`;
const wave = (n: number) => ({
  id: `00000000-0000-4000-b000-00000000000${n}`,
  projectId: project.id,
  code: `W${n}`,
  name: `Welle ${n}`,
  signingDeadline: "2091-02-15",
  defaultTgStart: "2091-03-01",
  defaultTgEnd: "2092-02-29",
  latestEntryDate: "2091-03-15",
  participations: 0,
  createdAt: "2026-10-15T08:30:00.123456Z",
  updatedAt: "2026-10-15T08:30:00.123456Z",
});
const { participations: _p, createdAt: _c, updatedAt: _u, projectId: _id, ...w1 } = wave(1);

const detail = {
  id: participationId,
  projectId: project.id,
  status: "imported",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  statusVersion: 0,
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
  person: {
    personnelNumber: "BSP-0001",
    lastName: "Mustermann",
    firstName: "Erika",
    birthDate: "1970-01-01",
    oldEmploymentEndDate: "2091-02-28",
    address: {
      street: "Musterstraße 1",
      postalCode: "99999",
      city: "Beispielstadt",
      country: "DE",
    },
    phone: null,
    mobile: "0171 3920000",
    privateEmail: "erika@example.org",
    workEmail: null,
  },
  assignments: [],
  activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
  privacyNoticeState: { state: "due", dueOn: "2026-11-15", providedAt: null },
  capabilities: {
    assignEntryWave: true,
    setParticipationDates: false,
    assignParticipations: true,
    issueActivationCode: false,
    recordHandover: false,
    revokeActivationCode: false,
    providePrivacyNotice: false,
    setPlacementAgentur: false,
    startAssistedMode: false,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
};
const option1 =
  "W1 – Welle 1 (Unterschrift bis 15.02.2091, TG 01.03.2091 bis 29.02.2092, Eintritt bis 15.03.2091)";
const option2 = option1.replaceAll("1 – Welle 1", "2 – Welle 2");

function setup(routes: Parameters<typeof mockApi>[0] = {}, shown: object = detail) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [wave(1), wave(2)], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(shown),
    ...routes,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}`, api);
  return calls;
}

const section = (name: string) => screen.findByRole("region", { name });

describe("the participant page", () => {
  it("shows person, contact, status, wave and dates; a missing value as a dash", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Mustermann, Erika" })).toBeInTheDocument();
    const person = await section("Person");
    expect(within(person).getByText("BSP-0001")).toBeInTheDocument();
    expect(within(person).getByText("01.01.1970")).toBeInTheDocument();
    const contact = await section("Kontakt");
    expect(
      within(contact).getByText("Musterstraße 1, 99999 Beispielstadt, DE"),
    ).toBeInTheDocument();
    expect(within(contact).getAllByText("—")).toHaveLength(2);
    expect(within(await section("Status")).getByText("Importiert")).toBeInTheDocument();
    expect(within(await section("Welle und Vertragsdaten")).getByText("Welle")).toBeInTheDocument();
  });

  it("hides the fields the API didn't send; back office sees why there is no wave choice", async () => {
    setup(
      {},
      {
        ...detail,
        person: { personnelNumber: "BSP-0001" },
        capabilities: { assignEntryWave: false },
        refusals: { assignEntryWave: "forbidden" },
      },
    );
    expect(await screen.findByRole("heading", { name: "Teilnehmende Person" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Kontakt" })).toBeNull();
    expect(screen.queryByLabelText("Welle zuordnen")).toBeNull();
    expect(screen.getByText("Nur die Projektleitung ordnet Wellen zu.")).toBeInTheDocument();
  });

  it("names the API's reason for a closed status, not one guessed from the data", async () => {
    setup(
      {},
      {
        ...detail,
        status: "withdrawn",
        capabilities: { assignEntryWave: false },
        refusals: { assignEntryWave: "status_not_open" },
      },
    );
    expect(
      await screen.findByText("In diesem Status ändert sich die Welle nicht mehr."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/DSV-Angebot/)).toBeNull();
  });

  it("shows the wave's dates and their source, and the missed start", async () => {
    setup(
      {},
      {
        ...detail,
        status: "informed",
        entryWave: w1,
        dates: {
          ...detail.dates,
          tgEnd: "2092-01-31",
          effectiveTgStart: "2091-03-01",
          effectiveTgEnd: "2092-01-31",
        },
        hints: ["tg_start_missed"],
        capabilities: { assignEntryWave: false },
        refusals: { assignEntryWave: "individual_dates_set" },
      },
    );
    const dates = await section("Welle und Vertragsdaten");
    expect(within(dates).getByText("W1 – Welle 1")).toBeInTheDocument();
    expect(within(dates).getByText("01.03.2091 (aus der Welle)")).toBeInTheDocument();
    expect(within(dates).getByText("31.01.2092 (individuell)")).toBeInTheDocument();
    // The wave's own dates stay visible next to the individual end that overrides one of them.
    const fact = (label: string) => within(dates).getByText(label).nextElementSibling;
    expect(fact("Unterschriftsfrist")).toHaveTextContent("15.02.2091");
    expect(fact("TG-Beginn der Welle")).toHaveTextContent("01.03.2091");
    expect(fact("TG-Ende der Welle")).toHaveTextContent("29.02.2092");
    expect(fact("Spätester Eintritt")).toHaveTextContent("15.03.2091");
    expect(screen.getByText(/TG-Beginn verpasst/)).toBeInTheDocument();
    expect(screen.getByText(/individuelle Vertragsdaten/)).toBeInTheDocument();
  });

  it("asks to check the placement Agentur after the participant changed the address (Q139)", async () => {
    setup({}, { ...detail, hints: ["placement_agentur_check"] });
    expect(await screen.findByText(/Vermittlungs-Agentur prüfen/)).toBeInTheDocument();
  });

  it("assigns a wave and shows the result", async () => {
    const calls = setup({
      [`PUT ${detailPath}/entry-wave`]: () =>
        json({ ...detail, entryWave: w1, capabilities: { assignEntryWave: true } }),
    });
    await userEvent.selectOptions(await screen.findByLabelText("Welle zuordnen"), option1);
    await userEvent.click(screen.getByRole("button", { name: "Welle zuordnen" }));
    expect(await screen.findByText("Welle zugeordnet")).toBeInTheDocument();
    expect(calls.find((c) => c.key === `PUT ${detailPath}/entry-wave`)?.body).toEqual({
      waveId: w1.id,
    });
    expect(await screen.findByLabelText("Andere Welle zuordnen")).toBeInTheDocument();
  });

  it("shows a refusal by its code and reads the participation again", async () => {
    const calls = setup({
      [`PUT ${detailPath}/entry-wave`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "", code: "dsv_already_offered", detail: "Refused" }],
        }),
    });
    await userEvent.selectOptions(await screen.findByLabelText("Welle zuordnen"), option2);
    await userEvent.click(screen.getByRole("button", { name: "Welle zuordnen" }));
    expect(
      await screen.findByText("Nach dem ersten DSV-Angebot ändert sich die Welle nicht mehr."),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.key === `GET ${detailPath}`).length).toBeGreaterThan(1);
  });

  it("says when the participant may not be seen or doesn't exist", async () => {
    setup({ [`GET ${detailPath}`]: () => problem(403, "forbidden") });
    expect(
      await screen.findByText("Sie dürfen diese teilnehmende Person nicht sehen."),
    ).toBeInTheDocument();
  });

  it("treats a participant of another project as not found and loads none of its waves", async () => {
    const calls = setup({}, { ...detail, projectId: "00000000-0000-4000-9000-000000000099" });
    expect(
      await screen.findByText("Diese teilnehmende Person wurde nicht gefunden."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Person" })).toBeNull();
    expect(calls.some((c) => c.key.endsWith("/entry-waves"))).toBe(false);
  });

  it("says when the participant doesn't exist", async () => {
    setup({ [`GET ${detailPath}`]: () => problem(404, "not-found") });
    expect(
      await screen.findByText("Diese teilnehmende Person wurde nicht gefunden."),
    ).toBeInTheDocument();
  });
});

describe("activation details", () => {
  const activation = {
    status: {
      account: "not_activated",
      code: "open",
      issuedAt: "2026-10-21T10:00:00.000Z",
      expiresAt: "2026-11-20T10:00:00.000Z",
    },
    current: {
      purpose: "activation",
      activationCodeId: "00000000-0000-4000-a000-000000000010",
      channel: "letter",
      deliveryKind: null,
      deliveryStatus: null,
      noticeLanguage: "de",
      issuedBy: staffUsers[1]!.id,
      issuedByDisplayName: staffUsers[1]!.displayName,
      issuedAt: "2026-10-21T10:00:00.000Z",
      expiresAt: "2026-11-20T10:00:00.000Z",
      handedOverBy: null,
      handedOverAt: null,
      identityCheckedBy: null,
      identityCheckedAt: null,
      failedAttempts: 0,
      attemptsLeft: 5,
      lockedAt: null,
      revokedAt: null,
      revokeReason: null,
      usedAt: null,
    },
    account: null,
    channels: [],
    capabilities: {
      issueActivationCode: true,
      recordHandover: true,
      revokeActivationCode: true,
      providePrivacyNotice: true,
    },
  };
  const activationDetail = {
    ...detail,
    activationStatus: activation.status,
    capabilities: { ...detail.capabilities, ...activation.capabilities },
  };

  it("shows the issuer and requires explicit confirmation before replacing an open code", async () => {
    const calls = setup(
      {
        [`GET ${activationPath}`]: () => json(activation),
        [`POST ${detailPath}/activation-codes/in-person`]: () => json(activation, 201),
      },
      activationDetail,
    );
    const panel = await section("Portalaktivierung und Datenschutzhinweis");
    expect(await within(panel).findByText("Petra Projektleitung")).toBeInTheDocument();

    const send = within(panel).getByRole("button", { name: "Aktivierungslink senden" });
    await userEvent.type(
      within(panel).getByLabelText("Private E-Mail-Adresse oder Mobilnummer"),
      "erika@example.org",
    );
    await userEvent.click(
      within(panel).getByLabelText(
        "Originalen amtlichen Lichtbildausweis mit den importierten Identitätsdaten geprüft",
      ),
    );
    expect(send).toBeDisabled();
    await userEvent.click(
      within(panel).getByLabelText(
        "Bestehenden offenen Code widerrufen und bewusst neu ausstellen",
      ),
    );
    expect(send).toBeEnabled();
    await userEvent.click(send);
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/activation-codes/in-person`,
        body: {
          deliveryKind: "email",
          deliveryAddress: "erika@example.org",
          language: "de",
          identityChecked: true,
          replaceOpenCode: true,
        },
      }),
    );
  });

  it("hands over the notice in the chosen language and offers no revocation of a used code", async () => {
    const used = {
      ...activation,
      status: { ...activation.status, code: "used" },
      current: { ...activation.current, usedAt: "2026-10-22T10:00:00.000Z" },
    };
    const calls = setup(
      {
        [`GET ${activationPath}`]: () => json(used),
        [`POST ${detailPath}/privacy-notices`]: () => json({}, 201),
      },
      { ...activationDetail, activationStatus: used.status },
    );
    const panel = await section("Portalaktivierung und Datenschutzhinweis");
    expect(await within(panel).findByText("Petra Projektleitung")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Code widerrufen" })).toBeNull();
    await userEvent.selectOptions(within(panel).getByLabelText("Sprache"), "en");
    await userEvent.click(
      within(panel).getByRole("button", {
        name: "Datenschutzhinweis ausgedruckt persönlich übergeben",
      }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/privacy-notices`,
        body: { language: "en", method: "in_person_print", handedOver: true },
      }),
    );
  });
});

describe("an activated account (ADR-0007, Q123)", () => {
  it("shows how the identity was assured and the channels without any address, and no issuance", async () => {
    const activated = {
      status: { account: "activated", code: "none", issuedAt: null, expiresAt: null },
      current: null,
      account: {
        activatedAt: "2026-10-22T09:00:00.000Z",
        identityAssurance: "photo_id",
        identityAssuredAt: "2026-10-21T09:00:00.000Z",
      },
      channels: [
        {
          id: "00000000-0000-4000-a000-000000000020",
          kind: "sms",
          verifiedAt: "2026-10-22T09:00:00.000Z",
          verifiedBy: "activation_link",
          consentGivenAt: "2026-10-22T09:00:00.000Z",
          consentEndedAt: null,
          noticeSentAt: null,
          suspendedAt: null,
          removedAt: null,
        },
      ],
      capabilities: {
        issueActivationCode: true,
        recordHandover: true,
        revokeActivationCode: true,
        providePrivacyNotice: true,
      },
    };
    setup(
      { [`GET ${activationPath}`]: () => json(activated) },
      {
        ...detail,
        activationStatus: activated.status,
        capabilities: { ...detail.capabilities, ...activated.capabilities },
      },
    );
    const panel = await section("Portalaktivierung und Datenschutzhinweis");
    expect(
      await within(panel).findByText("Lichtbildausweis (kein Geburtsdatum hinterlegt)"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        /Mobilnummer \(SMS\), bestätigt am 22\.10\.2026, 11:00 über den persönlichen Aktivierungslink/,
      ),
    ).toHaveTextContent("Aktivierungsbenachrichtigung ausstehend.");
    expect(within(panel).queryByRole("button", { name: "Aktivierungslink senden" })).toBeNull();
  });

  it("issues a recovery letter after the person was verified, warns first and shows the print", async () => {
    const recovered = {
      status: { account: "activated", code: "open", issuedAt: null, expiresAt: null },
      current: null,
      account: {
        activatedAt: "2026-10-22T09:00:00.000Z",
        identityAssurance: "birth_date",
        identityAssuredAt: null,
      },
      channels: [],
      capabilities: {
        issueActivationCode: true,
        recordHandover: true,
        revokeActivationCode: true,
        providePrivacyNotice: true,
      },
    };
    const item = {
      activationCodeId: "00000000-0000-4000-a000-000000000031",
      participationId,
      firstName: "Erika",
      lastName: "Mustermann",
      address: {
        street: "Musterstraße 1",
        postalCode: "99999",
        city: "Beispielstadt",
        country: "DE",
      },
      code: "ABCD-2345-EFGH",
      activationUrl: "https://portal.example/portal/activate#ABCD2345EFGH",
      expiresAt: "2026-11-21T10:00:00.000Z",
      noticeVersion: "art14-activation:v1",
      noticeLanguage: "de",
      noticeTitle: "Datenschutzhinweise",
      noticeText: "Synthetischer Hinweistext.",
    };
    const calls = setup(
      {
        [`GET ${activationPath}`]: () =>
          json({ ...recovered, status: { ...recovered.status, code: "none" } }),
        [`POST ${detailPath}/activation-codes`]: () => json({ item, activation: recovered }, 201),
      },
      {
        ...detail,
        activationStatus: { account: "activated", code: "none", issuedAt: null, expiresAt: null },
        capabilities: { ...detail.capabilities, ...recovered.capabilities },
      },
    );
    const panel = await section("Portalaktivierung und Datenschutzhinweis");
    const recovery = await within(panel).findByRole("group", {
      name: "Zugang wiederherstellen (Zugang verloren)",
    });
    expect(within(recovery).getByText(/beendet sofort alle Sitzungen/)).toBeInTheDocument();
    const issue = within(recovery).getByRole("button", {
      name: "Wiederherstellungscode ausstellen",
    });
    expect(issue).toBeDisabled();
    await userEvent.click(
      within(recovery).getByLabelText(
        "Ich habe die Person identifiziert und die Anfrage stammt von ihr",
      ),
    );
    await userEvent.click(issue);
    expect(await screen.findByText("ABCD-2345-EFGH")).toBeInTheDocument();
    expect(calls).toContainEqual({
      key: `POST ${detailPath}/activation-codes`,
      body: {
        purpose: "recovery",
        channel: "letter",
        language: "de",
        identityVerified: true,
        replaceOpenCode: false,
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Druckansicht schließen und Codes verwerfen" }),
    );
    expect(screen.queryByText("ABCD-2345-EFGH")).toBeNull();
  });

  it("sends a recovery in person only after the photo-ID check, and shows suspended channels", async () => {
    const suspended = {
      status: { account: "activated", code: "none", issuedAt: null, expiresAt: null },
      current: null,
      account: {
        activatedAt: "2026-10-22T09:00:00.000Z",
        identityAssurance: "birth_date",
        identityAssuredAt: null,
      },
      channels: [
        {
          id: "00000000-0000-4000-a000-000000000021",
          kind: "email",
          verifiedAt: "2026-10-22T09:00:00.000Z",
          verifiedBy: "one_time_code",
          consentGivenAt: "2026-10-22T09:00:00.000Z",
          consentEndedAt: null,
          noticeSentAt: "2026-10-22T09:01:00.000Z",
          suspendedAt: "2026-10-23T09:00:00.000Z",
          removedAt: null,
        },
      ],
      capabilities: {
        issueActivationCode: true,
        recordHandover: true,
        revokeActivationCode: true,
        providePrivacyNotice: true,
      },
    };
    const calls = setup(
      {
        [`GET ${activationPath}`]: () => json(suspended),
        [`POST ${detailPath}/activation-codes`]: () =>
          json({ item: null, activation: suspended }, 201),
      },
      {
        ...detail,
        activationStatus: suspended.status,
        capabilities: { ...detail.capabilities, ...suspended.capabilities },
      },
    );
    const panel = await section("Portalaktivierung und Datenschutzhinweis");
    expect(await within(panel).findByText(/Gesperrt seit 23\.10\.2026/)).toBeInTheDocument();
    const recovery = within(panel).getByRole("group", {
      name: "Zugang wiederherstellen (Zugang verloren)",
    });
    await userEvent.click(
      within(recovery).getByLabelText(
        "Ich habe die Person identifiziert und die Anfrage stammt von ihr",
      ),
    );
    await userEvent.click(within(recovery).getByLabelText("Persönlich gesendet"));
    await userEvent.type(
      within(recovery).getByLabelText("Private E-Mail-Adresse oder Mobilnummer"),
      "neu@example.org",
    );
    const issue = within(recovery).getByRole("button", {
      name: "Wiederherstellungscode ausstellen",
    });
    expect(issue).toBeDisabled();
    await userEvent.click(
      within(recovery).getByLabelText(
        "Originalen amtlichen Lichtbildausweis mit den importierten Identitätsdaten geprüft",
      ),
    );
    await userEvent.click(issue);
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/activation-codes`,
        body: {
          purpose: "recovery",
          channel: "in_person",
          language: "de",
          identityVerified: true,
          replaceOpenCode: false,
          identityChecked: true,
          deliveryKind: "email",
          deliveryAddress: "neu@example.org",
        },
      }),
    );
  });
});

describe("the participant's consultants (Q62)", () => {
  const assigned = {
    staffUserId: consultant.id,
    displayName: consultant.displayName,
    assignedAt: "2026-10-20T08:00:00.000000Z",
  };

  it("lists them and lets the PL end an assignment", async () => {
    const calls = setup(
      {
        [`DELETE ${detailPath}/assignments/${consultant.id}`]: () =>
          new Response(null, { status: 204 }),
      },
      { ...detail, assignments: [assigned] },
    );
    const consultants = await section("Zuständige Beratung");
    expect(within(consultants).getByRole("cell", { name: "Bernd Beratung" })).toBeInTheDocument();
    await userEvent.click(
      within(consultants).getByRole("button", { name: "Zuweisung von Bernd Beratung aufheben" }),
    );
    await waitFor(() =>
      expect(calls.map((c) => c.key)).toContain(
        `DELETE ${detailPath}/assignments/${consultant.id}`,
      ),
    );
  });

  it("assigns a consultant of the project", async () => {
    const calls = setup({ [`POST ${projectPath}/assignments`]: () => json({ assigned: 1 }) });
    const consultants = await section("Zuständige Beratung");
    expect(within(consultants).getByText("Niemandem zugewiesen.")).toBeInTheDocument();
    await userEvent.selectOptions(
      within(consultants).getByLabelText("Beraterin oder Berater"),
      consultant.id,
    );
    await userEvent.click(within(consultants).getByRole("button", { name: "Zuweisen" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${projectPath}/assignments`,
        body: { staffUserId: consultant.id, participationIds: [participationId] },
      }),
    );
  });

  it("shows them read-only without the capability", async () => {
    setup(
      {},
      {
        ...detail,
        assignments: [assigned],
        capabilities: { ...detail.capabilities, assignParticipations: false },
      },
    );
    const consultants = await section("Zuständige Beratung");
    expect(within(consultants).getByRole("cell", { name: "Bernd Beratung" })).toBeInTheDocument();
    expect(within(consultants).queryByRole("button")).toBeNull();
  });
});

/** The placement Agentur combobox of the participant page. */
const field = async () =>
  within(await section("Vermittlungs-Agentur")).findByRole("combobox", {
    name: "Vermittlungs-Agentur festlegen",
  });

describe("the participant's placement Agentur (Q139)", () => {
  const choices = [
    {
      agenturKey: "beispielstadt-nord",
      label: { de: "Agentur Nord (Beispiel)" },
      pinnedVersion: 1,
      latestVersion: 2,
    },
    {
      agenturKey: "beispielstadt-sued",
      label: { de: "Agentur Süd (Beispiel)" },
      pinnedVersion: null,
      latestVersion: 1,
    },
  ];
  const settable = {
    ...detail,
    placementAgenturChoices: choices,
    capabilities: { ...detail.capabilities, setPlacementAgentur: true },
  };
  const placed = (agenturKey: string) => ({
    ...settable,
    placementAgenturKey: agenturKey,
    placementAgenturSetAt: "2026-10-21T09:00:00.000000Z",
  });
  const put = `PUT ${detailPath}/placement-agentur`;

  it("shows the current Agentur read-only without the capability, and a blocked submission", async () => {
    setup(
      {},
      {
        ...placed("beispielstadt-nord"),
        placementAgenturChoices: [],
        capabilities: detail.capabilities,
        submissionBlockers: [
          {
            code: "agentur_submission_blocked",
            step: "agentur_submission",
            agenturKey: "beispielstadt-nord",
            missing: ["submissionChannel"],
          },
        ],
      },
    );
    const shown = await section("Vermittlungs-Agentur");
    expect(within(shown).getByText("beispielstadt-nord")).toBeInTheDocument();
    expect(
      within(shown).getByText(/Übermittlung an die Agentur ist blockiert/),
    ).toBeInTheDocument();
    expect(within(shown).queryByRole("combobox")).toBeNull();
  });

  it("chooses a catalog Agentur, says which version will be pinned, and saves it", async () => {
    const calls = setup({ [put]: () => json(placed("beispielstadt-sued")) }, settable);
    expect(
      within(await section("Vermittlungs-Agentur")).getByText("Noch nicht festgelegt"),
    ).toBeInTheDocument();
    await userEvent.click(await field());
    await userEvent.click(
      await screen.findByRole("option", { name: "Agentur Süd (Beispiel) (beispielstadt-sued)" }),
    );
    expect(
      screen.getByText("Die Vorlage wird mit Version 1 im Projekt hinterlegt."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Vermittlungs-Agentur speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ key: put, body: { agenturKey: "beispielstadt-sued" } }),
    );
    expect(
      await within(await section("Vermittlungs-Agentur")).findByText(
        "Agentur Süd (Beispiel) (beispielstadt-sued)",
      ),
    ).toBeInTheDocument();
  });

  it("names the project's pinned version for a pinned Agentur", async () => {
    setup({}, settable);
    await userEvent.click(await field());
    await userEvent.click(
      await screen.findByRole("option", { name: "Agentur Nord (Beispiel) (beispielstadt-nord)" }),
    );
    expect(
      screen.getByText("Die im Projekt hinterlegte Vorlage (Version 1) gilt."),
    ).toBeInTheDocument();
  });

  it("takes a free key without a template, and refuses a malformed one", async () => {
    const calls = setup({ [put]: () => json(placed("ohne-vorlage")) }, settable);
    const input = await field();
    await userEvent.type(input, "Ohne Vorlage");
    expect(screen.getByText(/Kleinbuchstaben, Ziffern/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vermittlungs-Agentur speichern" })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "ohne-vorlage");
    expect(
      screen.getByText(/keine Vorlage: Die Übermittlung an die Agentur bleibt blockiert/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Vermittlungs-Agentur speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ key: put, body: { agenturKey: "ohne-vorlage" } }),
    );
  });

  it("shows the API's refusal by its code", async () => {
    setup(
      {
        [put]: () =>
          problem(422, "domain-error", {
            errors: [{ pointer: "", code: "override_invalid", detail: "Refused by a domain rule" }],
          }),
      },
      settable,
    );
    await userEvent.click(await field());
    await userEvent.click(
      await screen.findByRole("option", { name: "Agentur Süd (Beispiel) (beispielstadt-sued)" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Vermittlungs-Agentur speichern" }));
    expect(
      await screen.findByText(/Projektkonfiguration ungültig. Es wurde nichts gespeichert./),
    ).toBeInTheDocument();
  });
});
