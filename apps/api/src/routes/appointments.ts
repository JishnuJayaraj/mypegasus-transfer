import { createRoute, z } from "@hono/zod-openapi";
import { sql, type Database } from "@transfer/db";
import {
  Appointment,
  AppointmentBookingList,
  AppointmentCancelInput,
  AppointmentChangeInput,
  AppointmentHostInput,
  AppointmentInput,
  AppointmentPage,
  AppointmentQuery,
  AttendanceInput,
  AttendanceResult,
  bookingClosesAt,
  bookingCutoffDays,
  bookingEligibility,
  BookingInput,
  BookingResult,
  bookingView,
  cancellationEligibility,
  ConflictReviewInput,
  InformedInput,
  InformedResult,
  mayBookFor,
  mayListBookings,
  mayListField,
  mayManageAppointment,
  mayRecordAttendance,
  mayResolveAppointmentItem,
  needsResolution,
  ParticipationAppointments,
  terminalMainStatuses,
  type StaffUser,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { projectTarget } from "../access";
import {
  AttendanceRefusal,
  bookingAttendanceColumns,
  bookingAttendanceView,
  createAttendanceService,
  type BookingAttendanceRow,
} from "../appointments/attendance";
import {
  appointmentColumns,
  appointmentView,
  appointmentViewer,
  bookingParticipation,
  booksAtAll,
  hostRule,
  isMember,
  liveBookingsOf,
  loadAppointment,
  participationLiveBookings,
  type AppointmentRow,
  type AppointmentViewer,
} from "../appointments/service";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { decodeCursor, encodeCursor } from "../cursor";
import { functionRefusal } from "../database-errors";
import { BulkRefusal, StatusServiceError } from "../participations/status-service";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext } from "../sql";

// Appointments and staff bookings (data-protection.md, appointments; ADR-0010). Order: the schema
// (400) → visibility (404; a hidden participation in a body is `participation_not_found`) →
// permission (403) → state (422) → version (409). Bodies and logs carry ids and codes only; the
// title and venue are returned to the project's members, never logged.

const ProjectParams = z.object({ projectId: z.uuid() });
const AppointmentParams = z.object({ appointmentId: z.uuid() });
const BookingParams = z.object({ bookingId: z.uuid() });
const ParticipationParams = z.object({ participationId: z.uuid() });
const EmptyInput = z.strictObject({});

/** Where a refusal's code points in the body (ADR-0010); the rest point at the whole body. */
const fieldOf: Record<string, string> = {
  host_not_allowed: "hostStaffUserId",
  host_overlap: "startsAt",
  not_ta_tg: "audienceWaveId",
  wave_of_other_project: "audienceWaveId",
  starts_in_past: "startsAt",
  ends_before_start: "endsAt",
  capacity_below_bookings: "capacity",
  appointment_in_use: "startsAt",
  audience_mismatch: "audienceWaveId",
  participation_not_found: "participationId",
  information_delivery_unconfirmed: "informationDelivered",
};
const refused = (c: Context<AppEnv>, code: string) =>
  domainProblem(c, [{ code, field: fieldOf[code] ?? null }]);

/** The function refusals each write maps to a 422; `actor_not_allowed` is a 403 everywhere. */
const stateCodes = new Set([
  "project_not_active",
  "host_not_allowed",
  "host_not_responsible",
  "host_overlap",
  "not_ta_tg",
  "wave_of_other_project",
  "starts_in_past",
  "appointment_cancelled",
  "appointment_started",
  "appointment_in_use",
  "appointment_unchanged",
  "capacity_below_bookings",
  "not_consultation",
  "participation_not_found",
  "participation_closed",
  "not_in_audience",
  "already_booked",
  "info_event_limit",
  "booking_overlap",
  "appointment_full",
  "after_cutoff",
  "booking_cancelled",
  // Attendance and `informed` (Q163, Q164)
  "attendance_recorded",
  "appointment_not_started",
  "appointment_not_ended",
  "after_close_reason_required",
  "started_after_close",
  "not_booked",
  "attendance_unchanged",
  "mark_informed_not_allowed",
  "before_cutoff",
  "information_delivery_unconfirmed",
  "not_attended",
  "already_basis",
  "already_informed",
  "no_conflict",
  "already_escalated",
]);

