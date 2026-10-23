import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  Appointment,
  BookingResult,
  matchesWorklistFilter,
  ParticipationAppointments,
  ProjectDashboard,
  Worklist,
  type WorklistItem,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The work list's appointment items, the dashboard's "Termine" and the missed appointment's
// resolution and follow-up (process-and-lifecycle.md, appointments: the work list; ADR-0010)
// against transfer_test, on the system clock (the functions decide by the database's).
// Appointments are created ahead and moved into the past by the owner, a fixture. Synthetic data
// only.
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
const codes = async (res: Response) =>
  (await expectProblem(res, 422, "domain-error")).errors?.map(({ code, pointer }) => ({
    code,
    pointer,
  }));

/** A contacted participation of Werk Nord, assigned to the consultant unless said otherwise. */
async function participation(assigned = true) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await owner.$client.query(
    `insert into participant_identity (participation_id, project_id, personnel_number, last_name, first_name)
     values ($1, $2, $3, 'Beispiel', 'Erika')`,
    [id, werkNord, `SYN-${id.slice(-8)}`],
  );
  if (assigned) {
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
  }
  return id;
}

/** A new appointment `start` hours ahead with the participations booked; slots are the consultant's. */
async function appointment(kind: "info_event" | "consultation", start: number, booked: string[]) {
  const res = await post(`/projects/${werkNord}/appointments`, {
    kind,
    startsAt: hours(start),
    endsAt: hours(start + 2),
    capacity: 10,
    venue: "Raum 1",
    ...(kind === "consultation" && { hostStaffUserId: consultant }),
  });
  expect(res.status).toBe(201);
  const { id } = await readJson(res, Appointment);
  const bookings: string[] = [];
  for (const participationId of booked) {
    const booking = await post(`/appointments/${id}/bookings`, { participationId });
    expect(booking.status).toBe(201);
    bookings.push((await readJson(booking, BookingResult)).bookingId);
  }
  return { id, bookings };
}

/** Moves an appointment so it started `ago` hours ago (two days: its Berlin end date passed). */
const startedAgo = (id: string, ago = 50) =>
  owner.$client.query(
    `update appointment set starts_at = now() - $2 * interval '1 hour',
       ends_at = now() - ($2 - 2) * interval '1 hour',
       booking_closes_at = now() - ($2 + 24) * interval '1 hour' where id = $1`,
    [id, ago],
  );

const absent = async (appointmentId: string, participationId: string) =>
  expect(
    (
      await post(`/appointments/${appointmentId}/attendance`, {
        entries: [{ participationId, attendance: "absent" }],
      })
    ).status,
  ).toBe(200);

/** A missed consultation of the participation: booked, ended two days ago, recorded absent. */
async function missedConsultation(participationId: string, ago = 50) {
  const slot = await appointment("consultation", 48, [participationId]);
  await startedAgo(slot.id, ago);
  await absent(slot.id, participationId);
  return { appointmentId: slot.id, bookingId: slot.bookings[0]! };
}

const items = async (as: string = projectLead) =>
  (await readJson(await get(`/projects/${werkNord}/worklist`, as), Worklist)).items;
const row = (list: WorklistItem[], id: string) => list.find((item) => item.id === id)!;
const kindsOf = (item: WorklistItem) => item.appointments.items.map((i) => i.kind);
const resolve = (bookingId: string, reason: unknown, as: string = projectLead) =>
  post(`/appointment-bookings/${bookingId}/missed-resolution`, { reason }, as);

