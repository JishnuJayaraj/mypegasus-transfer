import { z } from "zod";
import { decideAccess, type Subject } from "../access/decide";
import { compareIsoDates } from "../dates";
import { isoDate, type IsoDate } from "../iso-date";
import { terminalMainStatuses, type MainStatus } from "../lifecycle/enums";
import type { ProjectType } from "../project";
import {
  berlinDate,
  type AppointmentKind,
  type AppointmentStatus,
  type BookingStatus,
  SeatAvailability,
} from "./model";

// Booking rules (process-and-lifecycle.md, appointments; Q162, Q164). Pure: the API passes the
// facts it loaded and the clock's `now` and Berlin `today`; the database decides again under the
// locks (ADR-0002, appointments).

/**
 * Why a booking is refused, in the order `bookingEligibility` checks; no OpenAPI id (also used
 * `.nullable()`).
 */
export const BookingRefusal = z.enum([
  "appointment_cancelled",
  "appointment_started",
  "booking_closed",
  "participation_closed",
  "not_in_audience",
  "host_not_responsible",
  "already_booked",
  "info_event_limit",
  "booking_overlap",
  "appointment_full",
  "after_cutoff",
]);
export type BookingRefusal = z.infer<typeof BookingRefusal>;

/** A booking that goes through but extends beyond the participation's upcoming cutoff. */
export const BookingWarning = z
  .strictObject({ code: z.literal("beyond_upcoming_cutoff"), latestEntryDate: isoDate })
  .meta({ id: "BookingWarning" });
export type BookingWarning = z.infer<typeof BookingWarning>;

export type AppointmentFacts = {
  id: string;
  kind: AppointmentKind;
  status: AppointmentStatus;
  /** UTC instants (ISO 8601). */
  startsAt: string;
  endsAt: string;
  bookingClosesAt: string;
  capacity: number;
  audienceWaveId: string | null;
};

/** A live booking of the participation, with its appointment's kind and times. */
export type LiveBooking = {
  appointmentId: string;
  kind: AppointmentKind;
  startsAt: string;
  endsAt: string;
};

export type BookingRequest = {
  appointment: AppointmentFacts;
  /** The appointment's live bookings: never shown, only compared with the capacity. */
  bookedCount: number;
  /** For a consultation: whether its host may list the participation now (Q62). */
  hostMayList: boolean;
  participation: {
    status: MainStatus;
    entryWaveId: string | null;
    /** The `latestEntryDate` of its wave (the `before_cutoff` guard's date). */
    latestEntryDate: IsoDate | null;
    /**
     * The applicable latest entry date while the cutoff would withdraw or flag the participation
     * (`latestEntryCutoff`: the wave's, or the project's final entry date without a wave), else
     * null: the date of the warning.
     */
    entryCutoff: IsoDate | null;
  };
  liveBookings: readonly LiveBooking[];
  projectType: ProjectType;
  /** The participant books until the public cutoff, staff until the start. */
  actor: "participant" | "staff";
  now: string;
  today: IsoDate;
};

const ms = (at: string) => Date.parse(at);
const beforeInformed = new Set<MainStatus>(["imported", "contacted", "unreachable"]);
const beforeTg = new Set<MainStatus>([...beforeInformed, "informed"]);

/**
 * Whether the participation may be booked now, the first refusal in this order (Q164): the
 * appointment (scheduled, not started; the participant only until `bookingClosesAt`); the
 * participation (not terminal; an info event's audience, the project or its wave, before
 * `active_in_tg`; a consultation whose host may list it); no second live booking of the
 * appointment, at most one live info-event booking that hasn't ended, no overlap with another live
 * booking (touching is fine); a free seat; before `informed` in `ta_tg`, the wave's cutoff not
 * passed (`before_cutoff`: today after `latestEntryDate`). A bookable appointment whose Berlin
 * start date lies after the participation's applicable cutoff (`entryCutoff`), not yet passed,
 * carries the warning `beyond_upcoming_cutoff` (Q172): information only; nothing predicts a
 * withdrawal and no guard changes.
 */
export function bookingEligibility(request: BookingRequest): {
  code: "ok" | BookingRefusal;
  warnings: BookingWarning[];
} {
  const refusal = firstRefusal(request);
  if (refusal) return { code: refusal, warnings: [] };
  const { appointment, participation, today } = request;
  const cutoff = participation.entryCutoff;
  const warned =
    cutoff !== null &&
    compareIsoDates(today, cutoff) <= 0 &&
    compareIsoDates(berlinDate(appointment.startsAt), cutoff) > 0;
  return {
    code: "ok",
    warnings: warned ? [{ code: "beyond_upcoming_cutoff", latestEntryDate: cutoff }] : [],
  };
}

