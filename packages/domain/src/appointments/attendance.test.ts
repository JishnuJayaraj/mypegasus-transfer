import { describe, expect, it } from "vitest";
import { edges } from "../lifecycle/edges";
import { MainStatus } from "../lifecycle/enums";
import {
  appointmentCancellation,
  attendanceCapabilities,
  attendanceEligibility,
  attendanceStatusChanges,
  conflictReviewRefusal,
  conflictState,
  informedConfirmation,
  qualifiesForInformed,
  type AttendanceRequest,
  type CapabilityRequest,
} from "./attendance";

// Attendance and `informed` (process-and-lifecycle.md, appointments: attendance; Q163, Q164).
const appointment = {
  kind: "info_event" as const,
  status: "scheduled" as const,
  startsAt: "2091-02-10T09:00:00.000Z",
  endsAt: "2091-02-10T11:00:00.000Z",
};
const during = "2091-02-10T10:00:00.000Z";
const after = "2091-02-10T12:00:00.000Z";

const request = (overrides: Partial<AttendanceRequest> = {}): AttendanceRequest => ({
  appointment,
  booking: { attendance: null },
  attendance: "attended",
  participation: { status: "contacted", closedAt: null },
  lead: false,
  afterCloseReason: null,
  hostMayList: true,
  now: after,
  ...overrides,
});
const closed = { status: "withdrawn" as const, closedAt: "2091-02-11T02:00:00.000Z" };

describe("attendanceEligibility", () => {
  it("records `attended` from the start and `absent` after the end", () => {
    expect(attendanceEligibility(request({ now: during }))).toBe("ok");
    expect(attendanceEligibility(request({ now: appointment.startsAt }))).toBe("ok");
    expect(attendanceEligibility(request({ now: "2091-02-10T08:59:59.999Z" }))).toBe(
      "appointment_not_started",
    );
    expect(attendanceEligibility(request({ attendance: "absent", now: during }))).toBe(
      "appointment_not_ended",
    );
    expect(attendanceEligibility(request({ attendance: "absent", now: appointment.endsAt }))).toBe(
      "ok",
    );
  });

  it("records nothing on a cancelled appointment", () => {
    const cancelled = { ...appointment, status: "cancelled" as const };
    expect(attendanceEligibility(request({ appointment: cancelled }))).toBe(
      "appointment_cancelled",
    );
  });

  it("lets only the PL record after the close, with a reason, of an appointment started before it", () => {
    expect(attendanceEligibility(request({ participation: closed }))).toBe("participation_closed");
    expect(attendanceEligibility(request({ participation: closed, lead: true }))).toBe(
      "after_close_reason_required",
    );
    const reasoned = { participation: closed, lead: true, afterCloseReason: "late_entry" } as const;
    expect(attendanceEligibility(request(reasoned))).toBe("ok");
    expect(
      attendanceEligibility(
        request({ ...reasoned, participation: { ...closed, closedAt: appointment.startsAt } }),
      ),
    ).toBe("started_after_close");
    // A terminal status without its time fails closed.
    expect(
      attendanceEligibility(request({ ...reasoned, participation: { ...closed, closedAt: null } })),
    ).toBe("started_after_close");
    // No walk-in after the close.
    expect(attendanceEligibility(request({ ...reasoned, booking: null }))).toBe(
      "participation_closed",
    );
  });

  it("adds walk-ins as `attended` only; a consultation's only when its host may list them", () => {
    expect(attendanceEligibility(request({ booking: null }))).toBe("ok");
    expect(attendanceEligibility(request({ booking: null, attendance: "absent" }))).toBe(
      "not_booked",
    );
    const slot = { ...appointment, kind: "consultation" as const };
    expect(attendanceEligibility(request({ appointment: slot, booking: null }))).toBe("ok");
    expect(
      attendanceEligibility(request({ appointment: slot, booking: null, hostMayList: false })),
    ).toBe("host_not_responsible");
  });

  it("corrects a recorded attendance to the other value only", () => {
    expect(attendanceEligibility(request({ booking: { attendance: "attended" } }))).toBe(
      "attendance_unchanged",
    );
    expect(
      attendanceEligibility(request({ booking: { attendance: "attended" }, attendance: "absent" })),
    ).toBe("ok");
    expect(attendanceEligibility(request({ booking: { attendance: "absent" } }))).toBe("ok");
  });
});