describe("GET /projects/{id}/worklist and /dashboard: the appointment items", () => {
  it("lists the next booking and the items; counts distinct participations by the same filter", async () => {
    const [unrecorded, missed, moved] = [
      await participation(),
      await participation(),
      await participation(),
    ];
    const event = await appointment("info_event", 48, [unrecorded]);
    await startedAgo(event.id);
    const slot = await missedConsultation(missed, 100);
    const future = await appointment("consultation", 72, [moved]);
    // The consultant (the slot's host) loses the participation: the PL resolves the booking.
    expect(
      (
        await app.request(`/api/v1/participations/${moved}/assignments/${consultant}`, {
          method: "DELETE",
          headers: { ...staff[projectLead]!, Origin: "http://localhost:5173" },
        })
      ).status,
    ).toBe(204);

    const list = await items();
    expect(row(list, unrecorded).appointments).toEqual({
      next: null,
      items: [
        {
          kind: "attendance_missing",
          appointmentId: event.id,
          appointmentKind: "info_event",
          startsAt: expect.any(String),
        },
      ],
    });
    expect(kindsOf(row(list, missed))).toEqual(["missed"]);
    expect(row(list, missed).appointments.items[0]!.appointmentId).toBe(slot.appointmentId);
    expect(row(list, moved).appointments).toMatchObject({
      next: { kind: "consultation" },
      items: [{ kind: "needs_resolution", appointmentId: future.id }],
    });
    // The host rule is the PL's: back office sees the booking, not the item.
    const office = await items(backOffice);
    expect(row(office, moved).appointments.items).toEqual([]);
    expect(row(office, moved).appointments.next).not.toBeNull();

    const board = await readJson(await get(`/projects/${werkNord}/dashboard`), ProjectDashboard);
    const tiles = Object.fromEntries(board.counts.tiles.map((t) => [t.key, t.count]));
    expect([tiles.appointments_overdue, tiles.appointments_to_resolve]).toEqual([2, 1]);
    for (const { key, count, filter } of [...board.counts.tiles, ...board.counts.appointments]) {
      expect([key, count]).toEqual([
        key,
        list.filter((i) => matchesWorklistFilter(i, filter)).length,
      ]);
    }
    expect(board.counts.appointments.map((a) => [a.key, a.count])).toEqual([
      ["upcoming", 1],
      ["overdue", 2],
      ["to_resolve", 1],
      ["attendance_missing", 1],
      ["missed", 1],
      ["notice_undelivered", 0],
      ["needs_resolution", 1],
      ["attendance_conflict", 0],
    ]);
    // Neither the title nor the venue enters a work list.
    expect(JSON.stringify(list)).not.toContain("Raum 1");
  });

  it("keeps attendance_missing of a closed participation, nothing else", async () => {
    const p = await participation();
    const event = await appointment("info_event", 48, [p]);
    await startedAgo(event.id);
    await missedConsultation(p, 100);
    expect(kindsOf(row(await items(), p))).toEqual(["attendance_missing", "missed"]);
    await changeStatus(owner.$client, p, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2026-10-20",
    });
    expect(kindsOf(row(await items(), p))).toEqual(["attendance_missing"]);
  });
});

describe("POST /appointment-bookings/{id}/missed-resolution", () => {
  it("checks the schema, visibility, permission, then the state (ADR-0010)", async () => {
    const [p, hidden] = [await participation(), await participation(false)];
    const { bookingId } = await missedConsultation(p);
    const unrecorded = await appointment("info_event", 48, [hidden]);
    await expectProblem(await resolve(bookingId, "other"), 400, "validation-error");
    await expectProblem(await resolve(randomUUID(), "no_longer_needed"), 404, "not-found");
    await expectProblem(
      await resolve(unrecorded.bookings[0]!, "no_longer_needed", consultant),
      404,
      "not-found",
    );
    await expectProblem(await resolve(bookingId, "no_longer_needed", backOffice), 403, "forbidden");
    expect(await codes(await resolve(unrecorded.bookings[0]!, "no_longer_needed"))).toEqual([
      { code: "not_missed", pointer: "" },
    ]);

    const tab = async (as: string) =>
      (
        await readJson(
          await get(`/participations/${p}/appointments`, as),
          ParticipationAppointments,
        )
      ).bookings[0]!;
    expect(await tab(consultant)).toMatchObject({
      missed: { followUp: true, resolve: true },
      missedResolution: null,
    });
    expect((await tab(backOffice)).missed).toEqual({ followUp: false, resolve: false });

    expect((await resolve(bookingId, "participant_declined", consultant)).status).toBe(204);
    expect(await tab(projectLead)).toMatchObject({
      missed: null,
      missedResolution: "participant_declined",
    });
    expect(kindsOf(row(await items(), p))).toEqual([]);
    expect(await codes(await resolve(bookingId, "no_longer_needed"))).toEqual([
      { code: "already_resolved", pointer: "" },
    ]);
  });
});

describe("POST /appointments/{id}/bookings with followUpOf", () => {
  it("books a consultation as the missed one's follow-up; cancelled, the item is back", async () => {
    const p = await participation();
    const { bookingId } = await missedConsultation(p);
    const event = await appointment("info_event", 24, []);
    const slot = await appointment("consultation", 72, []);
    const book = (appointmentId: string, followUpOf: string) =>
      post(`/appointments/${appointmentId}/bookings`, { participationId: p, followUpOf });

    expect(await codes(await book(slot.id, randomUUID()))).toEqual([
      { code: "follow_up_not_found", pointer: "/followUpOf" },
    ]);
    expect(await codes(await book(event.id, bookingId))).toEqual([
      { code: "follow_up_kind_mismatch", pointer: "/followUpOf" },
    ]);
    const res = await book(slot.id, bookingId);
    expect(res.status).toBe(201);
    const followUp = (await readJson(res, BookingResult)).bookingId;
    const tab = await readJson(
      await get(`/participations/${p}/appointments`),
      ParticipationAppointments,
    );
    expect(tab.bookings.find((b) => b.id === followUp)).toMatchObject({ followUpOf: bookingId });
    expect(kindsOf(row(await items(), p))).toEqual([]);
    expect(row(await items(), p).appointments.next).toMatchObject({ kind: "consultation" });

    expect((await post(`/appointment-bookings/${followUp}/cancellation`, {})).status).toBe(204);
    // The staff cancellation's notice had no channel: it needs its follow-up too.
    expect(kindsOf(row(await items(), p))).toEqual(["missed", "notice_undelivered"]);
  });
});