/** The refusal of a write function as a problem; undefined for anything else (a 500). */
function refusal(c: Context<AppEnv>, code: string | undefined) {
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (code === "appointment_not_found" || code === "booking_not_found")
    return problem(c, "not-found");
  if (code && stateCodes.has(code)) return refused(c, code);
  return undefined;
}

/** Runs a write function; maps its refusal, or rethrows anything else. */
async function write<T>(c: Context<AppEnv>, run: () => Promise<T>) {
  try {
    return { ok: true as const, value: await run() };
  } catch (error) {
    const response = refusal(c, functionRefusal(error));
    if (response) return { ok: false as const, response };
    throw error;
  }
}

/** A write with the version read: a stale one is a 409 (ADR-0010). */
async function writeVersioned<T>(c: Context<AppEnv>, run: () => Promise<T>) {
  try {
    return { ok: true as const, value: await run() };
  } catch (error) {
    const code = functionRefusal(error);
    if (code === "stale_version") return { ok: false as const, response: problem(c, "conflict") };
    const response = refusal(c, code);
    if (response) return { ok: false as const, response };
    throw error;
  }
}

const call = async (db: Database, query: ReturnType<typeof sql>) => {
  const { rows } = await db.execute<{ result: unknown }>(sql`select ${query} as result`);
  return rows[0]!.result;
};

/** A refusal of the attendance service as a problem; anything else is rethrown. */
function attendanceProblem(c: Context<AppEnv>, error: unknown) {
  if (error instanceof BulkRefusal) {
    return domainProblem(
      c,
      error.rows.map(({ index, code }) => ({ code, field: `entries/${index}` })),
    );
  }
  if (error instanceof AttendanceRefusal) {
    return domainProblem(c, [{ code: error.code, field: error.field }]);
  }
  if (error instanceof StatusServiceError) return refused(c, error.code);
  const response = refusal(c, functionRefusal(error));
  if (response) return response;
  throw error;
}

