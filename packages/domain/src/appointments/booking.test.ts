import { describe, expect, it } from "vitest";
import type { Subject } from "../access/decide";
import type { ProjectRole } from "../enums";
import {
  bookingEligibility,
  bookingView,
  cancellationEligibility,
  needsResolution,
  type BookingRequest,
} from "./booking";

const now = "2091-02-01T09:00:00.000Z";
const today = "2091-02-01";
const projectId = "project-a";

const appointment = {
  id: "appointment-a",
  kind: "info_event" as const,
  status: "scheduled" as const,
  startsAt: "2091-02-10T09:00:00.000Z",
  endsAt: "2091-02-10T11:00:00.000Z",
  bookingClosesAt: "2091-02-09T09:00:00.000Z",
  capacity: 2,
  audienceWaveId: null,
};

const request = (overrides: Partial<BookingRequest> = {}): BookingRequest => ({
  appointment,
  bookedCount: 0,
  hostMayList: true,
  participation: {
    status: "contacted",
    entryWaveId: "wave-1",
    latestEntryDate: "2091-03-15",
    entryCutoff: "2091-03-15",
  },
  liveBookings: [],
  projectType: "ta_tg",
  actor: "staff",
  now,
  today,
  ...overrides,
});

const code = (overrides: Partial<BookingRequest> = {}) =>
  bookingEligibility(request(overrides)).code;
const at = (start: string, end: string, kind: "info_event" | "consultation" = "consultation") => ({
  appointmentId: `other-${start}`,
  kind,
  startsAt: start,
  endsAt: end,
});

/** The warnings of a booking with this applicable cutoff. */
const warned = (entryCutoff: string | null, overrides: Partial<BookingRequest> = {}) =>
  bookingEligibility(
    request({ participation: { ...request().participation, entryCutoff }, ...overrides }),
  ).warnings;

