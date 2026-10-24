import { z } from "zod";
import type { AttendanceConflictState, Attendance } from "../appointments/attendance";
import {
  AppointmentKind,
  berlinDate,
  instant,
  type AppointmentStatus,
  type BookingStatus,
} from "../appointments/model";
import { compareIsoDates } from "../dates";
import type { IsoDate } from "../iso-date";
import { terminalMainStatuses, type MainStatus } from "../lifecycle/enums";
import {
  noticeUndelivered,
  type ReminderCancelReason,
  type ReminderKind,
  type ReminderStatus,
} from "../reminders/model";

// The work list's appointment items (process-and-lifecycle.md, appointments: the work list;
// Q167): staff work beside the deadline warnings, never a guard and never a participant action.

/** The items in their urgency order: a row shows the first one. */
export const AppointmentItemKind = z
  .enum([
    "attendance_missing",
    "missed",
    "notice_undelivered",
    "needs_resolution",
    "attendance_conflict",
  ])
  .meta({ id: "AppointmentItemKind" });
export type AppointmentItemKind = z.infer<typeof AppointmentItemKind>;

/** The work list's filter `appointment`: a next booking, the two unions, or one kind. */
export const AppointmentFilter = z
  .enum(["upcoming", "overdue", "to_resolve", ...AppointmentItemKind.options])
  .meta({ id: "AppointmentFilter" });
export type AppointmentFilter = z.infer<typeof AppointmentFilter>;

/**
 * Why no further follow-up of a missed appointment is needed (Q167): a closed list, no free
 * text; no OpenAPI id (also used `.nullable()`).
 */
export const MissedResolution = z.enum([
  "participant_declined",
  "information_delivered_otherwise",
  "no_longer_needed",
]);
export type MissedResolution = z.infer<typeof MissedResolution>;

export const AppointmentItem = z
  .strictObject({
    kind: AppointmentItemKind,
    appointmentId: z.uuid(),
    appointmentKind: AppointmentKind,
    /** The appointment's start (frozen once it is in use). */
    startsAt: instant,
  })
  .meta({ id: "AppointmentItem" });
export type AppointmentItem = z.infer<typeof AppointmentItem>;

export const WorklistAppointments = z
  .strictObject({
    /** The earliest live future booking, else null. */
    next: z.strictObject({ kind: AppointmentKind, startsAt: instant }).nullable(),
    items: z.array(AppointmentItem),
  })
  .meta({ id: "WorklistAppointments" });
export type WorklistAppointments = z.infer<typeof WorklistAppointments>;

/** A booking of the participation with its appointment, as the items need it. */
export type AppointmentItemBooking = {
  id: string;
  appointmentId: string;
  appointmentKind: AppointmentKind;
  appointmentStatus: AppointmentStatus;
  /** UTC instants (ISO 8601). */
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  attendance: Attendance | null;
  /** The missed consultation booking this one follows up (staff link it). */
  followUpOf: string | null;
  missedResolution: MissedResolution | null;
  /** Its conflict as a basis of `informed` (`conflictState`). */
  conflict: AttendanceConflictState | null;
  /**
   * For a viewer who resolves hosts (the PL): whether the slot's host may list the participation
   * now; null for anyone else (no `needs_resolution` item).
   */
  hostMayList: boolean | null;
};

/** An organizer's notice to the participation, with its appointment. */
export type AppointmentItemNotice = {
  appointmentId: string;
  appointmentKind: AppointmentKind;
  startsAt: string;
  kind: ReminderKind;
  status: ReminderStatus;
  cancelReason: ReminderCancelReason | null;
  followedUp: boolean;
};

const ms = (at: string) => Date.parse(at);
const rank = (kind: AppointmentItemKind) => AppointmentItemKind.options.indexOf(kind);
const live = (booking: AppointmentItemBooking) =>
  booking.status === "booked" && booking.appointmentStatus === "scheduled";

/**
 * Whether `candidate` follows up the missed `booking` (Q167, the second review): for an info
 * event a later info-event booking (the same briefing purpose, matched automatically), for a
 * consultation only a booking linked by `followUpOf`. It counts only while live: absent, it is the
 * chain's missed item itself.
 */
function followsUp(candidate: AppointmentItemBooking, booking: AppointmentItemBooking): boolean {
  if (!live(candidate) || candidate.id === booking.id) return false;
  if (booking.appointmentKind === "consultation") return candidate.followUpOf === booking.id;
  return (
    candidate.appointmentKind === "info_event" && ms(candidate.startsAt) > ms(booking.startsAt)
  );
}

/** A recorded absence that no conflict covers (a basis's absence is its conflict). */
const absence = (booking: AppointmentItemBooking) =>
  live(booking) && booking.attendance === "absent" && booking.conflict === null;

/**
 * The missed bookings of a participation: recorded `absent` (no conflict of a basis), no explicit
 * resolution, and no live follow-up. A follow-up recorded `absent` is missed itself, so a chain
 * has one missed item; cancelling the follow-up restores the item; a resolution ends the chain.
 */
