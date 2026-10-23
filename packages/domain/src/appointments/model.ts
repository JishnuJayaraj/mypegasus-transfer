import { z } from "zod";
import type { IsoDate } from "../iso-date";

// Appointments (process-and-lifecycle.md, appointments; data-protection.md, appointments; Q162,
// Q164, Q166): info events and consultation slots, booked by staff (and from the portal later).
// One policy in every project: nothing here varies per Agentur (regional-variation.md).

/** A group `info_event` (optionally for one wave) or a `consultation` slot with one host. */
export const AppointmentKind = z
  .enum(["info_event", "consultation"])
  .meta({ id: "AppointmentKind" });
export type AppointmentKind = z.infer<typeof AppointmentKind>;

export const AppointmentStatus = z
  .enum(["scheduled", "cancelled"])
  .meta({ id: "AppointmentStatus" });
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

/**
 * Why the organizer cancelled (Q164): a closed list, never free text. No OpenAPI id: it is also
 * used `.nullable()` in responses (like `isoDate`).
 */
export const AppointmentCancelReason = z.enum([
  "organiser_unavailable",
  "too_few_bookings",
  "did_not_take_place",
  "created_in_error",
  "other",
]);
export type AppointmentCancelReason = z.infer<typeof AppointmentCancelReason>;

/** Who booked: the participant in the portal, staff (also after the public cutoff), a walk-in. */
export const BookingOrigin = z
  .enum(["participant", "staff", "walk_in"])
  .meta({ id: "BookingOrigin" });
export type BookingOrigin = z.infer<typeof BookingOrigin>;

export const BookingStatus = z.enum(["booked", "cancelled"]).meta({ id: "BookingStatus" });
export type BookingStatus = z.infer<typeof BookingStatus>;

/** Why a booking was cancelled; no OpenAPI id (also used `.nullable()`). */
export const BookingCancelReason = z.enum([
  "participant_cancelled",
  "staff_cancelled",
  "appointment_cancelled",
  "participation_closed",
]);
export type BookingCancelReason = z.infer<typeof BookingCancelReason>;

/** The seat state shown to a viewer outside the exact count (Q150 exception, Q162). */
export const SeatAvailability = z.enum(["available", "full"]).meta({ id: "SeatAvailability" });
export type SeatAvailability = z.infer<typeof SeatAvailability>;

/**
 * One policy (Q164, Q166): capacity 1–500; the public booking cutoff 0–14 days before the start,
 * by default one day (24 hours); an optional generic title up to 100 characters and the shared
 * venue 1–200; 1–500 rows per bulk request.
 */
export const appointmentPolicy = {
  capacity: { min: 1, max: 500 },
  bookingCutoffDays: { min: 0, max: 14, default: 1 },
  titleMax: 100,
  venueMax: 200,
  rowsPerRequest: { min: 1, max: 500 },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A UTC instant (ISO 8601 with `Z`), as the API sends event times. */
export const instant = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });

/**
 * A generic text: trimmed, no control characters. The form says no names, diagnoses or
 * consultation notes belong here (Q166); the text never enters a message, audit detail or log.
 */
const genericText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/\p{Cc}/u.test(text), {
      message: "Control characters aren't allowed",
      params: { code: "control_character" },
    });

export const AppointmentTitle = genericText(appointmentPolicy.titleMax);
export const AppointmentVenue = genericText(appointmentPolicy.venueMax);

const Capacity = z.int().min(appointmentPolicy.capacity.min).max(appointmentPolicy.capacity.max);
const BookingCutoffDays = z
  .int()
  .min(appointmentPolicy.bookingCutoffDays.min)
  .max(appointmentPolicy.bookingCutoffDays.max);

type Issue = {
  addIssue: (issue: { code: "custom"; message: string; path: string[]; params: object }) => void;
};
const issue = (ctx: Issue, code: string, path: string) =>
  ctx.addIssue({ code: "custom", message: code, path: [path], params: { code } });

