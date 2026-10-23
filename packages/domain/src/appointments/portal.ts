import { z } from "zod";
import {
  bookingEligibility,
  inBookingRule,
  type AppointmentFacts,
  type BookingRequest,
  type LiveBooking,
} from "./booking";
import {
  AppointmentKind,
  instant,
  SeatAvailability,
  type BookingCancelReason,
  type BookingStatus,
} from "./model";

// The portal's "Termine" (data-protection.md, appointments: the portal; Q164, Q165). Pure: the API
// passes the facts it loaded and the clock's `now` and Berlin `today`; the database decides every
// booking and cancellation again under the locks. A participant sees the seat state, never a count.

/** A cancelled appointment stays under "Abgesagt" for 14 days after its start or cancellation. */
export const portalAppointmentPolicy = { cancelledVisibleDays: 14 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An appointment as the portal knows it. */
export type PortalAppointmentFacts = AppointmentFacts & {
  title: string | null;
  venue: string;
  /** UTC instant of the organizer's cancellation, or null. */
  cancelledAt: string | null;
  /** Its live bookings: never shown, only compared with the capacity. */
  bookedCount: number;
  /** For a consultation: whether its host may list the participation now (Q62). */
  hostMayList: boolean;
};

/** One of the participation's bookings. */
export type PortalBookingFacts = {
  id: string;
  appointmentId: string;
  status: BookingStatus;
  cancelReason: BookingCancelReason | null;
  cancelledAt: string | null;
};

export type PortalAppointmentsRequest = {
  /** The project's upcoming scheduled appointments and every invited or booked one. */
  appointments: readonly PortalAppointmentFacts[];
  /** The appointments the participant was invited to, whether or not a message arrived. */
  invitedAppointmentIds: readonly string[];
  bookings: readonly PortalBookingFacts[];
  participation: BookingRequest["participation"];
  projectType: BookingRequest["projectType"];
  now: string;
  today: BookingRequest["today"];
};

/** What the portal shows of an appointment; no OpenAPI id (also used `.nullable()`). */
export const PortalAppointmentDetails = z.strictObject({
  startsAt: instant,
  endsAt: instant,
  title: z.string().nullable(),
  venue: z.string(),
});
export type PortalAppointmentDetails = z.infer<typeof PortalAppointmentDetails>;

/**
 * An invitation's state: bookable; "ausgebucht" (`full`); "Buchung geschlossen" (`closed`, past the
 * public cutoff); another booking rule refuses it (`unavailable`); or no longer in the audience or
 * host rule (`no_longer_valid`, "Diese Einladung gilt nicht mehr", without details).
 */
export const PortalInvitationState = z
  .enum(["bookable", "full", "closed", "unavailable", "no_longer_valid"])
  .meta({ id: "PortalInvitationState" });
export type PortalInvitationState = z.infer<typeof PortalInvitationState>;

const book = z.strictObject({ book: z.boolean() });

/** `GET /portal/appointments`: the four sections of "Termine". */
export const PortalAppointments = z
  .strictObject({
    invitations: z.array(
      z.strictObject({
        appointmentId: z.uuid(),
        kind: AppointmentKind,
        details: PortalAppointmentDetails.nullable(),
        state: PortalInvitationState,
        /** "Dieser Termin liegt nach einer für Sie geltenden Frist." (never the date). */
        cutoffHint: z.boolean(),
        /** Booking disabled: "Anderen Termin buchen" when an alternative of its kind is bookable. */
        alternative: z.boolean(),
        capabilities: book,
      }),
    ),
    bookings: z.array(
      z.strictObject({
        id: z.uuid(),
        appointmentId: z.uuid(),
        kind: AppointmentKind,
        details: PortalAppointmentDetails,
        capabilities: z.strictObject({ cancel: z.boolean() }),
      }),
    ),
    cancelled: z.array(
      z.strictObject({
        appointmentId: z.uuid(),
        kind: AppointmentKind,
        details: PortalAppointmentDetails.nullable(),
        /** "vom Veranstalter abgesagt" or "vom Beratungsteam abgesagt". */
        cancelledBy: z.enum(["organizer", "team"]),
        alternative: z.boolean(),
      }),
    ),
    bookable: z.array(
      z.strictObject({
        appointmentId: z.uuid(),
        kind: AppointmentKind,
        details: PortalAppointmentDetails,
        availability: SeatAvailability,
        cutoffHint: z.boolean(),
        capabilities: book,
      }),
    ),
  })
  .meta({ id: "PortalAppointments" });
export type PortalAppointments = z.infer<typeof PortalAppointments>;

/** `POST /portal/appointments/{id}/booking`: the new booking. */
export const PortalBookingResult = z
  .strictObject({ bookingId: z.uuid() })
  .meta({ id: "PortalBookingResult" });

const ms = (at: string) => Date.parse(at);
const details = (a: PortalAppointmentFacts): PortalAppointmentDetails => ({
  startsAt: a.startsAt,
  endsAt: a.endsAt,
  title: a.title,
  venue: a.venue,
});
const visibleUntil = (a: PortalAppointmentFacts, cancelledAt: string) =>
  Math.max(ms(a.startsAt), ms(cancelledAt)) + portalAppointmentPolicy.cancelledVisibleDays * DAY_MS;
const byStart = (a: { details: { startsAt: string } }, b: { details: { startsAt: string } }) =>
  ms(a.details.startsAt) - ms(b.details.startsAt);

/**
 * The portal's "Termine" (Q164, Q165), with the booking rules for the participant (until the public
 * cutoff):
 * - **Einladungen**: each invited appointment without a live booking of it, until its start; its
 *   details only while it is in the participation's audience or host rule, else
 *   `no_longer_valid`; a cancelled one moves to "Abgesagt";
 * - **Meine Termine**: the live bookings until their end, "Absagen" until the start;
 * - **Abgesagt**: bookings cancelled by the organizer or the team, and invited appointments the
 *   organizer cancelled, until 14 days after the later of the original start and the cancellation;
 * - **Termine buchen**: the other upcoming appointments the participant may book now or that are
 *   full ("ausgebucht").
 * "Anderen Termin buchen" (`alternative`) wherever booking isn't possible and another appointment
 * of the same kind is bookable now.
 */
export function portalAppointments(request: PortalAppointmentsRequest): PortalAppointments {
  const { appointments, bookings, participation, now } = request;
  const byId = new Map(appointments.map((a) => [a.id, a]));
  const live = bookings.filter((b) => b.status === "booked" && byId.has(b.appointmentId));
  const liveIds = new Set(live.map((b) => b.appointmentId));
  const liveBookings: LiveBooking[] = live.map((b) => {
    const { id, kind, startsAt, endsAt } = byId.get(b.appointmentId)!;
    return { appointmentId: id, kind, startsAt, endsAt };
  });
  const eligibility = (a: PortalAppointmentFacts) =>
    bookingEligibility({
      appointment: a,
      bookedCount: a.bookedCount,
      hostMayList: a.hostMayList,
      participation,
      liveBookings,
      projectType: request.projectType,
      actor: "participant",
      now,
      today: request.today,
    });
  const inRule = (a: PortalAppointmentFacts) => inBookingRule(a, participation, a.hostMayList);
  const bookableNow = new Set(
    appointments.filter((a) => eligibility(a).code === "ok").map((a) => a.id),
  );
  const alternative = (a: PortalAppointmentFacts) =>
    appointments.some((b) => b.id !== a.id && b.kind === a.kind && bookableNow.has(b.id));

  const invited = [...new Set(request.invitedAppointmentIds)].flatMap((id) => byId.get(id) ?? []);
  const invitations: PortalAppointments["invitations"] = invited
    .filter((a) => a.status === "scheduled" && ms(now) < ms(a.startsAt) && !liveIds.has(a.id))
    .map((a) => {
      if (!inRule(a)) {
        return {
          appointmentId: a.id,
          kind: a.kind,
          details: null,
          state: "no_longer_valid" as const,
          cutoffHint: false,
          alternative: false,
          capabilities: { book: false },
        };
      }
      const { code, warnings } = eligibility(a);
      const state: PortalInvitationState =
        code === "ok"
          ? "bookable"
          : code === "booking_closed"
            ? "closed"
            : code === "appointment_full"
              ? "full"
              : "unavailable";
      return {
        appointmentId: a.id,
        kind: a.kind,
        details: details(a),
        state,
        cutoffHint: warnings.length > 0,
        alternative: state !== "bookable" && alternative(a),
        capabilities: { book: state === "bookable" },
      };
    })
    .toSorted(
      (a, b) => ms(byId.get(a.appointmentId)!.startsAt) - ms(byId.get(b.appointmentId)!.startsAt),
    );

  const mine: PortalAppointments["bookings"] = live
    .flatMap((b) => {
      const a = byId.get(b.appointmentId)!;
      if (ms(now) >= ms(a.endsAt)) return [];
      return [
        {
          id: b.id,
          appointmentId: a.id,
          kind: a.kind,
          details: details(a),
          capabilities: { cancel: ms(now) < ms(a.startsAt) },
        },
      ];
    })
    .toSorted(byStart);

  // The latest organizer or team cancellation per appointment the participant isn't booked on.
  const cancelledBookings = new Map<string, { by: "organizer" | "team"; at: string }>();
  for (const b of bookings) {
    const by =
      b.cancelReason === "appointment_cancelled"
        ? "organizer"
        : b.cancelReason === "staff_cancelled"
          ? "team"
          : null;
    if (by === null || b.cancelledAt === null || liveIds.has(b.appointmentId)) continue;
    const seen = cancelledBookings.get(b.appointmentId);
    if (!seen || ms(seen.at) < ms(b.cancelledAt)) {
      cancelledBookings.set(b.appointmentId, { by, at: b.cancelledAt });
    }
  }
  const cancelled = [
    ...[...cancelledBookings].flatMap(([id, { by, at }]) => {
      const a = byId.get(id);
      return a ? [{ a, by, at, details: details(a) }] : [];
    }),
    ...invited.flatMap((a) =>
      a.status === "cancelled" && a.cancelledAt !== null && !cancelledBookings.has(a.id)
        ? [
            {
              a,
              by: "organizer" as const,
              at: a.cancelledAt,
              details: inRule(a) ? details(a) : null,
            },
          ]
        : [],
    ),
  ]
    .filter(({ a, at }) => ms(now) < visibleUntil(a, at))
    .toSorted((x, y) => ms(y.at) - ms(x.at))
    .map(({ a, by, details: shownDetails }) => ({
      appointmentId: a.id,
      kind: a.kind,
      details: shownDetails,
      cancelledBy: by,
      alternative: alternative(a),
    }));

  const shown = new Set([...invitations.map((i) => i.appointmentId), ...liveIds]);
  const bookable: PortalAppointments["bookable"] = appointments
    .filter((a) => !shown.has(a.id))
    .flatMap((a) => {
      const { code, warnings } = eligibility(a);
      if (code !== "ok" && code !== "appointment_full") return [];
      return [
        {
          appointmentId: a.id,
          kind: a.kind,
          details: details(a),
          availability: code === "ok" ? ("available" as const) : ("full" as const),
          cutoffHint: warnings.length > 0,
          capabilities: { book: code === "ok" },
        },
      ];
    })
    .toSorted(byStart);

  return { invitations, bookings: mine, cancelled, bookable };
}
