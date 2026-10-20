import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, mockApi, problem, project, regions, renderApp, staffUsers } from "./test-utils";

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

const oidcMode = { "GET /api/v1/dev/staff-users": () => problem(404, "not-found") };
const noSession = { "GET /api/v1/me": () => problem(401, "unauthenticated") };
const banner = () => screen.getByRole("banner");

describe("staff login (Slice 3, PR 3b)", () => {
  it("sends a first visit to the login page without 'Sitzung abgelaufen', and logs in with the dev switcher", async () => {
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
    const { router } = renderApp("/projects", api);

    expect(await screen.findByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ returnTo: "/projects" });
    expect(screen.queryByText("Sitzung abgelaufen")).not.toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: "Petra Projektleitung · Projektleitung" }),
    );

    expect(await screen.findByText("Restrukturierung Werk Nord")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects");
    expect(within(banner()).getByText("Petra Projektleitung")).toBeInTheDocument();
    expect(within(banner()).getByRole("button", { name: "Abmelden" })).toBeInTheDocument();
    expect(calls).toContainEqual({
      key: "POST /api/v1/dev/session",
      body: { staffUserId: staffUsers[1]!.id },
    });
  });

  it("shows 'Anmelden' to the identity provider in OIDC mode, with the return path", async () => {
    renderApp("/projects/new", mockApi({ ...oidcMode, ...noSession }).api);
    const login = await screen.findByRole("link", { name: "Anmelden" });
    expect(login).toHaveAttribute("href", "/api/v1/auth/login?returnTo=%2Fprojects%2Fnew");
    expect(screen.queryByRole("button", { name: "Abmelden" })).not.toBeInTheDocument();
  });

  it("never offers a foreign return path", async () => {
    renderApp("/login?returnTo=https%3A%2F%2Fevil.example", mockApi(oidcMode).api);
    expect(await screen.findByRole("link", { name: "Anmelden" })).toHaveAttribute(
      "href",
      "/api/v1/auth/login?returnTo=%2F",
    );
  });

  it.each([
    ["unknown_account", "Kein Zugang", "Für dieses Konto ist kein Zugang eingerichtet."],
    ["account_deactivated", "Kein Zugang", "Dieses Konto ist deaktiviert."],
    ["identity_mismatch", "Kein Zugang", "mit einer anderen Anmeldung verknüpft"],
    ["login_failed", "Anmeldung fehlgeschlagen", "Bitte versuchen Sie es erneut."],
    ["something_else", "Anmeldung fehlgeschlagen", "Bitte versuchen Sie es erneut."],
  ])("explains the refusal %s from the callback", async (code, title, text) => {
    renderApp(`/login?error=${code}`, mockApi(oidcMode).api);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
  });

  it("returns to the login page with 'Sitzung abgelaufen' on a 401 after a session", async () => {
    let expired = false;
    const { api } = mockApi({
      ...oidcMode,
      "GET /api/v1/me": () => (expired ? problem(401, "unauthenticated") : json(staffUsers[1])),
      "GET /api/v1/projects": () => json({ items: [project], nextCursor: null }),
      [`GET /api/v1/projects/${project.id}`]: () => problem(401, "unauthenticated"),
    });
    const { router } = renderApp("/projects", api);
    expect(await screen.findByText("Restrukturierung Werk Nord")).toBeInTheDocument();
    expired = true;
    await userEvent.click(screen.getByRole("link", { name: "Restrukturierung Werk Nord" }));

    expect(await screen.findByText("Sitzung abgelaufen")).toBeInTheDocument();
    expect(screen.getByText("Bitte melden Sie sich erneut an.")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({
      returnTo: `/projects/${project.id}`,
      reason: "expired",
    });
    expect(within(banner()).queryByText("Petra Projektleitung")).not.toBeInTheDocument();
  });

  it("logs out with 'Abmelden'", async () => {
    let session = true;
    const { api, calls } = mockApi({
      ...oidcMode,
      "GET /api/v1/me": () => (session ? json(staffUsers[1]) : problem(401, "unauthenticated")),
      "GET /api/v1/projects": () => json({ items: [project], nextCursor: null }),
      "POST /api/v1/auth/logout": () => {
        session = false;
        return new Response(null, { status: 204 });
      },
    });
    const { router } = renderApp("/projects", api);
    expect(await screen.findByText("Restrukturierung Werk Nord")).toBeInTheDocument();
    await userEvent.click(await within(banner()).findByRole("button", { name: "Abmelden" }));

    expect(await screen.findByRole("link", { name: "Anmelden" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.queryByText("Sitzung abgelaufen")).not.toBeInTheDocument();
    expect(within(banner()).queryByText("Petra Projektleitung")).not.toBeInTheDocument();
    expect(calls).toContainEqual({ key: "POST /api/v1/auth/logout", body: {} });
  });

  it("refuses a deactivated dev user with 'Kein Zugang'", async () => {
    const { api } = mockApi({
      ...noSession,
      "GET /api/v1/dev/staff-users": () => json(staffUsers),
      "POST /api/v1/dev/session": () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "", code: "account_deactivated", detail: "Refused" }],
        }),
    });
    renderApp("/login", api);
    await userEvent.click(await screen.findByRole("button", { name: "Erika Musterfrau · Admin" }));
    expect(await screen.findByText("Kein Zugang")).toBeInTheDocument();
    expect(screen.getByText(/Dieses Konto ist deaktiviert/)).toBeInTheDocument();
  });
});

const fill = async (fields: Record<string, string>) => {
  for (const [label, value] of Object.entries(fields)) {
    await userEvent.type(await screen.findByLabelText(label), value);
  }
};
const submit = () => userEvent.click(screen.getByRole("button", { name: "Projekt anlegen" }));
/** The creator chooses the region (Q126). */
const chooseRegion = async () =>
  userEvent.selectOptions(
    await screen.findByLabelText("Region (Niederlassung)"),
    await screen.findByRole("option", { name: "Niederlassung Nord (NORD)" }),
  );

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
    await chooseRegion();
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
    await chooseRegion();
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
        regionId: regions[0]!.id,
      },
    });
  });
});
