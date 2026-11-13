import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  json,
  mockApi,
  openSetupStep,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
} from "./test-utils";

// Slice 7b plan D12 (PR 7b-7): "Einrichtung" is a step list with what blocks activation in the
// header; each step's state and one-line status come from what the page already loads.
const path = `/api/v1/projects/${project.id}`;
const label = (name: string) => ({ de: `Agentur ${name} (Beispiel)` });
const catalog = [
  {
    agenturKey: "beispielstadt-nord",
    version: 1,
    label: label("Nord"),
    sample: true,
    sha256: "a".repeat(64),
  },
  {
    agenturKey: "beispielstadt-nord",
    version: 2,
    label: label("Nord"),
    sample: true,
    sha256: "b".repeat(64),
  },
  {
    agenturKey: "beispielstadt-sued",
    version: 1,
    label: label("Süd"),
    sample: true,
    sha256: "c".repeat(64),
  },
];
const nordPin = {
  agenturKey: "beispielstadt-nord",
  version: 2,
  label: label("Nord"),
  sha256Prefix: "bbbbbbbbbbbb",
  pinnedAt: "2026-10-17T08:30:00.123456Z",
  pinnedBy: staffUsers[1]!.id,
  migrationTargets: [],
};
const pinnedConfig = {
  ...unpinnedConfig,
  projectAgenturKey: "beispielstadt-nord",
  pins: [nordPin],
  projectBlockers: [],
  agenturen: [
    {
      agenturKey: "beispielstadt-nord",
      blockers: [
        {
          code: "agentur_submission_blocked",
          step: "agentur_submission",
          agenturKey: "beispielstadt-nord",
          missing: ["leadTimeDays", "originalRequired"],
        },
      ],
      warnings: [],
    },
  ],
  activationBlockers: [],
};
const wave = {
  id: "00000000-0000-4000-a000-000000000010",
  projectId: project.id,
  code: "W1",
  name: "Lager",
  signingDeadline: "2027-03-12",
  defaultTgStart: "2027-04-01",
  defaultTgEnd: "2028-03-31",
  latestEntryDate: "2027-03-31",
  participations: 0,
  createdAt: "2026-10-15T08:30:00.123456Z",
};
const dsvView = (version: string | null, approvedForLive = false) => ({
  version,
  fixed: false,
  versions: version ? [{ version, approvedForLive }] : [],
  capabilities: { pin: true },
});
const settlementView = (
  values: {
    kugFinalSettlementDate?: string | null;
    measure110SettlementDate?: string | null;
    kugRequired?: boolean;
    measureRequired?: boolean;
    fundingUnknown?: boolean;
  } = {},
) => ({
  kugFinalSettlementDate: values.kugFinalSettlementDate ?? null,
  measure110SettlementDate: values.measure110SettlementDate ?? null,
  required: {
    kugFinalSettlementDate: values.kugRequired ?? false,
    measure110SettlementDate: values.measureRequired ?? false,
    fundingUnknown: values.fundingUnknown ?? false,
  },
  capabilities: { set: true },
});

function setup(
  routes: Parameters<typeof mockApi>[0] = {},
  config: object = unpinnedConfig,
  url = `/projects/${project.id}?tab=setup`,
) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(config),
    [`GET ${path}/dsv-template`]: () => json(dsvView(null)),
    [`GET ${path}/settlement-dates`]: () => json(settlementView()),
    "GET /api/v1/config/templates": () => json({ items: catalog, nextCursor: null }),
    ...routes,
  });
  renderApp(url, api);
  return calls;
}

async function setupNavigation() {
  return within(await screen.findByRole("navigation", { name: "Schritte der Einrichtung" }));
}

/** One step's button in the setup list, by its title. */
function stepButton(nav: ReturnType<typeof within>, title: string) {
  return nav.getByText(title, { selector: ".tp-step-title" }).closest("button")!;
}

