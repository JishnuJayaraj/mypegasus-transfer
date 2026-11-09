import { act, screen, within } from "@testing-library/react";
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

// data-protection.md, evidence corrections (D29; readings Q209): "Korrektur beantragen" on a
// closed BA outcome and an accepted document, each value chosen, nothing preset; the dialog keeps
// the target it opened for; a confirmation dialog still open for a task an approved correction
// superseded posts to that task, never its replacement (Q207 (6)); "Freigaben" lists the
// corrections with their source and no corrected value, and decides one in a dialog. Synthetic
// data.
const participationId = "00000000-0000-4000-a000-000000000001";
const projectPath = `/api/v1/projects/${project.id}`;
const detailPath = `/api/v1/participations/${participationId}`;
const correctionsPath = `${detailPath}/evidence-corrections`;
const noCorrection = { pending: false, mayRequest: false };

const closed = {
  id: "00000000-0000-4000-c000-000000000001",
  reportingKind: "planned_end_changed",
  subjectDate: "2092-01-31",
  status: "not_required",
  createdAt: "2026-10-20T08:00:00.000000Z",
  reportedOn: null,
  notRequiredReason: "created_in_error",
  decidedAt: "2026-10-21T08:00:00.000000Z",
  supersededBy: null,
  replacesTaskId: null,
  correction: { pending: false, mayRequest: true },
  capabilities: { recordOutcome: false },
};
const pending = {
  ...closed,
  id: "00000000-0000-4000-c000-000000000002",
  status: "pending",
  notRequiredReason: null,
  decidedAt: null,
  correction: noCorrection,
  capabilities: { recordOutcome: true },
};
const detail = {
  id: participationId,
  projectId: project.id,
  status: "contacted",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  statusVersion: 4,
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
  amendments: [],
  baReportingTasks: [closed],
  assignments: [],
  activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
  privacyNoticeState: { state: "due", dueOn: "2026-11-15", providedAt: null },
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
  },
  refusals: { assignEntryWave: "no_other_wave", setParticipationDates: null },
};

function setup(shown: () => object, routes: Parameters<typeof mockApi>[0] = {}) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(shown()),
    ...routes,
  });
  const { queryClient } = renderApp(
    `/projects/${project.id}/participations/${participationId}`,
    api,
  );
  return { calls, queryClient };
}
const section = () => screen.findByRole("region", { name: "BA-Meldungen" });
const bodies = (calls: { key: string; body: unknown }[], key: string) =>
  calls.filter((c) => c.key === key).map((c) => c.body);

describe("Korrektur beantragen (D29)", () => {
  it("asks for a closed outcome's correction with a reason and source chosen, never preset", async () => {
    const { calls } = setup(() => detail, {
      [`POST ${correctionsPath}`]: () =>
        json({ correctionId: "00000000-0000-4000-e000-000000000001" }, 201),
    });
    const tasks = await section();
    await userEvent.click(
      within(tasks).getByRole("button", {
        name: "Korrektur beantragen: Meldung: Geplantes Ende geändert zum 31.01.2092",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Korrektur beantragen" });
    const confirm = within(dialog).getByRole("button", { name: "Beantragen" });
    expect(within(dialog).getByLabelText("Grund")).toHaveValue("");
    expect(within(dialog).getByLabelText("Dokumentierte Quelle")).toHaveValue("");
    expect(confirm).toBeDisabled();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Grund"),
      "documented_internal_error",
    );
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText("Dokumentierte Quelle"),
      "Vermerk PL vom 03.11.",
    );
    await userEvent.click(confirm);
    expect(
      await screen.findByText("Korrektur beantragt. Sie wird in den Freigaben entschieden."),
    ).toBeInTheDocument();
    expect(bodies(calls, `POST ${correctionsPath}`)).toEqual([
      {
        correction: "supersede_ba_report",
        taskId: closed.id,
        reason: "documented_internal_error",
        source: "Vermerk PL vom 03.11.",
      },
    ]);
  });

  it("shows a superseded outcome, its replacement and a pending request; no button without the capability", async () => {
    setup(() => ({
      ...detail,
      baReportingTasks: [
        { ...closed, supersededBy: pending.id, correction: noCorrection },
        { ...pending, replacesTaskId: closed.id },
        {
          ...closed,
          id: "00000000-0000-4000-c000-000000000003",
          correction: { pending: true, mayRequest: false },
        },
      ],
    }));
    const tasks = await section();
    expect(
      within(tasks).getByText("Nicht erforderlich · Durch Korrektur ersetzt"),
    ).toBeInTheDocument();
    expect(
      within(tasks).getByText("Ausstehend · Ersetzt eine korrigierte Meldung"),
    ).toBeInTheDocument();
    expect(within(tasks).getByText("Nicht erforderlich · Korrektur beantragt")).toBeInTheDocument();
    expect(within(tasks).queryByRole("button", { name: /^Korrektur beantragen/ })).toBeNull();
  });

  it("keeps an open 'Gemeldet am' dialog on its task when a correction replaced it meanwhile (Q207 (6))", async () => {
    const replacement = {
      ...pending,
      id: "00000000-0000-4000-c000-000000000004",
      replacesTaskId: pending.id,
    };
    let shown: object = { ...detail, baReportingTasks: [pending] };
    const stalePath = `/api/v1/ba-reporting-tasks/${pending.id}/outcome`;
    const { calls, queryClient } = setup(() => shown, {
      [`POST ${stalePath}`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "", code: "already_recorded", detail: "Refused" }],
        }),
    });
    const tasks = await section();
    await userEvent.click(within(tasks).getByRole("button", { name: "Gemeldet am …" }));
    // Meanwhile: the task was closed elsewhere and a correction replaced it.
    shown = {
      ...detail,
      baReportingTasks: [
        { ...pending, status: "reported", reportedOn: "2026-10-22", supersededBy: replacement.id },
        replacement,
      ],
    };
    await act(() => queryClient.invalidateQueries());
    await screen.findByText("Ausstehend · Ersetzt eine korrigierte Meldung");
    const dialog = screen.getByRole("dialog", { name: "Meldung als gesendet festhalten" });
    await userEvent.type(within(dialog).getByLabelText("Gemeldet am"), "02.11.2026");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ergebnis übernehmen" }));
    expect(
      await screen.findByText("Für diese Meldung ist bereits ein Ergebnis erfasst."),
    ).toBeInTheDocument();
    // Posted to the task the dialog opened for, never adopted by the replacement.
    expect(calls.filter((c) => c.key.startsWith("POST ")).map((c) => c.key)).toEqual([
      `POST ${stalePath}`,
    ]);
  });
});

