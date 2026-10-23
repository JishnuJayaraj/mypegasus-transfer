import { describe, expect, it } from "vitest";
import {
  AppointmentFilter,
  AppointmentItemKind,
  appointmentItems,
  followUpRefusal,
  matchesAppointmentFilter,
  missedBookings,
  missedResolutionRefusal,
  MissedResolution,
  type AppointmentItemBooking,
  type AppointmentItemNotice,
} from "./appointments";

// Synthetic bookings of one participation (Europe/Berlin is UTC+1 in winter).
const now = "2027-02-10T09:00:00.000Z";
const today = "2027-02-10";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function booking(n: number, overrides: Partial<AppointmentItemBooking> = {}) {
  return {
    id: id(n),
    appointmentId: id(100 + n),
    appointmentKind: "info_event",
    appointmentStatus: "scheduled",
    // Ended on 8 February (Berlin), recorded absent.
    startsAt: "2027-02-08T09:00:00.000Z",
    endsAt: "2027-02-08T11:00:00.000Z",
    status: "booked",
    attendance: null,
    followUpOf: null,
    missedResolution: null,
    conflict: null,
    hostMayList: null,
    ...overrides,
  } satisfies AppointmentItemBooking;
}

function notice(overrides: Partial<AppointmentItemNotice> = {}) {
  return {
    appointmentId: id(200),
    appointmentKind: "consultation",
    startsAt: "2027-02-12T09:00:00.000Z",
    kind: "appointment_cancelled",
    status: "cancelled",
    cancelReason: "no_channel",
    followedUp: false,
    ...overrides,
  } satisfies AppointmentItemNotice;
}

const open = { status: "informed", closedAt: null } as const;
const closed = { status: "withdrawn", closedAt: "2027-02-09T22:00:00.000Z" } as const;

const kinds = (
  bookings: readonly AppointmentItemBooking[],
  notices: readonly AppointmentItemNotice[] = [],
  participation: { status: "informed" | "withdrawn"; closedAt: string | null } = open,
  at = { now, today },
) =>
  appointmentItems(
    bookings,
    notices,
    participation.status,
    participation.closedAt,
    at.now,
    at.today,
  ).items.map((item) => `${item.kind}:${item.appointmentId}`);

describe("appointmentItems: next", () => {
  it("is the earliest live future booking, of a scheduled appointment", () => {
    const later = booking(1, {
      appointmentKind: "consultation",
      startsAt: "2027-02-20T09:00:00.000Z",
      endsAt: "2027-02-20T10:00:00.000Z",
    });
    const sooner = booking(2, {
      startsAt: "2027-02-15T09:00:00.000Z",
      endsAt: "2027-02-15T10:00:00.000Z",
    });
    const cancelled = booking(3, {
      status: "cancelled",
      startsAt: "2027-02-11T09:00:00.000Z",
      endsAt: "2027-02-11T10:00:00.000Z",
    });
    const result = appointmentItems([later, sooner, cancelled], [], "informed", null, now, today);
    expect(result.next).toEqual({ kind: "info_event", startsAt: "2027-02-15T09:00:00.000Z" });
    expect(appointmentItems([later], [], "informed", null, now, today).next).toEqual({
      kind: "consultation",
      startsAt: "2027-02-20T09:00:00.000Z",
    });
  });

  it("is null without a future booking, at the start and for a terminal participation", () => {
    const started = booking(1, { startsAt: now, endsAt: "2027-02-10T10:00:00.000Z" });
    expect(appointmentItems([started], [], "informed", null, now, today).next).toBeNull();
    const future = booking(2, { startsAt: "2027-02-15T09:00:00.000Z" });
    expect(appointmentItems([future], [], "withdrawn", null, now, today).next).toBeNull();
    expect(appointmentItems([], [], "informed", null, now, today)).toEqual({
      next: null,
      items: [],
    });
  });
});

