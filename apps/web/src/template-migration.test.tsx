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

// Slice 2 plan 5.8, 5.13 (PR 2e-2; Q36, Q93, R15): in Einrichtung the PL migrates a pinned
// template to a newer version with the review of its Agentur's scoped setting (AC-19, AC-20).
const path = `/api/v1/projects/${project.id}`;
const nord = "beispielstadt-nord";
const pin = (version: number, migrationTargets: number[]) => ({
  agenturKey: nord,
  version,
  label: { de: "Agentur Nord (Beispiel)" },
  sha256Prefix: "bbbbbbbbbbbb",
  pinnedAt: "2026-10-17T08:30:00.123456Z",
  pinnedBy: staffUsers[1]!.id,
  migrationTargets,
});
const scoped = {
  agenturKey: nord,
  settings: { agentur_submission: { leadTimeDays: 12, submissionChannel: "email" } },
  source: "email_agentur",
  confirmedBy: staffUsers[1]!.id,
  confirmedOn: "2026-10-15",
};
const config = (version: number, migrationTargets: number[], extra: object = {}) => ({
  ...unpinnedConfig,
  projectAgenturKey: nord,
  pins: [pin(version, migrationTargets)],
  projectBlockers: [],
  agenturen: [{ agenturKey: nord, blockers: [], warnings: [] }],
  activationBlockers: [],
  override: { version: 1, agenturSettings: [scoped], relaxations: [] },
  ...extra,
});
const before = config(1, [2]);
const after = config(2, [], {
  override: {
    version: 2,
    agenturSettings: [
      { ...scoped, settings: { agentur_submission: { submissionChannel: "email" } } },
    ],
    relaxations: [],
  },
});
const preview = {
  agenturKey: nord,
  fromVersion: 1,
  version: 2,
  expectedVersion: 1,
  settings: [
    { key: "agentur_submission.leadTimeDays", from: 10, to: 14 },
    { key: "asu_registration.batchSubmissionChannel", from: "scan_email", to: "upload" },
  ],
  rules: {
    added: [
      { id: "beispielstadt-nord-mobile", step: "data_collection", basis: "operational_default" },
    ],
    removed: [],
    changed: [],
  },
  fields: { added: [], removed: [], changed: [] },
  overrideIssues: [],
  review: [
    { key: "agentur_submission.leadTimeDays", value: 12, from: 10, to: 14 },
    { key: "agentur_submission.submissionChannel", value: "email", from: "upload", to: "upload" },
  ],
};

function setup(routes: Parameters<typeof mockApi>[0] = {}, initial: object = before) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(initial),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`POST ${path}/config/pins/${nord}/migration-preview`]: () => json(preview),
    ...routes,
  });
  renderApp(`/projects/${project.id}`, api);
  return calls;
}
const action = "Agentur Nord (Beispiel) migrieren";
const openPreview = async () => {
  await userEvent.click(await screen.findByRole("button", { name: action }));
  expect(screen.getByLabelText("Neue Version")).toHaveValue("2");
  await userEvent.click(screen.getByRole("button", { name: "Änderungen anzeigen" }));
};

/** Chooses keep or remove for the reviewed setting whose legend matches. */
const decide = async (setting: RegExp, choice: string) =>
  userEvent.click(
    within(await screen.findByRole("group", { name: setting })).getByRole("radio", {
      name: choice,
    }),
  );

