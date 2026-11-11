import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, mockApi, problem, renderApp, staffUsers } from "./test-utils";

// Legal holds in "Freigaben" (data-protection.md, legal holds; Q218): the region's manager sees
// the project, the scope, the reason code and the day, never a name or the basis, and releases a
// hold with a documented source; a hold they placed offers no release. Synthetic data.
const holdId = "00000000-0000-4000-e000-000000000007";
const manager = {
  ...staffUsers[1],
  grants: [{ role: "regional_operations_manager", scope: "region", regionId: null }],
};
const hold = (over: object = {}) => ({
  id: holdId,
  projectId: "00000000-0000-4000-9000-000000000001",
  projectName: "Restrukturierung Werk Nord",
  classes: ["health_record"],
  recordKinds: ["dsv_contract"],
  documentCount: 2,
  reason: "litigation",
  placedOn: "2026-10-01",
  capabilities: { release: true },
  ...over,
});
function reviews(holds: object[], routes: Parameters<typeof mockApi>[0] = {}) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(manager),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    "GET /api/v1/reviews": () =>
      json({
        items: [],
        corrections: [],
        clarifications: [],
        reconciliations: [],
        legalHolds: holds,
      }),
    ...routes,
  });
  renderApp("/reviews", mock.api);
  return mock;
}

describe("legal holds in Freigaben", () => {
  it("lists the scope without a name and releases with a source", async () => {
    const { calls } = reviews([hold()], {
      [`POST /api/v1/legal-holds/${holdId}/release`]: () => new Response(null, { status: 204 }),
    });
    const table = await screen.findByRole("table", { name: "Aufbewahrungssperren" });
    expect(table).toHaveTextContent("Gesundheitsangaben, DSV-Vertragsdaten, 2 Dokumente");
    expect(table).toHaveTextContent("Rechtsstreit");
    expect(table).toHaveTextContent("01.10.2026");
    await userEvent.click(within(table).getByRole("button", { name: /^Freigeben/ }));
    const dialog = await screen.findByRole("dialog", { name: "Freigeben" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Freigeben" }));
    expect(calls.some((c) => c.key.startsWith("POST"))).toBe(false);
    await userEvent.type(within(dialog).getByLabelText(/^Weisung/), "Weisung DSB 01.10.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Freigeben" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST /api/v1/legal-holds/${holdId}/release`,
        body: { source: "Weisung DSB 01.10." },
      }),
    );
  });

  it("offers no release for a hold the manager placed, and says when it was released", async () => {
    reviews([hold({ capabilities: { release: false } })]);
    const table = await screen.findByRole("table", { name: "Aufbewahrungssperren" });
    expect(table).toHaveTextContent("Von Ihnen gesetzt");
    expect(within(table).queryByRole("button", { name: /Freigeben/ })).toBeNull();
  });

  it("reports a hold released meanwhile", async () => {
    reviews([hold()], {
      [`POST /api/v1/legal-holds/${holdId}/release`]: () =>
        problem(409, "conflict", { errors: [{ pointer: "/", code: "hold_released" }] }),
    });
    const table = await screen.findByRole("table", { name: "Aufbewahrungssperren" });
    await userEvent.click(within(table).getByRole("button", { name: /^Freigeben/ }));
    const dialog = await screen.findByRole("dialog", { name: "Freigeben" });
    await userEvent.type(within(dialog).getByLabelText(/^Weisung/), "Weisung DSB");
    await userEvent.click(within(dialog).getByRole("button", { name: "Freigeben" }));
    expect(await screen.findByText("Die Sperre war bereits freigegeben.")).toBeVisible();
  });
});