describe("appointmentItems: attendance_missing", () => {
  // Ends 10 February 22:30 UTC = 23:30 Berlin: its Berlin end date is the 10th.
  const late = booking(1, {
    startsAt: "2027-02-10T20:00:00.000Z",
    endsAt: "2027-02-10T22:30:00.000Z",
  });

  it("from the day after the Berlin end date, not on it", () => {
    expect(
      kinds([late], [], open, { now: "2027-02-10T23:30:00.000Z", today: "2027-02-11" }),
    ).toEqual([`attendance_missing:${id(101)}`]);
    // Ended (UTC) but still the 10th in Berlin: not yet.
    expect(
      kinds([late], [], open, { now: "2027-02-10T22:45:00.000Z", today: "2027-02-10" }),
    ).toEqual([]);
  });

  it("only while unrecorded, on a live booking", () => {
    expect(kinds([booking(1)])).toEqual([`attendance_missing:${id(101)}`]);
    expect(kinds([booking(1, { attendance: "attended" })])).toEqual([]);
    expect(kinds([booking(1, { status: "cancelled" })])).toEqual([]);
    expect(kinds([booking(1, { appointmentStatus: "cancelled" })])).toEqual([]);
  });

  it("stays for a terminal participation (the PL's closed-case flow), for an appointment that started before the close", () => {
    expect(kinds([booking(1)], [], closed)).toEqual([`attendance_missing:${id(101)}`]);
    const afterClose = booking(2, {
      startsAt: "2027-02-09T23:00:00.000Z",
      endsAt: "2027-02-09T23:30:00.000Z",
    });
    expect(kinds([afterClose], [], closed)).toEqual([]);
    // A terminal participation without its close time still shows the work.
    expect(kinds([booking(1)], [], { status: "withdrawn", closedAt: null })).toEqual([
      `attendance_missing:${id(101)}`,
    ]);
  });
});

describe("appointmentItems: missed", () => {
  const absent = (n: number, overrides: Partial<AppointmentItemBooking> = {}) =>
    booking(n, { attendance: "absent", ...overrides });
  const laterEvent = (n: number, overrides: Partial<AppointmentItemBooking> = {}) =>
    booking(n, {
      startsAt: "2027-02-15T09:00:00.000Z",
      endsAt: "2027-02-15T11:00:00.000Z",
      ...overrides,
    });
  const consultation = (n: number, overrides: Partial<AppointmentItemBooking> = {}) =>
    booking(n, { appointmentKind: "consultation", attendance: "absent", ...overrides });

  it("an absence without follow-up or resolution", () => {
    expect(kinds([absent(1)])).toEqual([`missed:${id(101)}`]);
    expect(kinds([absent(1, { status: "cancelled" })])).toEqual([]);
  });

  it("an info event: cleared while a later info-event booking is live or attended", () => {
    expect(kinds([absent(1), laterEvent(2)])).toEqual([]);
    const attended = laterEvent(2, {
      startsAt: "2027-02-09T09:00:00.000Z",
      endsAt: "2027-02-09T11:00:00.000Z",
      attendance: "attended",
    });
    expect(kinds([absent(1), attended])).toEqual([]);
  });

  it("back when the follow-up is cancelled", () => {
    expect(kinds([absent(1), laterEvent(2, { status: "cancelled" })])).toEqual([
      `missed:${id(101)}`,
    ]);
  });

  it("passed on when the follow-up is absent: one item per chain", () => {
    const absentAgain = laterEvent(2, {
      startsAt: "2027-02-09T09:00:00.000Z",
      endsAt: "2027-02-09T11:00:00.000Z",
      attendance: "absent",
    });
    expect(kinds([absent(1), absentAgain])).toEqual([`missed:${id(102)}`]);
  });

  it("an earlier info event, a consultation or a cancelled appointment's booking is no follow-up", () => {
    const earlier = booking(2, {
      startsAt: "2027-02-01T09:00:00.000Z",
      endsAt: "2027-02-01T11:00:00.000Z",
      attendance: "attended",
    });
    const unrelated = laterEvent(3, { appointmentKind: "consultation" });
    expect(kinds([absent(1), earlier, unrelated])).toEqual([`missed:${id(101)}`]);
  });

  it("a consultation: only a booking linked by followUpOf clears it", () => {
    const missed = consultation(1);
    const unrelated = laterEvent(2, { appointmentKind: "consultation" });
    expect(kinds([missed, unrelated])).toEqual([`missed:${id(101)}`]);
    // A later info event isn't its follow-up either.
    expect(kinds([missed, laterEvent(3)])).toEqual([`missed:${id(101)}`]);
    const linked = laterEvent(4, { appointmentKind: "consultation", followUpOf: id(1) });
    expect(kinds([missed, linked])).toEqual([]);
    expect(kinds([missed, { ...linked, status: "cancelled" }])).toEqual([`missed:${id(101)}`]);
    expect(kinds([missed, { ...linked, attendance: "absent" }])).toEqual([`missed:${id(104)}`]);
    expect(kinds([missed, { ...linked, attendance: "attended" }])).toEqual([]);
  });

  it("an explicit resolution ends the chain", () => {
    expect(kinds([absent(1, { missedResolution: "participant_declined" })])).toEqual([]);
    const resolvedFollowUp = laterEvent(2, {
      startsAt: "2027-02-09T09:00:00.000Z",
      endsAt: "2027-02-09T11:00:00.000Z",
      attendance: "absent",
      missedResolution: "no_longer_needed",
    });
    expect(kinds([absent(1), resolvedFollowUp])).toEqual([]);
    expect(missedBookings([absent(1), resolvedFollowUp])).toEqual(new Set());
  });

  it("not for a terminal participation", () => {
    expect(kinds([absent(1)], [], closed)).toEqual([]);
  });

  it("missedBookings names the actionable bookings", () => {
    expect(missedBookings([absent(1), consultation(2)])).toEqual(new Set([id(1), id(2)]));
  });
});