describe("template migration with review", () => {
  it("shows what the new version changes and asks keep or remove for every scoped key", async () => {
    setup();
    await openPreview();
    for (const text of [
      "Einstellung Vorlauf in Tagen: bisher 10, neu 14",
      "Einstellung Übermittlungsweg Kug 200b: bisher Scan per E-Mail, neu Upload",
      "Neue Regel beispielstadt-nord-mobile (Datenerfassung)",
    ]) {
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
    expect(
      screen.getByText("Vorlauf in Tagen: im Projekt 12; Vorlage bisher 10, neu 14"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Übermittlungsweg TL 407: im Projekt E-Mail; Vorlage bisher Upload, neu Upload",
      ),
    ).toBeInTheDocument();
    // Every key needs a decision before the migration can be confirmed (R15).
    expect(screen.getByRole("button", { name: "Migration bestätigen" })).toBeDisabled();
  });

  it("confirms with the decisions and shows the result after rereading the configuration", async () => {
    let current: object = before;
    const calls = setup({
      [`GET ${path}/config`]: () => json(current),
      [`POST ${path}/config/pins/${nord}/migration`]: () => {
        current = after;
        return json(after);
      },
    });
    await openPreview();
    await decide(/^Vorlauf in Tagen: im Projekt/, "Entfernen (dann gilt die Vorlage)");
    await decide(/^Übermittlungsweg TL 407: im Projekt/, "Beibehalten");
    await userEvent.click(screen.getByRole("button", { name: "Migration bestätigen" }));
    expect(
      await screen.findByText(
        "Agentur Nord (Beispiel) nutzt jetzt Version 2. Entfernte Einstellungen: Vorlauf in Tagen.",
      ),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.key === `POST ${path}/config/pins/${nord}/migration`)?.body).toEqual(
      {
        fromVersion: 1,
        version: 2,
        expectedVersion: 1,
        decisions: {
          "agentur_submission.leadTimeDays": "remove",
          "agentur_submission.submissionChannel": "keep",
        },
      },
    );
    // No newer version is left, so the action is gone; the result stays.
    expect(screen.queryByRole("button", { name: action })).toBeNull();
    expect(screen.queryByText("Migration bestätigen")).toBeNull();
    // Nothing renders a staff id (Q109).
    expect(document.body.textContent).not.toContain(staffUsers[1]!.id);
  });

  it("names override issues and doesn't offer the confirm (AC-16)", async () => {
    setup({
      [`POST ${path}/config/pins/${nord}/migration-preview`]: () =>
        json({ ...preview, overrideIssues: ["rule_redefined"], review: [] }),
    });
    await openPreview();
    expect(
      await screen.findByText(
        "Mit dieser Version wäre die Projektkonfiguration ungültig. Die Migration ist so nicht möglich.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Für diese Agentur gibt es keine agenturbezogene Einstellung zu prüfen."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Migration bestätigen" })).toBeDisabled();
  });

  // Round 29: after a concurrent change the refusal outlives the migration, which unmounts
  // once the reread configuration offers no newer version; everything shown is reread.
  it("keeps the refusal after a concurrent migration and rereads the project and configuration", async () => {
    let current: object = before;
    const calls = setup({
      [`GET ${path}/config`]: () => json(current),
      [`POST ${path}/config/pins/${nord}/migration`]: () => {
        current = after;
        return problem(409, "conflict");
      },
    });
    await openPreview();
    for (const radio of screen.getAllByRole("radio", { name: "Beibehalten" })) {
      await userEvent.click(radio);
    }
    const reads = () =>
      calls.filter((c) => c.key === `GET ${path}` || c.key === `GET ${path}/config`).length;
    const readsBefore = reads();
    await userEvent.click(screen.getByRole("button", { name: "Migration bestätigen" }));
    expect(
      await screen.findByText(
        "Die Vorlage oder die Projektkonfiguration wurde inzwischen geändert und neu geladen. Bitte zeigen Sie die Änderungen erneut an.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Projekt-Agentur: Agentur Nord (Beispiel), Vorlage Version 2"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: action })).toBeNull();
    expect(reads()).toBeGreaterThanOrEqual(readsBefore + 2);
  });

  // Round 31: the target can't change while its preview loads, so a preview (and a confirm) never
  // belongs to another target than the one shown.
  it("locks the target while its preview loads", async () => {
    let answer!: (response: Response) => void;
    const calls = setup(
      {
        [`POST ${path}/config/pins/${nord}/migration-preview`]: () =>
          new Promise<Response>((resolve) => (answer = resolve)),
      },
      config(1, [2, 3]),
    );
    await userEvent.click(await screen.findByRole("button", { name: action }));
    const target = screen.getByLabelText("Neue Version");
    expect(target).toHaveValue("3");
    await userEvent.selectOptions(target, "2");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen anzeigen" }));
    expect(target).toBeDisabled();
    await userEvent.selectOptions(target, "3").catch(() => undefined);
    expect(target).toHaveValue("2");
    answer(json(preview));
    expect(await screen.findByText("Was Version 2 ändert")).toBeInTheDocument();
    expect(target).toBeEnabled();
    expect(target).toHaveValue("2");
    expect(
      calls.filter((c) => c.key === `POST ${path}/config/pins/${nord}/migration-preview`),
    ).toEqual([
      { key: `POST ${path}/config/pins/${nord}/migration-preview`, body: { version: 2 } },
    ]);
  });

  // Round 26: only the server's capability and the pin's targets offer it.
  it.each([
    [
      "a role without the operation",
      config(1, [], { capabilities: { ...unpinnedConfig.capabilities, migrateTemplate: false } }),
    ],
    ["a pin without a newer version", config(2, [])],
  ])("isn't offered to %s", async (_label, initial) => {
    setup({}, initial);
    expect(await screen.findByText("Einrichtung")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: action })).toBeNull();
    const setupSection = screen.getByRole("region", { name: "Einrichtung" });
    expect(within(setupSection).queryByRole("columnheader", { name: "Aktionen" })).toBeNull();
  });
});