/** `POST /projects/{id}/appointments`: a host for a consultation only, a wave for an info event only. */
export const AppointmentInput = z
  .strictObject({
    kind: AppointmentKind,
    startsAt: instant,
    endsAt: instant,
    bookingCutoffDays: BookingCutoffDays.default(appointmentPolicy.bookingCutoffDays.default),
    capacity: Capacity,
    title: AppointmentTitle.nullable().default(null),
    venue: AppointmentVenue,
    hostStaffUserId: z.uuid().nullable().default(null),
    audienceWaveId: z.uuid().nullable().default(null),
  })
  .superRefine((input, ctx) => {
    if (Date.parse(input.endsAt) <= Date.parse(input.startsAt))
      issue(ctx, "ends_before_start", "endsAt");
    if ((input.kind === "consultation") !== (input.hostStaffUserId !== null)) {
      issue(ctx, "host_mismatch", "hostStaffUserId");
    }
    if (input.kind === "consultation" && input.audienceWaveId !== null) {
      issue(ctx, "audience_mismatch", "audienceWaveId");
    }
  })
  .meta({ id: "AppointmentInput" });
export type AppointmentInput = z.infer<typeof AppointmentInput>;

/**
 * `PATCH /appointments/{id}`: the changed fields with the version read. Times, the cutoff and the
 * audience are frozen once the appointment is in use (Q164, Q168); the kind never changes (cancel
 * and create anew) and the host changes through its own route.
 */
export const AppointmentChangeInput = z
  .strictObject({
    expectedVersion: z.int().min(1),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    bookingCutoffDays: BookingCutoffDays.optional(),
    capacity: Capacity.optional(),
    title: AppointmentTitle.nullable().optional(),
    venue: AppointmentVenue.optional(),
    audienceWaveId: z.uuid().nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 1, {
    message: "Nothing to change",
    params: { code: "appointment_unchanged" },
  })
  .meta({ id: "AppointmentChangeInput" });
export type AppointmentChangeInput = z.infer<typeof AppointmentChangeInput>;

/** `POST /appointments/{id}/host` (the PL only, Q162). */
export const AppointmentHostInput = z
  .strictObject({ expectedVersion: z.int().min(1), hostStaffUserId: z.uuid() })
  .meta({ id: "AppointmentHostInput" });

/** `POST /appointments/{id}/cancellation`: a closed reason, no free text. */
export const AppointmentCancelInput = z
  .strictObject({ reason: AppointmentCancelReason })
  .meta({ id: "AppointmentCancelInput" });

/** `POST /appointments/{id}/bookings`: staff book one participation. */
export const BookingInput = z
  .strictObject({ participationId: z.uuid() })
  .meta({ id: "BookingInput" });

const utcParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** An instant (epoch milliseconds) as UTC ISO 8601, without reading the clock. */
function isoInstant(ms: number): string {
  const p = Object.fromEntries(utcParts.formatToParts(ms).map((part) => [part.type, part.value]));
  const millis = String(((ms % 1000) + 1000) % 1000).padStart(3, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${millis}Z`;
}

/** The public booking cutoff: `days` whole days before the start. */
export function bookingClosesAt(startsAt: string, days: number): string {
  return isoInstant(Date.parse(startsAt) - days * DAY_MS);
}

/** The whole days between the cutoff and the start, as the form shows them. */
export function bookingCutoffDays(startsAt: string, closesAt: string): number {
  return Math.round((Date.parse(startsAt) - Date.parse(closesAt)) / DAY_MS);
}

const berlinParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function wallClock(ms: number) {
  const parts = Object.fromEntries(
    berlinParts.formatToParts(ms).map((part) => [part.type, part.value]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute", string>;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}` as IsoDate,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** The Berlin calendar date of an instant (an appointment's day, CLAUDE.md, dates). */
export function berlinDate(at: string): IsoDate {
  return wallClock(Date.parse(at)).date;
}

/** The Berlin wall-clock time (`HH:MM`) of an instant. */
export function berlinTime(at: string): string {
  return wallClock(Date.parse(at)).time;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The instant of a Berlin date and wall-clock time (`HH:MM`), as UTC ISO 8601; `null` for a
 * malformed time or one the clock change skips. Of a time that occurs twice the earlier.
 */
export function berlinInstant(date: IsoDate, time: string): string | null {
  if (!TIME.test(time)) return null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Berlin is UTC+1 or UTC+2: try the larger offset first, so a repeated hour gives the earlier.
  for (const offsetHours of [2, 1]) {
    const candidate = asUtc - offsetHours * 60 * 60 * 1000;
    const wall = wallClock(candidate);
    if (wall.date === date && wall.time === time) return isoInstant(candidate);
  }
  return null;
}
