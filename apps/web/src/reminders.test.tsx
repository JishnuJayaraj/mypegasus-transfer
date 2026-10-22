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
  worklist,
  worklistItem,
} from "./test-utils";

// Reminders in the staff app (data-protection.md, reminders): "Erinnern" with the counts from the
// rows' capabilities, the fixed text as a preview and the result per code; the column "Erinnert";
// the tab "Nachrichten". Synthetic rows only.
const projectPath = `/api/v1/projects/${project.id}`;
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const remind = (allowed: boolean, code: string | null, channel: string | null = null) => ({
  capabilities: { remind: { allowed, code, channel } },
});
const open = [{ kind: "field", key: "mobile", state: "missing" }];
const rows = [
  worklistItem({
    id: id(1),
    personnelNumber: "BSP-0001",
    actions: open,
    ...remind(true, null, "email"),
  }),
  worklistItem({
    id: id(2),
    personnelNumber: "BSP-0002",
    actions: open,
    ...remind(true, null, "email"),
  }),
  worklistItem({
    id: id(3),
    personnelNumber: "BSP-0003",
    actions: open,
    ...remind(true, null, "sms"),
  }),
  worklistItem({
    id: id(4),
    personnelNumber: "BSP-0004",
    actions: open,
    reminder: { lastRequestedOn: "2026-10-20", status: "sent" },
    ...remind(false, "reminded_recently"),
  }),
  worklistItem({
    id: id(5),
    personnelNumber: "BSP-0005",
    actions: open,
    ...remind(false, "no_channel"),
  }),
  worklistItem({
    id: id(6),
    personnelNumber: "BSP-0006",
    actions: open,
    ...remind(false, "consent_required"),
  }),
  worklistItem({ id: id(7), personnelNumber: "BSP-0007", ...remind(false, "nothing_open") }),
];

function setup(items: object[], routes: Parameters<typeof mockApi>[0] = {}) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`GET ${projectPath}/worklist`]: () => json(worklist(items)),
    ...routes,
  });
  return { ...mock, ...renderApp(`/projects/${project.id}?tab=participants`, mock.api) };
}

