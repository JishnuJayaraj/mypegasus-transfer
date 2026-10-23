import { z } from "zod";
import {
  Attendance,
  AttendanceAfterCloseReason,
  AttendanceConflictResolution,
  AttendanceConflictReview,
  AttendanceConflictState,
} from "./attendance";
import { BookingCounts, BookingRefusal, BookingWarning } from "./booking";
import {
  AppointmentCancelReason,
  AppointmentKind,
  appointmentPolicy,
  AppointmentStatus,
  BookingCancelReason,
  BookingOrigin,
  BookingStatus,
  instant,
  SeatAvailability,
} from "./model";

// The appointment routes (ADR-0010; data-protection.md, appointments). Codes, ids, times and the
// generic title and venue; a booking's person fields only where the viewer may list them.

const appointmentRows = appointmentPolicy.rowsPerRequest;

/** What the viewer may do with an appointment now (decided by the server, ADR-0010). */
export const AppointmentCapabilities = z
  .strictObject({
    change: z.boolean(),
    changeHost: z.boolean(),
    cancel: z.boolean(),
    book: z.boolean(),
    /** "Teilnahme erfassen": from the start, the PL or a consultant (per row the booking's own). */
    recordAttendance: z.boolean(),
    /** "Fand nicht statt (Korrektur)": the PL, with absences only recorded (Q164). */
    correctNotTakenPlace: z.boolean(),
  })
  .meta({ id: "AppointmentCapabilities" });

export const Appointment = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    kind: AppointmentKind,
    startsAt: instant,
    endsAt: instant,
    bookingClosesAt: instant,
    capacity: z.int().min(1),
    title: z.string().nullable(),
    venue: z.string(),
    hostStaffUserId: z.uuid().nullable(),
    audienceWaveId: z.uuid().nullable(),
    status: AppointmentStatus,
    cancelReason: AppointmentCancelReason.nullable(),
    cancelledAt: instant.nullable(),
    /** Booking or invitation present: kind, times, cutoff and audience are frozen. */
    inUse: z.boolean(),
    version: z.int().min(1),
    bookings: BookingCounts,
    /** For the PL: the live future bookings whose host may no longer list them; else null. */
    needsResolution: z.int().min(0).nullable(),
    capabilities: AppointmentCapabilities,
  })
  .meta({ id: "Appointment" });
export type Appointment = z.infer<typeof Appointment>;

export const AppointmentPage = z
  .strictObject({
    items: z.array(Appointment),
    nextCursor: z.string().nullable(),
    /** Whether the viewer may create an info event, a consultation (their own, or any host). */
    capabilities: z.strictObject({
      createInfoEvent: z.boolean(),
      createConsultation: z.boolean(),
      /** The PL chooses any host; a consultant only themselves. */
      chooseHost: z.boolean(),
    }),
  })
  .meta({ id: "AppointmentPage" });