describe("Freigaben: corrections", () => {
  const correction = {
    correctionId: "00000000-0000-4000-e000-000000000001",
    projectId: project.id,
    projectName: "Restrukturierung Werk Nord",
    targetKind: "asu_registration",
    action: "supersede",
    documentType: null,
    reportingKind: null,
    wrongPerson: null,
    reason: "corrected_source_document",
    source: "BA-Schreiben vom 02.11.",
    requestedOn: "2026-11-05",
    targetRecordedOn: "2026-11-01",
    capabilities: { decide: true },
  };
  const decisionPath = `/api/v1/evidence-corrections/${correction.correctionId}/decision`;

  function queue(decision: () => Response) {
    const { api, calls } = mockApi({
      "GET /api/v1/me": () =>
        json({
          ...staffUsers[1],
          orgRoles: [{ role: "regional_operations_manager", regionId: "r-1" }],
        }),
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      "GET /api/v1/reviews": () =>
        json({ items: [], corrections: [correction], clarifications: [] }),
      [`POST ${decisionPath}`]: decision,
    });
    renderApp("/reviews", api);
    return calls;
  }

  it("lists the target's kind, action, reason, source and dates, and decides after a confirmation", async () => {
    const calls = queue(() => new Response(null, { status: 204 }));
    const table = await screen.findByRole("table", { name: "Beantragte Korrekturen" });
    expect(within(table).getByText("ASU-Meldung")).toBeInTheDocument();
    expect(within(table).getByText("ersetzen")).toBeInTheDocument();
    expect(within(table).getByText("BA-Schreiben vom 02.11.")).toBeInTheDocument();
    expect(within(table).getByText("01.11.2026")).toBeInTheDocument();
    await userEvent.click(
      within(table).getByRole("button", {
        name: "Korrektur freigeben: Restrukturierung Werk Nord, ASU-Meldung, beantragt am 05.11.2026",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Korrektur freigeben" });
    expect(
      within(dialog).getByText(
        "Die ASU-Meldung wird mit dem beantragten Datum ersetzt, erfasst zum Zeitpunkt der Freigabe.",
      ),
    ).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Freigeben" }));
    expect(await screen.findByText("Korrektur freigegeben.")).toBeInTheDocument();
    expect(bodies(calls, `POST ${decisionPath}`)).toEqual([{ decision: "approve" }]);
  });

  it("says so when the correction was decided meanwhile", async () => {
    queue(() =>
      problem(409, "conflict", {
        errors: [{ pointer: "", code: "source_changed", detail: "Read it again" }],
      }),
    );
    const table = await screen.findByRole("table", { name: "Beantragte Korrekturen" });
    await userEvent.click(within(table).getByRole("button", { name: /^Korrektur zurückweisen: / }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Korrektur zurückweisen" })).getByRole("button", {
        name: "Zurückweisen",
      }),
    );
    expect(
      await screen.findByText("Die Korrektur ist schon entschieden. Die Liste wurde neu geladen."),
    ).toBeInTheDocument();
  });
});
