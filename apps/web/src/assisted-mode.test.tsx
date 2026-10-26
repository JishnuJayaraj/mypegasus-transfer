import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { selfServiceValueSchemas } from "@transfer/domain";
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

// Assisted mode and the "Selbstauskunft" tab (ADR-0007, assisted mode; data-protection.md,
// self-service; Q136). Synthetic data only.
const participationId = "00000000-0000-4000-a000-000000000001";
const assistedModeId = "00000000-0000-4000-c000-000000000001";
const projectPath = `/api/v1/projects/${project.id}`;
const detailPath = `/api/v1/participations/${participationId}`;
const assistedPath = `${detailPath}/assisted/self-service`;
const pagePath = `/projects/${project.id}/participations/${participationId}`;

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
    startAssistedMode: true,
    viewProfiling: false,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
};

const values = {
  ...Object.fromEntries(Object.keys(selfServiceValueSchemas).map((key) => [key, null])),
  gender: "female",
  mobile: "0171 3920000",
};

/** The tab's projection: the consultant reads everything; a PL only knows presence. */
const selfService = (overrides: object = {}) => ({
  participationId,
  revision: 4,
  updatedAt: "2026-10-21T09:00:00.000000Z",
  notice: { version: "self-service-purposes:v1", acknowledgedAt: "2026-10-21T08:00:00.000000Z" },
  values,
  customValues: { "custom.beispiel_nr": "ZN-4711" },
  customLabels: { "custom.beispiel_nr": "Nachweis-Nr. (Beispiel)" },
  participantMaintained: ["mobile"],
  sensitive: {
    pensionInsuranceNumber: true,
    nationality: false,
    entryToGermanyDate: false,
    residenceStatus: false,
    buergergeld: false,
    healthRestrictions: true,
    severeDisability: false,
  },
  sensitiveReadable: [
    "pensionInsuranceNumber",
    "nationality",
    "entryToGermanyDate",
    "residenceStatus",
    "buergergeld",
    "healthRestrictions",
    "severeDisability",
  ],
  missing: [
    {
      step: "profiling",
      ruleId: "base-tl407-maritalStatus",
      kind: "field",
      key: "maritalStatus",
      reason: "missing",
    },
    {
      step: "profiling",
      ruleId: "base-tl407-nationality",
      kind: "field",
      key: "nationality",
      reason: "missing",
    },
  ],
  ...overrides,
});

/** The assisted wizard state: the PL's, without the BA details page. */
const assistedState = {
  participationId,
  assistedModeId,
  revision: 4,
  notice: { version: "self-service-purposes:v1", acknowledged: true },
  identity: { firstName: "Erika", lastName: "Mustermann", birthDate: "1970-01-01" },
  values,
  customValues: {},
  sensitive: { healthRestrictions: true, severeDisability: false },
  pages: [
    {
      page: "personal",
      sensitive: false,
      complete: false,
      fields: [
        { key: "gender", required: true },
        { key: "maritalStatus", required: true },
      ],
    },
    {
      page: "health",
      sensitive: true,
      complete: true,
      fields: [
        { key: "healthRestrictions", required: true },
        { key: "severeDisability", required: true },
      ],
    },
  ],
  missing: [
    {
      step: "profiling",
      ruleId: "base-tl407-maritalStatus",
      kind: "field",
      key: "maritalStatus",
      reason: "missing",
    },
  ],
};

function setup(routes: Parameters<typeof mockApi>[0] = {}, path = `${pagePath}?tab=self-service`) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail),
    [`GET ${detailPath}/self-service`]: () => json(selfService()),
    ...routes,
  });
  const { router } = renderApp(path, mock.api);
  return { ...mock, router };
}

describe("the 'Selbstauskunft' tab", () => {
  it("shows values, sensitive fields as given or missing, and the missing items by step", async () => {
    const user = userEvent.setup();
    const { calls } = setup({}, pagePath);
    await user.click(await screen.findByRole("tab", { name: "Selbstauskunft" }));
    const personal = await screen.findByRole("region", { name: "Persönliches" });
    expect(within(personal).getByText("Weiblich")).toBeInTheDocument();
    const contact = screen.getByRole("region", { name: "Kontakt" });
    expect(within(contact).getByText("Von der Person gepflegt: Mobilnummer")).toBeInTheDocument();
    const custom = screen.getByRole("region", { name: "Weitere Angaben" });
    expect(within(custom).getByText("Nachweis-Nr. (Beispiel)")).toBeInTheDocument();
    expect(within(custom).getByText("ZN-4711")).toBeInTheDocument();
    const missing = screen.getByRole("region", { name: "Fehlende Angaben" });
    expect(within(missing).getByRole("heading", { name: "Profiling" })).toBeInTheDocument();
    expect(within(missing).getByText("Familienstand")).toBeInTheDocument();
    expect(within(missing).getByText("Staatsangehörigkeit")).toBeInTheDocument();
    const agentur = screen.getByRole("region", { name: "Angaben für die Agentur" });
    expect(within(agentur).getAllByText("fehlt")).toHaveLength(4);
    expect(within(agentur).getByText("angegeben")).toBeInTheDocument();
    // No value of a sensitive field has been read.
    expect(calls.filter(({ key }) => key.includes("/sensitive/"))).toEqual([]);
  });

  it("reads one field on 'Anzeigen', for the roles that may", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      [`GET ${detailPath}/self-service/sensitive/ba_details`]: ({ query }) => {
        expect(query.get("field")).toBe("pensionInsuranceNumber");
        return json({
          participationId,
          group: "ba_details",
          values: { pensionInsuranceNumber: "65170839J003" },
        });
      },
    });
    const show = await screen.findByRole("button", { name: "Rentenversicherungsnummer anzeigen" });
    // Only a given field can be shown.
    expect(screen.queryByRole("button", { name: "Staatsangehörigkeit anzeigen" })).toBeNull();
    await user.click(show);
    expect(await screen.findByText("65170839J003")).toBeInTheDocument();
    expect(calls.filter(({ key }) => key.includes("/sensitive/"))).toHaveLength(1);
  });

  it("shows the PL presence only, never an 'Anzeigen'", async () => {
    setup({
      [`GET ${detailPath}/self-service`]: () =>
        json(
          selfService({
            sensitive: { healthRestrictions: true, severeDisability: false },
            sensitiveReadable: [],
            missing: [],
          }),
        ),
    });
    const health = await screen.findByRole("region", { name: "Gesundheit" });
    expect(within(health).getByText("angegeben")).toBeInTheDocument();
    expect(within(health).getByText("fehlt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /anzeigen$/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Angaben für die Agentur" })).toBeNull();
    expect(screen.getByText("Keine fehlenden Angaben.")).toBeInTheDocument();
  });

  it("says when the viewer may not see it", async () => {
    setup({ [`GET ${detailPath}/self-service`]: () => problem(403, "forbidden") });
    expect(
      await screen.findByText("Sie dürfen die Selbstauskunft dieser Person nicht sehen."),
    ).toBeInTheDocument();
  });
});

