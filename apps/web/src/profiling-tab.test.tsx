import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyAssessment } from "@transfer/domain";
import { describe, expect, it, vi } from "vitest";
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

type Choice = "full" | "anonymous_callme" | "anonymous_no_contact" | "none" | null;

/** The tab's view: the PL's (`profiler: false`) or the assigned consultant's. */
type GeneratedForm = {
  documentId: string;
  formVersion: string;
  generatedAt: string;
  anlage: boolean;
  latest: boolean;
  versionInUse: boolean;
  capabilities: { open: boolean };
};

const view = (
  profiler: boolean,
  options: {
    revision?: number;
    jobboerseChoice?: Choice;
    closed?: boolean;
    tl407?: boolean;
    tl407Forms?: GeneratedForm[];
  } = {},
) => ({
  participationId,
  profilingStatus: "profiling_accepted",
  statusVersion: 3,
  profilingDoneOn: null,
  closed: options.closed ?? false,
  revision: options.revision ?? 2,
  sessions: [session],
  ...(profiler && {
    declarations: {
      jobboerseChoice: options.jobboerseChoice ?? null,
      baContactConsent: null,
      recordedAt: null,
    },
    assessment: {
      revision: 1,
      recorded: ["profilingAssessment.schoolQualification", "profilingHealthAssessment"],
      writtenAt: "2026-10-20T11:00:00.000000Z",
    },
    unemploymentPeriodRecorded: true,
  }),
  tl407Forms: options.tl407Forms ?? [],
  transitions: options.closed
    ? [{ to: "profiling_in_progress", allowed: false, refusal: "track_inactive" }]
    : [
        { to: "profiling_in_progress", allowed: true, refusal: null },
        { to: "profiling_declined", allowed: true, refusal: null },
      ],
  capabilities: {
    record: profiler && !options.closed,
    readAssessment: profiler,
    writeAssessment: profiler && !options.closed,
    readUnemploymentPeriod: profiler,
    generateTl407: (options.tl407 ?? false) && profiler && !options.closed,
    readTl407Readiness: options.tl407 ?? false,
  },
});

/** A write's answer: its own revision, its warnings and the record as read after it. */
const written = (
  profiling: ReturnType<typeof view>,
  warnings: string[] = [],
  revision = profiling.revision,
) => json({ revision, warnings, profiling });

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

type Routes = Parameters<typeof mockApi>[0];

