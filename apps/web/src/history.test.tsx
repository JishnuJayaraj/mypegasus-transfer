import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryEventType } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import de from "./locales/de/translation.json";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
} from "./test-utils";

// The tab "Verlauf" (data-protection.md, audit metadata; Q157): every event type's label, the
// actor kinds, "Ehemaliges Teammitglied", "Mehr laden" with the opaque cursor. Synthetic rows only.
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const w1 = "00000000-0000-4000-b000-000000000001";
const w2 = "00000000-0000-4000-b000-000000000002";
const wave = (id: string, code: string) => ({
  id,
  projectId: project.id,
  code,
  name: `Welle ${code}`,
  signingDeadline: "2091-02-15",
  defaultTgStart: "2091-03-01",
  defaultTgEnd: "2092-02-29",
  latestEntryDate: "2091-03-15",
  participations: 1,
  createdAt: "2026-10-15T08:30:00.123456Z",
  updatedAt: "2026-10-15T08:30:00.123456Z",
});
const detail = {
  id: participationId,
  projectId: project.id,
  status: "informed",
  profilingStatus: "not_started",
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
  person: { personnelNumber: "BSP-0001", lastName: "Mustermann", firstName: "Erika" },
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
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
};

const staff = (name: string | null, assisted = false) => ({
  kind: "staff",
  name,
  assisted,
  job: null,
});
const entry = (overrides: object) => ({
  occurredAt: "2026-10-22T08:15:00.000000Z",
  type: "participation_created",
  actor: staff("Petra Projektleitung"),
  change: null,
  reasonCode: null,
  effectiveDate: null,
  details: {},
  ...overrides,
});

function setup(history: Parameters<typeof mockApi>[0][string]) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () =>
      json({ items: [wave(w1, "W1"), wave(w2, "W2")], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail),
    [`GET ${detailPath}/history`]: history,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=history`, mock.api);
  return mock;
}

const rowOf = async (text: string) => (await screen.findByText(text)).closest("tr")!;

describe("the tab 'Verlauf'", () => {
  it("has a German label for every event type a history can show", () => {
    for (const type of HistoryEventType.options) {
      expect(de.history.events[type]).toMatch(/\S/);
    }
    expect(Object.keys(de.history.events).toSorted()).toEqual(
      [...HistoryEventType.options].toSorted(),
    );
  });

  it("labels every event type in the table", async () => {
    setup(() =>
      json({
        items: HistoryEventType.options.map((type) => entry({ type })),
        nextCursor: null,
      }),
    );
    const table = (await screen.findByText("Teilnahme angelegt")).closest("table")!;
    for (const type of HistoryEventType.options) {
      expect(within(table).getAllByText(de.history.events[type]).length).toBeGreaterThan(0);
    }
  });

  it("shows when, what, the change, the reason, the date and who, newest first", async () => {
    setup(() =>
      json({
        items: [
          entry({
            occurredAt: "2026-10-22T09:00:00.000000Z",
            type: "status_changed",
            change: { field: "status", from: "informed", to: "withdrawn" },
            reasonCode: "declined_dsv",
            effectiveDate: "2026-10-21",
          }),
          entry({
            occurredAt: "2026-10-22T08:30:00.000000Z",
            type: "entry_wave_assigned",
            actor: staff(null),
            details: { waveId: w2, previousWaveId: w1 },
          }),
          entry({
            occurredAt: "2026-10-22T08:20:00.000000Z",
            type: "reminder_delivery",
            actor: { kind: "system", name: null, assisted: false, job: "reminders.send" },
            reasonCode: "nothing_open",
            details: { outcome: "cancelled" },
          }),
          entry({
            occurredAt: "2026-10-22T08:10:00.000000Z",
            type: "participant_data_changed",
            actor: staff("Bernd Beratung", true),
            details: { fields: ["lastName", "mobile"] },
          }),
          entry({
            occurredAt: "2026-10-22T08:05:00.000000Z",
            type: "consent_given",
            actor: { kind: "participant", name: null, assisted: false, job: null },
            details: { purpose: "portal_contact", textVersion: "portal-contact-consent:v2" },
          }),
        ],
        nextCursor: null,
      }),
    );
    expect(await screen.findByRole("tab", { name: "Verlauf", selected: true })).toBeInTheDocument();
    for (const header of ["Zeitpunkt", "Ereignis", "Änderung", "Grund", "Wirksam am", "Durch"]) {
      expect(await screen.findByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const status = await rowOf("22.10.2026, 11:00");
    expect(within(status).getByText("Status geändert")).toBeInTheDocument();
    expect(within(status).getByText("Informiert → Ausgeschieden")).toBeInTheDocument();
    expect(within(status).getByText("DSV abgelehnt")).toBeInTheDocument();
    expect(within(status).getByText("21.10.2026")).toBeInTheDocument();
    expect(within(status).getByText("Petra Projektleitung")).toBeInTheDocument();
    const assigned = await rowOf("Eintrittswelle zugewiesen");
    expect(within(assigned).getByText("W1 → W2")).toBeInTheDocument();
    expect(within(assigned).getByText("Ehemaliges Teammitglied")).toBeInTheDocument();
    const delivery = await rowOf("Erinnerung abgeschlossen");
    expect(within(delivery).getByText("nicht gesendet")).toBeInTheDocument();
    expect(within(delivery).getByText("Nichts mehr offen")).toBeInTheDocument();
    expect(within(delivery).getByText("System")).toBeInTheDocument();
    const data = await rowOf("Personendaten geändert");
    expect(within(data).getByText("Nachname, Mobilnummer")).toBeInTheDocument();
    expect(within(data).getByText("Bernd Beratung (assistiert)")).toBeInTheDocument();
    const consent = await rowOf("Einwilligung erteilt");
    expect(within(consent).getByText("Teilnehmer·in")).toBeInTheDocument();
  });

  it("loads more with the opaque cursor", async () => {
    const user = userEvent.setup();
    const mock = setup(({ query }) =>
      query.get("cursor") === "b3BhcXVl"
        ? json({ items: [entry({ type: "participant_assigned" })], nextCursor: null })
        : json({
            items: [
              entry({
                type: "reminder_queued",
                details: { kind: "open_items", channelKind: "sms" },
              }),
            ],
            nextCursor: "b3BhcXVl",
          }),
    );
    const queued = await rowOf("Erinnerung angefordert");
    expect(within(queued).getByText("SMS")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mehr laden" }));
    expect(await screen.findByText("Beratung zugewiesen")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument(),
    );
    expect(mock.calls.filter((call) => call.key === `GET ${detailPath}/history`)).toHaveLength(2);
  });

  it("isn't loaded before the tab is shown", async () => {
    const mock = mockApi({
      "GET /api/v1/me": () => json(staffUsers[1]),
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      [`GET ${projectPath}`]: () => json(project),
      [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
      [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
      [`GET ${detailPath}`]: () => json(detail),
    });
    renderApp(`/projects/${project.id}/participations/${participationId}`, mock.api);
    expect(await screen.findByRole("tab", { name: "Verlauf" })).toBeInTheDocument();
    expect(mock.calls.some((call) => call.key === `GET ${detailPath}/history`)).toBe(false);
  });

  it("says when the viewer may not see the history", async () => {
    setup(() => problem(403, "forbidden"));
    expect(
      await screen.findByText("Sie dürfen den Verlauf dieser Person nicht sehen."),
    ).toBeInTheDocument();
  });

  it("says when the history couldn't be loaded", async () => {
    setup(() => problem(500, "internal-error"));
    expect(await screen.findByText("Der Verlauf konnte nicht geladen werden.")).toBeInTheDocument();
  });
});
