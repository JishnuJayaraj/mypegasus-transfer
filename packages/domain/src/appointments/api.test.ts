import { describe, expect, it } from "vitest";
import { Appointment, AppointmentQuery, AttendanceInput, ParticipationAppointments } from "./api";

const id = "00000000-0000-4000-a000-000000000001";
const summary = {
  id,
  kind: "info_event",
  startsAt: "2091-02-10T09:00:00.000Z",
  endsAt: "2091-02-10T11:00:00.000Z",
  title: null,
  venue: "Kantine Werk 2",
  status: "scheduled",
};

describe("the appointment payloads", () => {
  it("carry a count view, never both a total and an own count", () => {
    const appointment = {
      ...summary,
      projectId: id,
      bookingClosesAt: "2091-02-09T09:00:00.000Z",
      capacity: 40,
      hostStaffUserId: null,
      audienceWaveId: null,
      cancelReason: null,
      cancelledAt: null,
      inUse: false,
      version: 1,
      bookings: { scope: "own", own: 3, availability: "available" },
      needsResolution: null,
      capabilities: {
        change: false,
        changeHost: false,
        cancel: false,
        book: true,
        recordAttendance: false,
        correctNotTakenPlace: false,
      },
    };
    expect(Appointment.safeParse(appointment).success).toBe(true);
    const leaking = { ...appointment, bookings: { ...appointment.bookings, booked: 12 } };
    expect(Appointment.safeParse(leaking).success).toBe(false);
  });

  it("list the participant tab's bookings and bookable appointments", () => {
    expect(
      ParticipationAppointments.parse({
        bookings: [],
        bookable: [
          { appointment: summary, availability: "full", code: "appointment_full", warnings: [] },
        ],
        capabilities: { book: true },
      }).bookable,
    ).toHaveLength(1);
  });

  it("page upcoming appointments by default", () => {
    expect(AppointmentQuery.parse({})).toEqual({ period: "upcoming", limit: 50 });
  });
});

describe("the attendance request", () => {
  const entry = { participationId: id, attendance: "attended" };

  it("defaults the tick, the confirmation and the reason", () => {
    expect(AttendanceInput.parse({ entries: [entry] })).toEqual({
      entries: [{ ...entry, markInformed: false }],
      informationDelivered: false,
      afterCloseReason: null,
    });
  });

  it("takes 1–500 rows, each participation once", () => {
    expect(AttendanceInput.safeParse({ entries: [] }).success).toBe(false);
    expect(
      AttendanceInput.safeParse({ entries: Array.from({ length: 501 }, () => entry) }).success,
    ).toBe(false);
    const twice = AttendanceInput.safeParse({ entries: [entry, entry] });
    expect(twice.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["entries", 1, "participationId"], "duplicate_entry"],
    ]);
  });
});
