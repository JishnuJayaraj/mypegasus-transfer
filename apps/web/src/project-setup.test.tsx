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

// Slice 2 plan 5.8, 5.13 (PR 2c-2): the setup section shows the Project Agentur, the pins and the
// blockers; the PL pins from the catalog.
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

function setup(routes: Parameters<typeof mockApi>[0] = {}, config: object = unpinnedConfig) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(config),
    "GET /api/v1/config/templates": () => json({ items: catalog, nextCursor: null }),
    ...routes,
  });
  renderApp(`/projects/${project.id}`, api);
  return calls;
}

describe("project setup", () => {
  it("shows a project without a Project Agentur and its activation blocker", async () => {
    setup();
    expect(
      await screen.findByText(/Es ist noch keine Projekt-Agentur gewählt/),
    ).toBeInTheDocument();
    expect(screen.getByText("Es ist noch keine Vorlage gepinnt.")).toBeInTheDocument();
    // In the blocker list and again at the activation it blocks.
    expect(
      screen.getAllByText("Aktivierung blockiert: Es fehlt die Vorlage der Projekt-Agentur."),
    ).toHaveLength(2);
  });

  it("shows the pins with version and hash prefix, and the blockers per Agentur and step", async () => {
    setup({}, pinnedConfig);
    expect(
      await screen.findByText("Projekt-Agentur: Agentur Nord (Beispiel), Vorlage Version 2"),
    ).toBeInTheDocument();
    const row = screen.getByText("bbbbbbbbbbbb").closest("tr")!;
    for (const text of ["Agentur Nord (Beispiel)", "beispielstadt-nord", "2", "Projekt-Agentur"]) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        "Agentur Nord (Beispiel) – Einreichung bei der Agentur (TL 407) blockiert, es fehlt: Vorlauf in Tagen, Original erforderlich",
      ),
    ).toBeInTheDocument();
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
    const agentur = await screen.findByLabelText("Agentur");
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
    await userEvent.selectOptions(await screen.findByLabelText("Version"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Agentur"), "beispielstadt-sued");
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
      expect(await screen.findByText("Einrichtung")).toBeInTheDocument();
      expect(screen.queryByLabelText("Agentur")).toBeNull();
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
    expect(
      await screen.findByRole("button", { name: "Als weitere Agentur pinnen" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Als Projekt-Agentur festlegen" })).toBeNull();
  });
});

// Slice 2 plan 5.5, 5.13 (PR 2e-1): the PL activates a draft project from the server's capability.
describe("project activation", () => {
  const activeProject = {
    ...project,
    status: "active",
    activatedAt: "2026-10-17T08:30:00.123456Z",
  };
  const activeConfig = {
    ...pinnedConfig,
    capabilities: {
      ...pinnedConfig.capabilities,
      setProjectAgentur: false,
      activateProject: false,
    },
  };
  const warning = pinnedConfig.agenturen[0]!.blockers[0]!;

  it("names the blockers it would hit and can't be used while there are any", async () => {
    setup(
      {},
      {
        ...unpinnedConfig,
        activationBlockers: ["project_activation_blocked", "no_entry_wave_with_latest_entry_date"],
      },
    );
    expect(await screen.findByText("Status: Entwurf.", { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText("Die Aktivierung ist erst möglich, wenn diese Blocker behoben sind:"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Aktivierung blockiert: Keine Eintrittswelle hat einen letztmöglichen Eintritt.",
      ),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Aktivieren" })).toBeDisabled();
  });

  it("activates, shows the status and the non-blocking warnings, and offers it no more", async () => {
    let current = { project: project as object, config: pinnedConfig as object };
    const calls = setup({
      [`GET ${path}`]: () => json(current.project),
      [`GET ${path}/config`]: () => json(current.config),
      [`POST ${path}/activation`]: () => {
        current = { project: activeProject, config: activeConfig };
        return json({
          status: "active",
          activatedAt: activeProject.activatedAt,
          warnings: [warning],
        });
      },
    });
    expect(await screen.findByText("Projekt aktivieren", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByText(/Die Aktivierung ist endgültig/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Aktivieren" }));
    expect(await screen.findByText("Projekt aktiviert")).toBeInTheDocument();
    expect(calls.find((c) => c.key === `POST ${path}/activation`)?.body).toEqual({});
    expect(await screen.findByText(/^Status: aktiv seit/)).toBeInTheDocument();
    expect(
      screen.getByText("Projekt aktiviert. Noch offen, ohne die Aktivierung zu blockieren:"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Agentur Nord (Beispiel) – Einreichung bei der Agentur (TL 407) blockiert, es fehlt: Vorlauf in Tagen, Original erforderlich",
      ).length,
    ).toBeGreaterThan(1);
    expect(screen.queryByRole("button", { name: "Aktivieren" })).toBeNull();
  });

  it("shows a refusal of the API and the current blockers", async () => {
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
    expect(
      await screen.findByText("Die Aktivierung ist erst möglich, wenn diese Blocker behoben sind:"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Aktivierung blockiert: Keine Eintrittswelle hat einen letztmöglichen Eintritt.",
      ),
    ).toHaveLength(3);
  });

  // Round 26: only the server's capability offers it (a global org role, another project's PL,
  // an active project); the API's 403 stays authoritative.
  it.each([
    [
      "a role without the operation",
      { ...pinnedConfig, capabilities: { ...pinnedConfig.capabilities, activateProject: false } },
    ],
    ["an active project", activeConfig],
  ])("isn't offered to %s", async (_label, config) => {
    setup({}, config);
    expect(await screen.findByText("Einrichtung")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aktivieren" })).toBeNull();
    expect(screen.queryByText("Projekt aktivieren")).toBeNull();
  });
});
