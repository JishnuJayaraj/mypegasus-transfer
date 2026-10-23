import { z } from "zod";
import { BookingCounts, BookingRefusal, BookingWarning } from "./booking";
import {
  AppointmentCancelReason,
  AppointmentKind,
  AppointmentStatus,
  BookingCancelReason,
  BookingOrigin,
  BookingStatus,
  instant,
  SeatAvailability,
} from "./model";

// The appointment routes (ADR-0010; data-protection.md, appointments). Codes, ids, times and the
// generic title and venue; a booking's person fields only where the viewer may list them.

/** What the viewer may do with an appointment now (decided by the server, ADR-0010). */
export const AppointmentCapabilities = z
  .strictObject({
    change: z.boolean(),
    changeHost: z.boolean(),
    cancel: z.boolean(),
    book: z.boolean(),
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
    capabilities: z.strictObject({ cancel: z.boolean() }),
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
        capabilities: z.strictObject({ cancel: z.boolean() }),
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
