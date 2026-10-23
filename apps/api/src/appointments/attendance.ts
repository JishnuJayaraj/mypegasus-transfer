import type { Clock } from "@transfer/adapters";
import { sql, type Database } from "@transfer/db";
import {
  attendanceCapabilities,
  attendanceEligibility,
  attendanceStatusChanges,
  conflictReviewRefusal,
  conflictState,
  informedConfirmation,
  mayListBookings,
  mayRecordAttendance,
  terminalMainStatuses,
  type Attendance,
  type AttendanceAfterCloseReason,
  type AttendanceConflictResolution,
  type AttendanceConflictReview,
  type AttendanceInput,
  type BookingStatus,
  type MainStatus,
} from "@transfer/domain";
import { projectTarget } from "../access";
import {
  BulkRefusal,
  createStatusService,
  StatusServiceError,
} from "../participations/status-service";
import type { GuardFactsProvider, Transaction } from "../participations/guard-facts";
import { auditContext } from "../sql";
import { hostRule, loadAppointment, type AppointmentRow, type AppointmentViewer } from "./service";

// Attendance and `informed` in the API (process-and-lifecycle.md and data-protection.md,
// appointments: attendance; ADR-0010). Each write is one transaction: the project lock, then the
// domain's rules and, for a status change, the status service's checks of each step; then the
// function, which decides again under its locks. Ids and codes only.

const at = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** A booking's attendance columns as the views and the checks read them (`b` the booking). */
export const bookingAttendanceColumns = sql`b.attendance,
  ${at("b.attendance_recorded_at")} as "attendanceRecordedAt",
  b.after_close_reason as "afterCloseReason", b.informed_basis_at is not null as "informedBasis",
  b.attendance_superseded_at is not null as superseded,
  b.conflict_escalated_at is not null as "conflictEscalated",
  b.conflict_resolution as "conflictResolution", q.status as "participationStatus",
  exists (select from appointment_booking x where x.participation_id = b.participation_id
    and x.informed_basis_at is not null and x.attendance = 'absent'
    and x.conflict_resolution is null) as "openConflict"`;

export type BookingAttendanceRow = {
  status: BookingStatus;
  participationId: string;
  attendance: Attendance | null;
  attendanceRecordedAt: string | null;
  afterCloseReason: AttendanceAfterCloseReason | null;
  informedBasis: boolean;
  superseded: boolean;
  conflictEscalated: boolean;
  conflictResolution: AttendanceConflictResolution | null;
  participationStatus: MainStatus;
  /** Some booking of the participation is a basis in conflict, unresolved. */
  openConflict: boolean;
};

const leads = (viewer: AppointmentViewer) =>
  viewer.subject.projectRoles[viewer.projectId]?.has("project_lead") ?? false;

/**
 * A booking's attendance fields and capabilities for the viewer (Q163): the closed-case flow's
 * permission is the PL's; a terminal participation's live booking is of an appointment that
 * started before the close (the terminal change cancels the others), so `now` stands for the
 * close here and the database decides with its time.
 */
export function bookingAttendanceView(
  viewer: AppointmentViewer,
  appointment: Pick<AppointmentRow, "kind" | "status" | "startsAt" | "endsAt">,
  row: BookingAttendanceRow,
) {
  const terminal = terminalMainStatuses.has(row.participationStatus);
  const target = projectTarget(viewer.projectId, viewer.regionId, row.participationId);
  const conflict = conflictState({
    informedBasis: row.informedBasis,
    attendance: row.attendance,
    escalated: row.conflictEscalated,
    resolution: row.conflictResolution,
  });
  return {
    fields: {
      attendance: row.attendance,
      attendanceRecordedAt: row.attendanceRecordedAt,
      afterCloseReason: row.afterCloseReason,
      informedBasis: row.informedBasis,
      superseded: row.superseded,
      conflict,
      conflictResolution: row.conflictResolution,
    },
    capabilities: attendanceCapabilities({
      appointment,
      booking: row,
      participation: { status: row.participationStatus, closedAt: terminal ? viewer.now : null },
      conflict,
      openConflict: row.openConflict,
      record: mayRecordAttendance(viewer.subject, target, terminal).ok,
      lead: leads(viewer),
      projectActive: viewer.projectActive,
      now: viewer.now,
    }),
  };
}

