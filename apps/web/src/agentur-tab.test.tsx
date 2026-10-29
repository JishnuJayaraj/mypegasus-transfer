import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { documentNavigation } from "./components/documents-tab";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
} from "./test-utils";

// The project tab "Agentur" (process-and-lifecycle.md, Kug 200b batches; D25, Q203): the
// Agenturen with their channel or "Einstellungen fehlen" and the artifact, "Sammelmeldung bilden"
// over the ready scans, a batch's work list, "Übermittelt am", "Verwerfen" and a stale batch's
// rows. Synthetic data only.
const projectPath = `/api/v1/projects/${project.id}`;
const batchId = "00000000-0000-4000-a000-0000000000b1";
const a = "00000000-0000-4000-a000-000000000001";
const b = "00000000-0000-4000-a000-000000000002";
const person = (participationId: string, lastName: string) => ({
  participationId,
  documentId: participationId.replace("a000-0000000000", "a000-00000000d0"),
  lastName,
  firstName: "Erika",
  formVersion: "09-2021",
  asuChannel: "kug_200b",
});
const agentur = (overrides: object = {}) => ({
  agenturKey: "beispielstadt-ost",
  channel: "scan_email",
  artifact: { kind: "kug200a" },
  candidates: [person(a, "Albers"), person(b, "Zander")],
  routeMissing: [],
  capabilities: { createBatch: true },
  ...overrides,
});
const batch = (overrides: object = {}) => ({
  id: batchId,
  agenturKey: "beispielstadt-ost",
  channel: "scan_email",
  artifact: "kug200a",
  status: "open",
  createdAt: "2026-11-20T09:00:00.000000Z",
  createdOn: "2026-11-20",
  submittedOn: null,
  submittedAt: null,
  discardedAt: null,
  members: [person(a, "Albers"), person(b, "Zander")],
  staleRows: [],
  capabilities: { submit: true, discard: true, exportIndex: true },
  ...overrides,
});
const tab = (overrides: object = {}) => ({
  withoutPlacementAgentur: 0,
  agenturen: [agentur()],
  batches: [],
  ...overrides,
});

