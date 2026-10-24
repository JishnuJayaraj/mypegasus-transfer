import { sql, type Database } from "@transfer/db";
import {
  conflictState,
  noticeKinds,
  type AppointmentItemBooking,
  type AppointmentItemNotice,
  type Attendance,
  type AttendanceConflictResolution,
} from "@transfer/domain";
import { hostRule } from "./service";

// The facts of the work list's appointment items (process-and-lifecycle.md, appointment
// items): each participation's bookings with their appointments and its organizer's notices.
// Codes, ids and times only, never a title or a venue.

const at = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

const uuids = (ids: readonly string[]) => `{${ids.join(",")}}`;

type BookingRow = Omit<AppointmentItemBooking, "conflict" | "hostMayList"> & {
  participationId: string;
  hostStaffUserId: string | null;
  informedBasis: boolean;
  conflictEscalated: boolean;
  conflictResolution: AttendanceConflictResolution | null;
  attendance: Attendance | null;
};

/**
 * The participations' bookings as the items need them. A viewer who `resolvesHosts` (the PL, as
 * on the appointment page) learns whether each slot's host may list the participation now; anyone
 * else nothing, and so no `needs_resolution` item.
 */
export async function itemBookingsOf(
  db: Pick<Database, "execute">,
  projectId: string,
  participationIds: readonly string[],
  resolvesHosts: boolean,
): Promise<Map<string, AppointmentItemBooking[]>> {
  const byParticipation = new Map<string, AppointmentItemBooking[]>();
  if (participationIds.length === 0) return byParticipation;
  const { rows } = await db.execute<BookingRow>(
    sql`select b.id, b.participation_id as "participationId", b.appointment_id as "appointmentId",
        a.kind as "appointmentKind", a.status as "appointmentStatus",
        ${at("a.starts_at")} as "startsAt", ${at("a.ends_at")} as "endsAt",
        a.host_staff_user_id as "hostStaffUserId", b.status, b.attendance,
        b.follow_up_of as "followUpOf", b.missed_resolution as "missedResolution",
        b.informed_basis_at is not null as "informedBasis",
        b.conflict_escalated_at is not null as "conflictEscalated",
        b.conflict_resolution as "conflictResolution"
      from appointment_booking b join appointment a on a.id = b.appointment_id
      where b.participation_id = any(${uuids(participationIds)}::uuid[])
      order by a.starts_at, b.id`,
  );
  const hostMayList = resolvesHosts
    ? await hostRule(
        db,
        projectId,
        rows.flatMap((row) => (row.hostStaffUserId ? [row.hostStaffUserId] : [])),
      )
    : null;
  for (const row of rows) {
    const { participationId, hostStaffUserId, informedBasis, conflictEscalated, ...booking } = row;
    const list = byParticipation.get(participationId) ?? [];
    list.push({
      id: booking.id,
      appointmentId: booking.appointmentId,
      appointmentKind: booking.appointmentKind,
      appointmentStatus: booking.appointmentStatus,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      status: booking.status,
      attendance: booking.attendance,
      followUpOf: booking.followUpOf,
      missedResolution: booking.missedResolution,
      conflict: conflictState({
        informedBasis,
        attendance: booking.attendance,
        escalated: conflictEscalated,
        resolution: booking.conflictResolution,
      }),
      hostMayList:
        hostMayList && booking.appointmentKind === "consultation"
          ? hostMayList(hostStaffUserId, participationId)
          : null,
    });
    byParticipation.set(participationId, list);
  }
  return byParticipation;
}

/** The participations' organizer's notices with their appointments' kinds and starts. */
export async function itemNoticesOf(
  db: Pick<Database, "execute">,
  participationIds: readonly string[],
): Promise<Map<string, AppointmentItemNotice[]>> {
  const byParticipation = new Map<string, AppointmentItemNotice[]>();
  if (participationIds.length === 0) return byParticipation;
  const { rows } = await db.execute<AppointmentItemNotice & { participationId: string }>(
    sql`select r.participation_id as "participationId", r.appointment_id as "appointmentId",
        a.kind as "appointmentKind", ${at("a.starts_at")} as "startsAt", r.kind, r.status,
        r.cancel_reason as "cancelReason", r.followed_up_at is not null as "followedUp"
      from participant_reminder r join appointment a on a.id = r.appointment_id
      where r.participation_id = any(${uuids(participationIds)}::uuid[])
        and r.kind::text = any(${`{${[...noticeKinds].join(",")}}`}::text[])`,
  );
  for (const { participationId, ...notice } of rows) {
    byParticipation.set(participationId, [...(byParticipation.get(participationId) ?? []), notice]);
  }
  return byParticipation;
}