/** A refusal of one request as a whole: a code at a body field, or at the whole body. */
export class AttendanceRefusal extends Error {
  override readonly name = "AttendanceRefusal";

  constructor(
    readonly code: string,
    readonly field: string | null = null,
  ) {
    super(code);
  }
}

type Deps = { db: Database; clock: Clock; facts?: GuardFactsProvider | undefined };

const call = async (tx: Pick<Database, "execute">, query: ReturnType<typeof sql>) => {
  const { rows } = await tx.execute<{ result: unknown }>(sql`select ${query} as result`);
  return rows[0]!.result;
};

/** What a participation's rows need: its project and status, its live booking of the appointment. */
async function entryFacts(tx: Transaction, appointmentId: string, ids: readonly string[]) {
  const { rows } = await tx.execute<{
    id: string;
    projectId: string;
    status: MainStatus;
    attendance: Attendance | null;
    booked: boolean;
  }>(
    sql`select q.id, q.project_id as "projectId", q.status, b.attendance, b.id is not null as booked
      from participation q
      left join appointment_booking b on b.participation_id = q.id
        and b.appointment_id = ${appointmentId}::uuid and b.status = 'booked'
      where q.id = any(${`{${ids.join(",")}}`}::uuid[])`,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export function createAttendanceService({ db, clock, facts }: Deps) {
  const statusService = createStatusService({ db, clock, facts });

  return {
    /**
     * "Teilnahme erfassen" (Q163, Q164): under the exclusive project lock every row through
     * `attendanceEligibility` and, when ticked, the status service's checks of its steps to
     * `informed`; any refusal writes nothing (`BulkRefusal` with each row's index), a request
     * refusal throws `AttendanceRefusal`. Then `record_attendance`.
     */
    record(
      viewer: AppointmentViewer,
      appointmentId: string,
      input: AttendanceInput,
      requestId: string,
    ): Promise<{ recorded: number; informed: number; statusChanges: number }> {
      const { subject } = viewer;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select lock_project_setup(${viewer.projectId}::uuid)`);
        const { rows: project } = await tx.execute<{ status: string }>(
          sql`select status from project where id = ${viewer.projectId}::uuid`,
        );
        if (project[0]?.status !== "active") throw new AttendanceRefusal("project_not_active");
        const appointment = (await loadAppointment(tx, appointmentId))!;
        if (appointment.status === "cancelled")
          throw new AttendanceRefusal("appointment_cancelled");
        if (input.entries.some((entry) => entry.markInformed) && !input.informationDelivered) {
          throw new AttendanceRefusal("information_delivery_unconfirmed", "informationDelivered");
        }
        const ids = input.entries.map((entry) => entry.participationId);
        const known = await entryFacts(tx, appointmentId, ids);
        const hostMayList = await hostRule(
          tx,
          viewer.projectId,
          appointment.hostStaffUserId ? [appointment.hostStaffUserId] : [],
        );
        const lead = leads(viewer);
        const now = clock.now().toISOString();
        const refused: { index: number; code: string }[] = [];
        // The participations in UUID order (ADR-0002, appointments), each row's index kept.
        const rows = [...input.entries.entries()].toSorted(([, a], [, b]) =>
          a.participationId < b.participationId ? -1 : 1,
        );
        for (const [index, entry] of rows) {
          const { participationId } = entry;
          const found = known.get(participationId);
          if (
            !found ||
            found.projectId !== viewer.projectId ||
            !mayListBookings(subject, { projectId: viewer.projectId, participationId })
          ) {
            refused.push({ index, code: "participation_not_found" });
            continue;
          }
          const target = projectTarget(viewer.projectId, viewer.regionId, participationId);
          if (!mayRecordAttendance(subject, target).ok) {
            refused.push({ index, code: "actor_not_allowed" });
            continue;
          }
          const terminal = terminalMainStatuses.has(found.status);
          const code = attendanceEligibility({
            appointment,
            booking: found.booked ? { attendance: found.attendance } : null,
            attendance: entry.attendance,
            participation: { status: found.status, closedAt: terminal ? now : null },
            lead,
            afterCloseReason: input.afterCloseReason,
            hostMayList: hostMayList(appointment.hostStaffUserId, participationId),
            now,
          });
          if (code !== "ok") {
            refused.push({ index, code });
            continue;
          }
          if (!entry.markInformed) continue;
          // Only a first record: a correction never changes a status.
          const steps =
            found.attendance === null
              ? attendanceStatusChanges(found.status, entry.attendance, terminal)
              : [];
          const failure =
            steps.length === 0
              ? "mark_informed_not_allowed"
              : await statusService.checkSteps(tx, subject, participationId, steps);
          if (failure) refused.push({ index, code: failure });
        }
        if (refused.length > 0) {
          throw new BulkRefusal(refused.toSorted((a, b) => a.index - b.index));
        }
        const result = await call(
          tx,
          sql`record_attendance(p_context => ${auditContext(subject.staffUserId, requestId)},
            p_appointment_id => ${appointmentId}::uuid,
            p_participation_ids => ${`{${ids.join(",")}}`}::uuid[],
            p_attendance => ${`{${input.entries.map((e) => e.attendance).join(",")}}`}::attendance[],
            p_mark_informed => ${`{${input.entries.map((e) => e.markInformed).join(",")}}`}::boolean[],
            p_information_delivered => ${input.informationDelivered}::boolean,
            p_after_close_reason => ${input.afterCloseReason}::attendance_after_close_reason)`,
        );
        return result as { recorded: number; informed: number; statusChanges: number };
      });
    },

    /**
     * "Als informiert erfassen" or "Als Grundlage bestätigen" (Q163): under the participation's
     * lock `informedConfirmation`, the status service's checks of the steps, then
     * `confirm_information_delivered`. A refusal throws a `StatusServiceError` (`domain`).
     */
    confirm(
      viewer: AppointmentViewer,
      bookingId: string,
      requestId: string,
    ): Promise<{ statusChanges: number }> {
      const { subject } = viewer;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from lock_participation((
          select participation_id from appointment_booking where id = ${bookingId}::uuid))`);
        const { rows } = await tx.execute<BookingAttendanceRow & { status: BookingStatus }>(
          sql`select b.status, b.participation_id as "participationId", ${bookingAttendanceColumns}
            from appointment_booking b join participation q on q.id = b.participation_id
            where b.id = ${bookingId}::uuid`,
        );
        const row = rows[0]!;
        const confirmation = informedConfirmation({
          booking: row,
          participationStatus: row.participationStatus,
          openConflict: row.openConflict,
          lead: leads(viewer),
        });
        if (confirmation.code !== "ok") throw new StatusServiceError("domain", confirmation.code);
        if (confirmation.statusChange) {
          const steps = attendanceStatusChanges(row.participationStatus, "attended", false);
          const failure = await statusService.checkSteps(tx, subject, row.participationId, steps);
          if (failure) throw new StatusServiceError("domain", failure);
        }
        const changes = await call(
          tx,
          sql`confirm_information_delivered(
            p_context => ${auditContext(subject.staffUserId, requestId)},
            p_booking_id => ${bookingId}::uuid, p_information_delivered => true)`,
        );
        return { statusChanges: Number(changes) };
      });
    },

    /** The PL's review of a conflict (Q163): `escalated` or the attestation. */
    async review(
      viewer: AppointmentViewer,
      booking: BookingAttendanceRow & { id: string },
      reason: AttendanceConflictReview,
      requestId: string,
    ): Promise<void> {
      const state = conflictState({
        informedBasis: booking.informedBasis,
        attendance: booking.attendance,
        escalated: booking.conflictEscalated,
        resolution: booking.conflictResolution,
      });
      const refusal = conflictReviewRefusal(state, reason);
      if (refusal) throw new StatusServiceError("domain", refusal);
      const context = auditContext(viewer.subject.staffUserId, requestId);
      await call(
        db,
        reason === "escalated"
          ? sql`escalate_attendance_conflict(p_context => ${context},
              p_booking_id => ${booking.id}::uuid)`
          : sql`resolve_attendance_conflict(p_context => ${context},
              p_booking_id => ${booking.id}::uuid,
              p_resolution => 'information_delivered_otherwise'::attendance_conflict_resolution)`,
      );
    },
  };
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;
