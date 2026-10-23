import { sql, type Database } from "@transfer/db";
import {
  bookingView,
  mayBookFor,
  mayManageAppointment,
  needsResolution,
  type Appointment,
  type AppointmentFacts,
  type LiveBooking,
  type MainStatus,
  type ProjectRole,
  type StaffUser,
} from "@transfer/domain";
import { projectAccess, projectTarget } from "../access";
import type { StaffSubject } from "../participations/subjects";

// Appointments in the API (data-protection.md, appointments; ADR-0010): loading, the viewer's
// count view and capabilities. The database decides every write again under its locks.

/** An instant as the API sends it: UTC ISO 8601 with the database's microseconds. */
const at = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

export type AppointmentRow = AppointmentFacts & {
  projectId: string;
  hostStaffUserId: string | null;
  title: string | null;
  venue: string;
  cancelReason: Appointment["cancelReason"];
  cancelledAt: string | null;
  version: number;
  inUse: boolean;
};

export const appointmentColumns = sql`a.id, a.project_id as "projectId", a.kind,
  a.host_staff_user_id as "hostStaffUserId", a.audience_wave_id as "audienceWaveId",
  ${at("a.starts_at")} as "startsAt", ${at("a.ends_at")} as "endsAt",
  ${at("a.booking_closes_at")} as "bookingClosesAt", a.capacity, a.title, a.venue, a.status,
  a.cancel_reason as "cancelReason", ${at("a.cancelled_at")} as "cancelledAt", a.version,
  exists (select from appointment_booking u where u.appointment_id = a.id) as "inUse"`;

export async function loadAppointment(
  db: Pick<Database, "execute">,
  appointmentId: string,
): Promise<AppointmentRow | undefined> {
  const { rows } = await db.execute<AppointmentRow>(
    sql`select ${appointmentColumns} from appointment a where a.id = ${appointmentId}::uuid`,
  );
  return rows[0];
}

/** The live bookings of these appointments: which participation, never more. */
export async function liveBookingsOf(
  db: Pick<Database, "execute">,
  appointmentIds: readonly string[],
): Promise<Map<string, { id: string; participationId: string }[]>> {
  const byAppointment = new Map<string, { id: string; participationId: string }[]>();
  if (appointmentIds.length === 0) return byAppointment;
  const { rows } = await db.execute<{ id: string; appointmentId: string; participationId: string }>(
    sql`select id, appointment_id as "appointmentId", participation_id as "participationId"
      from appointment_booking
      where status = 'booked' and appointment_id = any(${`{${appointmentIds.join(",")}}`}::uuid[])`,
  );
  for (const row of rows) {
    const list = byAppointment.get(row.appointmentId) ?? [];
    list.push({ id: row.id, participationId: row.participationId });
    byAppointment.set(row.appointmentId, list);
  }
  return byAppointment;
}

/**
 * Whether each host may list (so host or book) a participation now (Q62): an active PL of the
 * project, or its consultant while assigned; the same rule as `appointment_staff_allowed`.
 */
export async function hostRule(
  db: Pick<Database, "execute">,
  projectId: string,
  hostIds: readonly string[],
): Promise<(hostId: string | null, participationId: string) => boolean> {
  const hosts = [...new Set(hostIds)];
  if (hosts.length === 0) return () => false;
  const list = `{${hosts.join(",")}}`;
  const [{ rows: roles }, { rows: assigned }] = await Promise.all([
    db.execute<{ staffUserId: string; role: ProjectRole }>(
      sql`select m.staff_user_id as "staffUserId", m.role from project_membership m
        join staff_user u on u.id = m.staff_user_id and u.deactivated_at is null
        where m.project_id = ${projectId}::uuid and m.staff_user_id = any(${list}::uuid[])`,
    ),
    db.execute<{ staffUserId: string; participationId: string }>(
      sql`select a.staff_user_id as "staffUserId", a.participation_id as "participationId"
        from participant_assignment a join participation p on p.id = a.participation_id
        where p.project_id = ${projectId}::uuid and a.ended_at is null
          and a.staff_user_id = any(${list}::uuid[])`,
    ),
  ]);
  const subjects = new Map<string, StaffSubject>(
    hosts.map((staffUserId) => [
      staffUserId,
      {
        kind: "staff",
        staffUserId,
        orgRoles: new Map(),
        projectRoles: {
          [projectId]: new Set(
            roles.filter((r) => r.staffUserId === staffUserId).map((r) => r.role),
          ),
        },
        assignedParticipationIds: new Set(
          assigned.filter((a) => a.staffUserId === staffUserId).map((a) => a.participationId),
        ),
      },
    ]),
  );
  return (hostId, participationId) => {
    const subject = hostId ? subjects.get(hostId) : undefined;
    return (
      subject !== undefined &&
      mayBookFor(subject, projectTarget(projectId, null, participationId)).ok
    );
  };
}