export function appointmentRoutes(deps: Deps) {
  const { db, clock } = deps;
  const attendance = createAttendanceService(deps);
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const now = () => clock.now().toISOString();

  /** The appointment and the viewer, or the problem: 404 unless a visible project's member. */
  async function access(c: Context<AppEnv>, user: StaffUser, appointmentId: string) {
    const row = await loadAppointment(db, appointmentId);
    if (!row) return { response: problem(c, "not-found") };
    const { viewer, visible } = await appointmentViewer(db, user, row.projectId, now());
    if (!visible) return { response: problem(c, "not-found") };
    if (!isMember(viewer)) return { response: problem(c, "forbidden") };
    return { row, viewer };
  }

  async function view(viewer: AppointmentViewer, row: AppointmentRow) {
    const live = (await liveBookingsOf(db, [row.id])).get(row.id) ?? [];
    const hostMayList = await hostRule(
      db,
      row.projectId,
      row.hostStaffUserId ? [row.hostStaffUserId] : [],
    );
    return appointmentView(viewer, row, live, hostMayList);
  }

  const refetch = async (c: Context<AppEnv>, viewer: AppointmentViewer, id: string) =>
    c.json(await view({ ...viewer, now: now() }, (await loadAppointment(db, id))!), 200);

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/appointments",
      tags: ["appointments"],
      summary:
        "The project's appointments, upcoming or past (cursor), with the viewer's count view and capabilities; for its members",
      middleware,
      request: { params: ProjectParams, query: AppointmentQuery },
      responses: {
        200: json(AppointmentPage, "A page of appointments"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { period, limit, cursor } = c.req.valid("query");
      const { viewer, visible } = await appointmentViewer(db, sessionUser(c), projectId, now());
      if (!visible) return problem(c, "not-found");
      if (!isMember(viewer)) return problem(c, "forbidden");
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      if (cursor !== undefined && !after) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Unknown cursor" }],
        });
      }
      const upcoming = period === "upcoming";
      const position = after
        ? upcoming
          ? sql`and (a.starts_at, a.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
          : sql`and (a.starts_at, a.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
        : sql``;
      const { rows } = await db.execute<AppointmentRow>(
        sql`select ${appointmentColumns} from appointment a
          where a.project_id = ${projectId}::uuid
            and ${upcoming ? sql`a.ends_at > ${viewer.now}::timestamptz` : sql`a.ends_at <= ${viewer.now}::timestamptz`}
            ${position}
          order by ${upcoming ? sql`a.starts_at, a.id` : sql`a.starts_at desc, a.id desc`}
          limit ${limit + 1}`,
      );
      const page = rows.slice(0, limit);
      const live = await liveBookingsOf(
        db,
        page.map((row) => row.id),
      );
      const hostMayList = await hostRule(
        db,
        projectId,
        page.flatMap((row) => (row.hostStaffUserId ? [row.hostStaffUserId] : [])),
      );
      const last = page.at(-1);
      const roles = viewer.subject.projectRoles[projectId]!;
      c.header("Cache-Control", "private, no-store");
      return c.json(
        {
          items: page.map((row) =>
            appointmentView(viewer, row, live.get(row.id) ?? [], hostMayList),
          ),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ createdAt: last.startsAt, id: last.id })
              : null,
          capabilities: {
            createInfoEvent: roles.has("project_lead"),
            createConsultation: roles.has("project_lead") || roles.has("consultant"),
            chooseHost: roles.has("project_lead"),
          },
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/appointments",
      tags: ["appointments"],
      summary:
        "Create an info event (the PL) or a consultation slot (the PL for any host, a consultant their own)",
      middleware,
      request: {
        params: ProjectParams,
        body: { required: true, content: { "application/json": { schema: AppointmentInput } } },
      },
      responses: {
        201: json(Appointment, "The new appointment"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { viewer, visible } = await appointmentViewer(db, user, projectId, now());
      if (!visible) return problem(c, "not-found");
      if (!mayManageAppointment(viewer.subject, input, { projectId }).ok) {
        return problem(c, "forbidden");
      }
      const id = randomUUID();
      const done = await write(c, () =>
        call(
          db,
          sql`create_appointment(p_context => ${auditContext(user.id, c.get("requestId"))},
            p_project_id => ${projectId}::uuid, p_id => ${id}::uuid,
            p_kind => ${input.kind}::appointment_kind,
            p_host_staff_user_id => ${input.hostStaffUserId}::uuid,
            p_audience_wave_id => ${input.audienceWaveId}::uuid,
            p_starts_at => ${input.startsAt}::timestamptz, p_ends_at => ${input.endsAt}::timestamptz,
            p_booking_closes_at => ${bookingClosesAt(input.startsAt, input.bookingCutoffDays)}::timestamptz,
            p_capacity => ${input.capacity}::integer, p_title => ${input.title}::text,
            p_venue => ${input.venue}::text)`,
        ),
      );
      if (!done.ok) return done.response;
      const row = (await loadAppointment(db, id))!;
      return c.json(await view(viewer, row), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/appointments/{appointmentId}",
      tags: ["appointments"],
      summary: "One appointment with the viewer's count view and capabilities",
      middleware,
      request: { params: AppointmentParams },
      responses: {
        200: json(Appointment, "The appointment"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const found = await access(c, sessionUser(c), c.req.valid("param").appointmentId);
      if (found.response) return found.response;
      c.header("Cache-Control", "private, no-store");
      return c.json(await view(found.viewer, found.row), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/appointments/{appointmentId}",
      tags: ["appointments"],
      summary:
        "Change an appointment (version); times, cutoff and audience only while it has had no booking",
      middleware,
      request: {
        params: AppointmentParams,
        body: {
          required: true,
          content: { "application/json": { schema: AppointmentChangeInput } },
        },
      },
      responses: {
        200: json(Appointment, "The changed appointment"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { appointmentId } = c.req.valid("param");
      const input = c.req.valid("json");
      const found = await access(c, user, appointmentId);
      if (found.response) return found.response;
      const { row, viewer } = found;
      if (!mayManageAppointment(viewer.subject, row, viewer).ok) return problem(c, "forbidden");
      if (row.status === "cancelled") return refused(c, "appointment_cancelled");
      if (input.expectedVersion !== row.version) return problem(c, "conflict");
      // The whole new state: what the body names, else what is stored. The cutoff keeps its days
      // before a moved start unless the body names new days.
      const startsAt = input.startsAt ?? row.startsAt;
      const endsAt = input.endsAt ?? row.endsAt;
      const days = input.bookingCutoffDays ?? bookingCutoffDays(row.startsAt, row.bookingClosesAt);
      const audienceWaveId =
        input.audienceWaveId === undefined ? row.audienceWaveId : input.audienceWaveId;
      if (Date.parse(endsAt) <= Date.parse(startsAt)) return refused(c, "ends_before_start");
      if (row.kind === "consultation" && audienceWaveId !== null) {
        return refused(c, "audience_mismatch");
      }
      const closesAt =
        input.startsAt === undefined && input.bookingCutoffDays === undefined
          ? row.bookingClosesAt
          : bookingClosesAt(startsAt, days);
      const done = await writeVersioned(c, () =>
        call(
          db,
          sql`update_appointment(p_context => ${auditContext(user.id, c.get("requestId"))},
            p_id => ${appointmentId}::uuid, p_expected_version => ${input.expectedVersion}::integer,
            p_starts_at => ${startsAt}::timestamptz, p_ends_at => ${endsAt}::timestamptz,
            p_booking_closes_at => ${closesAt}::timestamptz,
            p_capacity => ${input.capacity ?? row.capacity}::integer,
            p_title => ${input.title === undefined ? row.title : input.title}::text,
            p_venue => ${input.venue ?? row.venue}::text,
            p_audience_wave_id => ${audienceWaveId}::uuid)`,
        ),
      );
      if (!done.ok) return done.response;
      return refetch(c, viewer, appointmentId);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/appointments/{appointmentId}/host",
      tags: ["appointments"],
      summary:
        "Change a future slot's host (the PL): a PL or consultant who may list every live booking",
      middleware,
      request: {
        params: AppointmentParams,
        body: { required: true, content: { "application/json": { schema: AppointmentHostInput } } },
      },
      responses: {
        200: json(Appointment, "The appointment with its new host"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { appointmentId } = c.req.valid("param");
      const input = c.req.valid("json");
      const found = await access(c, user, appointmentId);
      if (found.response) return found.response;
      const { row, viewer } = found;
      if (!mayManageAppointment(viewer.subject, row, viewer, "host").ok) {
        return problem(c, "forbidden");
      }
      const done = await writeVersioned(c, () =>
        call(
          db,
          sql`change_appointment_host(p_context => ${auditContext(user.id, c.get("requestId"))},
            p_id => ${appointmentId}::uuid, p_expected_version => ${input.expectedVersion}::integer,
            p_host => ${input.hostStaffUserId}::uuid)`,
        ),
      );
      if (!done.ok) return done.response;
      return refetch(c, viewer, appointmentId);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/appointments/{appointmentId}/cancellation",
      tags: ["appointments"],
      summary:
        "Cancel an appointment with a closed reason, also after its start; every live booking is cancelled with it",
      middleware,
      request: {
        params: AppointmentParams,
        body: {
          required: true,
          content: { "application/json": { schema: AppointmentCancelInput } },
        },
      },
      responses: {
        200: json(Appointment, "The cancelled appointment"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { appointmentId } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const found = await access(c, user, appointmentId);
      if (found.response) return found.response;
      const { row, viewer } = found;
      if (!mayManageAppointment(viewer.subject, row, viewer).ok) return problem(c, "forbidden");
      const done = await write(c, () =>
        call(
          db,
          sql`cancel_appointment(p_context => ${auditContext(user.id, c.get("requestId"))},
            p_id => ${appointmentId}::uuid, p_reason => ${reason}::appointment_cancel_reason)`,
        ),
      );
      if (!done.ok) return done.response;
      return refetch(c, viewer, appointmentId);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/appointments/{appointmentId}/bookings",
      tags: ["appointments"],
      summary: "The appointment's bookings of the participations the viewer may list (live first)",
      middleware,
      request: { params: AppointmentParams },
      responses: {
        200: json(AppointmentBookingList, "The bookings the viewer may list"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const found = await access(c, sessionUser(c), c.req.valid("param").appointmentId);
      if (found.response) return found.response;
      const { row, viewer } = found;
      const { rows } = await db.execute<
        BookingAttendanceRow & {
          id: string;
          personnelNumber: string | null;
          lastName: string | null;
          firstName: string | null;
          origin: "participant" | "staff" | "walk_in";
          bookedAt: string;
          cancelReason:
            | null
            | "participant_cancelled"
            | "staff_cancelled"
            | "appointment_cancelled"
            | "participation_closed";
          cancelledAt: string | null;
        }
      >(
        sql`select b.id, b.participation_id as "participationId",
            i.personnel_number as "personnelNumber", i.last_name as "lastName",
            i.first_name as "firstName", b.status, b.origin,
            to_char(b.booked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "bookedAt",
            b.cancel_reason as "cancelReason",
            to_char(b.cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cancelledAt",
            ${bookingAttendanceColumns}
          from appointment_booking b join participation q on q.id = b.participation_id
          left join participant_identity i on i.participation_id = b.participation_id
          where b.appointment_id = ${row.id}::uuid
          order by b.status = 'booked' desc, i.last_name, i.first_name, b.id`,
      );
      const visible = rows.filter((booking) =>
        mayListBookings(viewer.subject, {
          projectId: row.projectId,
          participationId: booking.participationId,
        }),
      );
      const hostMayList = await hostRule(
        db,
        row.projectId,
        row.hostStaffUserId ? [row.hostStaffUserId] : [],
      );
      const lead = viewer.subject.projectRoles[row.projectId]!.has("project_lead");
      const field = (
        pid: string,
        key: "personnelNumber" | "lastName" | "firstName",
        value: string | null,
      ) => (mayListField(viewer.subject, row.projectId, pid, key) ? value : null);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        {
          items: visible.map((booking) => {
            const { fields, capabilities } = bookingAttendanceView(viewer, row, booking);
            return {
              id: booking.id,
              participationId: booking.participationId,
              personnelNumber: field(
                booking.participationId,
                "personnelNumber",
                booking.personnelNumber,
              ),
              lastName: field(booking.participationId, "lastName", booking.lastName),
              firstName: field(booking.participationId, "firstName", booking.firstName),
              status: booking.status,
              origin: booking.origin,
              bookedAt: booking.bookedAt,
              cancelReason: booking.cancelReason,
              cancelledAt: booking.cancelledAt,
              needsResolution: lead
                ? needsResolution(
                    booking,
                    row,
                    hostMayList(row.hostStaffUserId, booking.participationId),
                    viewer.now,
                  )
                : null,
              ...fields,
              capabilities: {
                cancel:
                  mayBookFor(
                    viewer.subject,
                    projectTarget(row.projectId, viewer.regionId, booking.participationId),
                  ).ok && cancellationEligibility(booking, row, viewer.now) === "ok",
                ...capabilities,
              },
            };
          }),
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/appointments/{appointmentId}/bookings",
      tags: ["appointments"],
      summary:
        "Book a participation (the PL, the assigned consultant): until the start, also after the public cutoff; with the booking's warnings",
      middleware,
      request: {
        params: AppointmentParams,
        body: { required: true, content: { "application/json": { schema: BookingInput } } },
      },
      responses: {
        201: json(BookingResult, "The booking and its warnings"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { appointmentId } = c.req.valid("param");
      const { participationId } = c.req.valid("json");
      const found = await access(c, user, appointmentId);
      if (found.response) return found.response;
      const { row, viewer } = found;
      const facts = await bookingParticipation(db, participationId);
      const target = projectTarget(row.projectId, viewer.regionId, participationId);
      if (
        !facts ||
        facts.projectId !== row.projectId ||
        !mayListBookings(viewer.subject, { projectId: row.projectId, participationId })
      ) {
        return refused(c, "participation_not_found");
      }
      if (!mayBookFor(viewer.subject, target).ok) return problem(c, "forbidden");
      if (!viewer.projectActive) return refused(c, "project_not_active");
      const [live, booked, hostMayList] = await Promise.all([
        participationLiveBookings(db, participationId),
        liveBookingsOf(db, [row.id]),
        hostRule(db, row.projectId, row.hostStaffUserId ? [row.hostStaffUserId] : []),
      ]);
      const eligibility = bookingEligibility({
        appointment: row,
        bookedCount: booked.get(row.id)?.length ?? 0,
        hostMayList: hostMayList(row.hostStaffUserId, participationId),
        participation: facts,
        liveBookings: live,
        projectType: facts.projectType,
        actor: "staff",
        now: viewer.now,
        today: clock.today(),
      });
      if (eligibility.code !== "ok") return refused(c, eligibility.code);
      const bookingId = randomUUID();
      const done = await write(c, () =>
        call(
          db,
          sql`book_appointment(p_context => ${auditContext(user.id, c.get("requestId"))},
            p_appointment_id => ${appointmentId}::uuid,
            p_participation_id => ${participationId}::uuid, p_id => ${bookingId}::uuid)`,
        ),
      );
      if (!done.ok) return done.response;
      return c.json({ bookingId, warnings: eligibility.warnings }, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/appointment-bookings/{bookingId}/cancellation",
      tags: ["appointments"],
      summary: "Cancel a live booking until the start (the PL, the assigned consultant)",
      middleware,
      request: {
        params: BookingParams,
        body: { required: true, content: { "application/json": { schema: EmptyInput } } },
      },
      responses: {
        204: { description: "Cancelled" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { bookingId } = c.req.valid("param");
      const { rows } = await db.execute<{
        participationId: string;
        appointmentId: string;
        status: "booked" | "cancelled";
      }>(
        sql`select participation_id as "participationId", appointment_id as "appointmentId", status
          from appointment_booking where id = ${bookingId}::uuid`,
      );
      const booking = rows[0];
      if (!booking) return problem(c, "not-found");
      const found = await access(c, user, booking.appointmentId);
      if (found.response) return problem(c, "not-found");
      const { row, viewer } = found;
      const { participationId } = booking;
      if (!mayListBookings(viewer.subject, { projectId: row.projectId, participationId })) {
        return problem(c, "not-found");
      }
      if (
        !mayBookFor(viewer.subject, projectTarget(row.projectId, viewer.regionId, participationId))
          .ok
      ) {
        return problem(c, "forbidden");
      }
      const code = cancellationEligibility(booking, row, viewer.now);
      if (code !== "ok") return refused(c, code);
      const done = await write(c, () =>
        call(
          db,
          sql`cancel_appointment_booking(p_context => ${auditContext(user.id, c.get("requestId"))},
            p_booking_id => ${bookingId}::uuid)`,
        ),
      );
      if (!done.ok) return done.response;
      return c.body(null, 204);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/appointments",
      tags: ["appointments"],
      summary:
        'The participant tab "Termine": the bookings and the upcoming appointments in the participation\'s audience or host rule',
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(ParticipationAppointments, "The bookings and bookable appointments"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const facts = await bookingParticipation(db, participationId);
      if (!facts) return problem(c, "not-found");
      const { viewer, visible } = await appointmentViewer(
        db,
        sessionUser(c),
        facts.projectId,
        now(),
      );
      if (!visible) return problem(c, "not-found");
      if (!mayListBookings(viewer.subject, { projectId: facts.projectId, participationId })) {
        return problem(c, "forbidden");
      }
      const target = projectTarget(facts.projectId, viewer.regionId, participationId);
      const mayBook = viewer.projectActive && mayBookFor(viewer.subject, target).ok;
      const summary = sql`a.id, a.kind, to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "startsAt",
        to_char(a.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "endsAt",
        a.title, a.venue, a.status`;
      const [{ rows: bookings }, { rows: upcoming }, live] = await Promise.all([
        db.execute<
          BookingAttendanceRow & {
            id: string;
            origin: "participant" | "staff" | "walk_in";
            bookedAt: string;
            cancelReason:
              | null
              | "participant_cancelled"
              | "staff_cancelled"
              | "appointment_cancelled"
              | "participation_closed";
            cancelledAt: string | null;
            appointment: {
              id: string;
              kind: "info_event" | "consultation";
              startsAt: string;
              endsAt: string;
              title: string | null;
              venue: string;
              status: "scheduled" | "cancelled";
            };
          }
        >(
          sql`select b.id, b.participation_id as "participationId", b.status, b.origin,
              to_char(b.booked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "bookedAt",
              b.cancel_reason as "cancelReason",
              to_char(b.cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cancelledAt",
              (select row_to_json(s) from (select ${summary}) s) as appointment,
              ${bookingAttendanceColumns}
            from appointment_booking b join appointment a on a.id = b.appointment_id
            join participation q on q.id = b.participation_id
            where b.participation_id = ${participationId}::uuid
            order by a.starts_at desc, b.id`,
        ),
        db.execute<AppointmentRow>(
          sql`select ${appointmentColumns} from appointment a
            where a.project_id = ${facts.projectId}::uuid and a.status = 'scheduled'
              and a.starts_at > ${viewer.now}::timestamptz
            order by a.starts_at, a.id limit 200`,
        ),
        participationLiveBookings(db, participationId),
      ]);
      const counts = await liveBookingsOf(
        db,
        upcoming.map((row) => row.id),
      );
      const hostMayList = await hostRule(
        db,
        facts.projectId,
        upcoming.flatMap((row) => (row.hostStaffUserId ? [row.hostStaffUserId] : [])),
      );
      const outside = new Set([
        "participation_closed",
        "not_in_audience",
        "host_not_responsible",
        "already_booked",
      ]);
      const bookable = upcoming.flatMap((row) => {
        const booked = counts.get(row.id) ?? [];
        const { code, warnings } = bookingEligibility({
          appointment: row,
          bookedCount: booked.length,
          hostMayList: hostMayList(row.hostStaffUserId, participationId),
          participation: facts,
          liveBookings: live,
          projectType: facts.projectType,
          actor: "staff",
          now: viewer.now,
          today: clock.today(),
        });
        if (outside.has(code)) return [];
        return [
          {
            appointment: {
              id: row.id,
              kind: row.kind,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
              title: row.title,
              venue: row.venue,
              status: row.status,
            },
            availability: bookingView(viewer.subject, row, booked).availability,
            code: code === "ok" ? null : code,
            warnings,
          },
        ];
      });
      c.header("Cache-Control", "private, no-store");
      return c.json(
        {
          bookings: bookings.map((booking) => {
            const { fields, capabilities } = bookingAttendanceView(
              viewer,
              booking.appointment,
              booking,
            );
            return {
              id: booking.id,
              appointment: booking.appointment,
              status: booking.status,
              origin: booking.origin,
              bookedAt: booking.bookedAt,
              cancelReason: booking.cancelReason,
              cancelledAt: booking.cancelledAt,
              ...fields,
              capabilities: {
                cancel:
                  mayBook &&
                  cancellationEligibility(booking, booking.appointment, viewer.now) === "ok",
                ...capabilities,
              },
            };
          }),
          bookable,
          capabilities: { book: mayBook },
        },
        200,
      );
    },
  );

  /** A booking the viewer may list, with its appointment and attendance; else the 404. */
  async function bookingAccess(c: Context<AppEnv>, user: StaffUser, bookingId: string) {
    const { rows } = await db.execute<BookingAttendanceRow & { id: string; appointmentId: string }>(
      sql`select b.id, b.appointment_id as "appointmentId", b.participation_id as "participationId",
          b.status, ${bookingAttendanceColumns}
        from appointment_booking b join participation q on q.id = b.participation_id
        where b.id = ${bookingId}::uuid`,
    );
    const booking = rows[0];
    if (!booking) return { response: problem(c, "not-found") };
    const found = await access(c, user, booking.appointmentId);
    if (found.response) return { response: problem(c, "not-found") };
    const { row, viewer } = found;
    const { participationId } = booking;
    if (!mayListBookings(viewer.subject, { projectId: row.projectId, participationId })) {
      return { response: problem(c, "not-found") };
    }
    return { booking, row, viewer };
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/appointments/{appointmentId}/attendance",
      tags: ["appointments"],
      summary:
        'Record or correct attendance (the PL, the assigned consultant; after a close the PL with a reason): 1–500 rows, all or nothing, walk-ins, and "als informiert erfassen" with the delivery confirmed',
      middleware,
      request: {
        params: AppointmentParams,
        body: { required: true, content: { "application/json": { schema: AttendanceInput } } },
      },
      responses: {
        200: json(AttendanceResult, "What was recorded and the status changes"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { appointmentId } = c.req.valid("param");
      const found = await access(c, user, appointmentId);
      if (found.response) return found.response;
      const { viewer } = found;
      if (!booksAtAll(viewer)) return problem(c, "forbidden");
      try {
        const result = await attendance.record(
          viewer,
          appointmentId,
          c.req.valid("json"),
          c.get("requestId"),
        );
        return c.json(result, 200);
      } catch (error) {
        return attendanceProblem(c, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/appointment-bookings/{bookingId}/informed",
      tags: ["appointments"],
      summary:
        '"Als informiert erfassen" on a qualifying attendance, or "Als Grundlage bestätigen" while another basis is in conflict, with the delivery confirmed',
      middleware,
      request: {
        params: BookingParams,
        body: { required: true, content: { "application/json": { schema: InformedInput } } },
      },
      responses: {
        200: json(InformedResult, "The status changes made"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { bookingId } = c.req.valid("param");
      const found = await bookingAccess(c, sessionUser(c), bookingId);
      if (found.response) return found.response;
      const { booking, row, viewer } = found;
      const closed = terminalMainStatuses.has(booking.participationStatus);
      const target = projectTarget(row.projectId, viewer.regionId, booking.participationId);
      if (!mayRecordAttendance(viewer.subject, target, closed).ok) return problem(c, "forbidden");
      if (!viewer.projectActive) return refused(c, "project_not_active");
      try {
        return c.json(await attendance.confirm(viewer, bookingId, c.get("requestId")), 200);
      } catch (error) {
        return attendanceProblem(c, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/appointment-bookings/{bookingId}/conflict-review",
      tags: ["appointments"],
      summary:
        "The PL's review of an attendance conflict: escalated (stays open) or information_delivered_otherwise (resolved), also after the close",
      middleware,
      request: {
        params: BookingParams,
        body: {
          required: true,
          content: { "application/json": { schema: ConflictReviewInput } },
        },
      },
      responses: {
        204: { description: "Recorded" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { bookingId } = c.req.valid("param");
      const found = await bookingAccess(c, sessionUser(c), bookingId);
      if (found.response) return found.response;
      const { booking, row, viewer } = found;
      const target = projectTarget(row.projectId, viewer.regionId, booking.participationId);
      if (!mayResolveAppointmentItem(viewer.subject, target, "attendance_conflict").ok) {
        return problem(c, "forbidden");
      }
      try {
        await attendance.review(viewer, booking, c.req.valid("json").reason, c.get("requestId"));
        return c.body(null, 204);
      } catch (error) {
        return attendanceProblem(c, error);
      }
    },
  );

  return router;
}