export function missedBookings(bookings: readonly AppointmentItemBooking[]): Set<string> {
  return new Set(
    bookings
      .filter(
        (booking) =>
          absence(booking) &&
          booking.missedResolution === null &&
          !bookings.some((candidate) => followsUp(candidate, booking)),
      )
      .map((booking) => booking.id),
  );
}

/**
 * A participation's appointment items (Q167): `attendance_missing` (a live booking whose Berlin
 * end date has passed, unrecorded; for a terminal participation only of an appointment that
 * started before the close, the PL's closed-case flow), `missed`, `notice_undelivered`
 * (`noticeUndelivered`), `needs_resolution` (for the PL) and `attendance_conflict` (open or
 * escalated). A terminal participation keeps `attendance_missing` and the conflicts, nothing
 * else. Ordered by kind, then start.
 */
export function appointmentItems(
  bookings: readonly AppointmentItemBooking[],
  notices: readonly AppointmentItemNotice[],
  status: MainStatus,
  closedAt: string | null,
  now: string,
  today: IsoDate,
): WorklistAppointments {
  const terminal = terminalMainStatuses.has(status);
  const items: AppointmentItem[] = [];
  const add = (
    kind: AppointmentItemKind,
    of: Pick<AppointmentItemBooking, "appointmentId" | "appointmentKind" | "startsAt">,
  ) =>
    items.push({
      kind,
      appointmentId: of.appointmentId,
      appointmentKind: of.appointmentKind,
      startsAt: of.startsAt,
    });
  const missed = terminal ? new Set<string>() : missedBookings(bookings);
  for (const booking of bookings) {
    if (!live(booking)) continue;
    if (
      booking.attendance === null &&
      compareIsoDates(berlinDate(booking.endsAt), today) < 0 &&
      (!terminal || closedAt === null || ms(booking.startsAt) < ms(closedAt))
    ) {
      add("attendance_missing", booking);
    }
    if (missed.has(booking.id)) add("missed", booking);
    if (
      !terminal &&
      booking.appointmentKind === "consultation" &&
      booking.hostMayList === false &&
      ms(booking.startsAt) > ms(now)
    ) {
      add("needs_resolution", booking);
    }
  }
  // A conflict outlives the booking's cancellation (the PL's correction supersedes the absence).
  for (const booking of bookings) {
    if (booking.conflict === "open" || booking.conflict === "escalated") {
      add("attendance_conflict", booking);
    }
  }
  if (!terminal) {
    for (const notice of notices) if (noticeUndelivered(notice)) add("notice_undelivered", notice);
  }
  const upcoming = terminal
    ? []
    : bookings
        .filter((booking) => live(booking) && ms(booking.startsAt) > ms(now))
        .toSorted((a, b) => ms(a.startsAt) - ms(b.startsAt));
  const first = upcoming[0];
  return {
    next: first ? { kind: first.appointmentKind, startsAt: first.startsAt } : null,
    items: items.toSorted((a, b) => rank(a.kind) - rank(b.kind) || ms(a.startsAt) - ms(b.startsAt)),
  };
}

const overdue: ReadonlySet<AppointmentItemKind> = new Set(["attendance_missing", "missed"]);

/** Whether a row's appointments match the filter: one predicate for a count and its list. */
export function matchesAppointmentFilter(
  appointments: WorklistAppointments,
  filter: AppointmentFilter,
): boolean {
  switch (filter) {
    case "upcoming":
      return appointments.next !== null;
    case "overdue":
      return appointments.items.some((item) => overdue.has(item.kind));
    case "to_resolve":
      return appointments.items.some((item) => !overdue.has(item.kind));
    default:
      return appointments.items.some((item) => item.kind === filter);
  }
}

/**
 * Whether a new booking may follow up `missed` (`followUpOf`): both consultations (an info
 * event's follow-up is matched automatically), and `missed` a missed booking now.
 */
export function followUpRefusal(
  missed: AppointmentItemBooking,
  bookings: readonly AppointmentItemBooking[],
  kind: AppointmentKind,
): "follow_up_kind_mismatch" | "follow_up_not_missed" | null {
  if (kind !== "consultation" || missed.appointmentKind !== "consultation") {
    return "follow_up_kind_mismatch";
  }
  return missedBookings(bookings).has(missed.id) ? null : "follow_up_not_missed";
}

/** Whether the missed booking may get its explicit resolution: once, while it is an item. */
export function missedResolutionRefusal(
  booking: AppointmentItemBooking,
  bookings: readonly AppointmentItemBooking[],
  status: MainStatus,
): "participation_closed" | "already_resolved" | "not_missed" | null {
  if (terminalMainStatuses.has(status)) return "participation_closed";
  if (booking.missedResolution !== null) return "already_resolved";
  return missedBookings(bookings).has(booking.id) ? null : "not_missed";
}
