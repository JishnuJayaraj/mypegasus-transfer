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

// Slice 2 plan 5.9, 5.13 (PR 2d-2): rule relaxations in the Konfiguration section. The PL
// requests, withdraws and removes; the regional operations manager approves or rejects; every
// action only with its server-derived capability (round 26).
const path = `/api/v1/projects/${project.id}`;
const pl = staffUsers[1]!;
const rom = "00000000-0000-4000-8000-000000000006";
const requestId = "00000000-0000-4000-b000-000000000001";
const ruleId = "base-import-birthDate";
const relaxable = [
  { ruleId: "base-import-address", step: "data_collection" },
  { ruleId, step: "data_collection" },
];
const open = (capabilities = { decide: false, withdraw: true }, requestedBy = pl.id) => ({
  id: requestId,
  ruleId,
  reasonCode: "source_data_not_provided",
  requestedBy,
  requestedOn: "2026-10-17",
  capabilities,
});
const approved = {
  ...unpinnedConfig,
  override: {
    version: 3,
    agenturSettings: [],
    relaxations: [
      { ruleId, reasonCode: "source_data_not_provided", approvedBy: rom, approvedOn: "2026-10-17" },
    ],
  },
  relaxableRules: relaxable.slice(0, 1),
};
const readOnly = {
  pinTemplate: false,
  setProjectAgentur: false,
  changeOverride: false,
  requestRelaxation: false,
};

function setup(config: object, routes: Parameters<typeof mockApi>[0] = {}, me: object = pl) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(me),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(config),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    ...routes,
  });
  renderApp(`/projects/${project.id}?tab=setup`, api);
  return calls;
}
const section = async () =>
  within(
    (await screen.findByRole("heading", { name: "Lockerungen von Regeln" })).closest("section")!,
  );

