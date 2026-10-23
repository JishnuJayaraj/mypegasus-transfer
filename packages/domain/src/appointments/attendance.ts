import { z } from "zod";
import { edges, type Edge } from "../lifecycle/edges";
import { terminalMainStatuses, type MainStatus } from "../lifecycle/enums";
import type {
  AppointmentCancelReason,
  AppointmentKind,
  AppointmentStatus,
  BookingStatus,
} from "./model";

// Attendance and `informed` (process-and-lifecycle.md, appointments: attendance; Q163, Q164).
// Recording what happened and authorizing what happens next are two steps. Pure: the API passes
// the facts it loaded and the clock's `now`; the database decides again under the locks
// (ADR-0002, appointments).

/** What happened at an appointment; no OpenAPI id (also used `.nullable()`). */
export const Attendance = z.enum(["attended", "absent"]);
export type Attendance = z.infer<typeof Attendance>;

/** Why the PL records after a participation closed (Q163); no OpenAPI id (nullable too). */
export const AttendanceAfterCloseReason = z.enum(["late_entry", "correction"]);
export type AttendanceAfterCloseReason = z.infer<typeof AttendanceAfterCloseReason>;

/**
 * How a conflict ended: another `attended` booking confirmed as the basis, or the PL's
 * attestation; no OpenAPI id (nullable too).
 */
export const AttendanceConflictResolution = z.enum([
  "replacement_basis",
  "information_delivered_otherwise",
]);
export type AttendanceConflictResolution = z.infer<typeof AttendanceConflictResolution>;

/** The PL's review of a conflict: the open handling state, or the attestation. */
export const AttendanceConflictReview = z
  .enum(["escalated", "information_delivered_otherwise"])
  .meta({ id: "AttendanceConflictReview" });
export type AttendanceConflictReview = z.infer<typeof AttendanceConflictReview>;

/** A basis booking's conflict; no OpenAPI id (nullable too). */
export const AttendanceConflictState = z.enum(["open", "escalated", "resolved"]);
export type AttendanceConflictState = z.infer<typeof AttendanceConflictState>;

/** Why one attendance row is refused, in the order `attendanceEligibility` checks. */
export type AttendanceRefusal =
  | "appointment_cancelled"
  | "appointment_not_started"
  | "appointment_not_ended"
  | "participation_closed"
  | "after_close_reason_required"
  | "started_after_close"
  | "not_booked"
  | "host_not_responsible"
  | "attendance_unchanged";

export type AttendanceRequest = {
  appointment: {
    kind: AppointmentKind;
    status: AppointmentStatus;
    /** UTC instants (ISO 8601). */
    startsAt: string;
    endsAt: string;
  };
  /** The participation's live booking of the appointment; null for a walk-in. */
  booking: { attendance: Attendance | null } | null;
  attendance: Attendance;
  participation: {
    status: MainStatus;
    /** When it became terminal; null while it isn't (a terminal one without it fails closed). */
    closedAt: string | null;
  };
  /** Whether the recorder is a PL of the project: after the close only the PL records. */
  lead: boolean;
  afterCloseReason: AttendanceAfterCloseReason | null;
  /** For a consultation's walk-in: whether its host may list the participation now (Q62). */
  hostMayList: boolean;
  now: string;
};

const ms = (at: string) => Date.parse(at);
const beforeInformed: ReadonlySet<MainStatus> = new Set(["imported", "contacted", "unreachable"]);

/**
 * Whether one attendance row may be recorded now, the first refusal in this order (Q163, Q164):
 * a scheduled appointment; `attended` from the start, `absent` after the end; after the
 * participation closed only the PL, with a reason, for a booking of an appointment that started
 * before the close (no walk-in then); a walk-in (no live booking) only `attended`, for a
 * consultation one its host may list; a recorded attendance corrected to the other value only.
 */