function firstRefusal(request: BookingRequest): BookingRefusal | null {
  const { appointment, participation, liveBookings, now } = request;
  if (appointment.status === "cancelled") return "appointment_cancelled";
  if (ms(now) >= ms(appointment.startsAt)) return "appointment_started";
  if (request.actor === "participant" && ms(now) >= ms(appointment.bookingClosesAt)) {
    return "booking_closed";
  }
  if (terminalMainStatuses.has(participation.status)) return "participation_closed";
  if (appointment.kind === "info_event") {
    const inAudience =
      appointment.audienceWaveId === null ||
      appointment.audienceWaveId === participation.entryWaveId;
    if (!inAudience || !beforeTg.has(participation.status)) return "not_in_audience";
  } else if (!request.hostMayList) {
    return "host_not_responsible";
  }
  if (liveBookings.some((booking) => booking.appointmentId === appointment.id)) {
    return "already_booked";
  }
  if (
    appointment.kind === "info_event" &&
    liveBookings.some((booking) => booking.kind === "info_event" && ms(booking.endsAt) > ms(now))
  ) {
    return "info_event_limit";
  }
  const overlaps = (booking: LiveBooking) =>
    ms(booking.startsAt) < ms(appointment.endsAt) && ms(appointment.startsAt) < ms(booking.endsAt);
  if (liveBookings.some(overlaps)) return "booking_overlap";
  if (request.bookedCount >= appointment.capacity) return "appointment_full";
  const cutoff = participation.latestEntryDate;
  if (
    request.projectType === "ta_tg" &&
    cutoff !== null &&
    beforeInformed.has(participation.status) &&
    compareIsoDates(request.today, cutoff) > 0
  ) {
    return "after_cutoff";
  }
  return null;
}

/** Whether a live booking may be cancelled now (Q164): the participant or staff, until the start. */
export function cancellationEligibility(
  booking: { status: BookingStatus },
  appointment: { startsAt: string },
  now: string,
): "ok" | "booking_cancelled" | "appointment_started" {
  if (booking.status !== "booked") return "booking_cancelled";
  if (ms(now) >= ms(appointment.startsAt)) return "appointment_started";
  return "ok";
}

/**
 * A live future consultation booking whose host may no longer list its participation (Q162): the
 * PL resolves it by another host, cancelling the booking or the appointment.
 */
export function needsResolution(
  booking: { status: BookingStatus },
  appointment: { kind: AppointmentKind; status: AppointmentStatus; startsAt: string },
  hostMayList: boolean,
  now: string,
): boolean {
  return (
    booking.status === "booked" &&
    appointment.kind === "consultation" &&
    appointment.status === "scheduled" &&
    ms(appointment.startsAt) > ms(now) &&
    !hostMayList
  );
}

/**
 * What a viewer learns of an appointment's bookings (Q150, Q162): the exact count only while
 * they may list every live booking of it (a member: the PL and back office always, a consultant
 * while all are of their assigned participations); otherwise the count among those they may list
 * and the seat state. A participant gets the seat state only. Never a total or a remaining-seat
 * count outside the exact scope.
 */
export const BookingCounts = z
  .discriminatedUnion("scope", [
    z.strictObject({
      scope: z.literal("all"),
      booked: z.int().min(0),
      availability: SeatAvailability,
    }),
    z.strictObject({
      scope: z.literal("own"),
      own: z.int().min(0),
      availability: SeatAvailability,
    }),
    z.strictObject({ scope: z.literal("availability"), availability: SeatAvailability }),
  ])
  .meta({ id: "BookingCounts" });
export type BookingCounts = z.infer<typeof BookingCounts>;

/** Whether the viewer may list the participation's bookings (`case_internal`, Q62). */
export function mayListBookings(
  subject: Subject,
  target: { projectId: string; participationId: string },
): boolean {
  return (
    decideAccess(
      subject,
      { kind: "field", ...target, regionId: null, phase: "active", field: "appointmentBookings" },
      "list",
      { kind: "normal" },
    ).effect === "allow"
  );
}

export function bookingView(
  viewer: Subject,
  appointment: { projectId: string; capacity: number },
  liveBookings: readonly { participationId: string }[],
): BookingCounts {
  const availability: SeatAvailability =
    liveBookings.length >= appointment.capacity ? "full" : "available";
  if (viewer.kind === "participant") return { scope: "availability", availability };
  const listed = liveBookings.filter((booking) =>
    mayListBookings(viewer, {
      projectId: appointment.projectId,
      participationId: booking.participationId,
    }),
  ).length;
  const member = (viewer.projectRoles[appointment.projectId]?.size ?? 0) > 0;
  if (member && listed === liveBookings.length) {
    return { scope: "all", booked: listed, availability };
  }
  return { scope: "own", own: listed, availability };
}