describe("'Erinnern' in the work list", () => {
  it("counts the selected rows by channel and code, previews the fixed text and sends", async () => {
    const user = userEvent.setup();
    const { calls } = setup(rows, {
      [`POST ${projectPath}/reminders`]: () =>
        json(
          {
            batchId: "00000000-0000-4000-c000-000000000001",
            queued: [
              { participationId: id(1), channel: "email" },
              { participationId: id(2), channel: "email" },
              { participationId: id(3), channel: "sms" },
            ],
            skipped: [
              { participationId: id(4), code: "reminded_recently" },
              { participationId: id(5), code: "no_channel" },
              { participationId: id(6), code: "consent_required" },
            ],
          },
          201,
        ),
    });
    await user.click(await screen.findByRole("button", { name: "Alle Treffer auswählen" }));
    await user.click(screen.getByRole("button", { name: "Erinnern (7)" }));
    const dialog = await screen.findByRole("dialog");
    const counts = within(dialog).getByRole("list", { name: "Ausgewählte Teilnehmende" });
    expect(
      within(counts)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "2 per E-Mail",
      "1 per SMS",
      "1 kürzlich erinnert (wieder ab 23.10.2026)",
      "2 ohne Kontaktweg: Kein für Erinnerungen nutzbarer Kontaktweg.",
      "1 nichts offen",
    ]);
    expect(
      within(dialog).getByText("Im Teilnehmerportal ist noch etwas offen"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "In Ihrem Teilnehmerportal ist noch etwas offen. Bitte melden Sie sich an und prüfen Sie Ihre Angaben oder Unterlagen: [Adresse des Teilnehmerportals]",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Senden" }));
    expect(
      await within(dialog).findByText("3 Erinnerungen werden gesendet (2 per E-Mail, 1 per SMS)."),
    ).toBeInTheDocument();
    const result = within(dialog)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(result).toEqual([
      "1: kürzlich erinnert",
      "2: Kein für Erinnerungen nutzbarer Kontaktweg.",
    ]);
    const sent = calls.find((call) => call.key === `POST ${projectPath}/reminders`)!;
    expect(sent.body).toEqual({ kind: "open_items", participationIds: rows.map((r) => r.id) });
  });

  it("isn't offered to a viewer who may not remind any row", async () => {
    setup([worklistItem({ id: id(1), actions: open })]);
    expect(await screen.findByText("BSP-0001")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Erinnern/ })).not.toBeInTheDocument();
  });

  it("shows the latest reminder in the column 'Erinnert'", async () => {
    setup(rows);
    const row = (await screen.findByText("BSP-0004")).closest("tr")!;
    expect(within(row).getByText("20.10.2026 (gesendet)")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Erinnert" })).toBeInTheDocument();
  });

  it("says nothing was sent when the service is unavailable", async () => {
    const user = userEvent.setup();
    setup(rows.slice(0, 1), {
      [`POST ${projectPath}/reminders`]: () =>
        problem(503, "service-unavailable", {
          errors: [{ pointer: "", code: "delivery_unavailable", detail: "x" }],
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Alle Treffer auswählen" }));
    await user.click(screen.getByRole("button", { name: "Erinnern (1)" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Senden" }),
    );
    expect(
      await screen.findByText(
        "Erinnerungen können derzeit nicht versendet werden. Es wurde nichts gesendet.",
      ),
    ).toBeInTheDocument();
  });
});

const participationId = id(1);
const detailPath = `/api/v1/participations/${participationId}`;
const detail = {
  id: participationId,
  projectId: project.id,
  status: "contacted",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  statusVersion: 1,
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
const record = (n: number, overrides: object = {}) => ({
  id: `00000000-0000-4000-e000-${String(n).padStart(12, "0")}`,
  kind: "open_items",
  messageVersion: "portal-reminder:v1",
  language: "de",
  channel: "email",
  requestedAt: "2026-10-22T08:15:00.000000Z",
  requestedOn: "2026-10-22",
  status: "sent",
  cancelReason: null,
  outcomeAt: "2026-10-22T08:15:02.000000Z",
  ...overrides,
});

function detailSetup(reminders: Parameters<typeof mockApi>[0][string]) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail),
    [`GET ${detailPath}/reminders`]: reminders,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=messages`, mock.api);
  return mock;
}

describe("the tab 'Nachrichten'", () => {
  it("lists when, what, the channel and the state, sent by 'Team', and loads more", async () => {
    const user = userEvent.setup();
    detailSetup(({ query }) =>
      query.get("cursor") === "b3BhcXVl"
        ? json({
            items: [
              record(2, {
                channel: "sms",
                requestedAt: "2026-10-18T08:15:00.000000Z",
                status: "cancelled",
                cancelReason: "consent_ended",
              }),
            ],
            nextCursor: null,
          })
        : json({ items: [record(1)], nextCursor: "b3BhcXVl" }),
    );
    expect(
      await screen.findByRole("tab", { name: "Nachrichten", selected: true }),
    ).toBeInTheDocument();
    for (const header of ["Zeitpunkt", "Nachricht", "Kanal", "Status", "Durch"]) {
      expect(await screen.findByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const first = (await screen.findByText("22.10.2026, 10:15")).closest("tr")!;
    expect(within(first).getByText("Erinnerung an offene Punkte")).toBeInTheDocument();
    expect(within(first).getByText("E-Mail")).toBeInTheDocument();
    expect(within(first).getByText("gesendet")).toBeInTheDocument();
    expect(within(first).getByText("Team")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mehr laden" }));
    const second = (await screen.findByText("SMS")).closest("tr")!;
    expect(within(second).getByText("nicht gesendet: Einwilligung beendet")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument(),
    );
  });

  it("says when the viewer may not read the messages", async () => {
    detailSetup(() => problem(403, "forbidden"));
    expect(
      await screen.findByText("Sie dürfen die Nachrichten dieser Person nicht sehen."),
    ).toBeInTheDocument();
  });
});
