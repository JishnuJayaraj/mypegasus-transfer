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

// Slice 2 plan 5.7 (PR 2h-3; rounds 32–34): the PL changes the contractual TG dates; a signed DSV
// asks for its amendment; amendments and BA reporting tasks are listed.
const participationId = "00000000-0000-4000-a000-000000000001";
const projectPath = `/api/v1/projects/${project.id}`;
const detailPath = `/api/v1/participations/${participationId}`;
const wave = {
  id: "00000000-0000-4000-b000-000000000001",
  code: "W1",
  name: "Welle 1",
  signingDeadline: "2091-02-15",
  defaultTgStart: "2091-03-01",
  defaultTgEnd: "2092-02-29",
  latestEntryDate: "2091-03-15",
};
const detail = {
  id: participationId,
  projectId: project.id,
  status: "informed",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  statusVersion: 4,
  entryWave: wave,
  dates: {
    tgStart: null,
    tgEnd: null,
    effectiveTgStart: "2091-03-01",
    effectiveTgEnd: "2092-02-29",
    offerDeadline: null,
    tgEntryDate: null,
    exitDate: null,
    withdrawnOn: null,
    profilingDoneOn: null,
  },
  hints: [],
  person: { personnelNumber: "BSP-0001", lastName: "Mustermann", firstName: "Erika" },
  amendments: [],
  baReportingTasks: [],
  assignments: [],
  capabilities: { assignEntryWave: false, setParticipationDates: true, assignParticipations: true },
  refusals: { assignEntryWave: "no_other_wave", setParticipationDates: null },
};
const task = {
  id: "00000000-0000-4000-c000-000000000001",
  reportingKind: "planned_end_changed",
  subjectDate: "2092-01-31",
  status: "pending",
  createdAt: "2026-10-20T08:00:00.000000Z",
  reportedOn: null,
};

function setup(shown: object, put?: Parameters<typeof mockApi>[0][string]) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(shown),
    ...(put && { [`PUT ${detailPath}/dates`]: put }),
  });
  renderApp(`/projects/${project.id}/participations/${participationId}`, api);
  return calls;
}
const sent = (calls: ReturnType<typeof setup>) =>
  calls.filter((c) => c.key === `PUT ${detailPath}/dates`).map((c) => c.body);
const open = async () =>
  userEvent.click(await screen.findByRole("button", { name: "Vertragsdaten ändern" }));
const type = async (label: string, value: string) => {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  await userEvent.type(input, value);
};

describe("changing the contractual dates", () => {
  it("sends a new end before signature and shows the pending BA task", async () => {
    const calls = setup(detail, () =>
      json({ ...detail, statusVersion: 5, baReportingTasks: [task] }),
    );
    await open();
    expect(screen.getByText(/nicht unterstützt/)).toBeInTheDocument();
    expect(screen.queryByText("DSV-Nachtrag")).toBeNull();
    await type("TG-Ende (TT.MM.JJJJ)", "31.01.2092");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    const tasks = await screen.findByRole("region", { name: "Meldungen an die Agentur" });
    expect(within(tasks).getByText("Geplantes Ende geändert")).toBeInTheDocument();
    expect(within(tasks).getByText("Ausstehend")).toBeInTheDocument();
    expect(sent(calls)).toEqual([{ tgStart: null, tgEnd: "2092-01-31", expectedVersion: 4 }]);
  });

  it("asks for the amendment once the DSV is signed and sends it with the confirmations", async () => {
    const calls = setup({ ...detail, dsvStatus: "dsv_signed" }, () =>
      json({ ...detail, dsvStatus: "dsv_signed" }),
    );
    await open();
    expect(screen.getByText("DSV-Nachtrag")).toBeInTheDocument();
    await type("TG-Ende (TT.MM.JJJJ)", "29.02.2092");
    // Without the date the last party signed, nothing is sent.
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText(/Kein gültiges Datum/)).toBeInTheDocument();
    expect(sent(calls)).toEqual([]);
    await type("Vollständig unterschrieben am", "15.10.2026");
    await type("Dokumentnummer (optional)", "DSV-2026/0001");
    await userEvent.click(screen.getByLabelText(/Original liegt mir vor/));
    await userEvent.click(screen.getByLabelText(/Alle erforderlichen Parteien/));
    await userEvent.click(screen.getByLabelText(/bleibt auffindbar/));
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await screen.findByText("Vertragsdaten geändert");
    expect(sent(calls)).toEqual([
      {
        tgStart: null,
        tgEnd: "2092-02-29",
        expectedVersion: 4,
        amendment: {
          fullyExecutedOn: "2026-10-15",
          originalLocation: "paper_personnel_file",
          documentReference: "DSV-2026/0001",
          originalInspected: true,
          allPartiesSigned: true,
          retrievable: true,
        },
      },
    ]);
  });

  it("shows the API's refusals at their fields, and a conflict as changed meanwhile", async () => {
    let first = true;
    setup(detail, () => {
      if (!first)
        return problem(409, "conflict", {
          errors: [{ pointer: "", code: "stale_status", detail: "x" }],
        });
      first = false;
      return problem(422, "domain-error", {
        errors: [
          { pointer: "/tgStart", code: "ba_review_required", detail: "x" },
          { pointer: "/tgEnd", code: "period_exceeds_twelve_months", detail: "x" },
        ],
      });
    });
    await open();
    await type("TG-Beginn (TT.MM.JJJJ)", "05.03.2091");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText(/Kein gewöhnlicher späterer Eintritt/)).toBeInTheDocument();
    expect(
      screen.getByText(/mehr als zwölf Monate werden von der Anwendung nicht unterstützt;/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("TG-Beginn (TT.MM.JJJJ)")).toHaveAttribute("aria-invalid", "true");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText(/inzwischen geändert/)).toBeInTheDocument();
  });

  it("gives the API's reason when the dates can't change", async () => {
    setup({
      ...detail,
      dsvStatus: "dsv_offered",
      capabilities: { assignEntryWave: false, setParticipationDates: false },
      refusals: { assignEntryWave: "dsv_already_offered", setParticipationDates: "dsv_offer_open" },
    });
    expect(
      await screen.findByText(/Ein DSV-Angebot ist offen: Das ausgehändigte/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vertragsdaten ändern" })).toBeNull();
  });

  it("lists the amendments and the review hint", async () => {
    setup({
      ...detail,
      dsvStatus: "dsv_signed",
      hints: ["tg_start_missed", "new_start_needs_ba_review"],
      amendments: [
        {
          id: "00000000-0000-4000-d000-000000000001",
          kind: "extension",
          fullyExecutedOn: "2026-10-15",
          oldTgStart: "2091-03-01",
          newTgStart: "2091-03-01",
          oldTgEnd: "2092-01-31",
          newTgEnd: "2092-02-29",
          confirmedBy: staffUsers[1]!.id,
          confirmedAt: "2026-10-20T08:00:00.000000Z",
          originalLocation: "paper_personnel_file",
          documentReference: null,
        },
      ],
    });
    const amendments = await screen.findByRole("region", { name: "DSV-Nachträge" });
    expect(within(amendments).getByText("Verlängerung")).toBeInTheDocument();
    expect(within(amendments).getByText("TG-Ende: 31.01.2092 → 29.02.2092")).toBeInTheDocument();
    expect(within(amendments).getByText("Papier-Personalakte")).toBeInTheDocument();
    expect(screen.getByText(/Neuer Beginn nur nach BA-\/Rechtsprüfung/)).toBeInTheDocument();
  });
});
