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

// Slice 2 plan 5.9, 5.13 (PR 2d-1b): the Konfiguration section lists the Agentur-scoped settings
// with source, confirmer and date; the PL sets and removes them (round 8, Q93, R14).
const path = `/api/v1/projects/${project.id}`;
const settingPath = (key: string) => `${path}/config/agentur-settings/${key}`;
const nord = "beispielstadt-nord";
const ost = "beispielstadt-ost";
const nordPin = {
  agenturKey: nord,
  version: 2,
  label: { de: "Agentur Nord (Beispiel)" },
  sha256Prefix: "bbbbbbbbbbbb",
  pinnedAt: "2026-10-17T08:30:00.123456Z",
  pinnedBy: staffUsers[1]!.id,
};
const otherStaff = "00000000-0000-4000-8000-000000000009";
const scoped = (agenturKey: string, confirmedBy = staffUsers[1]!.id) => ({
  agenturKey,
  settings: { agentur_submission: { leadTimeDays: 5, originalRequired: true } },
  source: "phone_call_agentur",
  confirmedBy,
  confirmedOn: "2026-10-16",
});
const base = { ...unpinnedConfig, pins: [nordPin] };
const withSettings = {
  ...base,
  override: { version: 2, agenturSettings: [scoped(nord), scoped(ost, otherStaff)] },
};

function setup(routes: Parameters<typeof mockApi>[0] = {}, config: object = base) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(config),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    ...routes,
  });
  renderApp(`/projects/${project.id}`, api);
  return calls;
}

const section = async () =>
  within((await screen.findByRole("heading", { name: "Konfiguration" })).closest("section")!);

async function fillForm(options: { date?: string } = {}) {
  const form = await section();
  await userEvent.click(
    form.getByRole("button", { name: "Agenturbezogene Einstellung hinzufügen" }),
  );
  await userEvent.selectOptions(form.getByLabelText("Übermittlungsweg TL 407"), "upload");
  await userEvent.type(form.getByLabelText("Vorlauf in Tagen"), "7");
  await userEvent.selectOptions(form.getByLabelText("Quelle"), "email_agentur");
  await userEvent.type(form.getByLabelText("Bestätigt am"), options.date ?? "16.10.2026");
  return form;
}

