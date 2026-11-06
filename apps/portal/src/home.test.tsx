import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { json, me, noAppointments, problem, renderPortal } from "./test-utils";

// The portal start page (ui-patterns.md, C5): the checklist from GET /portal/progress, the next
// appointment and the participant's areas. Synthetic data only.

const appointmentId = "00000000-0000-4000-8000-0000000000a1";
const tasks = [
  { kind: "notice", done: true },
  { kind: "section", page: "personal", done: true },
  { kind: "section", page: "ba_details", done: false },
  { kind: "upload", documentType: "cv", done: false },
  { kind: "appointment", appointmentId, appointmentKind: "consultation", done: false },
];

function home(progress: unknown, extra: Parameters<typeof renderPortal>[1] = {}) {
  return renderPortal("/portal/", {
    "GET /api/v1/portal/me": () => json(me),
    "GET /api/v1/portal/progress": () => json(progress),
    ...extra,
  });
}

const checklist = () => screen.findByRole("region", { name: "Das fehlt noch" });
const bar = () =>
  screen.getByRole("progressbar", { name: "Ihr Fortschritt" }) as HTMLProgressElement;

afterEach(async () => {
  await i18n.changeLanguage("de");
});

describe("the start page's checklist (C5)", () => {
  it("counts the tasks, links each open one to where it is done and keeps the done ones apart", async () => {
    home({ tasks, optional: ["education", "documents"] });
    const region = await checklist();
    expect(await within(region).findByText("2 von 5 Aufgaben erledigt (40 %)")).toBeInTheDocument();
    expect([bar().value, bar().max]).toEqual([2, 5]);
    expect(bar()).toHaveAccessibleDescription("2 von 5 Aufgaben erledigt (40 %)");

    const [open] = within(region).getAllByRole("list");
    expect(
      within(open!)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Angaben machen: Angaben für die Agentur", "/portal/self-service?step=ba_details"],
      ["Unterlage hochladen: Lebenslauf", "/portal/self-service?step=documents"],
      ["Termin buchen: Beratungstermin", "/portal/appointments"],
    ]);
    // the state is text, not colour alone
    expect(within(open!).getAllByText("Offen:")).toHaveLength(3);
    const done = within(region).getByText("2 Aufgaben erledigt");
    expect(done.tagName).toBe("SUMMARY");
    expect(within(done.parentElement!).getAllByText("Erledigt:")).toHaveLength(2);
  });

  it("lists the optional pages as Freiwillig, outside the count", async () => {
    home({ tasks, optional: ["education", "documents"] });
    const optional = await screen.findByRole("region", { name: "Freiwillig" });
    expect(within(optional).getByText(/zählen nicht zum Fortschritt/)).toBeInTheDocument();
    expect(
      within(optional)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Schule und Ausbildung", "/portal/self-service?step=education"],
      ["Unterlagen", "/portal/self-service?step=documents"],
    ]);
  });

  it("never lets an optional item change the percentage", async () => {
    const percentages: number[] = [];
    for (const optional of [[], ["education"], ["education", "job_wish", "health", "documents"]]) {
      home({ tasks, optional });
      await checklist();
      await screen.findByText(/von 5 Aufgaben erledigt/);
      percentages.push(bar().value / bar().max);
      cleanup();
    }
    expect(percentages).toEqual([0.4, 0.4, 0.4]);
  });

  it("says nothing is missing when every task is done", async () => {
    home({ tasks: tasks.map((task) => ({ ...task, done: true })), optional: ["education"] });
    const region = await checklist();
    expect(await within(region).findByText(/Zurzeit fehlt nichts von Ihnen/)).toBeInTheDocument();
    expect(within(region).getByText("5 von 5 Aufgaben erledigt (100 %)")).toBeInTheDocument();
  });

  it("loads no self-service value and no sensitive field: only me, progress and appointments", async () => {
    const { calls } = home({ tasks, optional: [] });
    await checklist();
    await screen.findByText(/von 5 Aufgaben erledigt/);
    await screen.findByText("Sie haben zurzeit keinen Termin gebucht.");
    const paths = calls.map((call) => call.path);
    expect(paths.filter((path) => path.includes("/self-service"))).toEqual([]);
    expect([...new Set(paths)].toSorted()).toEqual([
      "/api/v1/portal/appointments",
      "/api/v1/portal/me",
      "/api/v1/portal/progress",
    ]);
  });

  it("says when the tasks fail to load and retries", async () => {
    const user = userEvent.setup();
    let fail = true;
    home(undefined, {
      "GET /api/v1/portal/progress": () =>
        fail ? problem(500, "internal") : json({ tasks, optional: [] }),
    });
    expect(
      await screen.findByText("Ihre Aufgaben konnten nicht geladen werden."),
    ).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText(/2 von 5 Aufgaben erledigt/)).toBeInTheDocument();
  });

  it("is in English too", async () => {
    await i18n.changeLanguage("en");
    home({ tasks, optional: ["education"] });
    expect(await screen.findByRole("region", { name: "Still to do" })).toBeInTheDocument();
    expect(await screen.findByText("2 of 5 tasks done (40 %)")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Optional" })).toBeInTheDocument();
  });
});