describe("project setup steps", () => {
  it("lists the setup steps in order with state and one-line status from the loaded data", async () => {
    setup();
    const nav = await setupNavigation();
    expect(
      [...nav.getAllByRole("button")].map(
        (button) => button.querySelector(".tp-step-title")?.textContent,
      ),
    ).toEqual(["Projekt", "Agentur", "Eintrittswellen", "Import", "DSV-Vorlage", "Abrechnung"]);
    expect(stepButton(nav, "Projekt")).toHaveTextContent("Entwurf seit 15.10.2026");
    expect(stepButton(nav, "Agentur")).toHaveTextContent(
      "Blockiert: Es fehlt die Vorlage der Projekt-Agentur.",
    );
    expect(stepButton(nav, "Eintrittswellen")).toHaveTextContent(
      "Offen: Noch keine Eintrittswelle",
    );
    expect(stepButton(nav, "Import")).toHaveTextContent("Offen: Noch keine Teilnehmenden");
    await waitFor(() =>
      expect(stepButton(nav, "DSV-Vorlage")).toHaveTextContent(
        "Offen: Noch keine Vorlage festgelegt",
      ),
    );
    await waitFor(() =>
      expect(stepButton(nav, "Abrechnung")).toHaveTextContent("Erledigt: Nicht erforderlich"),
    );
    expect(screen.getByText("1 Schritt fehlt bis zur Aktivierung")).toBeInTheDocument();
  });

  it("shows a done Agentur, the wave count and the DSV and settlement states once loaded", async () => {
    setup(
      {
        [`GET ${path}/entry-waves`]: () =>
          json({ items: [{ ...wave, participations: 4 }], nextCursor: null }),
        [`GET ${path}/dsv-template`]: () => json(dsvView("dsv:v1")),
        [`GET ${path}/settlement-dates`]: () =>
          json(settlementView({ kugFinalSettlementDate: "2027-03-31", kugRequired: true })),
      },
      pinnedConfig,
    );
    const nav = await setupNavigation();
    expect(stepButton(nav, "Agentur")).toHaveTextContent(
      "Erledigt: Agentur Nord (Beispiel), Vorlage 2",
    );
    expect(stepButton(nav, "Eintrittswellen")).toHaveTextContent("Erledigt: 1 Eintrittswelle");
    expect(stepButton(nav, "Import")).toHaveTextContent("Erledigt: 4 Teilnehmende");
    await waitFor(() =>
      expect(stepButton(nav, "DSV-Vorlage")).toHaveTextContent("Erledigt: dsv:v1 (Muster)"),
    );
    await waitFor(() =>
      expect(stepButton(nav, "Abrechnung")).toHaveTextContent(
        "Erledigt: Schlussabrechnung erfasst",
      ),
    );
  });

  it("says a step is not required where the project type has none", async () => {
    setup({ [`GET ${path}`]: () => json({ ...project, type: "ta_only" }) }, unpinnedConfig);
    const nav = await setupNavigation();
    expect(stepButton(nav, "Eintrittswellen")).toHaveTextContent("Erledigt: Nicht erforderlich");
    expect(nav.queryByRole("button", { name: /^DSV-Vorlage/ })).toBeNull();
    expect(nav.queryByRole("button", { name: /^Abrechnung/ })).toBeNull();
  });

  it("leaves out the import step without the import capability", async () => {
    setup(
      {},
      {
        ...unpinnedConfig,
        capabilities: { ...unpinnedConfig.capabilities, importParticipations: false },
      },
    );
    const nav = await setupNavigation();
    expect(nav.queryByRole("button", { name: /^Import/ })).toBeNull();
  });

  it("leaves out a step the server refuses to show and names the DSV's audience", async () => {
    setup({
      [`GET ${path}/dsv-template`]: () => problem(403, "forbidden"),
      [`GET ${path}/settlement-dates`]: () => problem(403, "forbidden"),
    });
    const nav = await setupNavigation();
    await waitFor(() =>
      expect(stepButton(nav, "DSV-Vorlage")).toHaveTextContent(
        "Die DSV-Vorlage sehen die Projektleitung und das Back Office.",
      ),
    );
    await waitFor(() => expect(nav.queryByRole("button", { name: /^Abrechnung/ })).toBeNull());
  });
});