function setup(options: {
  profiler: boolean;
  viewProfiling?: boolean;
  closed?: boolean;
  tl407?: boolean;
  tl407Forms?: GeneratedForm[];
  routes?: Routes;
}) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail(options.viewProfiling ?? true)),
    [`GET ${detailPath}/self-service`]: () => json(selfService),
    [`GET ${detailPath}/profiling`]: () =>
      json(
        view(options.profiler, {
          closed: options.closed,
          tl407: options.tl407,
          tl407Forms: options.tl407Forms,
        }),
      ),
    [`POST ${detailPath}/profiling-status`]: () =>
      json({ ...view(options.profiler), profilingStatus: "profiling_in_progress" }),
    [`PUT ${detailPath}/profiling/sessions`]: ({ body }) => {
      const { sessions } = body as { sessions: { date: string }[] };
      if (sessions.length === 0) return problem(409, "conflict");
      return sessions.some((s) => s.date > "2026-12-31")
        ? problem(422, "domain-error", {
            errors: [{ pointer: "/sessions/1/date", code: "session_in_future", detail: "x" }],
          })
        : written(view(options.profiler, { revision: 3 }));
    },
    [`GET ${detailPath}/profiling/assessment`]: () => json(assessment),
    [`PUT ${detailPath}/profiling/assessment`]: () => written(view(options.profiler), [], 2),
    [`GET ${detailPath}/profiling/unemployment`]: () =>
      json({ participationId, revision: 1, period: { from: "2025-11-01", until: null } }),
    [`PUT ${detailPath}/profiling/unemployment`]: () => written(view(options.profiler)),
    [`PUT ${detailPath}/profiling/declarations`]: () => written(view(options.profiler)),
    ...options.routes,
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

  it("says so and reloads when the record changed meanwhile (409)", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ profiler: true });
    await user.click(await screen.findByRole("button", { name: "Termin 1 entfernen" }));
    await user.click(screen.getByRole("button", { name: "Termine speichern" }));
    expect(await screen.findByText(/inzwischen geändert/)).toBeVisible();
    await waitFor(() => expect(callTo(calls, `GET ${detailPath}/profiling`).length).toBe(2));
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

  it("keeps an unsaved declaration across a session save and sends the new revision", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ profiler: true });
    const jobboerse = await screen.findByLabelText("Veröffentlichung in der Jobbörse (Feld 50)");
    await user.selectOptions(jobboerse, "full");
    await user.click(screen.getByRole("button", { name: "Termine speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/profiling/sessions`)).toHaveLength(1),
    );
    // The session save answered with revision 3 and unchanged declarations: the draft stays.
    await waitFor(() => expect(jobboerse).toHaveValue("full"));
    expect(screen.queryByText(/an anderer Stelle gespeichert/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Erklärungen speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/profiling/declarations`)[0]?.body).toEqual({
        revision: 3,
        jobboerseChoice: "full",
        baContactConsent: null,
      }),
    );
  });

  it("shows a conflict when the stored declarations changed under a draft, kept until 'Neu laden'", async () => {
    const user = userEvent.setup();
    // The server's record: another tab stores "none" (revision 4) before this tab's session save.
    let stored = view(true);
    const { calls } = setup({
      profiler: true,
      routes: {
        [`GET ${detailPath}/profiling`]: () => json(stored),
        [`PUT ${detailPath}/profiling/sessions`]: () => {
          stored = view(true, { revision: 4, jobboerseChoice: "none" });
          return written(stored);
        },
        [`PUT ${detailPath}/profiling/declarations`]: ({ body }) =>
          (body as { revision: number }).revision === stored.revision
            ? written(stored)
            : problem(409, "conflict"),
      },
    });
    const jobboerse = await screen.findByLabelText("Veröffentlichung in der Jobbörse (Feld 50)");
    await user.selectOptions(jobboerse, "full");
    await user.click(screen.getByRole("button", { name: "Termine speichern" }));
    expect(await screen.findByText(/an anderer Stelle gespeichert/)).toBeVisible();
    expect(jobboerse).toHaveValue("full");
    // A save goes with the draft's own revision: refused, the draft stays.
    await user.click(screen.getByRole("button", { name: "Erklärungen speichern" }));
    expect(await screen.findByText(/Das Profiling wurde inzwischen geändert/)).toBeVisible();
    expect(callTo(calls, `PUT ${detailPath}/profiling/declarations`)[0]?.body).toMatchObject({
      revision: 2,
    });
    expect(jobboerse).toHaveValue("full");
    await user.click(screen.getByRole("button", { name: "Neu laden" }));
    expect(jobboerse).toHaveValue("none");
    expect(screen.queryByText(/an anderer Stelle gespeichert/)).toBeNull();
  });

  it("keeps section C's input on 409 and sends the save's own revision next", async () => {
    const user = userEvent.setup();
    let refuse = false;
    const { calls } = setup({
      profiler: true,
      routes: {
        [`PUT ${detailPath}/profiling/assessment`]: () =>
          refuse ? problem(409, "conflict") : written(view(true), [], 2),
      },
    });
    const section = within(
      (await screen.findByRole("heading", { name: "Handlungsbedarf (Abschnitt C)" })).closest(
        "section",
      )!,
    );
    await user.click(section.getByRole("button", { name: /Anzeigen/ }));
    const text = await section.findByDisplayValue(SECRET);
    await user.click(section.getByRole("button", { name: "Einschätzung speichern" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/profiling/assessment`)).toHaveLength(1),
    );
    refuse = true;
    await user.type(text, " ergänzt");
    await user.click(section.getByRole("button", { name: "Einschätzung speichern" }));
    expect(await section.findByText(/Einschätzung wurde inzwischen/)).toBeVisible();
    expect(text).toHaveValue(`${SECRET} ergänzt`);
    expect(callTo(calls, `PUT ${detailPath}/profiling/assessment`)[1]?.body).toMatchObject({
      revision: 2,
    });
  });

  it("shows a closed participation read-only", async () => {
    const user = userEvent.setup();
    setup({ profiler: true, closed: true });
    expect(await screen.findByText(/Die Teilnahme ist beendet/)).toBeVisible();
    expect(screen.queryByText(/erst geändert werden, wenn die Person informiert ist/)).toBeNull();
    expect(screen.getByRole("table", { name: "Termine des Profilings" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Termine speichern" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Erklärungen speichern" })).toBeNull();
    expect(screen.getByLabelText("Veröffentlichung in der Jobbörse (Feld 50)")).toBeDisabled();
    const section = within(
      screen.getByRole("heading", { name: "Handlungsbedarf (Abschnitt C)" }).closest("section")!,
    );
    await user.click(section.getByRole("button", { name: /Anzeigen/ }));
    expect(await section.findByDisplayValue(SECRET)).toHaveAttribute("readonly");
    expect(section.queryByRole("button", { name: "Einschätzung speichern" })).toBeNull();
    const unemployment = within(
      screen.getByRole("heading", { name: "Arbeitslos seit / bis" }).closest("section")!,
    );
    await user.click(unemployment.getByRole("button", { name: /Anzeigen/ }));
    expect(await unemployment.findByText("01.11.2025")).toBeVisible();
    expect(unemployment.queryByRole("button", { name: "Speichern" })).toBeNull();
  });

  it("saves the unemployment period with its revision and warns of a reversed range", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      profiler: true,
      routes: {
        [`PUT ${detailPath}/profiling/unemployment`]: () =>
          written(view(true), ["range_reversed"], 2),
      },
    });
    const unemployment = within(
      (await screen.findByRole("heading", { name: "Arbeitslos seit / bis" })).closest("section")!,
    );
    await user.click(unemployment.getByRole("button", { name: /Anzeigen/ }));
    await user.type(await unemployment.findByLabelText("Arbeitslos bis"), "01.10.2025");
    await user.click(unemployment.getByRole("button", { name: "Speichern" }));
    expect(await unemployment.findByText(/„seit“ liegt nach „bis“/)).toBeVisible();
    expect(callTo(calls, `PUT ${detailPath}/profiling/unemployment`)[0]?.body).toEqual({
      revision: 1,
      period: { from: "2025-11-01", until: "2025-10-01" },
    });
    // Clearing goes with the revision this save returned.
    await user.click(unemployment.getByRole("button", { name: "Angabe entfernen" }));
    await waitFor(() =>
      expect(callTo(calls, `PUT ${detailPath}/profiling/unemployment`)[1]?.body).toEqual({
        revision: 2,
        period: null,
      }),
    );
  });
});

