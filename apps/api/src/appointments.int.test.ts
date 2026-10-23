import { createDb, seedProjectIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  Appointment,
  AppointmentBookingList,
  AppointmentPage,
  BookingResult,
  ParticipationAppointments,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Appointments and staff bookings (data-protection.md, appointments; ADR-0010) against
// transfer_test, on the system clock (the functions decide by the database's). Synthetic data
// only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, verwaltung } = seedProjectIds;
const { projectLead, consultant, backOffice, admin } = seedStaffUserIds;
const otherConsultant = "00000000-0000-4000-8000-0000000000c2";
const staff = {} as Record<string, { Cookie: string }>;
const TITLE = "Infoveranstaltung Werk";
const VENUE = "Kantine Werk 2";

const hours = (h: number) =>
  new Date(Math.ceil(Date.now() / 60_000) * 60_000 + h * 3600_000).toISOString();

async function reset() {
  await resetTestDatabase({ seed: true, active: true });
  await owner.$client.query(
    `insert into staff_user (id, display_name, email) values ($1, 'Clara Beratung', 'c2@example.org')
     on conflict do nothing`,
    [otherConsultant],
  );
  await owner.$client.query(
    `insert into project_membership (project_id, staff_user_id, role) values ($1, $2, 'consultant')`,
    [werkNord, otherConsultant],
  );
}

beforeAll(async () => {
  await reset();
  for (const id of [projectLead, consultant, backOffice, admin, otherConsultant]) {
    staff[id] = await login(app, id);
  }
});
beforeEach(async () => {
  await reset();
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

const get = (path: string, as: string = projectLead) =>
  app.request(`/api/v1${path}`, { headers: staff[as]! });
const post = (path: string, body: unknown, as: string = projectLead) =>
  app.request(`/api/v1${path}`, jsonRequest("POST", body, staff[as]!));
const patch = (path: string, body: unknown, as: string = projectLead) =>
  app.request(`/api/v1${path}`, jsonRequest("PATCH", body, staff[as]!));

async function participation(
  options: { projectId?: string; wave?: string; assignTo?: string } = {},
) {
  const projectId: string = options.projectId ?? werkNord;
  const id = await call(owner.$client, "create_participation", {
    projectId,
    context: pl,
    ...(options.wave && { entryWaveId: options.wave }),
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await owner.$client.query(
    `insert into participant_identity (participation_id, project_id, personnel_number, last_name, first_name)
     values ($1, $2, $3, 'Beispiel', 'Erika')`,
    [id, projectId, `SYN-${id.slice(-8)}`],
  );
  if (options.assignTo) await assign(id, options.assignTo, projectId);
  return id;
}

const assign = (participationId: string, staffUserId: string, projectId: string = werkNord) =>
  call(owner.$client, "assign_participations", {
    projectId,
    participationIds: [participationId],
    staffUserId,
    context: pl,
  });

async function createAppointment(
  body: Record<string, unknown> = {},
  as: string = projectLead,
  projectId: string = werkNord,
) {
  const res = await post(
    `/projects/${projectId}/appointments`,
    {
      kind: "info_event",
      startsAt: hours(48),
      endsAt: hours(50),
      capacity: 2,
      title: TITLE,
      venue: VENUE,
      ...body,
    },
    as,
  );
  expect(res.status).toBe(201);
  return readJson(res, Appointment);
}

const book = (appointmentId: string, participationId: string, as: string = projectLead) =>
  post(`/appointments/${appointmentId}/bookings`, { participationId }, as);

describe("creating and changing appointments", () => {
  it("lets the PL create an info event with the defaults and the exact count", async () => {
    const event = await createAppointment();
    expect(event).toMatchObject({
      kind: "info_event",
      status: "scheduled",
      title: TITLE,
      venue: VENUE,
      version: 1,
      inUse: false,
      bookings: { scope: "all", booked: 0, availability: "available" },
      needsResolution: 0,
      capabilities: { change: true, changeHost: false, cancel: true, book: true },
    });
    expect(Date.parse(event.bookingClosesAt)).toBe(Date.parse(event.startsAt) - 24 * 3600_000);
  });

  it("lets a consultant create their own slot only; back office and org roles nothing", async () => {
    const slot = await createAppointment(
      { kind: "consultation", hostStaffUserId: consultant, capacity: 1 },
      consultant,
    );
    expect(slot.capabilities).toEqual({
      change: true,
      changeHost: false,
      cancel: true,
      book: true,
    });
    expect(slot.needsResolution).toBeNull();
    const body = {
      kind: "info_event",
      startsAt: hours(48),
      endsAt: hours(49),
      capacity: 1,
      venue: "Raum",
    };
    await expectProblem(
      await post(`/projects/${werkNord}/appointments`, body, consultant),
      403,
      "forbidden",
    );
    await expectProblem(
      await post(`/projects/${werkNord}/appointments`, body, backOffice),
      403,
      "forbidden",
    );
    await expectProblem(
      await post(
        `/projects/${werkNord}/appointments`,
        { ...body, kind: "consultation", hostStaffUserId: otherConsultant },
        consultant,
      ),
      403,
      "forbidden",
    );
    // The global admin sees the project but isn't a member: no appointments.
    await expectProblem(await get(`/projects/${werkNord}/appointments`, admin), 403, "forbidden");
  });

  it("validates the body (400) and refuses the database's codes (422)", async () => {
    const problem = await expectProblem(
      await post(`/projects/${werkNord}/appointments`, {
        kind: "consultation",
        startsAt: hours(48),
        endsAt: hours(47),
        capacity: 1,
        venue: "Raum",
      }),
      400,
      "validation-error",
    );
    expect(problem.errors!.map((e) => e.code).toSorted()).toEqual([
      "ends_before_start",
      "host_mismatch",
    ]);
    const refused = await expectProblem(
      await post(`/projects/${verwaltung}/appointments`, {
        kind: "info_event",
        startsAt: hours(48),
        endsAt: hours(49),
        capacity: 1,
        venue: "Raum",
        audienceWaveId: seedWaves[0].id,
      }),
      422,
      "domain-error",
    );
    expect(refused.errors).toEqual([
      expect.objectContaining({ code: "not_ta_tg", pointer: "/audienceWaveId" }),
    ]);
  });

  it("freezes the times of a booked appointment and checks the version", async () => {
    const event = await createAppointment();
    await book(event.id, await participation());
    const changed = await patch(`/appointments/${event.id}`, {
      expectedVersion: 1,
      venue: "Raum 3",
      capacity: 5,
    });
    expect(await readJson(changed, Appointment)).toMatchObject({
      venue: "Raum 3",
      version: 2,
      inUse: true,
    });
    await expectProblem(
      await patch(`/appointments/${event.id}`, { expectedVersion: 1, capacity: 6 }),
      409,
      "conflict",
    );
    const frozen = await expectProblem(
      await patch(`/appointments/${event.id}`, {
        expectedVersion: 2,
        startsAt: hours(60),
        endsAt: hours(61),
      }),
      422,
      "domain-error",
    );
    expect(frozen.errors![0]!.code).toBe("appointment_in_use");
  });

  it("cancels an appointment and its bookings", async () => {
    const event = await createAppointment();
    const p = await participation();
    await book(event.id, p);
    const res = await post(`/appointments/${event.id}/cancellation`, {
      reason: "too_few_bookings",
    });
    expect(await readJson(res, Appointment)).toMatchObject({
      status: "cancelled",
      cancelReason: "too_few_bookings",
      bookings: { scope: "all", booked: 0 },
      capabilities: { change: false, cancel: false, book: false },
    });
    const tab = await readJson(
      await get(`/participations/${p}/appointments`),
      ParticipationAppointments,
    );
    expect(tab.bookings).toEqual([
      expect.objectContaining({ status: "cancelled", cancelReason: "appointment_cancelled" }),
    ]);
    await expectProblem(
      await post(`/appointments/${event.id}/cancellation`, { reason: "other" }, backOffice),
      403,
      "forbidden",
    );
  });
});

describe("staff bookings (Q62, Q162)", () => {
  it("books, warns beyond an upcoming cutoff and refuses with the booking codes", async () => {
    const wave = (
      await owner.$client.query(
        `insert into project_entry_wave (project_id, code, name, signing_deadline, default_tg_start,
           default_tg_end, latest_entry_date)
         values ($1, 'SOON', 'Bald', current_date, current_date + 1, current_date + 300,
           current_date + 1) returning id`,
        [werkNord],
      )
    ).rows[0].id;
    const event = await createAppointment({ startsAt: hours(72), endsAt: hours(74), capacity: 1 });
    const res = await book(event.id, await participation({ wave }));
    expect(res.status).toBe(201);
    expect((await readJson(res, BookingResult)).warnings).toEqual([
      { code: "beyond_upcoming_cutoff", latestEntryDate: expect.any(String) },
    ]);
    const full = await expectProblem(
      await book(event.id, await participation()),
      422,
      "domain-error",
    );
    expect(full.errors![0]!.code).toBe("appointment_full");
  });

  it("names a hidden participation participation_not_found; back office may not book", async () => {
    const event = await createAppointment();
    const unassigned = await participation();
    const hidden = await expectProblem(
      await book(event.id, unassigned, consultant),
      422,
      "domain-error",
    );
    expect(hidden.errors).toEqual([
      expect.objectContaining({ code: "participation_not_found", pointer: "/participationId" }),
    ]);
    const elsewhere = await participation({ projectId: verwaltung });
    const other = await expectProblem(await book(event.id, elsewhere), 422, "domain-error");
    expect(other.errors![0]!.code).toBe("participation_not_found");
    await expectProblem(await book(event.id, unassigned, backOffice), 403, "forbidden");
    expect(
      (await book(event.id, await participation({ assignTo: consultant }), consultant)).status,
    ).toBe(201);
  });

  it("shows a consultant their own count and listable bookings, never the total", async () => {
    const event = await createAppointment({ capacity: 3 });
    const mine = await participation({ assignTo: consultant });
    await book(event.id, mine);
    await book(event.id, await participation());
    const asConsultant = await get(`/projects/${werkNord}/appointments`, consultant);
    const text = await asConsultant.clone().text();
    const page = await readJson(asConsultant, AppointmentPage);
    expect(page.items[0]!.bookings).toEqual({ scope: "own", own: 1, availability: "available" });
    expect(text).not.toMatch(/"booked":/);
    expect(page.capabilities).toEqual({
      createInfoEvent: false,
      createConsultation: true,
      chooseHost: false,
    });
    const list = await readJson(
      await get(`/appointments/${event.id}/bookings`, consultant),
      AppointmentBookingList,
    );
    expect(list.items.map((b) => b.participationId)).toEqual([mine]);
    expect(list.items[0]).toMatchObject({
      lastName: "Beispiel",
      needsResolution: null,
      capabilities: { cancel: true },
    });
    // The PL and back office see every booking and the exact count.
    for (const viewer of [projectLead, backOffice]) {
      const all = await readJson(await get(`/appointments/${event.id}`, viewer), Appointment);
      expect(all.bookings).toEqual({ scope: "all", booked: 2, availability: "available" });
      const bookings = await readJson(
        await get(`/appointments/${event.id}/bookings`, viewer),
        AppointmentBookingList,
      );
      expect(bookings.items).toHaveLength(2);
      expect(bookings.items.every((b) => b.capabilities.cancel === (viewer === projectLead))).toBe(
        true,
      );
    }
  });

  it("takes a former host's access at once and shows the PL what needs resolution", async () => {
    const slot = await createAppointment({
      kind: "consultation",
      hostStaffUserId: consultant,
      capacity: 1,
    });
    const p = await participation({ assignTo: consultant });
    await book(slot.id, p, consultant);
    await call(owner.$client, "unassign_participation", {
      participationId: p,
      staffUserId: consultant,
      context: pl,
    });
    const bookings = await readJson(
      await get(`/appointments/${slot.id}/bookings`, consultant),
      AppointmentBookingList,
    );
    expect(bookings.items).toEqual([]);
    const own = await readJson(await get(`/appointments/${slot.id}`, consultant), Appointment);
    expect(own.bookings).toEqual({ scope: "own", own: 0, availability: "full" });
    await expectProblem(
      await get(`/participations/${p}/appointments`, consultant),
      403,
      "forbidden",
    );
    const forLead = await readJson(await get(`/appointments/${slot.id}`), Appointment);
    expect(forLead.needsResolution).toBe(1);
    const leadBookings = await readJson(
      await get(`/appointments/${slot.id}/bookings`),
      AppointmentBookingList,
    );
    expect(leadBookings.items[0]!.needsResolution).toBe(true);
    // A new host who may list the booking resolves it.
    await expectProblem(
      await post(`/appointments/${slot.id}/host`, {
        expectedVersion: 1,
        hostStaffUserId: otherConsultant,
      }),
      422,
      "domain-error",
    );
    await assign(p, otherConsultant);
    await expectProblem(
      await post(
        `/appointments/${slot.id}/host`,
        { expectedVersion: 1, hostStaffUserId: otherConsultant },
        consultant,
      ),
      403,
      "forbidden",
    );
    const moved = await post(`/appointments/${slot.id}/host`, {
      expectedVersion: 1,
      hostStaffUserId: otherConsultant,
    });
    expect(await readJson(moved, Appointment)).toMatchObject({
      hostStaffUserId: otherConsultant,
      needsResolution: 0,
    });
  });

  it("cancels a booking until the start; a hidden one is not found", async () => {
    const event = await createAppointment();
    const p = await participation();
    const { bookingId } = await readJson(await book(event.id, p), BookingResult);
    expect(
      (await post(`/appointment-bookings/${bookingId}/cancellation`, {}, consultant)).status,
    ).toBe(404);
    await expectProblem(
      await post(`/appointment-bookings/${bookingId}/cancellation`, {}, backOffice),
      403,
      "forbidden",
    );
    expect((await post(`/appointment-bookings/${bookingId}/cancellation`, {})).status).toBe(204);
    const again = await expectProblem(
      await post(`/appointment-bookings/${bookingId}/cancellation`, {}),
      422,
      "domain-error",
    );
    expect(again.errors![0]!.code).toBe("booking_cancelled");
  });
});

describe('the participant tab "Termine"', () => {
  it("lists the bookings and the bookable appointments with their codes", async () => {
    const p = await participation();
    const booked = await createAppointment();
    const second = await createAppointment({ startsAt: hours(80), endsAt: hours(81) });
    const forOtherWave = await createAppointment({ audienceWaveId: seedWaves[1].id });
    const slot = await createAppointment({
      kind: "consultation",
      hostStaffUserId: projectLead,
      startsAt: hours(90),
      endsAt: hours(91),
    });
    await book(booked.id, p);
    const tab = await readJson(
      await get(`/participations/${p}/appointments`),
      ParticipationAppointments,
    );
    expect(tab.capabilities).toEqual({ book: true });
    expect(tab.bookings.map((b) => [b.appointment.id, b.status, b.capabilities.cancel])).toEqual([
      [booked.id, "booked", true],
    ]);
    expect(tab.bookable.map((b) => [b.appointment.id, b.code])).toEqual([
      [second.id, "info_event_limit"],
      [slot.id, null],
    ]);
    expect(tab.bookable.map((b) => b.appointment.id)).not.toContain(forOtherWave.id);
    const asBackOffice = await readJson(
      await get(`/participations/${p}/appointments`, backOffice),
      ParticipationAppointments,
    );
    expect(asBackOffice.capabilities).toEqual({ book: false });
    expect(asBackOffice.bookings[0]!.capabilities.cancel).toBe(false);
  });

  it("never logs a title or a venue", async () => {
    const event = await createAppointment();
    await book(event.id, await participation());
    await get(`/projects/${werkNord}/appointments`);
    expect(logs.join("\n")).not.toMatch(new RegExp(`${TITLE}|${VENUE}`));
  });
});
