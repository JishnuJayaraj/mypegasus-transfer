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

// Slice 2 plan, "Planned in PR 2h" (PR 2h-2; R32): adding one person by hand.
const path = `/api/v1/projects/${project.id}`;
const createdId = "00000000-0000-4000-a000-000000000077";
const existingId = "00000000-0000-4000-a000-000000000001";
const wave = {
  id: "00000000-0000-4000-b000-000000000001",
  projectId: project.id,
  code: "W1",
  name: "Welle 1",
  signingDeadline: null,
  defaultTgStart: null,
  defaultTgEnd: null,
  latestEntryDate: null,
  participations: 0,
  createdAt: "2026-10-15T08:30:00.123456Z",
  updatedAt: "2026-10-15T08:30:00.123456Z",
};
const created = { id: createdId, projectId: project.id };

function setup(post: Parameters<typeof mockApi>[0][string], config: object = unpinnedConfig) {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json(project),
    [`GET ${path}/entry-waves`]: () => json({ items: [wave], nextCursor: null }),
    [`GET ${path}/config`]: () => json(config),
    [`GET ${path}/participations`]: () => json({ items: [], nextCursor: null }),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`POST ${path}/participations`]: post,
  });
  renderApp(`/projects/${project.id}`, api);
  return calls;
}

const posted = (calls: ReturnType<typeof setup>) =>
  calls.filter((c) => c.key === `POST ${path}/participations`).map((c) => c.body);
const refused = (...errors: [string, string][]) =>
  problem(422, "domain-error", {
    errors: errors.map(([pointer, code]) => ({ pointer, code, detail: "Refused" })),
  });

async function open() {
  const section = await screen.findByRole("region", { name: "Teilnehmende" });
  await userEvent.click(
    within(section).getByRole("button", { name: "Teilnehmende Person anlegen" }),
  );
  return section;
}
const fill = async (label: string, value: string) =>
  userEvent.type(screen.getByLabelText(label), value);

describe("manual creation", () => {
  it("is offered only with the import's capability", async () => {
    setup(() => json(created, 201), {
      ...unpinnedConfig,
      capabilities: { ...unpinnedConfig.capabilities, importParticipations: false },
    });
    const section = await screen.findByRole("region", { name: "Teilnehmende" });
    expect(
      within(section).queryByRole("button", { name: "Teilnehmende Person anlegen" }),
    ).toBeNull();
  });

  it("sends the entered values and the wave, then offers the new person's page", async () => {
    const calls = setup(() => json(created, 201));
    await open();
    await fill("Personalnummer", "BSP-0100");
    await fill("Nachname", "Beispiel");
    await fill("Geburtsdatum", "01.01.1970");
    await userEvent.selectOptions(screen.getByLabelText("Eintrittswelle"), "W1 – Welle 1");
    expect(screen.getByText(/Land der Anschrift: Deutschland/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("link", { name: "Seite der Person öffnen" })).toHaveAttribute(
      "href",
      `/projects/${project.id}/participations/${createdId}`,
    );
    expect(posted(calls)).toEqual([
      {
        values: { personnelNumber: "BSP-0100", lastName: "Beispiel", birthDate: "01.01.1970" },
        waveId: wave.id,
        confirmWarnings: false,
        createDespiteDuplicate: false,
      },
    ]);
  });

  it("shows refusals at their fields, the address at the street", async () => {
    setup(() =>
      refused(
        ["/values/lastName", "required_missing"],
        ["/values/address", "address_incomplete"],
        ["/values/phone", "value_invalid"],
      ),
    );
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Pflichtangabe fehlt")).toBeInTheDocument();
    expect(screen.getByText(/Die Anschrift ist unvollständig/)).toBeInTheDocument();
    expect(screen.getByText(/Ungültiger Wert; bitte korrigieren/)).toBeInTheDocument();
    expect(screen.getByLabelText("Nachname")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Straße und Hausnummer")).toHaveAttribute("aria-invalid", "true");
  });

  it("asks for the PL's word on warnings and a possible duplicate, then sends it", async () => {
    let first = true;
    const calls = setup(() => {
      if (!first) return json(created, 201);
      first = false;
      return refused(
        ["", "possible_duplicate"],
        ["", "warnings_unconfirmed"],
        ["/values/birthDate", "age_implausible"],
      );
    });
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await userEvent.click(await screen.findByLabelText("Hinweise geprüft, trotzdem anlegen"));
    await userEvent.click(screen.getByLabelText("Mögliche Dublette geprüft, trotzdem anlegen"));
    expect(screen.getByText(/Das Alter am Austrittsdatum/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Seite der Person öffnen")).toBeInTheDocument();
    expect(posted(calls).at(-1)).toMatchObject({
      confirmWarnings: true,
      createDespiteDuplicate: true,
    });
  });

  it("links to the person who already has the Personalnummer", async () => {
    setup(() =>
      problem(422, "domain-error", {
        errors: [
          { pointer: "/values/personnelNumber", code: "personnel_number_taken", detail: "Refused" },
        ],
        participationId: existingId,
      }),
    );
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(
      await screen.findByText("Diese Personalnummer gibt es in diesem Projekt bereits."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Person mit dieser Personalnummer öffnen" }),
    ).toHaveAttribute("href", `/projects/${project.id}/participations/${existingId}`);
  });

  it("says when the API refuses the PL, and can be cancelled", async () => {
    setup(() => problem(403, "forbidden"));
    const section = await open();
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(
      await screen.findByText("Sie dürfen in diesem Projekt keine Teilnehmenden anlegen."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(
      within(section).getByRole("button", { name: "Teilnehmende Person anlegen" }),
    ).toBeInTheDocument();
  });
});