function setup(first: object | Response, routes: Record<string, () => Response> = {}) {
  const ta = { ...project, type: "ta_tg" };
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(ta),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${projectPath}/kug200b-batches`]: () => (first instanceof Response ? first : json(first)),
    ...routes,
  });
  renderApp(`/projects/${project.id}?tab=agentur`, mock.api);
  return mock;
}

describe("the project tab Agentur", () => {
  it("builds a batch of the Agentur's ready scans with the Kug 200a", async () => {
    const user = userEvent.setup();
    const { calls } = setup(tab(), {
      [`POST ${projectPath}/kug200b-batches`]: () => json({ batchId }, 201),
    });
    expect(await screen.findByText("Vorblatt: Kug 200a (amtlicher Vordruck)")).toBeVisible();
    expect(screen.getByText("Übermittlungsweg Kug 200b: Scan per E-Mail")).toBeVisible();
    expect(screen.getByText("Albers, Erika")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sammelmeldung bilden" }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === `POST ${projectPath}/kug200b-batches`)?.body).toEqual({
        agenturKey: "beispielstadt-ost",
        documentIds: [person(a, "").documentId, person(b, "").documentId],
      }),
    );
    expect(await screen.findByText("Sammelmeldung gebildet.")).toBeVisible();
  });

  it('shows "Einstellungen fehlen" and the accepted alternative with its confirmation', async () => {
    setup(
      tab({
        agenturen: [
          agentur({ channel: null, capabilities: { createBatch: false } }),
          agentur({
            agenturKey: "beispielstadt-west",
            artifact: {
              kind: "accepted_alternative",
              source: "email_agentur",
              confirmedBy: staffUsers[1]!.id,
              confirmedOn: "2026-10-20",
            },
          }),
        ],
      }),
    );
    expect(await screen.findByText(/^Einstellungen fehlen/)).toBeVisible();
    expect(
      screen.getByText(
        `Vorblatt: Alternative anerkannt am 20.10.2026 von ${staffUsers[1]!.displayName}`,
      ),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Sammelmeldung bilden" })).toHaveLength(1);
  });

  it("lists a refused batch's rows from the server", async () => {
    const user = userEvent.setup();
    setup(tab(), {
      [`POST ${projectPath}/kug200b-batches`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "", code: "batch_stale", detail: "x" }],
          staleRows: [
            {
              participationId: a,
              documentId: person(a, "").documentId,
              reason: "participation_closed",
            },
          ],
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Sammelmeldung bilden" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/^Sammelmeldung veraltet/)).toBeVisible();
    expect(within(alert).getByText("Albers, Erika: Die Teilnahme ist beendet.")).toBeVisible();
  });

  it("downloads the work list, records the sent date and discards", async () => {
    const user = userEvent.setup();
    const assigned: string[] = [];
    const original = documentNavigation.assign;
    documentNavigation.assign = (url: string) => void assigned.push(url);
    try {
      const { calls } = setup(tab({ agenturen: [], batches: [batch()] }), {
        "POST /api/v1/exports/kug200b_batch_index": () =>
          json({ url: "/api/v1/export-content/x", expiresAt: "2026-11-20T09:01:00.000000Z" }, 201),
        [`POST /api/v1/kug200b-batches/${batchId}/submission`]: () =>
          json({ submissions: 2, registrations: 2 }),
        [`POST /api/v1/kug200b-batches/${batchId}/discard`]: () =>
          new Response(null, { status: 204 }),
      });
      await user.click(await screen.findByRole("button", { name: "Arbeitsliste (CSV)" }));
      await waitFor(() => expect(assigned).toEqual(["/api/v1/export-content/x"]));
      expect(calls.find((c) => c.key === "POST /api/v1/exports/kug200b_batch_index")?.body).toEqual(
        { batchId },
      );
      await user.type(screen.getByLabelText("Übermittelt am"), "24.11.2026");
      await user.click(screen.getByRole("button", { name: "Übermittlung erfassen" }));
      await waitFor(() =>
        expect(
          calls.find((c) => c.key === `POST /api/v1/kug200b-batches/${batchId}/submission`)?.body,
        ).toEqual({ submittedOn: "2026-11-24" }),
      );
      await user.click(screen.getByRole("button", { name: "Verwerfen" }));
      expect(await screen.findByText("Sammelmeldung verworfen.")).toBeVisible();
    } finally {
      documentNavigation.assign = original;
    }
  });

  it("shows a stale batch's rows and offers only the discard", async () => {
    setup(
      tab({
        agenturen: [],
        batches: [
          batch({
            staleRows: [
              {
                participationId: b,
                documentId: person(b, "").documentId,
                reason: "asu_route_changed",
              },
            ],
            capabilities: { submit: false, discard: true, exportIndex: false },
          }),
        ],
      }),
    );
    const rows = await screen.findByTestId("stale-rows");
    expect(
      within(rows).getByText("Zander, Erika: Der Weg der Arbeitsuchendmeldung hat sich geändert."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Übermittlung erfassen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Arbeitsliste (CSV)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Verwerfen" })).toBeVisible();
  });

  it("names who waits for an ASU route and links to their tab Arbeitsuche (Q203)", async () => {
    setup(
      tab({
        agenturen: [
          agentur({
            candidates: [],
            routeMissing: [{ participationId: a, lastName: "Albers", firstName: "Erika" }],
            capabilities: { createBatch: false },
          }),
        ],
      }),
    );
    expect(
      await screen.findByText(
        "1 angenommener Kug 200b wartet auf den Weg der Arbeitsuchendmeldung.",
      ),
    ).toBeVisible();
    const link = within(screen.getByTestId("route-missing")).getByRole("link", {
      name: "Albers, Erika",
    });
    expect(link).toHaveAttribute("href", `/projects/${project.id}/participations/${a}?tab=asu`);
    expect(screen.queryByRole("button", { name: "Sammelmeldung bilden" })).toBeNull();
  });

  it("tells others that only the PL sees the batches", async () => {
    setup(problem(403, "forbidden"));
    expect(
      await screen.findByText(
        "Sammelmeldungen der Kug 200b sind nur für die Projektleitung sichtbar.",
      ),
    ).toBeVisible();
  });
});