export type AppointmentViewer = {
  subject: StaffSubject;
  projectId: string;
  regionId: string | null;
  now: string;
};

const roles = (viewer: AppointmentViewer) =>
  viewer.subject.projectRoles[viewer.projectId] ?? new Set<ProjectRole>();

/** Whether the viewer is a member of the project (appointments are project data, Q166). */
export const isMember = (viewer: AppointmentViewer) => roles(viewer).size > 0;

/** Whether the viewer books for anyone at all (the PL, a consultant; per row `mayBookFor`). */
export const booksAtAll = (viewer: AppointmentViewer) =>
  roles(viewer).has("project_lead") || roles(viewer).has("consultant");

/** The viewer's access to a project's appointments: visible (else 404), a member (else 403). */
export async function appointmentViewer(
  db: Database,
  user: StaffUser,
  projectId: string,
  now: string,
): Promise<{ viewer: AppointmentViewer; visible: boolean }> {
  const { subject, visible, regionId } = await projectAccess(db, user, projectId);
  return { viewer: { subject, projectId, regionId, now }, visible };
}

/**
 * One appointment as the viewer sees it (Q150, Q162): the count view of `bookingView`, the
 * number needing resolution for the PL, the capabilities.
 */
export function appointmentView(
  viewer: AppointmentViewer,
  row: AppointmentRow,
  live: readonly { participationId: string }[],
  hostMayList: (hostId: string | null, participationId: string) => boolean,
): Appointment {
  const target = { projectId: viewer.projectId };
  const manage = mayManageAppointment(viewer.subject, row, target).ok;
  const scheduled = row.status === "scheduled";
  const upcoming = Date.parse(row.startsAt) > Date.parse(viewer.now);
  const lead = roles(viewer).has("project_lead");
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    bookingClosesAt: row.bookingClosesAt,
    capacity: row.capacity,
    title: row.title,
    venue: row.venue,
    hostStaffUserId: row.hostStaffUserId,
    audienceWaveId: row.audienceWaveId,
    status: row.status,
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt,
    inUse: row.inUse,
    version: row.version,
    bookings: bookingView(
      viewer.subject,
      { projectId: row.projectId, capacity: row.capacity },
      live,
    ),
    needsResolution: lead
      ? live.filter((booking) =>
          needsResolution(
            { status: "booked" },
            row,
            hostMayList(row.hostStaffUserId, booking.participationId),
            viewer.now,
          ),
        ).length
      : null,
    capabilities: {
      change: manage && scheduled,
      changeHost:
        mayManageAppointment(viewer.subject, row, target, "host").ok &&
        scheduled &&
        upcoming &&
        row.kind === "consultation",
      cancel: manage && scheduled,
      book: scheduled && upcoming && booksAtAll(viewer),
    },
  };
}

/** A participation's live bookings with their appointments' kinds and times. */
export async function participationLiveBookings(
  db: Pick<Database, "execute">,
  participationId: string,
): Promise<LiveBooking[]> {
  const { rows } = await db.execute<LiveBooking>(
    sql`select a.id as "appointmentId", a.kind, ${at("a.starts_at")} as "startsAt",
        ${at("a.ends_at")} as "endsAt"
      from appointment_booking b join appointment a on a.id = b.appointment_id
      where b.participation_id = ${participationId}::uuid and b.status = 'booked'`,
  );
  return rows;
}

/** What the booking rules need of a participation (its wave's cutoff, the project's type). */
export async function bookingParticipation(db: Pick<Database, "execute">, participationId: string) {
  const { rows } = await db.execute<{
    projectId: string;
    status: MainStatus;
    entryWaveId: string | null;
    latestEntryDate: string | null;
    projectType: "ta_tg" | "ta_only";
  }>(
    sql`select p.project_id as "projectId", p.status, p.entry_wave_id as "entryWaveId",
        w.latest_entry_date::text as "latestEntryDate", j.type as "projectType"
      from participation p join project j on j.id = p.project_id
      left join project_entry_wave w on w.id = p.entry_wave_id
      where p.id = ${participationId}::uuid`,
  );
  return rows[0];
}
