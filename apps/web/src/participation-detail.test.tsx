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

// Slice 2 plan, "Planned in PR 2h" (PR 2h-1): a participant's page and the PL's wave choice.
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