describe("bookingEligibility", () => {
  it("books a scheduled, unstarted appointment with a free seat", () => {
    expect(bookingEligibility(request())).toEqual({ code: "ok", warnings: [] });
  });

  it("refuses a cancelled or started appointment", () => {
    expect(code({ appointment: { ...appointment, status: "cancelled" } })).toBe(
      "appointment_cancelled",
    );
    expect(code({ now: appointment.startsAt })).toBe("appointment_started");
  });

  it("closes public booking at the cutoff for the participant, staff book until the start", () => {
    const atCutoff = { now: appointment.bookingClosesAt };
    expect(code({ ...atCutoff, actor: "participant" })).toBe("booking_closed");
    expect(code({ ...atCutoff, actor: "staff" })).toBe("ok");
    expect(code({ now: "2091-02-10T08:59:00.000Z", actor: "staff" })).toBe("ok");
    expect(code({ now: "2091-02-09T08:59:00.000Z", actor: "participant" })).toBe("ok");
  });

  it("refuses a terminal participation", () => {
    for (const status of ["withdrawn", "ta_completed", "exited"] as const) {
      expect(code({ participation: { ...request().participation, status } })).toBe(
        "participation_closed",
      );
    }
  });

  it("takes an info event's audience: the project or its wave, before active_in_tg", () => {
    const forWave = { ...appointment, audienceWaveId: "wave-2" };
    expect(code({ appointment: forWave })).toBe("not_in_audience");
    expect(code({ appointment: { ...forWave, audienceWaveId: "wave-1" } })).toBe("ok");
    const participation = { ...request().participation, status: "active_in_tg" as const };
    expect(code({ participation })).toBe("not_in_audience");
    expect(code({ participation: { ...participation, status: "informed" } })).toBe("ok");
  });

  it("takes a consultation only for a participation its host may list", () => {
    const slot = { ...appointment, kind: "consultation" as const };
    expect(code({ appointment: slot, hostMayList: false })).toBe("host_not_responsible");
    const participation = { ...request().participation, status: "active_in_tg" as const };
    expect(code({ appointment: slot, participation })).toBe("ok");
    // An info event has no host: the flag is irrelevant.
    expect(code({ hostMayList: false })).toBe("ok");
  });

  it("never books one appointment twice", () => {
    const own = {
      ...at(appointment.startsAt, appointment.endsAt, "info_event"),
      appointmentId: appointment.id,
    };
    expect(code({ liveBookings: [own] })).toBe("already_booked");
  });

  it("allows one live info-event booking that hasn't ended, any number of consultations", () => {
    const pastEvent = at("2091-01-20T09:00:00.000Z", "2091-01-20T10:00:00.000Z", "info_event");
    const runningEvent = at("2091-02-01T08:00:00.000Z", "2091-02-01T10:00:00.000Z", "info_event");
    const futureEvent = at("2091-03-01T09:00:00.000Z", "2091-03-01T10:00:00.000Z", "info_event");
    expect(code({ liveBookings: [pastEvent] })).toBe("ok");
    expect(code({ liveBookings: [runningEvent] })).toBe("info_event_limit");
    expect(code({ liveBookings: [futureEvent] })).toBe("info_event_limit");
    const slot = { ...appointment, kind: "consultation" as const };
    expect(
      code({
        appointment: slot,
        liveBookings: [
          futureEvent,
          at("2091-02-11T09:00:00.000Z", "2091-02-11T10:00:00.000Z"),
          at("2091-02-12T09:00:00.000Z", "2091-02-12T10:00:00.000Z"),
        ],
      }),
    ).toBe("ok");
  });

  it("refuses overlapping bookings of one participation; touching intervals are fine", () => {
    const slot = { ...appointment, kind: "consultation" as const };
    const before = at("2091-02-10T08:00:00.000Z", "2091-02-10T09:00:00.000Z");
    const after = at("2091-02-10T11:00:00.000Z", "2091-02-10T12:00:00.000Z");
    expect(code({ appointment: slot, liveBookings: [before, after] })).toBe("ok");
    const overlapStart = at("2091-02-10T08:00:00.000Z", "2091-02-10T09:01:00.000Z");
    const overlapEnd = at("2091-02-10T10:59:00.000Z", "2091-02-10T12:00:00.000Z");
    const inside = at("2091-02-10T09:30:00.000Z", "2091-02-10T10:00:00.000Z");
    for (const other of [overlapStart, overlapEnd, inside]) {
      expect(code({ appointment: slot, liveBookings: [other] })).toBe("booking_overlap");
    }
  });

  it("refuses when every seat is taken", () => {
    expect(code({ bookedCount: 1 })).toBe("ok");
    expect(code({ bookedCount: 2 })).toBe("appointment_full");
  });

  it("refuses after the wave's passed cutoff before informed; informed and later book", () => {
    const participation = { ...request().participation, latestEntryDate: "2091-02-05" };
    expect(code({ participation, today: "2091-02-05" })).toBe("ok");
    expect(code({ participation, today: "2091-02-06" })).toBe("after_cutoff");
    expect(
      code({ participation: { ...participation, status: "unreachable" }, today: "2091-02-06" }),
    ).toBe("after_cutoff");
    // The guard stays as it is: `informed` isn't refused (Q172).
    expect(
      code({ participation: { ...participation, status: "informed" }, today: "2091-02-06" }),
    ).toBe("ok");
    expect(code({ participation, projectType: "ta_only", today: "2091-02-06" })).toBe("ok");
    expect(
      code({ participation: { ...participation, latestEntryDate: null }, today: "2091-02-06" }),
    ).toBe("ok");
  });

  it("warns when the start lies after the applicable upcoming cutoff, whatever the wave guard says", () => {
    expect(warned("2091-02-05")).toEqual([
      { code: "beyond_upcoming_cutoff", latestEntryDate: "2091-02-05" },
    ]);
    // The project's final entry date for a participation without a wave (Q84), or an `informed`
    // one whose DSV track ends at the cutoff: the planner's projection decides, not the status.
    expect(
      warned("2091-02-05", {
        participation: {
          status: "informed",
          entryWaveId: null,
          latestEntryDate: null,
          entryCutoff: "2091-02-05",
        },
      }),
    ).toEqual([{ code: "beyond_upcoming_cutoff", latestEntryDate: "2091-02-05" }]);
    // Upcoming only: on the cutoff day still, after it no longer.
    expect(warned("2091-02-05", { today: "2091-02-05" })).toHaveLength(1);
    expect(
      warned("2091-02-05", {
        today: "2091-02-06",
        participation: {
          status: "informed",
          entryWaveId: "wave-1",
          latestEntryDate: "2091-02-05",
          entryCutoff: "2091-02-05",
        },
      }),
    ).toEqual([]);
    // No applicable cutoff (the planner's null), or a start before it: nothing.
    expect(warned(null)).toEqual([]);
    expect(warned("2091-03-15")).toEqual([]);
    // Only a bookable appointment carries a warning.
    expect(warned("2091-02-05", { bookedCount: 2 })).toEqual([]);
  });

  it("warns by the appointment's Berlin date: on the cutoff day itself nothing", () => {
    // 23:30 UTC on 9 Feb is 00:30 on 10 Feb in Berlin.
    const late = {
      ...appointment,
      startsAt: "2091-02-09T23:30:00.000Z",
      endsAt: "2091-02-10T01:00:00.000Z",
    };
    const participation = { ...request().participation, entryCutoff: "2091-02-10" };
    expect(bookingEligibility(request({ appointment: late, participation })).warnings).toEqual([]);
    const dayAfter = { ...participation, entryCutoff: "2091-02-09" };
    expect(
      bookingEligibility(request({ appointment: late, participation: dayAfter })).warnings,
    ).toEqual([{ code: "beyond_upcoming_cutoff", latestEntryDate: "2091-02-09" }]);
  });

  it("refuses in the documented order", () => {
    const everything: Partial<BookingRequest> = {
      appointment: { ...appointment, status: "cancelled", audienceWaveId: "wave-2" },
      participation: {
        status: "withdrawn",
        entryWaveId: "wave-1",
        latestEntryDate: "2091-01-01",
        entryCutoff: null,
      },
      bookedCount: 2,
      liveBookings: [
        {
          ...at(appointment.startsAt, appointment.endsAt, "info_event"),
          appointmentId: appointment.id,
        },
      ],
      now: "2091-02-10T09:00:00.000Z",
    };
    const order = [
      "appointment_cancelled",
      "appointment_started",
      "participation_closed",
      "not_in_audience",
      "already_booked",
      "appointment_full",
      "after_cutoff",
    ];
    let current = request(everything);
    const fixes: ((r: BookingRequest) => BookingRequest)[] = [
      (r) => ({ ...r, appointment: { ...r.appointment, status: "scheduled" } }),
      (r) => ({ ...r, now }),
      (r) => ({ ...r, participation: { ...r.participation, status: "contacted" } }),
      (r) => ({ ...r, appointment: { ...r.appointment, audienceWaveId: null } }),
      (r) => ({ ...r, liveBookings: [] }),
      (r) => ({ ...r, bookedCount: 0 }),
      (r) => ({ ...r, participation: { ...r.participation, latestEntryDate: null } }),
    ];
    order.forEach((expected, index) => {
      expect(bookingEligibility(current).code).toBe(expected);
      current = fixes[index]!(current);
    });
    expect(bookingEligibility(current).code).toBe("ok");
  });

  it("names the public cutoff before the participation, the limit before an overlap", () => {
    expect(
      code({
        actor: "participant",
        now: appointment.bookingClosesAt,
        participation: { ...request().participation, status: "exited" },
      }),
    ).toBe("booking_closed");
    const running = at("2091-02-10T08:00:00.000Z", "2091-02-10T10:00:00.000Z", "info_event");
    expect(code({ liveBookings: [running] })).toBe("info_event_limit");
    const slot = { ...appointment, kind: "consultation" as const };
    expect(code({ appointment: slot, hostMayList: false, liveBookings: [running] })).toBe(
      "host_not_responsible",
    );
    expect(code({ appointment: slot, liveBookings: [running], bookedCount: 2 })).toBe(
      "booking_overlap",
    );
  });
});