describe("assisted mode (Q136)", () => {
  it("needs the confirmation and how, then opens the wizard with its banner", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      [`POST ${detailPath}/assisted-mode`]: () =>
        json(
          {
            assistedModeId,
            participationId,
            how: "phone",
            startedAt: "2026-10-21T10:00:00.000000Z",
          },
          201,
        ),
      [`GET ${assistedPath}`]: ({ query }) => {
        expect(query.get("assistedModeId")).toBe(assistedModeId);
        return json(assistedState);
      },
    });
    await user.click(await screen.findByRole("button", { name: "Assistierte Erfassung starten" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Starten" });
    expect(submit).toBeDisabled();
    await user.click(
      within(dialog).getByLabelText(
        "Die Person ist anwesend oder am Telefon und hat um Unterstützung gebeten",
      ),
    );
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByLabelText("Am Telefon"));
    expect(submit).toBeEnabled();
    await user.click(submit);
    const banner = await screen.findByRole("region", { name: "Assistierte Erfassung" });
    expect(
      within(banner).getByText("Assistierte Erfassung für Erika Mustermann (am Telefon)"),
    ).toBeInTheDocument();
    expect(calls.find(({ key }) => key === `POST ${detailPath}/assisted-mode`)?.body).toEqual({
      confirmed: true,
      how: "phone",
    });
    // The wizard resumes at the first page with missing items.
    expect(await screen.findByRole("heading", { level: 1, name: "Persönliches" })).toBeVisible();
  });

  it("opens Gesundheit without a step-up, showing what the role sees", async () => {
    setup(
      {
        [`GET ${assistedPath}`]: () => json(assistedState),
        [`GET ${assistedPath}/sensitive/health`]: () =>
          json({
            participationId,
            group: "health",
            values: { healthRestrictions: true, severeDisability: false },
          }),
      },
      `${pagePath}/assisted?assistedModeId=${assistedModeId}&how=in_person&step=health`,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Gesundheit" })).toBeVisible();
    const restrictions = await screen.findByRole("group", {
      name: "Gesundheitliche Einschränkungen *",
    });
    expect(within(restrictions).getByRole("radio", { name: "Ja" })).toBeChecked();
    expect(screen.queryByLabelText("Ihr Geburtsdatum")).toBeNull();
    expect(screen.getByText("Assistierte Erfassung für Erika Mustermann (vor Ort)")).toBeVisible();
  });

  it("ends on 'Beenden' and returns to the tab", async () => {
    const user = userEvent.setup();
    const { calls, router } = setup(
      {
        [`GET ${assistedPath}`]: () => json(assistedState),
        [`DELETE ${detailPath}/assisted-mode`]: () => new Response(null, { status: 204 }),
      },
      `${pagePath}/assisted?assistedModeId=${assistedModeId}&how=phone`,
    );
    await user.click(await screen.findByRole("button", { name: "Beenden" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(pagePath));
    expect(calls.map(({ key }) => key)).toContain(`DELETE ${detailPath}/assisted-mode`);
    expect(
      await screen.findByRole("tab", { name: "Selbstauskunft", selected: true }),
    ).toBeVisible();
  });

  it("says when the mode has ended", async () => {
    setup(
      {
        [`GET ${assistedPath}`]: () =>
          problem(403, "forbidden", {
            errors: [{ pointer: "", code: "assisted_mode_required", detail: "x" }],
          }),
      },
      `${pagePath}/assisted?assistedModeId=${assistedModeId}`,
    );
    expect(await screen.findByText("Die assistierte Erfassung ist beendet.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Zurück zur Person" })).toBeVisible();
  });

  it("is offered only with the capability", async () => {
    setup({
      [`GET ${detailPath}`]: () =>
        json({ ...detail, capabilities: { ...detail.capabilities, startAssistedMode: false } }),
    });
    await screen.findByRole("region", { name: "Persönliches" });
    expect(screen.queryByRole("button", { name: "Assistierte Erfassung starten" })).toBeNull();
  });
});