describe("project setup header", () => {
  it("names each activation blocker with the step that resolves it", async () => {
    setup(
      { [`GET ${path}/entry-waves`]: () => json({ items: [wave], nextCursor: null }) },
      {
        ...unpinnedConfig,
        activationBlockers: ["project_activation_blocked", "no_entry_wave_with_latest_entry_date"],
      },
    );
    expect(await screen.findByText("2 Schritte fehlen bis zur Aktivierung")).toBeInTheDocument();
    expect(
      screen.getByText("Aktivierung blockiert: Es fehlt die Vorlage der Projekt-Agentur."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Aktivierung blockiert: Keine Eintrittswelle hat einen letztmöglichen Eintritt.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Zu „Eintrittswellen“" }));
    expect(screen.getByRole("region", { name: "Eintrittswellen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weiter zu „Agentur“" })).toBeInTheDocument();
    // Blocked, the action stays beside its prerequisite, disabled (ui-patterns.md, principle 3).
    expect(screen.getByRole("button", { name: "Aktivieren" })).toBeDisabled();
  });

  it("offers activation as the one primary action once nothing blocks it", async () => {
    let current = { project: project as object, config: pinnedConfig as object };
    const activeProject = {
      ...project,
      status: "active",
      activatedAt: "2026-10-17T08:30:00.123456Z",
    };
    const activeConfig = {
      ...pinnedConfig,
      capabilities: { ...pinnedConfig.capabilities, activateProject: false },
    };
    const calls = setup({
      [`GET ${path}`]: () => json(current.project),
      [`GET ${path}/config`]: () => json(current.config),
      [`POST ${path}/activation`]: () => {
        current = { project: activeProject, config: activeConfig };
        return json({
          status: "active",
          activatedAt: activeProject.activatedAt,
          warnings: [pinnedConfig.agenturen[0]!.blockers[0]!],
        });
      },
    });
    expect(await screen.findByText("Bereit zur Aktivierung")).toBeInTheDocument();
    expect(screen.getByText(/Die Aktivierung ist endgültig/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Aktivieren" }));
    expect(await screen.findByText("Projekt aktiviert")).toBeInTheDocument();
    expect(calls.find((c) => c.key === `POST ${path}/activation`)?.body).toEqual({});
    const nav = await setupNavigation();
    await waitFor(() =>
      expect(stepButton(nav, "Projekt")).toHaveTextContent("Erledigt: Aktiv seit"),
    );
    expect(
      await screen.findByText("Projekt aktiviert. Noch offen, ohne die Aktivierung zu blockieren:"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aktivieren" })).toBeNull();
  });

  it("shows a refusal and the blockers the reread configuration names", async () => {
    let config: object = pinnedConfig;
    setup({
      [`GET ${path}/config`]: () => json(config),
      [`POST ${path}/activation`]: () => {
        config = { ...pinnedConfig, activationBlockers: ["no_entry_wave_with_latest_entry_date"] };
        return problem(422, "domain-error", {
          errors: [{ pointer: "", code: "no_entry_wave_with_latest_entry_date", detail: "x" }],
        });
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Aktivieren" }));
    // The blocker appears twice: in the header list and in the refusal beside the action.
    expect(
      await screen.findAllByText(
        "Aktivierung blockiert: Keine Eintrittswelle hat einen letztmöglichen Eintritt.",
      ),
    ).not.toHaveLength(0);
    expect(screen.getByText("1 Schritt fehlt bis zur Aktivierung")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aktivieren" })).toBeDisabled();
  });

  // Round 29: activated concurrently by another request. The refusal outlives the activation,
  // which unmounts once the reread configuration no longer offers it; the status follows.
  it("keeps the refusal when another request activated the project meanwhile", async () => {
    let current = { project: project as object, config: pinnedConfig as object };
    setup({
      [`GET ${path}`]: () => json(current.project),
      [`GET ${path}/config`]: () => json(current.config),
      [`POST ${path}/activation`]: () => {
        current = {
          project: { ...project, status: "active", activatedAt: "2026-10-17T08:30:00.123456Z" },
          config: {
            ...pinnedConfig,
            capabilities: { ...pinnedConfig.capabilities, activateProject: false },
          },
        };
        return problem(422, "domain-error", {
          errors: [{ pointer: "", code: "project_not_draft", detail: "x" }],
        });
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Aktivieren" }));
    expect(await screen.findByText("Das Projekt ist bereits aktiv.")).toBeInTheDocument();
    const nav = await setupNavigation();
    await waitFor(() =>
      expect(stepButton(nav, "Projekt")).toHaveTextContent("Erledigt: Aktiv seit"),
    );
    expect(screen.queryByRole("button", { name: "Aktivieren" })).toBeNull();
    expect(screen.queryByText("Bereit zur Aktivierung")).toBeNull();
  });

  // Round 26: only the server's capability offers it (a global org role, another project's PL,
  // an active project); the API's 403 stays authoritative.
  it("offers no primary action when activation isn't available", async () => {
    setup(
      {},
      { ...pinnedConfig, capabilities: { ...pinnedConfig.capabilities, activateProject: false } },
    );
    const nav = await setupNavigation();
    expect(stepButton(nav, "Agentur")).toHaveTextContent("Erledigt");
    expect(screen.queryByRole("button", { name: "Aktivieren" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Weiter zu/ })).toBeNull();
  });
});

describe("project setup Agentur", () => {
  it("shows a project without a Project Agentur and its submission blockers", async () => {
    setup({}, pinnedConfig);
    await openSetupStep("Agentur");
    expect(
      await screen.findByText("Projekt-Agentur: Agentur Nord (Beispiel), Vorlage Version 2"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Agentur Nord (Beispiel) – Einreichung bei der Agentur (TL 407) blockiert, es fehlt: Vorlauf in Tagen, Original erforderlich",
      ),
    ).toBeInTheDocument();
  });

  it("shows the pins with version and hash prefix, and the blockers per Agentur and step", async () => {
    setup({}, pinnedConfig);
    await openSetupStep("Agentur");
    const row = (await screen.findByText("bbbbbbbbbbbb")).closest("tr")!;
    for (const text of ["Agentur Nord (Beispiel)", "beispielstadt-nord", "2", "Projekt-Agentur"]) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
  });

  it("pins the Project Agentur's latest version by default and shows the new state", async () => {
    let config: object = unpinnedConfig;
    const calls = setup({
      [`GET ${path}/config`]: () => json(config),
      [`POST ${path}/config/pins`]: () => {
        config = pinnedConfig;
        return json(pinnedConfig);
      },
    });
    await openSetupStep("Agentur");
    const agentur = await screen.findByRole("combobox", { name: "Agentur" });
    expect(agentur).toHaveValue("beispielstadt-nord");
    expect(screen.getByLabelText("Version")).toHaveValue("2");
    await userEvent.click(screen.getByRole("button", { name: "Als Projekt-Agentur festlegen" }));
    expect(await screen.findByText("Vorlage gepinnt")).toBeInTheDocument();
    expect(calls.find((c) => c.key === `POST ${path}/config/pins`)?.body).toEqual({
      agenturKey: "beispielstadt-nord",
      version: 2,
      projectAgentur: true,
    });
    expect(screen.getByText("bbbbbbbbbbbb")).toBeInTheDocument();
  });

  it("pins a further Agentur or an older version the PL chooses", async () => {
    const calls = setup({ [`POST ${path}/config/pins`]: () => json(pinnedConfig) });
    await openSetupStep("Agentur");
    await userEvent.selectOptions(await screen.findByLabelText("Version"), "1");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Agentur" }),
      "beispielstadt-sued",
    );
    expect(screen.getByLabelText("Version")).toHaveValue("1");
    await userEvent.click(screen.getByRole("button", { name: "Als weitere Agentur pinnen" }));
    await screen.findByText("Vorlage gepinnt");
    expect(calls.find((c) => c.key === `POST ${path}/config/pins`)?.body).toEqual({
      agenturKey: "beispielstadt-sued",
      version: 1,
      projectAgentur: false,
    });
  });

  it("shows a refusal of the API", async () => {
    setup({
      [`POST ${path}/config/pins`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "/version", code: "template_already_pinned", detail: "x" }],
        }),
    });
    await openSetupStep("Agentur");
    await userEvent.click(
      await screen.findByRole("button", { name: "Als weitere Agentur pinnen" }),
    );
    expect(
      await screen.findByText(/Diese Agentur ist bereits gepinnt. Eine andere Version/),
    ).toBeInTheDocument();
  });

  // Round 26: catalog access isn't a capability in this project. A global org role and a PL of
  // another project both read the catalog (Q108) but may not pin here.
  it.each(["a global org role", "the PL of another project"])(
    "offers no pin form to %s, whatever the catalog says",
    async () => {
      const readOnly = {
        ...unpinnedConfig,
        capabilities: { pinTemplate: false, setProjectAgentur: false },
      };
      const calls = setup({}, readOnly);
      await openSetupStep("Agentur");
      expect(await screen.findByRole("region", { name: "Agentur" })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Agentur" })).toBeNull();
      expect(screen.queryByRole("button", { name: /pinnen|festlegen/ })).toBeNull();
      expect(calls.some((c) => c.key === "GET /api/v1/config/templates")).toBe(false);
    },
  );

  it("offers only further Agenturen on an active project (R1)", async () => {
    const active = {
      ...pinnedConfig,
      capabilities: { pinTemplate: true, setProjectAgentur: false },
    };
    setup({}, active);
    await openSetupStep("Agentur");
    expect(
      await screen.findByRole("button", { name: "Als weitere Agentur pinnen" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Als Projekt-Agentur festlegen" })).toBeNull();
  });
});

describe("project setup steps in use", () => {
  it("keeps an unsaved wave draft while the viewer looks at another step", async () => {
    setup();
    await openSetupStep("Eintrittswellen");
    await userEvent.click(await screen.findByRole("button", { name: "Welle anlegen" }));
    await userEvent.type(screen.getByLabelText("Kürzel"), "W1");
    await openSetupStep("Projekt");
    expect(screen.getByRole("region", { name: "Projekt" })).toBeInTheDocument();
    await openSetupStep("Eintrittswellen");
    expect(screen.getByLabelText("Kürzel")).toHaveValue("W1");
  });

  it("opens the step an old anchor names", async () => {
    setup({}, unpinnedConfig, `/projects/${project.id}/setup#project-import`);
    expect(await screen.findByRole("region", { name: "Import" })).toBeInTheDocument();
  });

  it("opens Erweitert for the old Kug 200a anchor", async () => {
    setup({}, unpinnedConfig, `/projects/${project.id}/setup#setup-kug200a`);
    const toggle = await screen.findByRole("button", { name: "Erweitert" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByRole("heading", { name: "Kopf der Kug 200a" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Konfiguration" })).toBeInTheDocument();
  });

  it("keeps the rare settings under a collapsed Erweitert card", async () => {
    setup();
    const toggle = await screen.findByRole("button", { name: "Erweitert" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByText("Agenturbezogene Einstellungen (0) · Lockerungen (0 genehmigt, 0 offen)"),
    ).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "Kopf der Kug 200a" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Konfiguration" })).toBeInTheDocument();
  });
});