describe("appointmentItems: notice_undelivered, needs_resolution, attendance_conflict", () => {
  it("an undelivered organizer's notice until its follow-up, not for a closed participation", () => {
    expect(kinds([], [notice()])).toEqual([`notice_undelivered:${id(200)}`]);
    expect(kinds([], [notice({ status: "failed", cancelReason: null })])).toHaveLength(1);
    expect(kinds([], [notice({ followedUp: true })])).toEqual([]);
    expect(kinds([], [notice({ status: "sent", cancelReason: null })])).toEqual([]);
    expect(kinds([], [notice({ kind: "appointment_invitation" })])).toEqual([]);
    expect(kinds([], [notice()], closed)).toEqual([]);
  });

  it("a live future consultation whose host may no longer list the participation, for the PL", () => {
    const slot = booking(1, {
      appointmentKind: "consultation",
      startsAt: "2027-02-15T09:00:00.000Z",
      endsAt: "2027-02-15T10:00:00.000Z",
      hostMayList: false,
    });
    expect(kinds([slot])).toEqual([`needs_resolution:${id(101)}`]);
    expect(kinds([{ ...slot, hostMayList: true }])).toEqual([]);
    // Not the viewer's to resolve: no item.
    expect(kinds([{ ...slot, hostMayList: null }])).toEqual([]);
    expect(kinds([slot], [], { status: "withdrawn", closedAt: null })).toEqual([]);
  });

  it("an unresolved conflict, open or escalated, also after the close", () => {
    const basis = booking(1, { attendance: "absent", conflict: "open", missedResolution: null });
    // The conflict is the item of a basis corrected to absent, not a missed one.
    expect(kinds([basis])).toEqual([`attendance_conflict:${id(101)}`]);
    expect(kinds([{ ...basis, conflict: "escalated" }], [], closed)).toEqual([
      `attendance_conflict:${id(101)}`,
    ]);
    // A resolved conflict leaves nothing: the information was delivered.
    expect(kinds([{ ...basis, conflict: "resolved" }])).toEqual([]);
  });

  it("orders the items by kind, then by start: the first is the most urgent", () => {
    const missing = booking(1, {
      startsAt: "2027-02-05T09:00:00.000Z",
      endsAt: "2027-02-05T10:00:00.000Z",
    });
    const older = booking(2, {
      appointmentKind: "consultation",
      startsAt: "2027-02-01T09:00:00.000Z",
      endsAt: "2027-02-01T10:00:00.000Z",
    });
    const absent = booking(3, { appointmentKind: "consultation", attendance: "absent" });
    const result = appointmentItems(
      [absent, missing, older],
      [notice()],
      "informed",
      null,
      now,
      today,
    );
    expect(result.items.map((item) => [item.kind, item.appointmentId])).toEqual([
      ["attendance_missing", id(102)],
      ["attendance_missing", id(101)],
      ["missed", id(103)],
      ["notice_undelivered", id(200)],
    ]);
    expect(result.items[0]).toEqual({
      kind: "attendance_missing",
      appointmentId: id(102),
      appointmentKind: "consultation",
      startsAt: "2027-02-01T09:00:00.000Z",
    });
  });
});

