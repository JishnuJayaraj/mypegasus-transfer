import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyAssessment } from "@transfer/domain";
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

// The tab "Profiling" (process-and-lifecycle.md and data-protection.md, the profiling record):
// the track's steps by capability, the sessions, the profiler's blocks loaded on "Anzeigen" from
// their logged routes, the health line with its rating only. Synthetic data only.
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const sessionId = "00000000-0000-4000-a000-0000000000c1";

const detail = (viewProfiling: boolean) => ({
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
    startAssistedMode: true,
    viewProfiling,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
});

const session = {
  id: sessionId,
  date: "2026-10-20",
  from: "09:00",
  to: "10:30",
  recordedAt: "2026-10-20T11:00:00.000000Z",
};

/** The tab's view: the PL's (`profiler: false`) or the assigned consultant's. */
const view = (profiler: boolean) => ({
  participationId,
  profilingStatus: "profiling_accepted",
  statusVersion: 3,
  profilingDoneOn: null,
  revision: 2,
  sessions: [session],
  ...(profiler && {
    declarations: { jobboerseChoice: null, baContactConsent: null, recordedAt: null },
    assessment: {
      revision: 1,
      recorded: ["profilingAssessment.schoolQualification", "profilingHealthAssessment"],
      writtenAt: "2026-10-20T11:00:00.000000Z",
    },
    unemploymentPeriodRecorded: true,
  }),
  transitions: [
    { to: "profiling_in_progress", allowed: true, refusal: null },
    { to: "profiling_declined", allowed: true, refusal: null },
  ],
  capabilities: { record: profiler, assessment: profiler, readUnemploymentPeriod: profiler },
});