/** `GET /projects/{id}/appointments`: upcoming (not ended, soonest first) or past (latest first). */
export const AppointmentQuery = z.object({
  period: z.enum(["upcoming", "past"]).default("upcoming"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

/**
 * A booking's attendance (Q163): the value and when it was recorded, the closed-case flow's
 * reason, whether it is the basis of `informed`, superseded by the PL's correction, its conflict.
 */
const bookingAttendance = {
  attendance: Attendance.nullable(),
  attendanceRecordedAt: instant.nullable(),
  afterCloseReason: AttendanceAfterCloseReason.nullable(),
  informedBasis: z.boolean(),
  superseded: z.boolean(),
  conflict: AttendanceConflictState.nullable(),
  conflictResolution: AttendanceConflictResolution.nullable(),
};

/** What the viewer may do with a booking now (decided by the server, ADR-0010). */
export const BookingCapabilities = z
  .strictObject({
    cancel: z.boolean(),
    recordAttended: z.boolean(),
    recordAbsent: z.boolean(),
    /** The attendance dialog's "als informiert erfassen" (preselected for info events only). */
    offerInformed: z.boolean(),
    /** Recording is the closed-case flow: the PL with a reason, no status change. */
    afterClose: z.boolean(),
    /** "Als informiert erfassen" on the qualifying attendance. */
    markInformed: z.boolean(),
    /** "Als Grundlage bestätigen" while another basis is in conflict. */
    confirmBasis: z.boolean(),
    /** The PL's "Eskalieren" (while open) and "Anderweitig informiert". */
    reviewConflict: z.boolean(),
  })
  .meta({ id: "BookingCapabilities" });

/** One booking on the appointment page: listable person fields only (Q62). */
export const AppointmentBooking = z
  .strictObject({
    id: z.uuid(),
    participationId: z.uuid(),
    personnelNumber: z.string().nullable(),
    lastName: z.string().nullable(),
    firstName: z.string().nullable(),
    status: BookingStatus,
    origin: BookingOrigin,
    bookedAt: instant,
    cancelReason: BookingCancelReason.nullable(),
    cancelledAt: instant.nullable(),
    /** For the PL (Q162): its host may no longer list the participation; else null. */
    needsResolution: z.boolean().nullable(),
    ...bookingAttendance,
    capabilities: BookingCapabilities,
  })
  .meta({ id: "AppointmentBooking" });

export const AppointmentBookingList = z
  .strictObject({ items: z.array(AppointmentBooking) })
  .meta({ id: "AppointmentBookingList" });

/** A staff booking: its id and the warnings it went through with. */
export const BookingResult = z
  .strictObject({ bookingId: z.uuid(), warnings: z.array(BookingWarning) })
  .meta({ id: "BookingResult" });

/** An appointment as the participant tab names it. */
export const AppointmentSummary = z
  .strictObject({
    id: z.uuid(),
    kind: AppointmentKind,
    startsAt: instant,
    endsAt: instant,
    title: z.string().nullable(),
    venue: z.string(),
    status: AppointmentStatus,
  })
  .meta({ id: "AppointmentSummary" });

/** The participant tab "Termine": the bookings and the appointments staff may book now. */
export const ParticipationAppointments = z
  .strictObject({
    bookings: z.array(
      z.strictObject({
        id: z.uuid(),
        appointment: AppointmentSummary,
        status: BookingStatus,
        origin: BookingOrigin,
        bookedAt: instant,
        cancelReason: BookingCancelReason.nullable(),
        cancelledAt: instant.nullable(),
        ...bookingAttendance,
        capabilities: BookingCapabilities,
      }),
    ),
    /**
     * The upcoming appointments in the participation's audience or host rule, each with its seat
     * state and either `null` (bookable, with warnings) or the refusal it would get.
     */
    bookable: z.array(
      z.strictObject({
        appointment: AppointmentSummary,
        availability: SeatAvailability,
        code: BookingRefusal.nullable(),
        warnings: z.array(BookingWarning),
      }),
    ),
    capabilities: z.strictObject({ book: z.boolean() }),
  })
  .meta({ id: "ParticipationAppointments" });

/**
 * `POST /appointments/{id}/attendance` (Q163): 1–500 rows, all or nothing; a row without a live
 * booking is a walk-in. A ticked "als informiert erfassen" needs `informationDelivered`; the
 * reason applies to the rows of closed participations (the PL's closed-case flow).
 */
export const AttendanceInput = z
  .strictObject({
    entries: z
      .array(
        z.strictObject({
          participationId: z.uuid(),
          attendance: Attendance,
          markInformed: z.boolean().default(false),
        }),
      )
      .min(appointmentRows.min)
      .max(appointmentRows.max),
    informationDelivered: z.boolean().default(false),
    afterCloseReason: AttendanceAfterCloseReason.nullable().default(null),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of input.entries.entries()) {
      if (seen.has(entry.participationId)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate_entry",
          path: ["entries", index, "participationId"],
          params: { code: "duplicate_entry" },
        });
      }
      seen.add(entry.participationId);
    }
  })
  .meta({ id: "AttendanceInput" });
export type AttendanceInput = z.infer<typeof AttendanceInput>;

export const AttendanceResult = z
  .strictObject({
    recorded: z.int().min(0),
    /** The participations confirmed `informed` by this request. */
    informed: z.int().min(0),
    /** The `status_changed` events written (one or two per participation informed). */
    statusChanges: z.int().min(0),
  })
  .meta({ id: "AttendanceResult" });

/** "Als informiert erfassen" or "Als Grundlage bestätigen": the delivery confirmed. */
export const InformedInput = z
  .strictObject({ informationDelivered: z.literal(true) })
  .meta({ id: "InformedInput" });

export const InformedResult = z
  .strictObject({ statusChanges: z.int().min(0) })
  .meta({ id: "InformedResult" });

/** The PL's review of a conflict (Q163). */
export const ConflictReviewInput = z
  .strictObject({ reason: AttendanceConflictReview })
  .meta({ id: "ConflictReviewInput" });
