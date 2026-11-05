import { screen, within } from "@testing-library/react";
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

// process-and-lifecycle.md, BA reporting (D28): on the overview's "BA-Meldungen" the PL or back
// office records "Gemeldet am" or "Nicht erforderlich" for a pending task, confirmed in a dialog
// that names the task and fills in nothing; the buttons follow the capability. Synthetic data.
const participationId = "00000000-0000-4000-a000-000000000001";
const projectPath = `/api/v1/projects/${project.id}`;
const detailPath = `/api/v1/participations/${participationId}`;
const pending = {
  id: "00000000-0000-4000-c000-000000000001",
  reportingKind: "planned_end_changed",
  subjectDate: "2092-01-31",
  status: "pending",
  createdAt: "2026-10-20T08:00:00.000000Z",
  reportedOn: null,
  notRequiredReason: null,
  decidedAt: null,
  capabilities: { recordOutcome: true },
};
const reported = {
  ...pending,
  id: "00000000-0000-4000-c000-000000000002",
  reportingKind: "later_entry",
  subjectDate: "2091-04-01",
  status: "reported",
  reportedOn: "2026-10-22",
  decidedAt: "2026-10-22T09:00:00.000000Z",
  capabilities: { recordOutcome: false },
};
const notRequired = {
  ...reported,
  id: "00000000-0000-4000-c000-000000000003",
  reportingKind: "early_exit",
  status: "not_required",
  reportedOn: null,
  notRequiredReason: "created_in_error",
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
  baReportingTasks: [pending, reported, notRequired],
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
const outcomePath = `/api/v1/ba-reporting-tasks/${pending.id}/outcome`;

function setup(shown: object, post?: Parameters<typeof mockApi>[0][string]) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(shown),
    ...(post && { [`POST ${outcomePath}`]: post }),
  });
  renderApp(`/projects/${project.id}/participations/${participationId}`, api);
  return calls;
}
const sent = (calls: ReturnType<typeof setup>) =>
  calls.filter((c) => c.key === `POST ${outcomePath}`).map((c) => c.body);
const section = () => screen.findByRole("region", { name: "BA-Meldungen" });
const confirm = () => screen.getByRole("button", { name: "Ergebnis übernehmen" });

describe("BA-Meldungen (D28)", () => {
  it("lists each task's outcome; buttons only for the pending one the viewer may close", async () => {
    setup(detail);
    const tasks = await section();
    expect(within(tasks).getByText("Gemeldet am 22.10.2026")).toBeInTheDocument();
    expect(within(tasks).getByText("Nicht erforderlich: Irrtümlich angelegt")).toBeInTheDocument();
    expect(within(tasks).getAllByRole("button", { name: "Gemeldet am …" })).toHaveLength(1);
    expect(within(tasks).getAllByRole("button", { name: "Nicht erforderlich …" })).toHaveLength(1);
  });

  it("shows no action without the capability (a consultant)", async () => {
    setup({
      ...detail,
      baReportingTasks: [{ ...pending, capabilities: { recordOutcome: false } }],
    });
    const tasks = await section();
    expect(within(tasks).getByText("Ausstehend")).toBeInTheDocument();
    expect(within(tasks).queryByRole("button", { name: "Gemeldet am …" })).toBeNull();
    expect(within(tasks).queryByRole("columnheader", { name: "Aktionen" })).toBeNull();
  });

  it("confirms 'Gemeldet am' with the date typed, never a default, and sends it", async () => {
    const calls = setup(detail, () => new Response(null, { status: 204 }));
    await userEvent.click(within(await section()).getByRole("button", { name: "Gemeldet am …" }));
    const dialog = screen.getByRole("dialog", { name: "Meldung als gesendet festhalten" });
    expect(
      within(dialog).getByText("Meldung: Geplantes Ende geändert zum 31.01.2092"),
    ).toBeVisible();
    const field = within(dialog).getByLabelText("Gemeldet am");
    expect(field).toHaveValue("");
    expect(confirm()).toBeDisabled();
    await userEvent.type(field, "02.11.2026");
    await userEvent.click(confirm());
    expect(await screen.findByText("Ergebnis der Meldung festgehalten.")).toBeInTheDocument();
    expect(sent(calls)).toEqual([{ outcome: "reported", reportedOn: "2026-11-02" }]);
  });

  it("confirms 'Nicht erforderlich' with a reason chosen, never a default", async () => {
    const calls = setup(detail, () => new Response(null, { status: 204 }));
    await userEvent.click(
      within(await section()).getByRole("button", { name: "Nicht erforderlich …" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Meldung als nicht erforderlich festhalten",
    });
    expect(confirm()).toBeDisabled();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Grund"),
      "no_claim_month_affected",
    );
    await userEvent.click(confirm());
    await screen.findByText("Ergebnis der Meldung festgehalten.");
    expect(sent(calls)).toEqual([{ outcome: "not_required", reason: "no_claim_month_affected" }]);
  });

  it("names a refusal and keeps nothing typed for the next task", async () => {
    const calls = setup(detail, () =>
      problem(422, "domain-error", {
        errors: [{ pointer: "/reportedOn", code: "date_in_future", detail: "Refused" }],
      }),
    );
    const tasks = await section();
    await userEvent.click(within(tasks).getByRole("button", { name: "Gemeldet am …" }));
    await userEvent.type(screen.getByLabelText("Gemeldet am"), "01.01.2099");
    await userEvent.click(confirm());
    expect(await screen.findByText("Das Datum liegt in der Zukunft.")).toBeInTheDocument();
    expect(sent(calls)).toEqual([{ outcome: "reported", reportedOn: "2099-01-01" }]);
    await userEvent.click(within(tasks).getByRole("button", { name: "Gemeldet am …" }));
    expect(screen.getByLabelText("Gemeldet am")).toHaveValue("");
  });
});