const selfService = {
  participationId,
  revision: 4,
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

const SECRET = "Synthetischer Handlungsbedarf";
const assessment = {
  participationId,
  revision: 1,
  values: {
    ...emptyAssessment(),
    schoolQualification: { rating: "placement_relevant", text: SECRET },
    health: { rating: "no_need" },
  },
};

function setup(options: { profiler: boolean; viewProfiling?: boolean }) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail(options.viewProfiling ?? true)),
    [`GET ${detailPath}/self-service`]: () => json(selfService),
    [`GET ${detailPath}/profiling`]: () => json(view(options.profiler)),
    [`POST ${detailPath}/profiling-status`]: () =>
      json({ ...view(options.profiler), profilingStatus: "profiling_in_progress" }),
    [`PUT ${detailPath}/profiling/sessions`]: ({ body }) => {
      const { sessions } = body as { sessions: { date: string }[] };
      return sessions.some((s) => s.date > "2026-12-31")
        ? problem(422, "domain-error", {
            errors: [{ pointer: "/sessions/1/date", code: "session_in_future", detail: "x" }],
          })
        : json(view(options.profiler));
    },
    [`GET ${detailPath}/profiling/assessment`]: () => json(assessment),
    [`PUT ${detailPath}/profiling/assessment`]: () => json(view(options.profiler)),
    [`GET ${detailPath}/profiling/unemployment`]: () =>
      json({ participationId, period: { from: "2025-11-01", until: null } }),
    [`PUT ${detailPath}/profiling/declarations`]: () => json(view(options.profiler)),
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=profiling`, mock.api);
  return mock;
}

const callTo = (calls: { key: string; body: unknown }[], key: string) =>
  calls.filter((call) => call.key === key);

describe("the tab 'Profiling'", () => {
  it("shows the PL the status, the steps and the sessions, never the profiler's blocks", async () => {
    const { calls } = setup({ profiler: false });
    expect(await screen.findByRole("heading", { name: "Profiling-Status" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Profiling begonnen" })).toBeVisible();
    const sessions = screen.getByRole("table", { name: "Termine des Profilings" });
    expect(within(sessions).getByText("20.10.2026")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Handlungsbedarf (Abschnitt C)" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Arbeitslos seit / bis" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Erklärungen gegenüber der BA (vorgesehen)" }),
    ).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Im assistierten Modus ergänzen" }),
    ).toBeVisible();
    expect(callTo(calls, `GET ${detailPath}/profiling/assessment`)).toEqual([]);
  });

  it("has no tab without the capability (back office)", async () => {
    setup({ profiler: false, viewProfiling: false });
    expect(await screen.findByRole("tab", { name: "Selbstauskunft" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Profiling" })).toBeNull();
  });

  it("takes a step with the status version, a refusal only after the confirmation", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ profiler: false });
    await user.click(await screen.findByRole("button", { name: "Profiling begonnen" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/profiling-status`)[0]?.body).toEqual({
        to: "profiling_in_progress",
        statusVersion: 3,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Abgelehnt" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Ablehnung des Profilings erfassen",
    });
    expect(within(dialog).getByText(/Transfer-Kurzarbeitergeld/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Ablehnung erfassen" }));
    await waitFor(() =>
      expect(callTo(calls, `POST ${detailPath}/profiling-status`)[1]?.body).toMatchObject({
        to: "profiling_declined",
      }),
    );
  });

  it("writes the sessions whole and shows a refusal at its row", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ profiler: true });
    await user.click(await screen.findByRole("button", { name: "Termin hinzufügen" }));
    const row = screen.getByRole("group", { name: "Termin 2" });
    await user.type(within(row).getByLabelText("Datum"), "15.01.2099");
    await user.type(within(row).getByLabelText("von"), "13:00");
    await user.type(within(row).getByLabelText("bis"), "14:00");
    await user.click(screen.getByRole("button", { name: "Termine speichern" }));
    expect(
      await within(row).findByText("Ein Termin darf nicht in der Zukunft liegen."),
    ).toBeVisible();
    expect(callTo(calls, `PUT ${detailPath}/profiling/sessions`)[0]?.body).toEqual({
      revision: 2,
      sessions: [
        { id: sessionId, date: "2026-10-20", from: "09:00", to: "10:30" },
        { date: "2099-01-15", from: "13:00", to: "14:00" },
      ],
    });
  });

  it("loads section C only on 'Anzeigen', the health line with its rating only", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ profiler: true });
    const section = within(
      (await screen.findByRole("heading", { name: "Handlungsbedarf (Abschnitt C)" })).closest(
        "section",
      )!,
    );
    expect(section.getByText("2 von 16 Angaben erfasst")).toBeVisible();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    await user.click(section.getByRole("button", { name: /Anzeigen/ }));
    expect(await section.findByDisplayValue(SECRET)).toBeVisible();
    expect(section.getByText(/nur die Einstufung erfasst/)).toBeVisible();
    expect(
      section.queryByLabelText(
        "Vermittlungsrelevante gesundheitliche Einschränkungen: Handlungsbedarf (Text)",
      ),
    ).toBeNull();
    await user.click(section.getByRole("button", { name: "Einschätzung speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/profiling/assessment`)[0]?.body).toEqual({
        revision: 1,
        values: assessment.values,
      }),
    );
    // Hidden again, the values are gone from the page.
    await user.click(section.getByRole("button", { name: /Ausblenden/ }));
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });

  it("shows the unemployment period on 'Anzeigen' and records the pending declarations", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ profiler: true });
    const unemployment = within(
      (await screen.findByRole("heading", { name: "Arbeitslos seit / bis" })).closest("section")!,
    );
    expect(unemployment.getByText("angegeben")).toBeVisible();
    await user.click(unemployment.getByRole("button", { name: /Anzeigen/ }));
    expect(await unemployment.findByDisplayValue("01.11.2025")).toBeVisible();

    await user.selectOptions(
      screen.getByLabelText("Veröffentlichung in der Jobbörse (Feld 50)"),
      "anonymous_callme",
    );
    await user.click(screen.getByRole("radio", { name: "nein" }));
    await user.click(screen.getByRole("button", { name: "Erklärungen speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/profiling/declarations`)[0]?.body).toEqual({
        revision: 2,
        jobboerseChoice: "anonymous_callme",
        baContactConsent: false,
      }),
    );
  });
});