describe("attendanceStatusChanges", () => {
  it("returns only rows of `edges`, ending in `informed`, from every status before it", () => {
    const expected: Partial<Record<MainStatus, string[]>> = {
      imported: ["imported>contacted", "contacted>informed"],
      contacted: ["contacted>informed"],
      unreachable: ["unreachable>contacted", "contacted>informed"],
    };
    for (const status of MainStatus.options) {
      const changes = attendanceStatusChanges(status, "attended", false);
      for (const change of changes) {
        expect(edges).toContain(change);
        expect(change).toMatchObject({ track: "main", actor: "user", kind: "manual" });
      }
      expect(changes.map((e) => `${e.from}>${e.to}`)).toEqual(expected[status] ?? []);
    }
    // `unreachable → contacted` keeps its guard.
    expect(attendanceStatusChanges("unreachable", "attended", false)[0]!.guards).toEqual([
      "before_cutoff",
    ]);
  });

  it("returns nothing for `absent` or after the close", () => {
    for (const status of MainStatus.options) {
      expect(attendanceStatusChanges(status, "absent", false)).toEqual([]);
      expect(attendanceStatusChanges(status, "attended", true)).toEqual([]);
    }
  });
});

const qualifying = {
  status: "booked" as const,
  attendance: "attended" as const,
  afterCloseReason: null,
  informedBasis: false,
};

describe("qualifiesForInformed", () => {
  it("needs a live `attended` booking recorded before any close, before `informed`", () => {
    expect(qualifiesForInformed(qualifying, "contacted")).toBe(true);
    expect(qualifiesForInformed(qualifying, "unreachable")).toBe(true);
    expect(qualifiesForInformed(qualifying, "informed")).toBe(false);
    expect(qualifiesForInformed(qualifying, "withdrawn")).toBe(false);
    expect(qualifiesForInformed({ ...qualifying, attendance: "absent" }, "contacted")).toBe(false);
    expect(qualifiesForInformed({ ...qualifying, attendance: null }, "contacted")).toBe(false);
    expect(qualifiesForInformed({ ...qualifying, status: "cancelled" }, "contacted")).toBe(false);
    expect(
      qualifiesForInformed({ ...qualifying, afterCloseReason: "late_entry" }, "contacted"),
    ).toBe(false);
  });
});

const confirm = (overrides: Partial<Parameters<typeof informedConfirmation>[0]> = {}) =>
  informedConfirmation({
    booking: qualifying,
    participationStatus: "contacted",
    openConflict: false,
    lead: false,
    ...overrides,
  });

describe("informedConfirmation", () => {
  it("changes the status on a qualifying attendance before `informed`", () => {
    expect(confirm()).toEqual({ code: "ok", statusChange: true });
  });

  it("confirms a replacement basis without a status change while a conflict is open", () => {
    expect(confirm({ participationStatus: "informed", openConflict: true })).toEqual({
      code: "ok",
      statusChange: false,
    });
    expect(confirm({ participationStatus: "active_in_tg", openConflict: true })).toEqual({
      code: "ok",
      statusChange: false,
    });
    // After the close, the PL only.
    expect(confirm({ participationStatus: "withdrawn", openConflict: true })).toEqual({
      code: "participation_closed",
    });
    expect(confirm({ participationStatus: "withdrawn", openConflict: true, lead: true })).toEqual({
      code: "ok",
      statusChange: false,
    });
    const late = { ...qualifying, afterCloseReason: "late_entry" as const };
    expect(
      confirm({ booking: late, participationStatus: "exited", openConflict: true, lead: true }),
    ).toEqual({ code: "ok", statusChange: false });
  });

  it("refuses everything else with its code", () => {
    expect(confirm({ booking: { ...qualifying, status: "cancelled" } })).toEqual({
      code: "booking_cancelled",
    });
    expect(confirm({ booking: { ...qualifying, attendance: "absent" } })).toEqual({
      code: "not_attended",
    });
    expect(confirm({ booking: { ...qualifying, informedBasis: true } })).toEqual({
      code: "already_basis",
    });
    expect(confirm({ participationStatus: "informed" })).toEqual({ code: "already_informed" });
    expect(confirm({ participationStatus: "exited", lead: true })).toEqual({
      code: "participation_closed",
    });
  });
});

