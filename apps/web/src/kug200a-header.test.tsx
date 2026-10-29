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

// The Kug 200a's header on "Einrichtung" (ba-forms.md, the Kug 200a as built): the PL edits the
// project's T-Kug-Nummer and the employer's Betriebsnummer and Branche/WK; others read them.
const path = `/api/v1/projects/${project.id}`;

function setup(routes: Parameters<typeof mockApi>[0] = {}, config = unpinnedConfig) {
  return mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json({ ...project, employerBetriebsnummer: "87654321" }),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(config),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    ...routes,
  });
}

const openSection = async () => {
  await userEvent.click(await screen.findByRole("tab", { name: "Einrichtung" }));
  return within(
    (await screen.findByRole("heading", { name: "Kopf der Kug 200a" })).closest("section")!,
  );
};

describe("the Kug 200a's header", () => {
  it("sends only the changed keys, an emptied one as null", async () => {
    const { api, calls } = setup({ [`PATCH ${path}`]: () => json(project) });
    renderApp(`/projects/${project.id}?tab=setup`, api);
    const section = await openSection();
    await userEvent.type(section.getByLabelText("T-Kug-Nummer"), "123-456");
    await userEvent.clear(
      section.getByLabelText("Betriebsnummer des personalabgebenden Betriebes"),
    );
    await userEvent.click(section.getByRole("button", { name: "Kopf speichern" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `PATCH ${path}`,
        body: { tKugNumber: "123-456", employerBetriebsnummer: null },
      }),
    );
    expect(await section.findByText("Gespeichert.")).toBeInTheDocument();
  });

  it("explains a refused value at its field and says when nothing changed", async () => {
    const { api } = setup({
      [`PATCH ${path}`]: () =>
        problem(400, "validation-error", {
          errors: [{ pointer: "/tKugNumber", code: "t_kug_prefix", detail: "x" }],
        }),
    });
    renderApp(`/projects/${project.id}?tab=setup`, api);
    const section = await openSection();
    await userEvent.click(section.getByRole("button", { name: "Kopf speichern" }));
    expect(await section.findByText("Nichts geändert.")).toBeInTheDocument();
    await userEvent.type(section.getByLabelText("T-Kug-Nummer"), "TK-1");
    await userEvent.click(section.getByRole("button", { name: "Kopf speichern" }));
    expect(
      await section.findByText("Ohne „TK-“ eingeben: das Formular druckt es schon."),
    ).toBeInTheDocument();
  });

  it("reports a failed save", async () => {
    const { api } = setup({ [`PATCH ${path}`]: () => problem(403, "forbidden") });
    renderApp(`/projects/${project.id}?tab=setup`, api);
    const section = await openSection();
    await userEvent.type(section.getByLabelText("T-Kug-Nummer"), "1");
    await userEvent.click(section.getByRole("button", { name: "Kopf speichern" }));
    expect(
      await section.findByText("Die Angaben konnten nicht gespeichert werden."),
    ).toBeInTheDocument();
  });

  it("shows the values read-only without the capability", async () => {
    const readOnly = {
      ...unpinnedConfig,
      capabilities: { ...unpinnedConfig.capabilities, editKug200aHeader: false },
    };
    const { api } = setup({}, readOnly);
    renderApp(`/projects/${project.id}?tab=setup`, api);
    const section = await openSection();
    expect(section.queryByRole("button", { name: "Kopf speichern" })).toBeNull();
    expect(section.getByText("87654321")).toBeInTheDocument();
    expect(section.getAllByText("nicht erfasst")).toHaveLength(2);
  });
});