describe("the start page's next appointment and areas", () => {
  const details = {
    startsAt: "2026-11-10T09:00:00.000Z",
    endsAt: "2026-11-10T10:00:00.000Z",
    title: "Erstgespräch",
    venue: "Raum 1",
  };

  it("shows the next booking", async () => {
    home(
      { tasks, optional: [] },
      {
        "GET /api/v1/portal/appointments": () =>
          json({
            ...noAppointments,
            bookings: [
              {
                id: "00000000-0000-4000-8000-0000000000b2",
                appointmentId: "00000000-0000-4000-8000-0000000000a2",
                kind: "info_event",
                details: { ...details, startsAt: "2026-11-20T09:00:00.000Z", title: "Später" },
                capabilities: { cancel: true },
              },
              {
                id: "00000000-0000-4000-8000-0000000000b1",
                appointmentId,
                kind: "consultation",
                details,
                capabilities: { cancel: true },
              },
            ],
          }),
      },
    );
    const card = await screen.findByRole("region", { name: "Ihr nächster Termin" });
    expect(
      await within(card).findByText("Beratungstermin am Dienstag, 10. November 2026"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Erstgespräch")).toBeInTheDocument();
    expect(within(card).getByText("10:00–11:00 Uhr")).toBeInTheDocument();
    expect(within(card).queryByText("Später")).toBeNull();
    expect(within(card).getByRole("link", { name: "Alle Termine" })).toHaveAttribute(
      "href",
      "/portal/appointments",
    );
  });

  it("asks to book an open invitation", async () => {
    home(
      { tasks, optional: [] },
      {
        "GET /api/v1/portal/appointments": () =>
          json({
            ...noAppointments,
            invitations: [
              {
                appointmentId,
                kind: "consultation",
                details,
                state: "bookable",
                cutoffHint: false,
                alternative: false,
                capabilities: { book: true },
              },
            ],
          }),
      },
    );
    expect(
      await screen.findByText("Sie haben eine Einladung zu einem Termin. Bitte buchen Sie ihn."),
    ).toBeInTheDocument();
  });

  it("links the participant's areas as cards named by their titles", async () => {
    home({ tasks, optional: [] });
    const areas = await screen.findByRole("navigation", { name: "Ihre Bereiche" });
    expect(
      within(areas)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/portal/self-service", "/portal/appointments", "/portal/consents"]);
    expect(within(areas).getByRole("link", { name: "Termine" })).toBeInTheDocument();
    expect(within(areas).getByRole("link", { name: "Meine Angaben" })).toHaveAccessibleDescription(
      "Ihre Angaben für die Beratung und Ihre Unterlagen.",
    );
  });
});

describe("the start page without a session", () => {
  it("offers one clear choice: log in, or start with the activation code", async () => {
    const { calls } = renderPortal("/portal/", {
      "GET /api/v1/portal/me": () => problem(401, "unauthenticated"),
    });
    const login = await screen.findByRole("region", { name: "Sie haben schon einen Zugang" });
    expect(within(login).getByRole("link", { name: "Anmelden" })).toHaveAttribute(
      "href",
      "/portal/login",
    );
    const activate = screen.getByRole("region", { name: "Sie sind zum ersten Mal hier" });
    expect(within(activate).getByText(/Brief mit einem Aktivierungscode/)).toBeInTheDocument();
    expect(
      within(activate).getByRole("link", { name: "Mit Aktivierungscode starten" }),
    ).toHaveAttribute("href", "/portal/activate");
    // nothing of a participant is asked for, and no account menu
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/portal/me"]);
    expect(screen.queryByRole("button", { name: "Mein Konto" })).toBeNull();
  });
});

describe("the header's account menu", () => {
  it("opens Mein Konto from the menu and closes it without pulling the focus back", async () => {
    const user = userEvent.setup();
    const { router } = home({ tasks, optional: [] });
    const button = await screen.findByRole("button", { name: "Mein Konto" });
    await user.click(button);
    await user.click(screen.getByRole("link", { name: "Mein Konto" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Mein Konto" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/account");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveFocus();
  });
});