export function attendanceEligibility(request: AttendanceRequest): "ok" | AttendanceRefusal {
  const { appointment, booking, attendance, participation, now } = request;
  if (appointment.status === "cancelled") return "appointment_cancelled";
  if (attendance === "attended" && ms(now) < ms(appointment.startsAt)) {
    return "appointment_not_started";
  }
  if (attendance === "absent" && ms(now) < ms(appointment.endsAt)) return "appointment_not_ended";
  if (terminalMainStatuses.has(participation.status)) {
    if (!request.lead || booking === null) return "participation_closed";
    if (request.afterCloseReason === null) return "after_close_reason_required";
    const { closedAt } = participation;
    if (closedAt === null || ms(appointment.startsAt) >= ms(closedAt)) {
      return "started_after_close";
    }
  }
  if (booking === null) {
    if (attendance !== "attended") return "not_booked";
    if (appointment.kind === "consultation" && !request.hostMayList) {
      return "host_not_responsible";
    }
  } else if (booking.attendance === attendance) {
    return "attendance_unchanged";
  }
  return "ok";
}

/** The `manual` staff edge of the main track from `from` to `to` (a row of `edges`). */
const manualEdge = (from: MainStatus, to: MainStatus): Edge =>
  edges.find(
    (edge) =>
      edge.track === "main" &&
      edge.from === from &&
      edge.to === to &&
      edge.actor === "user" &&
      edge.kind === "manual",
  )!;

const toInformed: Partial<Record<MainStatus, readonly Edge[]>> = {
  imported: [manualEdge("imported", "contacted"), manualEdge("contacted", "informed")],
  contacted: [manualEdge("contacted", "informed")],
  unreachable: [manualEdge("unreachable", "contacted"), manualEdge("contacted", "informed")],
};

/**
 * The status changes "als informiert erfassen" makes (Q163), each its own `status_changed` along
 * an existing `manual` edge with its guards (`unreachable → contacted` keeps `before_cutoff`):
 * from `contacted`, `imported` or `unreachable` to `informed`; nothing for `absent`, after the
 * close, or from `informed` on.
 */
export function attendanceStatusChanges(
  status: MainStatus,
  attendance: Attendance,
  afterClose: boolean,
): readonly Edge[] {
  if (attendance !== "attended" || afterClose) return [];
  return toInformed[status] ?? [];
}

export type AttendanceBooking = {
  status: BookingStatus;
  attendance: Attendance | null;
  afterCloseReason: AttendanceAfterCloseReason | null;
  /** Marked as the basis of `informed` (or of a replacement). */
  informedBasis: boolean;
};

/**
 * A qualifying attendance for "Als informiert erfassen" (Q163): a live booking recorded
 * `attended`, not after a close, of a participation before `informed`.
 */
export function qualifiesForInformed(
  booking: Pick<AttendanceBooking, "status" | "attendance" | "afterCloseReason">,
  participationStatus: MainStatus,
): boolean {
  return (
    booking.status === "booked" &&
    booking.attendance === "attended" &&
    booking.afterCloseReason === null &&
    beforeInformed.has(participationStatus)
  );
}

export type InformedRefusal =
  | "booking_cancelled"
  | "not_attended"
  | "already_basis"
  | "participation_closed"
  | "already_informed";

/**
 * "Als informiert erfassen" or "Als Grundlage bestätigen" on one booking (Q163): on a qualifying
 * attendance with the status change; while the participation has an open conflict, a replacement
 * basis on another `attended` booking without one (after the close the PL only).
 */
export function informedConfirmation(input: {
  booking: AttendanceBooking;
  participationStatus: MainStatus;
  /** Another booking of the participation is a basis in conflict, unresolved. */
  openConflict: boolean;
  lead: boolean;
}): { code: "ok"; statusChange: boolean } | { code: InformedRefusal } {
  const { booking, participationStatus } = input;
  if (booking.status !== "booked") return { code: "booking_cancelled" };
  if (booking.attendance !== "attended") return { code: "not_attended" };
  if (booking.informedBasis) return { code: "already_basis" };
  if (qualifiesForInformed(booking, participationStatus)) return { code: "ok", statusChange: true };
  const terminal = terminalMainStatuses.has(participationStatus);
  if (input.openConflict && (!terminal || input.lead)) return { code: "ok", statusChange: false };
  return { code: terminal ? "participation_closed" : "already_informed" };
}