describe("cancellationEligibility", () => {
  it("cancels a live booking until the start", () => {
    expect(cancellationEligibility({ status: "booked" }, appointment, now)).toBe("ok");
    expect(cancellationEligibility({ status: "cancelled" }, appointment, now)).toBe(
      "booking_cancelled",
    );
    expect(cancellationEligibility({ status: "booked" }, appointment, appointment.startsAt)).toBe(
      "appointment_started",
    );
  });
});

describe("needsResolution", () => {
  const slot = { ...appointment, kind: "consultation" as const };
  const live = { status: "booked" as const };

  it("flags a live future consultation booking its host may no longer list", () => {
    // After an unassignment, a role removal or a deactivation the host may no longer list it.
    expect(needsResolution(live, slot, false, now)).toBe(true);
    expect(needsResolution(live, slot, true, now)).toBe(false);
  });

  it("never flags an info event, a cancelled booking or appointment, or a started slot", () => {
    expect(needsResolution(live, appointment, false, now)).toBe(false);
    expect(needsResolution({ status: "cancelled" }, slot, false, now)).toBe(false);
    expect(needsResolution(live, { ...slot, status: "cancelled" }, false, now)).toBe(false);
    expect(needsResolution(live, slot, false, slot.startsAt)).toBe(false);
  });
});