describe("matchesAppointmentFilter", () => {
  const empty = { next: null, items: [] };
  const item = (kind: AppointmentItemKind) => ({
    next: null,
    items: [{ kind, appointmentId: id(1), appointmentKind: "info_event" as const, startsAt: now }],
  });

  it("upcoming is a next booking", () => {
    expect(
      matchesAppointmentFilter(
        { next: { kind: "info_event", startsAt: now }, items: [] },
        "upcoming",
      ),
    ).toBe(true);
    expect(matchesAppointmentFilter(empty, "upcoming")).toBe(false);
  });

  it("overdue, to_resolve and each kind", () => {
    const overdue = new Set(["attendance_missing", "missed"]);
    for (const kind of AppointmentItemKind.options) {
      expect(matchesAppointmentFilter(item(kind), kind)).toBe(true);
      expect(matchesAppointmentFilter(item(kind), "overdue")).toBe(overdue.has(kind));
      expect(matchesAppointmentFilter(item(kind), "to_resolve")).toBe(!overdue.has(kind));
      expect(matchesAppointmentFilter(item(kind), "upcoming")).toBe(false);
    }
    expect(matchesAppointmentFilter(item("missed"), "attendance_missing")).toBe(false);
    expect(AppointmentFilter.options).toEqual([
      "upcoming",
      "overdue",
      "to_resolve",
      ...AppointmentItemKind.options,
    ]);
  });
});

describe("followUpRefusal", () => {
  const missed = booking(1, { appointmentKind: "consultation", attendance: "absent" });

  it("links a consultation to a missed consultation of the same participation", () => {
    expect(followUpRefusal(missed, [missed], "consultation")).toBeNull();
  });

  it("refuses another kind, a booking that isn't missed now", () => {
    expect(followUpRefusal(missed, [missed], "info_event")).toBe("follow_up_kind_mismatch");
    const event = booking(2, { attendance: "absent" });
    expect(followUpRefusal(event, [event], "consultation")).toBe("follow_up_kind_mismatch");
    const attended = { ...missed, attendance: "attended" as const };
    expect(followUpRefusal(attended, [attended], "consultation")).toBe("follow_up_not_missed");
    const followed = booking(3, { appointmentKind: "consultation", followUpOf: id(1) });
    expect(followUpRefusal(missed, [missed, followed], "consultation")).toBe(
      "follow_up_not_missed",
    );
    const resolved = { ...missed, missedResolution: "no_longer_needed" as const };
    expect(followUpRefusal(resolved, [resolved], "consultation")).toBe("follow_up_not_missed");
  });
});

describe("missedResolutionRefusal", () => {
  const missed = booking(1, { attendance: "absent" });

  it("a missed appointment of an open participation, once", () => {
    expect(missedResolutionRefusal(missed, [missed], "informed")).toBeNull();
    expect(missedResolutionRefusal(missed, [missed], "withdrawn")).toBe("participation_closed");
    const resolved = { ...missed, missedResolution: "participant_declined" as const };
    expect(missedResolutionRefusal(resolved, [resolved], "informed")).toBe("already_resolved");
    const later = booking(2, { startsAt: "2027-02-15T09:00:00.000Z" });
    expect(missedResolutionRefusal(missed, [missed, later], "informed")).toBe("not_missed");
  });

  it("has the closed reasons", () => {
    expect(MissedResolution.options).toEqual([
      "participant_declined",
      "information_delivered_otherwise",
      "no_longer_needed",
    ]);
  });
});
