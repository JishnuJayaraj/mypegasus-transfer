import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, mockApi, problem, project, renderApp, staffUsers } from "./test-utils";

const loggedIn = {
  "GET /api/v1/me": () => json(staffUsers[1]),
  "GET /api/v1/dev/staff-users": () => json(staffUsers),
};

describe("project list", () => {
  it("redirects / to the list and shows projects with their status and German timestamps", async () => {
    const { api } = mockApi({
      ...loggedIn,
      "GET /api/v1/projects": () => json({ items: [project], nextCursor: null }),
    });
    renderApp("/", api);

    const row = (await screen.findByText("Restrukturierung Werk Nord")).closest("tr")!;
    expect(within(row).getByText("Beispiel Maschinenbau GmbH")).toBeInTheDocument();
    expect(within(row).getByText("Transferagentur und Transfergesellschaft")).toBeInTheDocument();
    expect(within(row).getByText("Entwurf")).toBeInTheDocument();
    // 08:30 UTC is 10:30 in Berlin (summer time).
    expect(within(row).getByText("15.10.2026, 10:30")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    const { api } = mockApi({
      ...loggedIn,
      "GET /api/v1/projects": () => json({ items: [], nextCursor: null }),
    });
    renderApp("/projects", api);
    expect(await screen.findByText("Es gibt noch keine Projekte.")).toBeInTheDocument();
  });

  it("loads the next page with the cursor", async () => {
    const { api, calls } = mockApi({
      ...loggedIn,
      "GET /api/v1/projects": ({ query }) =>
        query.get("cursor") === "next"
          ? json({
              items: [
                { ...project, id: "00000000-0000-4000-9000-000000000002", name: "Zweites Projekt" },
              ],
              nextCursor: null,
            })
          : json({ items: [project], nextCursor: "next" }),
    });
    renderApp("/projects", api);

    await userEvent.click(await screen.findByRole("button", { name: "Mehr laden" }));
    expect(await screen.findByText("Zweites Projekt")).toBeInTheDocument();
    expect(screen.getByText("Restrukturierung Werk Nord")).toBeInTheDocument();
    expect(calls.filter((c) => c.key === "GET /api/v1/projects")).toHaveLength(2);
  });
});

describe("dev session", () => {
  it("asks for a dev user without a session, and logs in through the switcher", async () => {
    let session = false;
    const { api, calls } = mockApi({
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      "GET /api/v1/me": () => (session ? json(staffUsers[1]) : problem(401, "unauthenticated")),
      "GET /api/v1/projects": () =>
        session ? json({ items: [project], nextCursor: null }) : problem(401, "unauthenticated"),
      "POST /api/v1/dev/session": () => {
        session = true;
        return new Response(null, { status: 204 });
      },
    });
    renderApp("/projects", api);

    // In the header (from /me) and in place of the list (from the route loader).
    await waitFor(() =>
      expect(screen.getAllByText("Bitte Entwicklungsbenutzer wählen")).toHaveLength(2),
    );
    await userEvent.click(screen.getByRole("button", { name: "Entwicklungsbenutzer wechseln" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Petra Projektleitung · Projektleitung" }),
    );

    expect(await screen.findByText("Restrukturierung Werk Nord")).toBeInTheDocument();
    expect(screen.queryByText("Bitte Entwicklungsbenutzer wählen")).not.toBeInTheDocument();
    expect(calls).toContainEqual({
      key: "POST /api/v1/dev/session",
      body: { staffUserId: staffUsers[1]!.id },
    });
  });
});

const fill = async (fields: Record<string, string>) => {
  for (const [label, value] of Object.entries(fields)) {
    await userEvent.type(await screen.findByLabelText(label), value);
  }
};
const submit = () => userEvent.click(screen.getByRole("button", { name: "Projekt anlegen" }));

describe("create project form", () => {
  it("asks for no contractual dates: they belong to the entry waves (Q79)", async () => {
    renderApp("/projects/new", mockApi(loggedIn).api);
    expect(await screen.findByLabelText("Projektname")).toBeInTheDocument();
    expect(screen.queryByLabelText("TG-Beginn")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unterschriftsfrist")).not.toBeInTheDocument();
    expect(screen.getByText(/je Eintrittswelle erfasst/)).toBeInTheDocument();
  });

  it("validates on the client with the domain rules and sends nothing", async () => {
    const { api, calls } = mockApi(loggedIn);
    renderApp("/projects/new", api);
    await fill({ Kunde: "Beispiel GmbH" });
    await submit();

    expect(await screen.findByText("Pflichtfeld")).toBeInTheDocument();
    expect(calls.some((c) => c.key === "POST /api/v1/projects")).toBe(false);
  });

  it("shows server validation problems on the field from the JSON pointer", async () => {
    const { api } = mockApi({
      ...loggedIn,
      "POST /api/v1/projects": () =>
        problem(400, "validation-error", {
          errors: [{ pointer: "/customerName", code: "too_big", detail: "Too big" }],
        }),
    });
    renderApp("/projects/new", api);
    await fill({ Projektname: "Projekt Ost", Kunde: "Beispiel GmbH" });
    await submit();
    expect(await screen.findByText("Höchstens 200 Zeichen")).toBeInTheDocument();
  });

  it("creates the project, returns to the list and shows a toast", async () => {
    const created = { ...project, id: "00000000-0000-4000-9000-000000000009", name: "Projekt Ost" };
    let items = [project];
    const { api, calls } = mockApi({
      ...loggedIn,
      "GET /api/v1/projects": () => json({ items, nextCursor: null }),
      "POST /api/v1/projects": () => {
        items = [created, project];
        return json(created, 201);
      },
    });
    const { router } = renderApp("/projects/new", api);
    await userEvent.click(await screen.findByLabelText("Transferagentur"));
    await fill({ Projektname: "  Projekt Ost ", Kunde: "Beispiel GmbH" });
    await submit();

    expect(await screen.findByText("Projekt angelegt")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    const rows = await screen.findAllByRole("row");
    expect(within(rows[1]!).getByText("Projekt Ost")).toBeInTheDocument();
    expect(calls).toContainEqual({
      key: "POST /api/v1/projects",
      body: {
        name: "Projekt Ost",
        customerName: "Beispiel GmbH",
        type: "ta_only",
      },
    });
  });
});
