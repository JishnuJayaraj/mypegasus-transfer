import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, mockApi, problem, project, renderApp, staffUsers } from "./test-utils";

// AC-8 (Slice 2 plan 5.6, 5.13): the project page lists the waves, and one form creates and
// edits a wave and shows each domain error at its field.
const loggedIn = {
  "GET /api/v1/me": () => json(staffUsers[1]),
  "GET /api/v1/dev/staff-users": () => json(staffUsers),
};
const path = `/api/v1/projects/${project.id}`;
const w1 = {
  id: "00000000-0000-4000-b000-000000000001",
  projectId: project.id,
  code: "W1",
  name: "Welle 1",
  signingDeadline: "2091-02-15",
  defaultTgStart: "2091-03-01",
  defaultTgEnd: "2092-02-29",
  latestEntryDate: "2091-03-15",
  participations: 4,
  createdAt: "2026-10-15T08:30:00.123456Z",
  updatedAt: "2026-10-15T08:30:00.123456Z",
};

function setup(routes: Parameters<typeof mockApi>[0] = {}, waves = [w1]) {
  const { api, calls } = mockApi({
    ...loggedIn,
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: waves, nextCursor: null }),
    ...routes,
  });
  renderApp(`/projects/${project.id}`, api);
  return calls;
}

describe("project page", () => {
  it("shows the project and its waves with German dates", async () => {
    setup();
    expect(
      await screen.findByRole("heading", { name: "Restrukturierung Werk Nord" }),
    ).toBeInTheDocument();
    const row = screen.getByText("Welle 1").closest("tr")!;
    for (const text of ["W1", "15.02.2091", "01.03.2091", "29.02.2092", "15.03.2091", "4"]) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
  });

  it("is reached from the project list", async () => {
    const { api } = mockApi({
      ...loggedIn,
      "GET /api/v1/projects": () => json({ items: [project], nextCursor: null }),
      [`GET ${path}`]: () => json(project),
      [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    });
    renderApp("/projects", api);
    await userEvent.click(await screen.findByRole("link", { name: "Restrukturierung Werk Nord" }));
    expect(await screen.findByText("Es gibt noch keine Eintrittswellen.")).toBeInTheDocument();
  });

  it("explains that a ta_only project has no waves", async () => {
    const { api } = mockApi({
      ...loggedIn,
      [`GET ${path}`]: () => json({ ...project, type: "ta_only" }),
    });
    renderApp(`/projects/${project.id}`, api);
    expect(
      await screen.findByText("Nur Projekte mit Transfergesellschaft haben Eintrittswellen."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Welle anlegen" })).not.toBeInTheDocument();
  });
});

describe("wave form (AC-8)", () => {
  it("creates a wave with its dates and shows it in the list", async () => {
    let waves = [w1];
    const created = {
      ...w1,
      id: "00000000-0000-4000-b000-000000000003",
      code: "W3",
      name: "Welle 3",
    };
    const calls = setup({
      [`GET ${path}/entry-waves`]: () => json({ items: waves, nextCursor: null }),
      [`POST ${path}/entry-waves`]: () => {
        waves = [w1, created];
        return json(created, 201);
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Welle anlegen" }));
    expect(screen.getByText(/Keine personenbezogenen Daten/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Kürzel"), "W3");
    await userEvent.type(screen.getByLabelText("Bezeichnung"), "Welle 3");
    await userEvent.type(screen.getByLabelText("Letztmöglicher Eintritt"), "15.3.2091");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByText("Welle 3")).toBeInTheDocument();
    expect(screen.getByText("Eintrittswelle gespeichert")).toBeInTheDocument();
    expect(calls.find((c) => c.key === `POST ${path}/entry-waves`)?.body).toEqual({
      code: "W3",
      name: "Welle 3",
      signingDeadline: null,
      defaultTgStart: null,
      defaultTgEnd: null,
      latestEntryDate: "2091-03-15",
    });
  });

  it("edits a wave: prefilled, only the changed fields are sent, a cleared date as null", async () => {
    const calls = setup({
      [`PATCH ${path}/entry-waves/${w1.id}`]: () => json({ ...w1, defaultTgEnd: null }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "W1 bearbeiten" }));
    const end = screen.getByLabelText("TG-Ende (Standard)");
    expect(end).toHaveValue("29.02.2092");
    await userEvent.clear(end);
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByText("Eintrittswelle gespeichert")).toBeInTheDocument();
    // Round 24: never the whole loaded wave, which could undo another PL's edit of another field.
    expect(calls.find((c) => c.key === `PATCH ${path}/entry-waves/${w1.id}`)?.body).toEqual({
      defaultTgEnd: null,
    });
  });

  it("sends nothing for an edit without changes and says so", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByRole("button", { name: "W1 bearbeiten" }));
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Es wurde nichts geändert.")).toBeInTheDocument();
    expect(calls.some((c) => c.key.startsWith("PATCH"))).toBe(false);
  });

  it("shows every error of one field (round 24)", async () => {
    setup({
      [`PATCH ${path}/entry-waves/${w1.id}`]: () =>
        problem(422, "domain-error", {
          errors: [
            { pointer: "/latestEntryDate", code: "latest_entry_in_past", detail: "x" },
            { pointer: "/latestEntryDate", code: "cutoff_passed", detail: "x" },
          ],
        }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "W1 bearbeiten" }));
    const latest = screen.getByLabelText("Letztmöglicher Eintritt");
    await userEvent.clear(latest);
    await userEvent.type(latest, "01.01.2091");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(
      await screen.findByText("Der letztmögliche Eintritt darf nicht in der Vergangenheit liegen."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Der letztmögliche Eintritt ist verstrichen und kann nicht mehr geändert werden.",
      ),
    ).toBeInTheDocument();
  });

  it("shows each domain error at its field and a whole-wave error above the form", async () => {
    setup({
      [`PATCH ${path}/entry-waves/${w1.id}`]: () =>
        problem(422, "domain-error", {
          errors: [
            { pointer: "/code", code: "code_taken", detail: "x" },
            { pointer: "/defaultTgEnd", code: "period_exceeds_twelve_months", detail: "x" },
            { pointer: "/latestEntryDate", code: "cutoff_passed", detail: "x" },
            { pointer: "", code: "not_ta_tg", detail: "x" },
          ],
        }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "W1 bearbeiten" }));
    await userEvent.type(screen.getByLabelText("Kürzel"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(
      await screen.findByText("Dieses Kürzel hat schon eine andere Welle."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Kürzel")).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText("Die TG-Dauer darf zwölf Monate nicht überschreiten."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Der letztmögliche Eintritt ist verstrichen und kann nicht mehr geändert werden.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Nur Projekte mit Transfergesellschaft haben Eintrittswellen.").length,
    ).toBeGreaterThan(0);
  });

  it("refuses an impossible date without asking the API", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Welle anlegen" }));
    await userEvent.type(screen.getByLabelText("Unterschriftsfrist"), "31.02.2091");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Ungültiges Datum (TT.MM.JJJJ)")).toBeInTheDocument();
    expect(calls.some((c) => c.key === `POST ${path}/entry-waves`)).toBe(false);
  });

  it("says so when the user may not edit waves (403)", async () => {
    setup({ [`POST ${path}/entry-waves`]: () => problem(403, "forbidden") });
    await userEvent.click(await screen.findByRole("button", { name: "Welle anlegen" }));
    await userEvent.type(screen.getByLabelText("Kürzel"), "W3");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(
      await screen.findByText("Nur die Projektleitung kann Eintrittswellen bearbeiten."),
    ).toBeInTheDocument();
  });
});