const readinessPath = `GET ${detailPath}/forms/tl407/readiness`;
const generatePath = `POST ${detailPath}/forms/tl407`;
const documentId = "00000000-0000-4000-a000-0000000000d1";
const generatedForm = (overrides: Partial<GeneratedForm> = {}): GeneratedForm => ({
  documentId,
  formVersion: "08-2025",
  generatedAt: "2026-10-22T09:30:00.000000Z",
  anlage: true,
  latest: true,
  versionInUse: true,
  capabilities: { open: true },
  ...overrides,
});
const profilerReadiness = {
  view: "profiler",
  formVersion: "08-2025",
  ready: true,
  errors: [],
  warnings: [
    {
      code: "school_qualification_none",
      key: "education",
      label: "39 Schul- und Berufsausbildung",
    },
  ],
  overflow: [{ kind: "table", key: "work", label: "40 Werdegang der letzten drei Jahre" }],
};

describe("the section 'Profilingbogen (TL 407)'", () => {
  it("checks on 'Prüfen' only, and generates once each warning is confirmed", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      profiler: true,
      tl407: true,
      routes: {
        [readinessPath]: () => json(profilerReadiness),
        [generatePath]: () => json({ documentId, formVersion: "08-2025", anlage: true }, 201),
      },
    });
    const section = await screen.findByRole("region", { name: "Profilingbogen (TL 407)" });
    expect(within(section).getByText("Noch kein Bogen erzeugt.")).toBeVisible();
    // Each check reads the protected answers (logged): never without "Prüfen".
    expect(callTo(calls, readinessPath)).toEqual([]);
    await user.click(within(section).getByRole("button", { name: "Prüfen" }));
    expect(
      await within(section).findByText("Der Bogen (Fassung 08/2025) kann erzeugt werden."),
    ).toBeVisible();
    expect(within(section).getByText("40 Werdegang der letzten drei Jahre")).toBeVisible();
    const generate = within(section).getByRole("button", { name: "Erzeugen" });
    expect(generate).toBeDisabled();
    await user.click(within(section).getByLabelText(/Kein Schulabschluss/));
    await user.click(generate);
    await waitFor(() =>
      expect(callTo(calls, generatePath)[0]?.body).toEqual({
        confirmWarnings: ["school_qualification_none"],
      }),
    );
    expect(await screen.findByText("Profilingbogen mit Anlage erzeugt.")).toBeVisible();
  });

  it("explains a character the form can't print by field and points to paper (Q197)", async () => {
    const user = userEvent.setup();
    setup({
      profiler: true,
      tl407: true,
      routes: {
        [readinessPath]: () =>
          json({
            ...profilerReadiness,
            ready: false,
            errors: [{ code: "character_unsupported", key: "lastName", label: "7 Nachname" }],
            warnings: [],
            overflow: [],
          }),
      },
    });
    const section = await screen.findByRole("region", { name: "Profilingbogen (TL 407)" });
    await user.click(within(section).getByRole("button", { name: "Prüfen" }));
    expect(
      await within(section).findByText("Enthält Zeichen, die der Bogen nicht drucken kann."),
    ).toBeVisible();
    expect(within(section).getByText("7 Nachname:")).toBeVisible();
    expect(within(section).getByText(/Außerhalb der Anwendung ausgefüllt/)).toBeVisible();
    expect(within(section).queryByRole("button", { name: "Erzeugen" })).toBeNull();
  });

  it("re-checks after a refusal because the sources changed (409)", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      profiler: true,
      tl407: true,
      routes: {
        [readinessPath]: () => json({ ...profilerReadiness, warnings: [] }),
        [generatePath]: () => problem(409, "conflict"),
      },
    });
    const section = await screen.findByRole("region", { name: "Profilingbogen (TL 407)" });
    await user.click(within(section).getByRole("button", { name: "Prüfen" }));
    await user.click(await within(section).findByRole("button", { name: "Erzeugen" }));
    expect(
      await within(section).findByText(/Die Angaben haben sich inzwischen geändert/),
    ).toBeVisible();
    await waitFor(() => expect(callTo(calls, readinessPath)).toHaveLength(2));
  });

  it("gives the PL the summary at once and the forms to open, never 'Erzeugen'", async () => {
    const user = userEvent.setup();
    const { documentNavigation } = await import("./components/documents-tab");
    const assign = vi.spyOn(documentNavigation, "assign").mockImplementation(() => undefined);
    const { calls } = setup({
      profiler: false,
      tl407: true,
      tl407Forms: [generatedForm()],
      routes: {
        [readinessPath]: () =>
          json({
            view: "project_lead",
            ready: false,
            missing: [{ key: "birthDate", label: "8 Geburtsdatum" }],
          }),
        [`POST ${detailPath}/documents/${documentId}/opening`]: () =>
          json({ url: "/api/v1/document-content/abc", expiresAt: "2026-10-22T09:31:00Z" }, 201),
      },
    });
    const section = await screen.findByRole("region", { name: "Profilingbogen (TL 407)" });
    expect(await within(section).findByText("8 Geburtsdatum")).toBeVisible();
    expect(within(section).queryByRole("button", { name: "Prüfen" })).toBeNull();
    expect(within(section).queryByRole("button", { name: /erzeugen/i })).toBeNull();
    const forms = within(section).getByRole("table", { name: "Erzeugte Bögen" });
    expect(within(forms).getByText("mit Anlage")).toBeVisible();
    await user.click(within(forms).getByRole("button", { name: /Öffnen/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/v1/document-content/abc"));
    expect(callTo(calls, readinessPath)).toHaveLength(1);
  });

  it("says when the latest form's version is no longer valid and offers 'Neu erzeugen'", async () => {
    const user = userEvent.setup();
    setup({
      profiler: true,
      tl407: true,
      tl407Forms: [
        generatedForm({ versionInUse: false }),
        generatedForm({ documentId: sessionId, latest: false, anlage: false }),
      ],
      routes: { [readinessPath]: () => json({ ...profilerReadiness, warnings: [] }) },
    });
    const section = await screen.findByRole("region", { name: "Profilingbogen (TL 407)" });
    expect(within(section).getByText(/nicht mehr gültig: bitte neu erzeugen/)).toBeVisible();
    expect(within(section).getByText("ersetzt")).toBeVisible();
    await user.click(within(section).getByRole("button", { name: "Prüfen" }));
    expect(await within(section).findByRole("button", { name: "Neu erzeugen" })).toBeEnabled();
  });
});
