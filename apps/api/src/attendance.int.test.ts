import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  Appointment,
  AppointmentBookingList,
  AttendanceResult,
  InformedResult,
  ParticipationAppointments,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Attendance and `informed` (process-and-lifecycle.md and data-protection.md, appointments:
// attendance; ADR-0010) against transfer_test, on the system clock (the functions decide by the
// database's). Appointments are created ahead and moved into the past by the owner, a fixture.
// Synthetic data only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;

const hours = (h: number) =>
  new Date(Math.ceil(Date.now() / 60_000) * 60_000 + h * 3600_000).toISOString();

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

const get = (path: string, as: string = projectLead) =>
  app.request(`/api/v1${path}`, { headers: staff[as]! });
const post = (path: string, body: unknown, as: string = projectLead) =>
  app.request(`/api/v1${path}`, jsonRequest("POST", body, staff[as]!));

async function participation(options: { assigned?: boolean; status?: "unreachable" } = {}) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  if (options.status) {
    await changeStatus(owner.$client, id, {
      field: "status",
      from: "contacted",
      to: "unreachable",
    });
  }
  await owner.$client.query(
    `insert into participant_identity (participation_id, project_id, personnel_number, last_name, first_name)
     values ($1, $2, $3, 'Beispiel', 'Erika')`,
    [id, werkNord, `SYN-${id.slice(-8)}`],
  );
  if (options.assigned !== false) {
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
  }
  return id;
}

/** An info event with the participations booked, started `startedHoursAgo` hours ago. */
async function startedEvent(participations: string[], startedHoursAgo = 3) {
  const res = await post(`/projects/${werkNord}/appointments`, {
    kind: "info_event",
    startsAt: hours(48),
    endsAt: hours(50),
    capacity: 10,
    venue: "Kantine Werk 2",
  });
  expect(res.status).toBe(201);
  const { id } = await readJson(res, Appointment);
  for (const p of participations) {
    expect((await post(`/appointments/${id}/bookings`, { participationId: p })).status).toBe(201);
  }
  await owner.$client.query(
    `update appointment set starts_at = now() - $2 * interval '1 hour',
       ends_at = now() - ($2 - 2) * interval '1 hour',
       booking_closes_at = now() - ($2 + 24) * interval '1 hour' where id = $1`,
    [id, startedHoursAgo],
  );
  return id;
}

const status = async (id: string) =>
  (await owner.$client.query("select status::text from participation where id = $1", [id])).rows[0]
    .status;
const bookings = async (appointmentId: string, as: string = projectLead) =>
  (await readJson(await get(`/appointments/${appointmentId}/bookings`, as), AppointmentBookingList))
    .items;

