import { describe, expect, it } from "vitest";
import {
  portalAppointments,
  type PortalAppointmentFacts,
  type PortalAppointmentsRequest,
  type PortalBookingFacts,
} from "./portal";

// The portal's "Termine" (data-protection.md, appointments: the portal). Synthetic ids and times.
const now = "2091-02-01T09:00:00.000Z";
const today = "2091-02-01";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const appointment = (
  n: number,
  overrides: Partial<PortalAppointmentFacts> = {},
): PortalAppointmentFacts => ({
  id: id(n),
  kind: "info_event",
  status: "scheduled",
  startsAt: `2091-02-${String(10 + n).padStart(2, "0")}T09:00:00.000Z`,
  endsAt: `2091-02-${String(10 + n).padStart(2, "0")}T11:00:00.000Z`,
  bookingClosesAt: `2091-02-${String(9 + n).padStart(2, "0")}T09:00:00.000Z`,
  capacity: 2,
  audienceWaveId: null,
  title: "Infoveranstaltung",
  venue: "Kantine Werk 2",
  cancelledAt: null,
  bookedCount: 0,
  hostMayList: false,
  ...overrides,
});

const slot = (n: number, overrides: Partial<PortalAppointmentFacts> = {}) =>
  appointment(n, { kind: "consultation", hostMayList: true, title: null, ...overrides });

const booking = (
  n: number,
  appointmentNumber: number,
  overrides: Partial<PortalBookingFacts> = {},
): PortalBookingFacts => ({
  id: id(100 + n),
  appointmentId: id(appointmentNumber),
  status: "booked",
  cancelReason: null,
  cancelledAt: null,
  ...overrides,
});

const sections = (overrides: Partial<PortalAppointmentsRequest> = {}) =>
  portalAppointments({
    appointments: [],
    invitedAppointmentIds: [],
    bookings: [],
    participation: {
      status: "contacted",
      entryWaveId: "wave-1",
      latestEntryDate: "2091-03-15",
      entryCutoff: "2091-03-15",
    },
    projectType: "ta_tg",
    now,
    today,
    ...overrides,
  });

const cancelledBooking = (n: number, a: PortalAppointmentFacts) =>
  booking(n, Number(a.id.slice(-2)), {
    status: "cancelled",
    cancelReason: "appointment_cancelled",
    cancelledAt: a.cancelledAt,
  });

