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

// "Kontaktstatus" (process-and-lifecycle.md, the manual contact statuses; Q215): the targets the
// capability allows, nothing preset, the status version read when the dialog opened, the 409's
// message. Synthetic data only.
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;

const detail = (overrides: object = {}) => ({
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
  person: { personnelNumber: "BSP-0001", lastName: "Beispiel", firstName: "Erika" },
  assignments: [],
  activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
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
    viewAsu: false,
    viewDsv: false,
    withdraw: false,
    contactStatus: ["unreachable"],
    correctEndReason: false,
    reconcileTgEntry: false,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null, withdraw: "forbidden" },
  ...overrides,
});

function setup(first: object = {}, routes: Parameters<typeof mockApi>[0] = {}) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail(first)),
    ...routes,
  });
  renderApp(`/projects/${project.id}/participations/${participationId}`, mock.api);
  return mock;
}

async function openDialog() {
  const menu = await screen.findByRole("button", { name: "Aktionen" });
  await userEvent.click(menu);
  const items = within(document.getElementById(menu.getAttribute("aria-controls")!)!);
  await userEvent.click(items.getByText("Kontaktstatus"));
  return within(await screen.findByRole("dialog", { name: "Kontaktstatus" }));
}

describe("Kontaktstatus", () => {
  it("offers only the allowed targets, nothing preset, and sends the version read", async () => {
    const { calls } = setup(
      {},
      {
        [`POST ${detailPath}/contact-status`]: () =>
          json(detail({ status: "unreachable", statusVersion: 5 })),
      },
    );
    const panel = await openDialog();
    expect(panel.getByText("Aktueller Status: Kontaktiert")).toBeVisible();
    const radios = panel.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(["unreachable"]);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(panel.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(panel.getByText("Bitte einen neuen Status wählen.")).toBeVisible();
    await userEvent.click(panel.getByLabelText("Nicht erreichbar"));
    await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST ${detailPath}/contact-status`,
        body: { to: "unreachable", statusVersion: 4 },
      }),
    );
  });

  it("explains a 409: the participation changed meanwhile", async () => {
    setup(
      {
        status: "unreachable",
        capabilities: { ...detail().capabilities, contactStatus: ["contacted"] },
      },
      {
        [`POST ${detailPath}/contact-status`]: () =>
          problem(409, "conflict", [{ pointer: "", code: "stale_status" }]),
      },
    );
    const panel = await openDialog();
    await userEvent.click(panel.getByLabelText("Kontaktiert"));
    await userEvent.click(panel.getByRole("button", { name: "Speichern" }));
    expect(
      await panel.findByText("Die Teilnahme wurde inzwischen geändert. Bitte neu laden."),
    ).toBeVisible();
  });

  it("is not offered without a target", async () => {
    setup({ capabilities: { ...detail().capabilities, contactStatus: [] } });
    expect(await screen.findByRole("heading", { name: "Beispiel, Erika" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Aktionen" })).toBeNull();
  });
});