describe("POST /appointments/{id}/attendance", () => {
  it("records attendance and informs the ticked rows with the confirmation", async () => {
    const [p, q] = [await participation(), await participation()];
    const event = await startedEvent([p, q]);
    const [first] = await bookings(event);
    expect(first!.capabilities).toMatchObject({
      recordAttended: true,
      recordAbsent: true,
      offerInformed: true,
      afterClose: false,
      markInformed: false,
    });
    const before = await readJson(await get(`/appointments/${event}`), Appointment);
    expect(before.capabilities).toMatchObject({ recordAttendance: true, cancel: true });
    const res = await post(`/appointments/${event}/attendance`, {
      entries: [
        { participationId: p, attendance: "attended", markInformed: true },
        { participationId: q, attendance: "absent" },
      ],
      informationDelivered: true,
    });
    expect(res.status).toBe(200);
    expect(await readJson(res, AttendanceResult)).toEqual({
      recorded: 2,
      informed: 1,
      statusChanges: 1,
    });
    expect(await status(p)).toBe("informed");
    const listed = await bookings(event);
    expect(listed.find((b) => b.participationId === p)).toMatchObject({
      attendance: "attended",
      informedBasis: true,
      conflict: null,
      capabilities: { recordAttended: false, recordAbsent: true, offerInformed: false },
    });
    const after = await readJson(await get(`/appointments/${event}`), Appointment);
    expect(after.capabilities).toMatchObject({ cancel: false, correctNotTakenPlace: false });
    expect(JSON.stringify(logs)).not.toMatch(/Kantine/);
  });

  it("names each refused row at /entries/<i> and records nothing", async () => {
    const [p, q] = [await participation(), await participation()];
    const event = await startedEvent([p, q], 1);
    const problem = await expectProblem(
      await post(`/appointments/${event}/attendance`, {
        entries: [
          { participationId: p, attendance: "attended", markInformed: true },
          { participationId: q, attendance: "absent" },
          { participationId: "00000000-0000-4000-a000-0000000000ff", attendance: "attended" },
        ],
        informationDelivered: true,
      }),
      422,
      "domain-error",
    );
    expect(problem.errors).toEqual([
      expect.objectContaining({ pointer: "/entries/1", code: "appointment_not_ended" }),
      expect.objectContaining({ pointer: "/entries/2", code: "participation_not_found" }),
    ]);
    expect(await status(p)).toBe("contacted");
    expect((await bookings(event)).every((b) => b.attendance === null)).toBe(true);
  });

  it("refuses a ticked row without the confirmation, and an `unreachable` attendee after the cutoff", async () => {
    const p = await participation({ status: "unreachable" });
    const event = await startedEvent([p]);
    const unconfirmed = await expectProblem(
      await post(`/appointments/${event}/attendance`, {
        entries: [{ participationId: p, attendance: "attended", markInformed: true }],
      }),
      422,
      "domain-error",
    );
    expect(unconfirmed.errors).toEqual([
      expect.objectContaining({
        pointer: "/informationDelivered",
        code: "information_delivery_unconfirmed",
      }),
    ]);
    const wave = (
      await owner.$client.query(
        `insert into project_entry_wave (project_id, code, name, latest_entry_date)
         values ($1, 'T9', 'T9', current_date - 1) returning id`,
        [werkNord],
      )
    ).rows[0].id;
    await owner.$client.query("update participation set entry_wave_id = $2 where id = $1", [
      p,
      wave,
    ]);
    const cutoff = await expectProblem(
      await post(`/appointments/${event}/attendance`, {
        entries: [{ participationId: p, attendance: "attended", markInformed: true }],
        informationDelivered: true,
      }),
      422,
      "domain-error",
    );
    expect(cutoff.errors).toEqual([
      expect.objectContaining({ pointer: "/entries/0", code: "before_cutoff" }),
    ]);
    expect(await status(p)).toBe("unreachable");
  });

  it("refuses back office (403), a hidden participation for a consultant, and an unknown appointment", async () => {
    const [assigned, other] = [await participation(), await participation({ assigned: false })];
    const event = await startedEvent([assigned, other]);
    const body = { entries: [{ participationId: assigned, attendance: "attended" }] };
    await expectProblem(
      await post(`/appointments/${event}/attendance`, body, backOffice),
      403,
      "forbidden",
    );
    const hidden = await expectProblem(
      await post(
        `/appointments/${event}/attendance`,
        { entries: [{ participationId: other, attendance: "attended" }] },
        consultant,
      ),
      422,
      "domain-error",
    );
    expect(hidden.errors).toEqual([
      expect.objectContaining({ pointer: "/entries/0", code: "participation_not_found" }),
    ]);
    expect((await bookings(event, consultant)).map((b) => b.participationId)).toEqual([assigned]);
    await expectProblem(
      await post("/appointments/00000000-0000-4000-a000-0000000000ee/attendance", body),
      404,
      "not-found",
    );
    const duplicate = await expectProblem(
      await post(`/appointments/${event}/attendance`, {
        entries: [body.entries[0], body.entries[0]],
      }),
      400,
      "validation-error",
    );
    expect(duplicate.errors).toEqual([
      expect.objectContaining({ pointer: "/entries/1/participationId", code: "duplicate_entry" }),
    ]);
  });

  it("takes the closed-case flow from the PL with a reason, never a status change", async () => {
    const p = await participation();
    const event = await startedEvent([p], 20);
    await changeStatus(owner.$client, p, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "not_informed",
      effectiveDate: "2026-10-20",
      context: "(system,,,lifecycle.evaluate-project,,,)",
    });
    const [closed] = await bookings(event);
    expect(closed!.capabilities).toMatchObject({ afterClose: true, recordAttended: true });
    const entries = [{ participationId: p, attendance: "attended" }];
    const consultantRefused = await expectProblem(
      await post(
        `/appointments/${event}/attendance`,
        { entries, afterCloseReason: "late_entry" },
        consultant,
      ),
      422,
      "domain-error",
    );
    expect(consultantRefused.errors![0]!.code).toBe("participation_closed");
    const noReason = await expectProblem(
      await post(`/appointments/${event}/attendance`, { entries }),
      422,
      "domain-error",
    );
    expect(noReason.errors![0]!.code).toBe("after_close_reason_required");
    const res = await post(`/appointments/${event}/attendance`, {
      entries,
      afterCloseReason: "late_entry",
    });
    expect(await readJson(res, AttendanceResult)).toEqual({
      recorded: 1,
      informed: 0,
      statusChanges: 0,
    });
    expect(await status(p)).toBe("withdrawn");
  });
});