describe("Konfiguration: rule relaxations", () => {
  it("lets the PL request one for a relaxable rule with a controlled reason code", async () => {
    const calls = setup(
      { ...unpinnedConfig, relaxableRules: relaxable },
      {
        [`POST ${path}/config/relaxations`]: () =>
          json({ ...unpinnedConfig, relaxationRequests: [open()] }),
      },
    );
    const form = await section();
    expect(form.getByText("Es gibt keine offenen Anträge.")).toBeInTheDocument();
    await userEvent.click(form.getByRole("button", { name: "Beantragen" }));
    expect(form.getByText("Bitte wählen Sie eine Regel und eine Begründung.")).toBeInTheDocument();
    await userEvent.selectOptions(form.getByLabelText("Regel"), ruleId);
    await userEvent.selectOptions(form.getByLabelText("Begründung"), "source_data_not_provided");
    await userEvent.click(form.getByRole("button", { name: "Beantragen" }));
    expect(await screen.findByText("Lockerung beantragt")).toBeInTheDocument();
    expect(calls.find((c) => c.key === `POST ${path}/config/relaxations`)?.body).toEqual({
      ruleId,
      reasonCode: "source_data_not_provided",
    });
    // The open request, with the requester's own name and only the withdrawal.
    const row = form.getByText(ruleId).closest("tr")!;
    expect(within(row).getByText("Petra Projektleitung")).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: `Antrag zu ${ruleId} zurückziehen` }),
    ).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /genehmigen/ })).toBeNull();
  });

  it("shows a refused request's reason", async () => {
    setup(
      { ...unpinnedConfig, relaxableRules: relaxable },
      {
        [`POST ${path}/config/relaxations`]: () =>
          problem(422, "domain-error", {
            errors: [
              { pointer: "", code: "override_invalid", detail: "x" },
              { pointer: "", code: "relaxation_locked", detail: "x" },
            ],
          }),
      },
    );
    const form = await section();
    await userEvent.selectOptions(form.getByLabelText("Begründung"), "collected_outside_platform");
    await userEvent.click(form.getByRole("button", { name: "Beantragen" }));
    expect(await form.findByText(/kann nicht gelockert werden/)).toBeInTheDocument();
  });

  it("lets the regional operations manager approve with the loaded version, or reject", async () => {
    const decide = { decide: true, withdraw: false };
    const calls = setup(
      {
        ...unpinnedConfig,
        override: { ...unpinnedConfig.override, version: 2 },
        relaxationRequests: [open(decide)],
        capabilities: readOnly,
      },
      {
        [`POST /api/v1/config/relaxations/${requestId}/decision`]: () =>
          json({ ...approved, capabilities: readOnly }),
      },
      {
        id: rom,
        displayName: "Olga Operations",
        role: "regional_operations_manager",
        mayCreateProjects: false,
        orgRoles: [{ role: "regional_operations_manager", regionId: project.regionId }],
      },
    );
    const form = await section();
    const row = form.getByText(ruleId).closest("tr")!;
    // Another requester is never shown by an id (Q109).
    expect(within(row).getByText("Andere berechtigte Person")).toBeInTheDocument();
    expect(form.queryByRole("button", { name: "Beantragen" })).toBeNull();
    expect(within(row).queryByRole("button", { name: /zurückziehen/ })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: `${ruleId} genehmigen` }));
    expect(await screen.findByText("Lockerung genehmigt")).toBeInTheDocument();
    expect(calls.find((c) => c.key.endsWith("/decision"))?.body).toEqual({
      decision: "approved",
      expectedVersion: 2,
    });
    // The approved relaxation, approved by the viewer, without removal (no changeOverride).
    const approvedRow = form.getByText("Olga Operations").closest("tr")!;
    expect(within(approvedRow).getByText("17.10.2026")).toBeInTheDocument();
    expect(form.queryByRole("button", { name: /aufheben/ })).toBeNull();
  });

  it("sends a rejection without a version", async () => {
    const calls = setup(
      { ...unpinnedConfig, relaxationRequests: [open({ decide: true, withdraw: false })] },
      { [`POST /api/v1/config/relaxations/${requestId}/decision`]: () => json(unpinnedConfig) },
    );
    const form = await section();
    await userEvent.click(form.getByRole("button", { name: `${ruleId} ablehnen` }));
    expect(await screen.findByText("Antrag abgelehnt")).toBeInTheDocument();
    expect(calls.find((c) => c.key.endsWith("/decision"))?.body).toEqual({ decision: "rejected" });
  });

  it("offers nothing without capabilities, also to a viewer who could decide elsewhere", async () => {
    setup(
      {
        ...approved,
        relaxationRequests: [open({ decide: false, withdraw: false }, rom)],
        capabilities: readOnly,
      },
      {},
      {
        id: rom,
        displayName: "Olga Operations",
        role: "regional_operations_manager",
        mayCreateProjects: false,
        orgRoles: [{ role: "regional_operations_manager", regionId: project.regionId }],
      },
    );
    const form = await section();
    // Approved and asked again (after a removal), both read-only here.
    expect(form.getAllByText(ruleId, { selector: "td" })).toHaveLength(2);
    expect(form.queryByRole("button")).toBeNull();
    expect(form.queryByText("Aktionen")).toBeNull();
  });

  it("withdraws a request and removes an approved relaxation with the loaded version", async () => {
    let expectedVersion: string | null = null;
    const calls = setup(
      { ...approved, relaxationRequests: [{ ...open(), ruleId: "base-import-address" }] },
      {
        [`POST /api/v1/config/relaxations/${requestId}/withdrawal`]: () => json(approved),
        [`DELETE ${path}/config/relaxations/${ruleId}`]: ({ query }) => {
          expectedVersion = query.get("expectedVersion");
          return json(unpinnedConfig);
        },
      },
    );
    const form = await section();
    await userEvent.click(
      form.getByRole("button", { name: "Antrag zu base-import-address zurückziehen" }),
    );
    expect(await screen.findByText("Antrag zurückgezogen")).toBeInTheDocument();
    expect(calls.find((c) => c.key.endsWith("/withdrawal"))?.body).toEqual({});
    await userEvent.click(form.getByRole("button", { name: `Lockerung ${ruleId} aufheben` }));
    expect(await screen.findByText("Lockerung aufgehoben")).toBeInTheDocument();
    expect(expectedVersion).toBe("3");
    expect(form.getByText("Es gibt keine genehmigten Lockerungen.")).toBeInTheDocument();
  });

  it("reloads the configuration after a 409 and says so", async () => {
    let loads = 0;
    setup(
      { ...unpinnedConfig, relaxationRequests: [open({ decide: true, withdraw: false })] },
      {
        [`GET ${path}/config`]: () => {
          loads += 1;
          return json({
            ...unpinnedConfig,
            relaxationRequests: [open({ decide: true, withdraw: false })],
          });
        },
        [`POST /api/v1/config/relaxations/${requestId}/decision`]: () => problem(409, "conflict"),
      },
    );
    const form = await section();
    await userEvent.click(form.getByRole("button", { name: `${ruleId} genehmigen` }));
    expect(await form.findByText(/inzwischen geändert und neu geladen/)).toBeInTheDocument();
    expect(loads).toBe(2);
  });
});