describe("conflictState and its review", () => {
  const basis = { informedBasis: true, attendance: "absent" as const, resolution: null };

  it("is open while the basis is `absent` and unresolved, escalated until a resolution", () => {
    expect(conflictState({ ...basis, escalated: false })).toBe("open");
    expect(conflictState({ ...basis, escalated: true })).toBe("escalated");
    expect(
      conflictState({ ...basis, escalated: true, resolution: "information_delivered_otherwise" }),
    ).toBe("resolved");
    expect(conflictState({ ...basis, attendance: "attended", escalated: false })).toBeNull();
    expect(conflictState({ ...basis, informedBasis: false, escalated: false })).toBeNull();
  });

  it("escalates an open conflict once; attests an open or escalated one", () => {
    expect(conflictReviewRefusal("open", "escalated")).toBeNull();
    expect(conflictReviewRefusal("escalated", "escalated")).toBe("already_escalated");
    expect(conflictReviewRefusal("escalated", "information_delivered_otherwise")).toBeNull();
    expect(conflictReviewRefusal("open", "information_delivered_otherwise")).toBeNull();
    expect(conflictReviewRefusal("resolved", "information_delivered_otherwise")).toBe(
      "no_conflict",
    );
    expect(conflictReviewRefusal(null, "escalated")).toBe("no_conflict");
  });
});

describe("appointmentCancellation", () => {
  it("cancels without attendance; corrects absences only as the PL's `did_not_take_place`", () => {
    expect(appointmentCancellation("too_few_bookings", false, [])).toBe("cancel");
    expect(appointmentCancellation("did_not_take_place", true, ["absent", "absent"])).toBe(
      "correction",
    );
    expect(appointmentCancellation("did_not_take_place", true, ["absent", "attended"])).toBe(
      "attendance_recorded",
    );
    expect(appointmentCancellation("did_not_take_place", false, ["absent"])).toBe(
      "attendance_recorded",
    );
    expect(appointmentCancellation("other", true, ["absent"])).toBe("attendance_recorded");
  });
});

const capabilities = (overrides: Partial<CapabilityRequest> = {}) =>
  attendanceCapabilities({
    appointment,
    booking: { ...qualifying, attendance: null },
    participation: { status: "contacted", closedAt: null },
    conflict: null,
    openConflict: false,
    record: true,
    lead: false,
    projectActive: true,
    now: after,
    ...overrides,
  });

describe("attendanceCapabilities", () => {
  it("offers recording and the dialog's informed tick on a first recording before `informed`", () => {
    expect(capabilities()).toEqual({
      recordAttended: true,
      recordAbsent: true,
      offerInformed: true,
      afterClose: false,
      markInformed: false,
      confirmBasis: false,
      reviewConflict: false,
    });
    expect(capabilities({ now: during })).toMatchObject({
      recordAttended: true,
      recordAbsent: false,
    });
    expect(capabilities({ participation: { status: "informed", closedAt: null } })).toMatchObject({
      offerInformed: false,
    });
  });

  it("offers the correction's other value and the separate informed action", () => {
    expect(capabilities({ booking: qualifying })).toMatchObject({
      recordAttended: false,
      recordAbsent: true,
      offerInformed: false,
      markInformed: true,
    });
  });

  it("offers the closed-case flow to the PL only, never informed", () => {
    const terminal = { participation: closed, booking: qualifying };
    expect(capabilities(terminal)).toMatchObject({
      recordAbsent: false,
      afterClose: true,
      markInformed: false,
    });
    expect(capabilities({ ...terminal, lead: true })).toMatchObject({
      recordAbsent: true,
      afterClose: true,
      offerInformed: false,
      markInformed: false,
    });
  });

  it("offers a replacement basis and the PL's review while a conflict is open", () => {
    const informed = { status: "informed" as const, closedAt: null };
    expect(
      capabilities({ booking: qualifying, participation: informed, openConflict: true }),
    ).toMatchObject({ confirmBasis: true, markInformed: false, reviewConflict: false });
    expect(capabilities({ conflict: "escalated", lead: true })).toMatchObject({
      reviewConflict: true,
    });
    expect(capabilities({ conflict: "resolved", lead: true })).toMatchObject({
      reviewConflict: false,
    });
  });

  it("offers nothing without the permission, an active project or a live booking", () => {
    const none = {
      recordAttended: false,
      recordAbsent: false,
      offerInformed: false,
      afterClose: false,
      markInformed: false,
      confirmBasis: false,
      reviewConflict: false,
    };
    expect(capabilities({ record: false })).toEqual(none);
    expect(capabilities({ projectActive: false })).toEqual(none);
    expect(capabilities({ booking: { ...qualifying, status: "cancelled" } })).toEqual(none);
  });
});
