import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "@transfer/db";
import {
  PortalAppointments,
  portalAppointments,
  PortalBookingResult,
  type BookingCancelReason,
  type BookingStatus,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import {
  appointmentColumns,
  bookingParticipation,
  hostRule,
  liveBookingsOf,
  type AppointmentRow,
} from "../appointments/service";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { clearPortalCookie, portalSession, requirePortalSession } from "../portal-session";
import { participantContext } from "../sql";

// The portal's "Termine" (data-protection.md, appointments: the portal; ADR-0010): the
// participant's own invitations, bookings and cancellations and the appointments they may book.
// The participant learns the seat state, never a count; the database decides every write again
// with the session's token, so nobody books or cancels for another participation.

const AppointmentParams = z.object({ appointmentId: z.uuid() });
const BookingParams = z.object({ bookingId: z.uuid() });
const EmptyInput = z.strictObject({});

/** The refusals a participant sees as a 422; outside the rule an appointment is a 404. */
const stateCodes = new Set([
  "appointment_cancelled",
  "appointment_started",
  "booking_closed",
  "already_booked",
  "info_event_limit",
  "booking_overlap",
  "appointment_full",
  "after_cutoff",
  "booking_cancelled",
  "attendance_recorded",
]);
const hidden = new Set([
  "appointment_not_found",
  "booking_not_found",
  "not_in_audience",
  "host_not_responsible",
  "participation_closed",
]);

export function portalAppointmentRoutes(deps: Deps) {
  const { db, env, clock } = deps;
  const router = createRouter();
  const active = [requirePortalSession(deps, "active")];

  /** A refusal of a portal write as a problem; anything else is rethrown. */
  function refused(c: Context<AppEnv>, error: unknown) {
    const code = functionRefusal(error);
    if (code === "session_invalid") {
      clearPortalCookie(c, env);
      return problem(c, "unauthenticated");
    }
    if (code && hidden.has(code)) return problem(c, "not-found");
    if (code && stateCodes.has(code)) return domainProblem(c, [code]);
    throw error;
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/portal/appointments",
      tags: ["portal"],
      summary:
        "The portal's \"Termine\": invitations, the participant's bookings, cancelled appointments and bookable ones",
      middleware: active,
      responses: {
        200: json(PortalAppointments, "The four sections"),
        ...problemResponses("unauthenticated"),
      },
    }),
    async (c) => {
      const { participationId, projectId } = portalSession(c);
      const now = clock.now().toISOString();
      const participation = (await bookingParticipation(db, participationId))!;
      const [{ rows: invitations }, { rows: bookings }] = await Promise.all([
        db.execute<{ appointmentId: string }>(
          sql`select distinct appointment_id as "appointmentId" from participant_reminder
            where participation_id = ${participationId}::uuid
              and kind = 'appointment_invitation'`,
        ),
        db.execute<{
          id: string;
          appointmentId: string;
          status: BookingStatus;
          cancelReason: BookingCancelReason | null;
          cancelledAt: string | null;
        }>(
          sql`select id, appointment_id as "appointmentId", status,
              cancel_reason as "cancelReason",
              to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cancelledAt"
            from appointment_booking where participation_id = ${participationId}::uuid`,
        ),
      ]);
      const named = [
        ...new Set([
          ...invitations.map((row) => row.appointmentId),
          ...bookings.map((row) => row.appointmentId),
        ]),
      ];
      const { rows: appointments } = await db.execute<AppointmentRow>(
        sql`select ${appointmentColumns} from appointment a
          where a.project_id = ${projectId}::uuid
            and (a.status = 'scheduled' and a.starts_at > ${now}::timestamptz
                 or a.id = any(${`{${named.join(",")}}`}::uuid[]))
          order by a.starts_at, a.id limit 500`,
      );
      const [live, hostMayList] = await Promise.all([
        liveBookingsOf(
          db,
          appointments.map((row) => row.id),
        ),
        hostRule(
          db,
          projectId,
          appointments.flatMap((row) => (row.hostStaffUserId ? [row.hostStaffUserId] : [])),
        ),
      ]);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        portalAppointments({
          appointments: appointments.map((row) => ({
            ...row,
            bookedCount: live.get(row.id)?.length ?? 0,
            hostMayList: hostMayList(row.hostStaffUserId, participationId),
          })),
          invitedAppointmentIds: invitations.map((row) => row.appointmentId),
          bookings,
          participation,
          projectType: participation.projectType,
          now,
          today: clock.today(),
        }),
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/appointments/{appointmentId}/booking",
      tags: ["portal"],
      summary: "Book an appointment as the participant, until its public booking cutoff",
      middleware: active,
      request: {
        params: AppointmentParams,
        body: { required: true, content: { "application/json": { schema: EmptyInput } } },
      },
      responses: {
        201: json(PortalBookingResult, "The booking"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const session = portalSession(c);
      const { appointmentId } = c.req.valid("param");
      const bookingId = randomUUID();
      try {
        await db.execute(sql`select book_appointment(
          p_context => ${participantContext(session.participationId, c.get("requestId"))},
          p_appointment_id => ${appointmentId}::uuid,
          p_participation_id => ${session.participationId}::uuid,
          p_id => ${bookingId}::uuid, p_token_hash => ${session.tokenHash})`);
      } catch (error) {
        return refused(c, error);
      }
      return c.json({ bookingId }, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/appointment-bookings/{bookingId}/cancellation",
      tags: ["portal"],
      summary:
        "Cancel the participant's own booking until the start; another participation's booking is a 404",
      middleware: active,
      request: {
        params: BookingParams,
        body: { required: true, content: { "application/json": { schema: EmptyInput } } },
      },
      responses: {
        204: { description: "Cancelled" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const session = portalSession(c);
      const { bookingId } = c.req.valid("param");
      try {
        await db.execute(sql`select cancel_appointment_booking(
          p_context => ${participantContext(session.participationId, c.get("requestId"))},
          p_booking_id => ${bookingId}::uuid, p_token_hash => ${session.tokenHash})`);
      } catch (error) {
        return refused(c, error);
      }
      return c.body(null, 204);
    },
  );

  return router;
}