describe("bookingView", () => {
  const staff = (roles: ProjectRole[], assigned: string[] = []): Subject => ({
    kind: "staff",
    staffUserId: "staff-a",
    orgRoles: new Map(),
    projectRoles: { [projectId]: new Set(roles) },
    assignedParticipationIds: new Set(assigned),
  });
  const target = { projectId, capacity: 3 };
  const bookings = [{ participationId: "p-1" }, { participationId: "p-2" }];

  it("gives the PL and back office the exact count", () => {
    for (const roles of [["project_lead"], ["back_office"]] satisfies ProjectRole[][]) {
      expect(bookingView(staff(roles), target, bookings)).toEqual({
        scope: "all",
        booked: 2,
        availability: "available",
      });
    }
    expect(bookingView(staff(["project_lead"]), { ...target, capacity: 2 }, bookings)).toEqual({
      scope: "all",
      booked: 2,
      availability: "full",
    });
  });

  it("gives a consultant the exact count only while every booking is of their assigned ones", () => {
    expect(bookingView(staff(["consultant"], ["p-1", "p-2"]), target, bookings)).toEqual({
      scope: "all",
      booked: 2,
      availability: "available",
    });
    expect(bookingView(staff(["consultant"], ["p-1"]), target, bookings)).toEqual({
      scope: "own",
      own: 1,
      availability: "available",
    });
    expect(bookingView(staff(["consultant"]), { ...target, capacity: 2 }, bookings)).toEqual({
      scope: "own",
      own: 0,
      availability: "full",
    });
  });

  it("gives a staff user outside the project their own count only, never a total", () => {
    const orgRole: Subject = {
      kind: "staff",
      staffUserId: "staff-b",
      orgRoles: new Map([["admin", { regionIds: "all" }]]),
      projectRoles: {},
      assignedParticipationIds: new Set(),
    };
    expect(bookingView(orgRole, target, [])).toEqual({
      scope: "own",
      own: 0,
      availability: "available",
    });
  });

  it("gives a participant the seat state only", () => {
    const participant: Subject = {
      kind: "participant",
      participationId: "p-1",
      knowledgeCheckPassed: false,
    };
    expect(bookingView(participant, { ...target, capacity: 2 }, bookings)).toEqual({
      scope: "availability",
      availability: "full",
    });
  });
});