describe("portalAppointments: Einladungen", () => {
  it("shows a bookable invitation with its details, and not again under Termine buchen", () => {
    const result = sections({ appointments: [appointment(1)], invitedAppointmentIds: [id(1)] });
    expect(result.invitations).toEqual([
      {
        appointmentId: id(1),
        kind: "info_event",
        details: {
          startsAt: "2091-02-11T09:00:00.000Z",
          endsAt: "2091-02-11T11:00:00.000Z",
          title: "Infoveranstaltung",
          venue: "Kantine Werk 2",
        },
        state: "bookable",
        cutoffHint: false,
        alternative: false,
        capabilities: { book: true },
      },
    ]);
    expect(result.bookable).toEqual([]);
  });

  it("keeps a full or closed invitation visible with booking disabled and the next step", () => {
    const full = appointment(1, { bookedCount: 2 });
    const closed = appointment(2, { bookingClosesAt: now });
    const other = appointment(3);
    const result = sections({
      appointments: [full, closed, other],
      invitedAppointmentIds: [id(1), id(2)],
    });
    expect(
      result.invitations.map(({ state, alternative, capabilities }) => [
        state,
        alternative,
        capabilities.book,
      ]),
    ).toEqual([
      ["full", true, false],
      ["closed", true, false],
    ]);
    // Without a bookable alternative of the same kind: "Bitte wenden Sie sich an Ihr Beratungsteam".
    const alone = sections({ appointments: [full, slot(3)], invitedAppointmentIds: [id(1)] });
    expect(alone.invitations[0]).toMatchObject({ state: "full", alternative: false });
  });

  it("names another refusal `unavailable`, and carries the cutoff hint, never the date", () => {
    const later = appointment(1, {
      startsAt: "2091-03-20T09:00:00.000Z",
      endsAt: "2091-03-20T11:00:00.000Z",
      bookingClosesAt: "2091-03-19T09:00:00.000Z",
    });
    const limited = sections({
      appointments: [appointment(2), appointment(3)],
      invitedAppointmentIds: [id(3)],
      bookings: [booking(1, 2)],
    });
    expect(limited.invitations[0]).toMatchObject({ state: "unavailable", alternative: false });
    const hinted = sections({ appointments: [later], invitedAppointmentIds: [id(1)] });
    expect(hinted.invitations[0]).toMatchObject({ state: "bookable", cutoffHint: true });
    expect(JSON.stringify(hinted)).not.toContain("2091-03-15");
  });

  it("shows only the kind and `no_longer_valid` outside the audience or host rule", () => {
    const result = sections({
      appointments: [slot(1, { hostMayList: false }), appointment(2, { audienceWaveId: "wave-2" })],
      invitedAppointmentIds: [id(1), id(2)],
    });
    expect(result.invitations).toEqual([
      {
        appointmentId: id(1),
        kind: "consultation",
        details: null,
        state: "no_longer_valid",
        cutoffHint: false,
        alternative: false,
        capabilities: { book: false },
      },
      expect.objectContaining({ kind: "info_event", details: null, state: "no_longer_valid" }),
    ]);
    const informedLater = sections({
      appointments: [appointment(1)],
      invitedAppointmentIds: [id(1)],
      participation: {
        status: "active_in_tg",
        entryWaveId: "wave-1",
        latestEntryDate: null,
        entryCutoff: null,
      },
    });
    expect(informedLater.invitations[0]?.state).toBe("no_longer_valid");
  });

  it("drops an invitation once booked or started; a cancelled one moves to Abgesagt", () => {
    const result = sections({
      appointments: [
        appointment(1),
        appointment(2, { startsAt: now, endsAt: "2091-02-01T11:00:00.000Z" }),
        appointment(3, { status: "cancelled", cancelledAt: "2091-01-31T09:00:00.000Z" }),
        appointment(4),
      ],
      invitedAppointmentIds: [id(1), id(2), id(3), id(3), id(9)],
      bookings: [booking(1, 1)],
    });
    expect(result.invitations).toEqual([]);
    expect(result.bookings.map((b) => b.appointmentId)).toEqual([id(1)]);
    expect(result.cancelled).toEqual([
      {
        appointmentId: id(3),
        kind: "info_event",
        details: expect.objectContaining({ venue: "Kantine Werk 2" }),
        cancelledBy: "organizer",
        alternative: false,
      },
    ]);
  });
});

describe("portalAppointments: Meine Termine", () => {
  it("lists live bookings until their end, Absagen until the start", () => {
    const running = slot(1, {
      startsAt: "2091-02-01T08:00:00.000Z",
      endsAt: "2091-02-01T10:00:00.000Z",
    });
    const ended = slot(2, {
      startsAt: "2091-01-31T08:00:00.000Z",
      endsAt: "2091-01-31T09:00:00.000Z",
    });
    const result = sections({
      appointments: [slot(5), running, ended, slot(4)],
      bookings: [booking(1, 5), booking(2, 1), booking(3, 2), booking(4, 4)],
    });
    expect(
      result.bookings.map(({ appointmentId, capabilities }) => [
        appointmentId,
        capabilities.cancel,
      ]),
    ).toEqual([
      [id(1), false],
      [id(4), true],
      [id(5), true],
    ]);
  });
});