/**
 * A basis booking's conflict (Q163): `open` while its attendance is corrected to `absent` and no
 * resolution is recorded, `escalated` once the PL records that handling state, `resolved` after a
 * replacement basis or the PL's attestation; null for any other booking.
 */
export function conflictState(booking: {
  informedBasis: boolean;
  attendance: Attendance | null;
  escalated: boolean;
  resolution: AttendanceConflictResolution | null;
}): AttendanceConflictState | null {
  if (!booking.informedBasis) return null;
  if (booking.resolution !== null) return "resolved";
  if (booking.attendance !== "absent") return null;
  return booking.escalated ? "escalated" : "open";
}

/** The PL's review of a conflict: `escalated` once, the attestation while it is unresolved. */
export function conflictReviewRefusal(
  state: AttendanceConflictState | null,
  review: AttendanceConflictReview,
): "no_conflict" | "already_escalated" | null {
  if (state !== "open" && state !== "escalated") return "no_conflict";
  if (review === "escalated" && state === "escalated") return "already_escalated";
  return null;
}

/**
 * An organizer's cancellation with the attendance recorded on the appointment's live bookings
 * (Q164): none, a plain cancellation; absences only, the PL's `did_not_take_place` correction
 * (each absence superseded and kept in the history); anything else `attendance_recorded`.
 */
export function appointmentCancellation(
  reason: AppointmentCancelReason,
  lead: boolean,
  recorded: readonly Attendance[],
): "cancel" | "correction" | "attendance_recorded" {
  if (recorded.length === 0) return "cancel";
  const correction =
    reason === "did_not_take_place" && lead && recorded.every((value) => value === "absent");
  return correction ? "correction" : "attendance_recorded";
}

export type CapabilityRequest = {
  appointment: AttendanceRequest["appointment"];
  booking: AttendanceBooking;
  participation: AttendanceRequest["participation"];
  conflict: AttendanceConflictState | null;
  openConflict: boolean;
  /** `mayRecordAttendance` for the participation (the PL, the assigned consultant). */
  record: boolean;
  lead: boolean;
  projectActive: boolean;
  now: string;
};

/**
 * What the viewer may do with a booking's attendance now (the buttons follow these, ADR-0010):
 * record either value (the closed-case flow with `afterClose`), the dialog's "als informiert
 * erfassen" on a first recording before `informed`, the separate action, a replacement basis and
 * the PL's conflict review.
 */
export function attendanceCapabilities(input: CapabilityRequest) {
  const { booking, participation, lead } = input;
  const live = input.projectActive && input.record && booking.status === "booked";
  const record = (attendance: Attendance) => {
    const code = attendanceEligibility({
      appointment: input.appointment,
      booking,
      attendance,
      participation,
      lead,
      // The closed-case flow's reason is the dialog's to give.
      afterCloseReason: "correction",
      hostMayList: true,
      now: input.now,
    });
    return live && code === "ok";
  };
  const confirmation = informedConfirmation({
    booking,
    participationStatus: participation.status,
    openConflict: input.openConflict,
    lead,
  });
  const confirms = (statusChange: boolean) =>
    live && confirmation.code === "ok" && confirmation.statusChange === statusChange;
  return {
    recordAttended: record("attended"),
    recordAbsent: record("absent"),
    offerInformed: live && booking.attendance === null && beforeInformed.has(participation.status),
    afterClose: live && terminalMainStatuses.has(participation.status),
    markInformed: confirms(true),
    confirmBasis: confirms(false),
    reviewConflict:
      input.projectActive && lead && (input.conflict === "open" || input.conflict === "escalated"),
  };
}