describe("informed, the conflict and its review", () => {
  it("informs on a corrected attendance, then reviews the conflict of a basis corrected to `absent`", async () => {
    const p = await participation();
    const event = await startedEvent([p]);
    const record = (attendance: string, as = projectLead) =>
      post(
        `/appointments/${event}/attendance`,
        { entries: [{ participationId: p, attendance }] },
        as,
      );
    expect((await record("absent")).status).toBe(200);
    expect((await record("attended", consultant)).status).toBe(200);
    const [booking] = await bookings(event);
    expect(booking!.capabilities.markInformed).toBe(true);
    await expectProblem(
      await post(`/appointment-bookings/${booking!.id}/informed`, {}, consultant),
      400,
      "validation-error",
    );
    await expectProblem(
      await post(
        `/appointment-bookings/${booking!.id}/informed`,
        { informationDelivered: true },
        backOffice,
      ),
      403,
      "forbidden",
    );
    const informed = await post(
      `/appointment-bookings/${booking!.id}/informed`,
      { informationDelivered: true },
      consultant,
    );
    expect(await readJson(informed, InformedResult)).toEqual({ statusChanges: 1 });
    expect(await status(p)).toBe("informed");
    const again = await expectProblem(
      await post(`/appointment-bookings/${booking!.id}/informed`, { informationDelivered: true }),
      422,
      "domain-error",
    );
    expect(again.errors![0]!.code).toBe("already_basis");

    // The basis corrected to `absent`: the status stays, the conflict shows.
    expect((await record("absent")).status).toBe(200);
    expect(await status(p)).toBe("informed");
    const tab = await readJson(
      await get(`/participations/${p}/appointments`),
      ParticipationAppointments,
    );
    expect(tab.bookings[0]).toMatchObject({
      conflict: "open",
      capabilities: { reviewConflict: true },
    });
    const review = (reason: string, as = projectLead) =>
      post(`/appointment-bookings/${booking!.id}/conflict-review`, { reason }, as);
    await expectProblem(await review("escalated", consultant), 403, "forbidden");
    expect((await review("escalated")).status).toBe(204);
    const twice = await expectProblem(await review("escalated"), 422, "domain-error");
    expect(twice.errors![0]!.code).toBe("already_escalated");
    expect((await bookings(event))[0]!.conflict).toBe("escalated");
    expect((await review("information_delivered_otherwise")).status).toBe(204);
    expect((await bookings(event))[0]).toMatchObject({
      conflict: "resolved",
      conflictResolution: "information_delivered_otherwise",
    });
    const none = await expectProblem(
      await review("information_delivered_otherwise"),
      422,
      "domain-error",
    );
    expect(none.errors![0]!.code).toBe("no_conflict");
  });
});

describe("cancelling with attendance recorded", () => {
  it("refuses a plain cancellation and takes the PL's `did_not_take_place` correction over absences", async () => {
    const p = await participation();
    const event = await startedEvent([p]);
    await post(`/appointments/${event}/attendance`, {
      entries: [{ participationId: p, attendance: "absent" }],
    });
    const appointment = await readJson(await get(`/appointments/${event}`), Appointment);
    expect(appointment.capabilities).toMatchObject({ cancel: false, correctNotTakenPlace: true });
    const plain = await expectProblem(
      await post(`/appointments/${event}/cancellation`, { reason: "too_few_bookings" }),
      422,
      "domain-error",
    );
    expect(plain.errors![0]!.code).toBe("attendance_recorded");
    const corrected = await post(`/appointments/${event}/cancellation`, {
      reason: "did_not_take_place",
    });
    expect((await readJson(corrected, Appointment)).status).toBe("cancelled");
    expect((await bookings(event))[0]).toMatchObject({
      status: "cancelled",
      attendance: "absent",
      superseded: true,
    });
  });
});
