import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { json, me, problem, renderPortal } from "./test-utils";

// The portal's "Termine" (data-protection.md, appointments: the portal) over a fake API.
// Synthetic ids, times and texts only.
afterEach(async () => {
  await i18n.changeLanguage("de");
});

const id = (n: number) => `00000000-0000-4000-c000-${String(n).padStart(12, "0")}`;
const details = (day: number, title: string | null = "Infoveranstaltung Werk") => ({
  startsAt: `2026-11-${String(day).padStart(2, "0")}T08:00:00.000Z`,
  endsAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`,
  title,
  venue: "Kantine Werk 2",
});
const invitation = (n: number, overrides: object = {}) => ({
  appointmentId: id(n),
  kind: "info_event",
  details: details(n),
  state: "bookable",
  cutoffHint: false,
  alternative: false,
  capabilities: { book: true },
  ...overrides,
});
const sections = {
  invitations: [
    invitation(2),
    invitation(3, { state: "full", alternative: true, capabilities: { book: false } }),
    invitation(4, { state: "closed", alternative: false, capabilities: { book: false } }),
    invitation(5, {
      kind: "consultation",
      details: null,
      state: "no_longer_valid",
      capabilities: { book: false },
    }),
  ],
  bookings: [
    {
      id: id(101),
      appointmentId: id(6),
      kind: "consultation",
      details: details(6, null),
      capabilities: { cancel: true },
    },
  ],
  cancelled: [
    {
      appointmentId: id(7),
      kind: "info_event",
      details: details(7),
      cancelledBy: "organizer",
      alternative: true,
    },
  ],
  bookable: [
    {
      appointmentId: id(8),
      kind: "info_event",
      details: details(8, "Infoveranstaltung Verwaltung"),
      availability: "available",
      cutoffHint: true,
      capabilities: { book: true },
    },
    {
      appointmentId: id(9),
      kind: "info_event",
      details: details(9, "Ausgebucht"),
      availability: "full",
      cutoffHint: false,
      capabilities: { book: false },
    },
  ],
};
const empty = { invitations: [], bookings: [], cancelled: [], bookable: [] };

const section = (name: string) => screen.getByRole("region", { name });
const items = (name: string) => within(section(name)).getAllByRole("listitem");

describe("Termine (data-protection.md, appointments: the portal)", () => {
  it("is linked from the start page", async () => {
    renderPortal("/portal/", { "GET /api/v1/portal/me": () => json(me) });
    expect(await screen.findByRole("link", { name: "Termine" })).toHaveAttribute(
      "href",
      "/portal/appointments",
    );
  });

  it("shows the four sections with invitations full, closed and no longer valid", async () => {
    renderPortal("/portal/appointments", {
      "GET /api/v1/portal/appointments": () => json(sections),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Termine" })).toBeInTheDocument();
    const [bookable, full, closed, invalid] = items("Einladungen");
    expect(
      within(bookable!).getByRole("heading", {
        name: "Infoveranstaltung am Montag, 2. November 2026",
      }),
    ).toBeInTheDocument();
    expect(within(bookable!).getByText("09:00–11:00 Uhr")).toBeInTheDocument();
    expect(within(bookable!).getByText("Kantine Werk 2")).toBeInTheDocument();
    expect(within(bookable!).getByRole("button", { name: "Buchen" })).toBeEnabled();
    expect(within(full!).getByText("ausgebucht")).toBeInTheDocument();
    expect(within(full!).getByRole("button", { name: "Buchen" })).toBeDisabled();
    expect(within(full!).getByRole("link", { name: "Anderen Termin buchen" })).toHaveAttribute(
      "href",
      "#termine-buchen",
    );
    expect(within(closed!).getByText("Buchung geschlossen")).toBeInTheDocument();
    expect(within(closed!).getByRole("button", { name: "Buchen" })).toBeDisabled();
    expect(
      within(closed!).getByText("Bitte wenden Sie sich an Ihr Beratungsteam."),
    ).toBeInTheDocument();
    // Without details: only the kind and that the invitation is no longer valid.
    expect(within(invalid!).getByRole("heading", { name: "Beratungstermin" })).toBeInTheDocument();
    expect(within(invalid!).getByText("Diese Einladung gilt nicht mehr.")).toBeInTheDocument();
    expect(within(invalid!).queryByText("Kantine Werk 2")).toBeNull();
    expect(within(invalid!).queryByRole("button")).toBeNull();

    const [mine] = items("Meine Termine");
    expect(within(mine!).getByRole("button", { name: "Absagen" })).toBeInTheDocument();
    const [cancelled] = items("Abgesagt");
    expect(within(cancelled!).getByText("vom Veranstalter abgesagt")).toBeInTheDocument();
    expect(within(cancelled!).getByRole("link", { name: "Anderen Termin buchen" })).toBeVisible();
    const [open, fullyBooked] = items("Termine buchen");
    expect(within(open!).getByText("Plätze frei")).toBeInTheDocument();
    expect(
      within(open!).getByText("Dieser Termin liegt nach einer für Sie geltenden Frist."),
    ).toBeInTheDocument();
    expect(within(fullyBooked!).getByText("ausgebucht")).toBeInTheDocument();
    expect(within(fullyBooked!).queryByRole("button")).toBeNull();
  });

  it("books after a confirmation and reloads", async () => {
    const user = userEvent.setup();
    let booked = false;
    const { calls } = renderPortal("/portal/appointments", {
      "GET /api/v1/portal/appointments": () =>
        json(
          booked
            ? {
                ...empty,
                bookings: [
                  {
                    id: id(102),
                    appointmentId: id(2),
                    kind: "info_event",
                    details: details(2),
                    capabilities: { cancel: true },
                  },
                ],
              }
            : { ...empty, invitations: [invitation(2)] },
        ),
      [`POST /api/v1/portal/appointments/${id(2)}/booking`]: () => {
        booked = true;
        return json({ bookingId: id(102) }, 201);
      },
    });
    const [item] = await waitFor(() => items("Einladungen"));
    await user.click(within(item!).getByRole("button", { name: "Buchen" }));
    expect(
      within(item!).getByRole("group", { name: "Möchten Sie diesen Termin verbindlich buchen?" }),
    ).toBeInTheDocument();
    await user.click(within(item!).getByRole("button", { name: "Ja, buchen" }));
    expect(await screen.findByText("Der Termin ist gebucht.")).toBeInTheDocument();
    await waitFor(() => expect(items("Meine Termine")).toHaveLength(1));
    expect(
      within(section("Einladungen")).getByText("Sie haben keine offenen Einladungen."),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.path.endsWith("/booking"))).toEqual([
      { path: `/api/v1/portal/appointments/${id(2)}/booking`, body: {} },
    ]);
  });

  it("cancels after a confirmation, or goes back", async () => {
    const user = userEvent.setup();
    let cancelled = false;
    renderPortal("/portal/appointments", {
      "GET /api/v1/portal/appointments": () =>
        json(cancelled ? empty : { ...empty, bookings: sections.bookings }),
      [`POST /api/v1/portal/appointment-bookings/${id(101)}/cancellation`]: () => {
        cancelled = true;
        return new Response(null, { status: 204 });
      },
    });
    const [item] = await waitFor(() => items("Meine Termine"));
    await user.click(within(item!).getByRole("button", { name: "Absagen" }));
    await user.click(within(item!).getByRole("button", { name: "Zurück" }));
    expect(cancelled).toBe(false);
    await user.click(within(item!).getByRole("button", { name: "Absagen" }));
    await user.click(within(item!).getByRole("button", { name: "Ja, absagen" }));
    expect(await screen.findByText("Ihre Buchung ist abgesagt.")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(section("Meine Termine")).getByText("Sie haben keine gebuchten Termine."),
      ).toBeInTheDocument(),
    );
  });

  it("explains a refused booking and asks to log in again after the session ended", async () => {
    const user = userEvent.setup();
    renderPortal("/portal/appointments", {
      "GET /api/v1/portal/appointments": () => json({ ...empty, invitations: [invitation(2)] }),
      [`POST /api/v1/portal/appointments/${id(2)}/booking`]: () => problem(422, "appointment_full"),
    });
    const [item] = await waitFor(() => items("Einladungen"));
    await user.click(within(item!).getByRole("button", { name: "Buchen" }));
    await user.click(within(item!).getByRole("button", { name: "Ja, buchen" }));
    expect(await screen.findByText("Der Termin ist inzwischen ausgebucht.")).toBeInTheDocument();
  });

  it("asks to log in without a session", async () => {
    renderPortal("/portal/appointments", {
      "GET /api/v1/portal/appointments": () => problem(401, "unauthenticated"),
    });
    expect(
      await screen.findByText("Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("speaks English, with the team's cancellation and the times in Berlin", async () => {
    await i18n.changeLanguage("en");
    renderPortal("/portal/appointments", {
      "GET /api/v1/portal/appointments": () =>
        json({
          ...sections,
          cancelled: [{ ...sections.cancelled[0], cancelledBy: "team", alternative: false }],
        }),
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Appointments" }),
    ).toBeInTheDocument();
    const [, full, closed, invalid] = items("Invitations");
    expect(within(full!).getByText("fully booked")).toBeInTheDocument();
    expect(within(closed!).getByText("Booking closed")).toBeInTheDocument();
    expect(within(invalid!).getByText("This invitation is no longer valid.")).toBeInTheDocument();
    const [cancelled] = items("Cancelled");
    expect(within(cancelled!).getByText("cancelled by your counselling team")).toBeInTheDocument();
    expect(
      within(cancelled!).getByRole("heading", {
        name: "Information event on Saturday, 7 November 2026",
      }),
    ).toBeInTheDocument();
    expect(within(cancelled!).getByText("09:00–11:00")).toBeInTheDocument();
    expect(items("Book an appointment")).toHaveLength(2);
  });
});