describe("Konfiguration: Agentur-scoped settings", () => {
  it("lists each setting with its values, source, confirmer and date", async () => {
    setup({}, withSettings);
    const form = await section();
    expect(form.getByText("Stand der Projektkonfiguration: Version 2")).toBeInTheDocument();
    const nordRow = form.getByText("Agentur Nord (Beispiel)").closest("tr")!;
    // The viewer's own name, once GET /me has answered.
    expect(await within(nordRow).findByText("Petra Projektleitung")).toBeInTheDocument();
    for (const text of [
      "Original erforderlich: Ja; Vorlauf in Tagen: 5",
      "Telefonat mit der Agentur",
      "16.10.2026",
    ]) {
      expect(within(nordRow).getByText(text)).toBeInTheDocument();
    }
    // No staff directory yet (Q109, round 27): another confirmer is never shown by an id.
    const ostRow = form.getByText(ost).closest("tr")!;
    expect(within(ostRow).getByText("Andere berechtigte Person")).toBeInTheDocument();
    expect(within(ostRow).queryByText(/00000000/)).toBeNull();
  });

  // Round 26: the server's capability decides, never the role.
  it("offers no changes without the changeOverride capability", async () => {
    const readOnly = {
      ...withSettings,
      capabilities: { pinTemplate: false, setProjectAgentur: false, changeOverride: false },
    };
    setup({}, readOnly);
    const form = await section();
    expect(form.getByText("Agentur Nord (Beispiel)")).toBeInTheDocument();
    expect(form.queryByRole("button")).toBeNull();
    expect(form.queryByText("Aktionen")).toBeNull();
  });

  it("sets a setting for a pinned Agentur with the loaded version, sending only what is set", async () => {
    const saved = { ...base, override: { version: 1, agenturSettings: [scoped(nord)] } };
    const calls = setup({ [`PUT ${settingPath(nord)}`]: () => json(saved) });
    const form = await fillForm();
    await userEvent.click(form.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Einstellung gespeichert")).toBeInTheDocument();
    expect(calls.find((c) => c.key === `PUT ${settingPath(nord)}`)?.body).toEqual({
      expectedVersion: 0,
      settings: { agentur_submission: { submissionChannel: "upload", leadTimeDays: 7 } },
      source: "email_agentur",
      confirmedOn: "2026-10-16",
    });
    expect(form.getByText("Stand der Projektkonfiguration: Version 1")).toBeInTheDocument();
  });

  it("sets a setting for an Agentur without a template by its key", async () => {
    const calls = setup({ [`PUT ${settingPath(ost)}`]: () => json(base) });
    const form = await section();
    await userEvent.click(
      form.getByRole("button", { name: "Agenturbezogene Einstellung hinzufügen" }),
    );
    await userEvent.selectOptions(form.getByLabelText("Agentur der Einstellung"), "");
    await userEvent.type(form.getByLabelText("Schlüssel der Agentur"), ost);
    await userEvent.selectOptions(form.getByLabelText("Original erforderlich"), "false");
    await userEvent.selectOptions(form.getByLabelText("Quelle"), "letter_agentur");
    await userEvent.type(form.getByLabelText("Bestätigt am"), "01.10.2026");
    await userEvent.click(form.getByRole("button", { name: "Speichern" }));
    await screen.findByText("Einstellung gespeichert");
    expect(calls.find((c) => c.key === `PUT ${settingPath(ost)}`)?.body).toMatchObject({
      settings: { agentur_submission: { originalRequired: false } },
    });
  });

  it("shows every refusal at its field and checks the date and the day count first", async () => {
    const calls = setup({
      [`PUT ${settingPath(nord)}`]: () =>
        problem(422, "domain-error", {
          errors: [
            { pointer: "/settings", code: "settings_empty", detail: "x" },
            { pointer: "/confirmedOn", code: "confirmed_on_in_future", detail: "x" },
          ],
        }),
    });
    const form = await fillForm({ date: "31.02.2026" });
    await userEvent.click(form.getByRole("button", { name: "Speichern" }));
    expect(
      form.getByText("Bitte ein gültiges Datum im Format TT.MM.JJJJ angeben."),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.key.startsWith("PUT"))).toBe(false);
    const date = form.getByLabelText("Bestätigt am");
    await userEvent.clear(date);
    await userEvent.type(date, "18.10.2026");
    await userEvent.click(form.getByRole("button", { name: "Speichern" }));
    expect(
      await form.findByText("Legen Sie mindestens eine Einstellung fest."),
    ).toBeInTheDocument();
    expect(
      form.getByText("Das Bestätigungsdatum darf nicht in der Zukunft liegen."),
    ).toBeInTheDocument();
  });

  it("reloads the configuration after a 409 and says so", async () => {
    let loads = 0;
    setup({
      [`GET ${path}/config`]: () => {
        loads += 1;
        return json(base);
      },
      [`PUT ${settingPath(nord)}`]: () => problem(409, "conflict"),
    });
    const form = await fillForm();
    await userEvent.click(form.getByRole("button", { name: "Speichern" }));
    expect(
      await form.findByText(/Die Konfiguration wurde inzwischen geändert und neu geladen/),
    ).toBeInTheDocument();
    expect(loads).toBe(2);
  });

  it("edits a setting with its values loaded, and removes one with the loaded version", async () => {
    let expectedVersion: string | null = null;
    setup(
      {
        [`DELETE ${settingPath(ost)}`]: ({ query }) => {
          expectedVersion = query.get("expectedVersion");
          return json(base);
        },
      },
      withSettings,
    );
    const form = await section();
    await userEvent.click(form.getByRole("button", { name: "Agentur Nord (Beispiel) bearbeiten" }));
    expect(form.getByLabelText("Vorlauf in Tagen")).toHaveValue("5");
    expect(form.getByLabelText("Original erforderlich")).toHaveValue("true");
    expect(form.getByLabelText("Quelle")).toHaveValue("phone_call_agentur");
    expect(form.queryByLabelText("Agentur der Einstellung")).toBeNull();
    await userEvent.click(form.getByRole("button", { name: "Abbrechen" }));
    await userEvent.click(form.getByRole("button", { name: `${ost} entfernen` }));
    expect(await screen.findByText("Einstellung entfernt")).toBeInTheDocument();
    expect(expectedVersion).toBe("2");
    expect(form.getByText(/Es gibt keine agenturbezogenen Einstellungen/)).toBeInTheDocument();
  });
});