describe("portalAppointments: Abgesagt", () => {
  it("shows organizer and team cancellations with the next step, not the participant's own", () => {
    const result = sections({
      appointments: [
        appointment(1, { status: "cancelled", cancelledAt: "2091-01-30T09:00:00.000Z" }),
        slot(2),
        slot(3),
        appointment(4),
        slot(5),
      ],
      bookings: [
        booking(1, 1, {
          status: "cancelled",
          cancelReason: "appointment_cancelled",
          cancelledAt: "2091-01-30T09:00:00.000Z",
        }),
        booking(2, 2, {
          status: "cancelled",
          cancelReason: "staff_cancelled",
          cancelledAt: "2091-01-31T09:00:00.000Z",
        }),
        booking(3, 3, {
          status: "cancelled",
          cancelReason: "participant_cancelled",
          cancelledAt: "2091-01-31T09:00:00.000Z",
        }),
        booking(4, 5, {
          status: "cancelled",
          cancelReason: "participation_closed",
          cancelledAt: "2091-01-31T09:00:00.000Z",
        }),
      ],
    });
    expect(
      result.cancelled.map(({ appointmentId, cancelledBy, alternative }) => [
        appointmentId,
        cancelledBy,
        alternative,
      ]),
    ).toEqual([
      [id(2), "team", true],
      [id(1), "organizer", true],
    ]);
  });

  it("keeps the latest cancellation once, and none for an appointment booked again", () => {
    const result = sections({
      appointments: [slot(1), slot(2)],
      bookings: [
        booking(1, 1, {
          status: "cancelled",
          cancelReason: "staff_cancelled",
          cancelledAt: "2091-01-29T09:00:00.000Z",
        }),
        booking(2, 1, {
          status: "cancelled",
          cancelReason: "staff_cancelled",
          cancelledAt: "2091-01-30T09:00:00.000Z",
        }),
        booking(3, 1, {
          status: "cancelled",
          cancelReason: "staff_cancelled",
          cancelledAt: "2091-01-28T09:00:00.000Z",
        }),
        booking(4, 2, {
          status: "cancelled",
          cancelReason: "staff_cancelled",
          cancelledAt: "2091-01-30T09:00:00.000Z",
        }),
        booking(5, 2),
        booking(6, 9, {
          status: "cancelled",
          cancelReason: "staff_cancelled",
          cancelledAt: "2091-01-30T09:00:00.000Z",
        }),
      ],
    });
    expect(result.cancelled.map((c) => c.appointmentId)).toEqual([id(1)]);
  });

  it("counts the 14 days from the later of the original start and the cancellation", () => {
    const early = slot(1, {
      status: "cancelled",
      startsAt: "2091-01-10T09:00:00.000Z",
      endsAt: "2091-01-10T10:00:00.000Z",
      cancelledAt: "2091-01-05T09:00:00.000Z",
    });
    // Cancelled late, after the start: the window runs from the cancellation.
    const late = slot(2, {
      status: "cancelled",
      startsAt: "2091-01-10T09:00:00.000Z",
      endsAt: "2091-01-10T10:00:00.000Z",
      cancelledAt: "2091-01-20T09:00:00.000Z",
    });
    const at = (when: string) =>
      sections({
        appointments: [early, late],
        bookings: [cancelledBooking(1, early), cancelledBooking(2, late)],
        now: when,
      }).cancelled.map((c) => c.appointmentId);
    expect(at("2091-01-24T08:59:00.000Z")).toEqual([id(2), id(1)]);
    expect(at("2091-01-24T09:00:00.000Z")).toEqual([id(2)]);
    expect(at("2091-02-03T08:59:00.000Z")).toEqual([id(2)]);
    expect(at("2091-02-03T09:00:00.000Z")).toEqual([]);
  });

  it("shows an invited appointment's cancellation without details outside the rule", () => {
    const result = sections({
      appointments: [slot(1, { status: "cancelled", cancelledAt: now, hostMayList: false })],
      invitedAppointmentIds: [id(1)],
    });
    expect(result.cancelled).toEqual([
      {
        appointmentId: id(1),
        kind: "consultation",
        details: null,
        cancelledBy: "organizer",
        alternative: false,
      },
    ]);
  });
});

describe("portalAppointments: Termine buchen", () => {
  it("lists bookable and full appointments by start with the seat state, nothing else", () => {
    const result = sections({
      appointments: [
        appointment(3, { bookedCount: 2 }),
        slot(1),
        slot(2, { hostMayList: false }),
        appointment(4, { bookingClosesAt: now }),
        appointment(5, { status: "cancelled", cancelledAt: now }),
      ],
    });
    expect(
      result.bookable.map(({ appointmentId, availability, capabilities }) => [
        appointmentId,
        availability,
        capabilities.book,
      ]),
    ).toEqual([
      [id(1), "available", true],
      [id(3), "full", false],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/bookedCount|capacity/);
  });
});
