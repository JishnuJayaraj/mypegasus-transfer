import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// Appointments and staff bookings (process-and-lifecycle.md and data-protection.md,
// appointments; ADR-0002, the lock order), as transfer_app calls the functions. Synthetic data
// only. Times are relative to the database's clock.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const { projectLead, consultant, backOffice, admin } = seedStaffUserIds;
/** A second consultant of Werk Nord, created per test. */
const otherConsultant = "00000000-0000-4000-8000-0000000000c2";
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asOther = auditContext({ actorType: "user", staffUserId: otherConsultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const asAdmin = auditContext({ actorType: "user", staffUserId: admin });
const { werkNord, verwaltung } = seedProjectIds;
const [w1, w2] = seedWaves;

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(async () => {
  base = Math.ceil(Date.now() / 60_000) * 60_000;
  await resetTestDatabase({ seed: true, active: true, keepSessions: false });
  await owner.query(
    `insert into staff_user (id, display_name, email) values ($1, 'Clara Beratung', 'c2@example.org')`,
    [otherConsultant],
  );
  await owner.query(
    `insert into project_membership (project_id, staff_user_id, role) values ($1, $2, 'consultant')`,
    [werkNord, otherConsultant],
  );
});

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
/** The test's clock base, on a whole minute, so touching intervals touch exactly. */
let base = 0;
const hours = (h: number) => new Date(base + h * 3600_000).toISOString();

type Create = {
  context?: string;
  projectId?: string;
  kind?: "info_event" | "consultation";
  host?: string | null;
  wave?: string | null;
  start?: number;
  end?: number;
  capacity?: number;
  title?: string | null;
  venue?: string;
};

/** A new appointment `start` hours from now, `end - start` hours long. */
async function create(options: Create = {}): Promise<string> {
  const { start = 48, end = start + 2, kind = "info_event" } = options;
  return call(app, "create_appointment", {
    context: options.context ?? pl,
    projectId: options.projectId ?? werkNord,
    id: randomUUID(),
    kind,
    hostStaffUserId: options.host ?? (kind === "consultation" ? consultant : null),
    audienceWaveId: options.wave ?? null,
    startsAt: hours(start),
    endsAt: hours(end),
    bookingClosesAt: hours(start - 24),
    capacity: options.capacity ?? 2,
    title: options.title === undefined ? null : options.title,
    venue: options.venue ?? "Kantine Werk 2",
  });
}

async function participation(
  options: { projectId?: string; wave?: string; assignTo?: string } = {},
): Promise<string> {
  const projectId: string = options.projectId ?? werkNord;
  const id = await call(app, "create_participation", {
    projectId,
    context: pl,
    ...(options.wave && { entryWaveId: options.wave }),
  });
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  if (options.assignTo) await assign(id, options.assignTo, projectId);
  return id;
}

async function assign(participationId: string, staffUserId: string, projectId: string = werkNord) {
  await call(app, "assign_participations", {
    projectId,
    participationIds: [participationId],
    staffUserId,
    context: pl,
  });
}

const book = (appointmentId: string, participationId: string, context = pl, client = app) =>
  call(client, "book_appointment", {
    context,
    appointmentId,
    participationId,
    id: randomUUID(),
  });
const cancelBooking = (bookingId: string, context = pl) =>
  call(app, "cancel_appointment_booking", { context, bookingId });
const cancel = (id: string, context = pl, reason = "too_few_bookings", client = app) =>
  call<number>(client, "cancel_appointment", { context, id, reason });
const appointment = (id: string) => one("select * from appointment where id = $1", [id]);
const booking = (id: string) => one("select * from appointment_booking where id = $1", [id]);
const events = (types: string[], participationId?: string) =>
  all(
    `select event_type::text, participation_id, actor_type::text, actor_staff_user_id,
       system_job, reason_code, details
     from audit_event where event_type::text = any($1)
       and ($2::uuid is null or participation_id = $2) order by seq`,
    [types, participationId ?? null],
  );

/** Moves an appointment's times `h` hours (a fixture as the owner: e.g. into the past). */
const shift = (id: string, h: number) =>
  owner.query(
    `update appointment set starts_at = starts_at + $2 * interval '1 hour',
       ends_at = ends_at + $2 * interval '1 hour',
       booking_closes_at = booking_closes_at + $2 * interval '1 hour' where id = $1`,
    [id, h],
  );

const update = (id: string, changes: Record<string, unknown>, context = pl) =>
  appointment(id).then((a) =>
    call<number>(app, "update_appointment", {
      context,
      id,
      expectedVersion: a.version,
      startsAt: a.starts_at,
      endsAt: a.ends_at,
      bookingClosesAt: a.booking_closes_at,
      capacity: a.capacity,
      title: a.title,
      venue: a.venue,
      audienceWaveId: a.audience_wave_id,
      ...changes,
    }),
  );

describe("create_appointment", () => {
  it("creates an info event and a slot, audited without title or venue", async () => {
    const event = await create({ title: "Infoveranstaltung", wave: w1.id });
    const slot = await create({ kind: "consultation", context: asConsultant, start: 72 });
    expect(await appointment(event)).toMatchObject({
      kind: "info_event",
      status: "scheduled",
      audience_wave_id: w1.id,
      created_by: projectLead,
      version: 1,
    });
    expect((await appointment(slot)).host_staff_user_id).toBe(consultant);
    const created = await events(["appointment_created"]);
    expect(created.map((row) => [row.participation_id, row.actor_type])).toEqual([
      [null, "user"],
      [null, "user"],
    ]);
    expect(Object.keys(created[0].details).toSorted()).toEqual([
      "appointmentId",
      "audienceWaveId",
      "bookingClosesAt",
      "capacity",
      "endsAt",
      "kind",
      "startsAt",
    ]);
    expect(JSON.stringify(created)).not.toMatch(/Kantine|Infoveranstaltung/);
  });

  it("lets a consultant create their own slots only; back office and org roles nothing", async () => {
    await expect(create({ context: asConsultant })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(
      create({ kind: "consultation", context: asConsultant, host: otherConsultant }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(create({ context: asBackOffice })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(create({ context: asAdmin })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const assisted = auditContext({
      actorType: "user",
      staffUserId: projectLead,
      onBehalfOf: randomUUID(),
    });
    await expect(create({ context: assisted })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });

  it("takes only a PL or consultant of the project as host, a ta_tg wave, a future start", async () => {
    await expect(create({ kind: "consultation", host: backOffice })).rejects.toMatchObject(
      failsWith("host_not_allowed"),
    );
    await expect(create({ projectId: verwaltung, wave: w1.id })).rejects.toMatchObject(
      failsWith("not_ta_tg"),
    );
    await owner.query(
      `insert into project_entry_wave (id, project_id, code, name) values ($1, $2, 'X', 'X')`,
      ["00000000-0000-4000-b000-0000000000f1", seedProjectIds.lagerSued],
    );
    await expect(create({ wave: "00000000-0000-4000-b000-0000000000f1" })).rejects.toMatchObject(
      failsWith("wave_of_other_project"),
    );
    await expect(create({ start: -1, end: 1 })).rejects.toMatchObject(failsWith("starts_in_past"));
    await expect(create({ projectId: seedProjectIds.lagerSued })).rejects.toMatchObject(
      failsWith("project_not_active"),
    );
  });

  it("refuses what the table refuses as invalid_argument", async () => {
    for (const bad of [
      { capacity: 0 },
      { capacity: 501 },
      { start: 48, end: 48 },
      { venue: " Raum" },
      { venue: "" },
      { title: "x".repeat(101) },
      { kind: "consultation" as const, host: null, context: pl },
    ]) {
      const options: Create =
        bad.kind === "consultation"
          ? { ...bad }
          : { ...bad, kind: "info_event" as const, host: undefined };
      await expect(
        call(app, "create_appointment", {
          context: pl,
          projectId: werkNord,
          id: randomUUID(),
          kind: options.kind ?? "info_event",
          hostStaffUserId: options.host ?? null,
          audienceWaveId: null,
          startsAt: hours(options.start ?? 48),
          endsAt: hours(options.end ?? 50),
          bookingClosesAt: hours(24),
          capacity: options.capacity ?? 2,
          title: options.title ?? null,
          venue: options.venue ?? "Raum 1",
        }),
      ).rejects.toMatchObject(failsWith("invalid_argument"));
    }
  });

  it("keeps a host's slots apart, across projects; touching slots are fine", async () => {
    await create({ kind: "consultation", start: 48, end: 49 });
    await create({ kind: "consultation", start: 49, end: 50 });
    await create({ kind: "consultation", start: 47, end: 48 });
    await expect(create({ kind: "consultation", start: 48.5, end: 49.5 })).rejects.toMatchObject(
      failsWith("host_overlap"),
    );
    await expect(
      create({ kind: "consultation", projectId: verwaltung, start: 46.5, end: 47.5 }),
    ).rejects.toMatchObject(failsWith("host_overlap"));
    // Another host, or an info event, at the same time.
    await create({ kind: "consultation", host: otherConsultant, start: 48, end: 49 });
    await create({ start: 48, end: 49 });
  });
});

describe("update_appointment", () => {
  it("changes the fields with the version and audits the changed keys only", async () => {
    const id = await create();
    expect(await update(id, { capacity: 5, title: "Neu", venue: "Raum 2" })).toBe(2);
    const [changed] = await events(["appointment_changed"]);
    expect(changed.details).toEqual({
      appointmentId: id,
      version: 2,
      fields: ["capacity", "title", "venue"],
    });
    await expect(
      call(app, "update_appointment", {
        context: pl,
        id,
        expectedVersion: 1,
        startsAt: hours(48),
        endsAt: hours(50),
        bookingClosesAt: hours(24),
        capacity: 6,
        title: null,
        venue: "Raum 2",
        audienceWaveId: null,
      }),
    ).rejects.toMatchObject(failsWith("stale_version"));
    await expect(update(id, {})).rejects.toMatchObject(failsWith("appointment_unchanged"));
  });

  it("corrects title and venue with bookings present but freezes times, cutoff and audience", async () => {
    const id = await create({ capacity: 2 });
    const bookingId = await book(id, await participation());
    await update(id, { venue: "Raum 3", title: "Info" });
    expect((await booking(bookingId)).status).toBe("booked");
    const a = await appointment(id);
    await expect(update(id, { startsAt: hours(60), endsAt: hours(62) })).rejects.toMatchObject(
      failsWith("appointment_in_use"),
    );
    await expect(update(id, { bookingClosesAt: hours(40) })).rejects.toMatchObject(
      failsWith("appointment_in_use"),
    );
    await expect(update(id, { audienceWaveId: w1.id })).rejects.toMatchObject(
      failsWith("appointment_in_use"),
    );
    // A cancelled booking still counts as use (its history names these times).
    await cancelBooking(bookingId);
    await expect(update(id, { startsAt: hours(60), endsAt: hours(62) })).rejects.toMatchObject(
      failsWith("appointment_in_use"),
    );
    expect((await appointment(id)).starts_at).toEqual(a.starts_at);
  });

  it("raises capacity any time and lowers it to the live bookings at most", async () => {
    const id = await create({ capacity: 3 });
    await book(id, await participation());
    await book(id, await participation());
    await expect(update(id, { capacity: 1 })).rejects.toMatchObject(
      failsWith("capacity_below_bookings"),
    );
    await update(id, { capacity: 2 });
    await update(id, { capacity: 500 });
  });

  it("moves unused times only into the future, a slot never onto its host's other slot", async () => {
    const slot = await create({ kind: "consultation", start: 48, end: 49 });
    await create({ kind: "consultation", start: 50, end: 51 });
    await expect(
      update(slot, { startsAt: hours(50.5), endsAt: hours(51.5), bookingClosesAt: hours(30) }),
    ).rejects.toMatchObject(failsWith("host_overlap"));
    await expect(
      update(slot, { startsAt: hours(-2), endsAt: hours(-1), bookingClosesAt: hours(-3) }),
    ).rejects.toMatchObject(failsWith("starts_in_past"));
    await update(slot, { startsAt: hours(52), endsAt: hours(53), bookingClosesAt: hours(30) });
  });

  it("lets only the PL or the slot's host change it, never a cancelled one", async () => {
    const event = await create();
    const slot = await create({ kind: "consultation" });
    await expect(update(event, { capacity: 9 }, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await update(slot, { capacity: 9 }, asConsultant);
    await expect(update(slot, { capacity: 8 }, asOther)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await cancel(slot);
    await expect(update(slot, { capacity: 7 })).rejects.toMatchObject(
      failsWith("appointment_cancelled"),
    );
  });
});

const changeHost = (id: string, host: string, context = pl, version?: number) =>
  appointment(id).then((a) =>
    call<number>(app, "change_appointment_host", {
      context,
      id,
      expectedVersion: version ?? a.version,
      host,
    }),
  );

describe("change_appointment_host", () => {
  it("lets the PL move a slot to a host who may list every live booking", async () => {
    const slot = await create({ kind: "consultation" });
    const p = await participation({ assignTo: consultant });
    await book(slot, p);
    await expect(changeHost(slot, otherConsultant)).rejects.toMatchObject(
      failsWith("host_not_responsible"),
    );
    await assign(p, otherConsultant);
    expect(await changeHost(slot, otherConsultant)).toBe(2);
    const [changed] = await events(["appointment_changed"]);
    expect(changed.details).toEqual({
      appointmentId: slot,
      version: 2,
      fields: ["hostStaffUserId"],
      hostStaffUserId: otherConsultant,
    });
    // The PL may list everything.
    await changeHost(slot, projectLead);
  });

  it("is the PL's alone, for a future slot, with a free host", async () => {
    const slot = await create({ kind: "consultation", start: 48, end: 49 });
    await create({ kind: "consultation", host: otherConsultant, start: 48.5, end: 49.5 });
    await expect(changeHost(slot, otherConsultant, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(changeHost(slot, otherConsultant)).rejects.toMatchObject(
      failsWith("host_overlap"),
    );
    await expect(changeHost(slot, consultant)).rejects.toMatchObject(
      failsWith("appointment_unchanged"),
    );
    await expect(changeHost(slot, backOffice)).rejects.toMatchObject(failsWith("host_not_allowed"));
    await expect(changeHost(slot, projectLead, pl, 7)).rejects.toMatchObject(
      failsWith("stale_version"),
    );
    await expect(changeHost(await create(), consultant)).rejects.toMatchObject(
      failsWith("not_consultation"),
    );
    await shift(slot, -50);
    await expect(changeHost(slot, projectLead)).rejects.toMatchObject(
      failsWith("appointment_started"),
    );
  });
});

describe("cancel_appointment", () => {
  it("cancels every live booking with the appointment, before or after the start", async () => {
    const id = await create({ capacity: 3 });
    const [a, b, c] = [await participation(), await participation(), await participation()];
    const first = await book(id, a);
    await book(id, b);
    await cancelBooking(await book(id, c));
    expect(await cancel(id, pl, "organiser_unavailable")).toBe(2);
    expect(await appointment(id)).toMatchObject({
      status: "cancelled",
      cancel_reason: "organiser_unavailable",
      version: 2,
    });
    expect(await booking(first)).toMatchObject({
      status: "cancelled",
      cancel_reason: "appointment_cancelled",
      cancelled_by: projectLead,
    });
    const cancelled = await events(["appointment_booking_cancelled"], a);
    expect(cancelled).toEqual([
      expect.objectContaining({ reason_code: "appointment_cancelled", actor_type: "user" }),
    ]);
    const [project] = await events(["appointment_cancelled"]);
    expect(project).toMatchObject({
      participation_id: null,
      reason_code: "organiser_unavailable",
      details: { appointmentId: id, correction: false },
    });
    await expect(cancel(id)).rejects.toMatchObject(failsWith("appointment_cancelled"));
    const late = await create();
    await shift(late, -49);
    await cancel(late, pl, "did_not_take_place");
  });

  it("lets a consultant cancel their own slot, never an info event", async () => {
    await expect(cancel(await create(), asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await cancel(await create({ kind: "consultation" }), asConsultant);
  });
});

describe("book_appointment", () => {
  it("books with origin staff and records kind and start as written", async () => {
    const id = await create();
    const p = await participation();
    const bookingId = await book(id, p);
    expect(await booking(bookingId)).toMatchObject({
      status: "booked",
      origin: "staff",
      booked_by: projectLead,
      participation_id: p,
      appointment_id: id,
    });
    const a = await appointment(id);
    const [booked] = await events(["appointment_booked"], p);
    expect(booked.details).toEqual({
      bookingId,
      appointmentId: id,
      appointmentKind: "info_event",
      startsAt: new Date(a.starts_at).toISOString(),
      origin: "staff",
    });
  });

  it("lets the PL and the assigned consultant book, nobody else", async () => {
    const id = await create({ capacity: 5 });
    const assigned = await participation({ assignTo: consultant });
    await book(id, assigned, asConsultant);
    const other = await participation();
    await expect(book(id, other, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(book(id, other, asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(book(id, other, asAdmin)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    const elsewhere = await participation({ projectId: verwaltung });
    await expect(book(id, elsewhere)).rejects.toMatchObject(failsWith("participation_not_found"));
    await expect(book(randomUUID(), other)).rejects.toMatchObject(
      failsWith("appointment_not_found"),
    );
  });

  it("refuses a cancelled or started appointment and a closed participation", async () => {
    const cancelled = await create();
    await cancel(cancelled);
    const p = await participation();
    await expect(book(cancelled, p)).rejects.toMatchObject(failsWith("appointment_cancelled"));
    const started = await create();
    await shift(started, -49);
    await expect(book(started, p)).rejects.toMatchObject(failsWith("appointment_started"));
    await changeStatus(app, p, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2026-10-20",
    });
    await expect(book(await create(), p)).rejects.toMatchObject(failsWith("participation_closed"));
  });

  it("books staff after the public cutoff until the start", async () => {
    const id = await create({ start: 2 });
    const bookingId = await book(id, await participation());
    expect((await booking(bookingId)).status).toBe("booked");
  });

  it("takes an info event's audience and a slot's host rule", async () => {
    const forW2 = await create({ wave: w2.id });
    const inW1 = await participation({ wave: w1.id });
    await expect(book(forW2, inW1)).rejects.toMatchObject(failsWith("not_in_audience"));
    await book(forW2, await participation({ wave: w2.id }));
    const slot = await create({ kind: "consultation" });
    await expect(book(slot, inW1)).rejects.toMatchObject(failsWith("host_not_responsible"));
    await assign(inW1, consultant);
    await book(slot, inW1);
  });

  it("refuses a second booking, a second info event, an overlap and a full appointment", async () => {
    const p = await participation();
    const event = await create({ start: 48, end: 50, capacity: 1 });
    await book(event, p);
    await expect(book(event, p)).rejects.toMatchObject(failsWith("already_booked"));
    await expect(book(await create({ start: 72, end: 74 }), p)).rejects.toMatchObject(
      failsWith("info_event_limit"),
    );
    const slot = await create({ kind: "consultation", host: projectLead, start: 49, end: 50 });
    await expect(book(slot, p)).rejects.toMatchObject(failsWith("booking_overlap"));
    const touching = await create({ kind: "consultation", host: projectLead, start: 50, end: 51 });
    await book(touching, p);
    await expect(book(event, await participation())).rejects.toMatchObject(
      failsWith("appointment_full"),
    );
  });

  it("refuses after the wave's cutoff before informed; informed participations still book", async () => {
    const wave = await one(
      `insert into project_entry_wave (project_id, code, name, signing_deadline, default_tg_start,
         default_tg_end, latest_entry_date)
       values ($1, 'PAST', 'Vergangen', current_date - 30, current_date - 20, current_date + 300,
         current_date - 1) returning id`,
      [werkNord],
    );
    const p = await participation({ wave: wave.id });
    const id = await create({ capacity: 5 });
    await expect(book(id, p)).rejects.toMatchObject(failsWith("after_cutoff"));
    const informed = await participation({ wave: w1.id });
    await changeStatus(app, informed, { field: "status", from: "contacted", to: "informed" });
    await owner.query("update participation set entry_wave_id = $1 where id = $2", [
      wave.id,
      informed,
    ]);
    await book(id, informed);
  });
});

describe("cancel_appointment_booking", () => {
  it("cancels a live booking until the start, audited staff_cancelled", async () => {
    const id = await create();
    const p = await participation({ assignTo: consultant });
    const bookingId = await book(id, p);
    await expect(cancelBooking(bookingId, asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await cancelBooking(bookingId, asConsultant);
    expect(await booking(bookingId)).toMatchObject({
      status: "cancelled",
      cancel_reason: "staff_cancelled",
      cancelled_by: consultant,
    });
    const [cancelled] = await events(["appointment_booking_cancelled"], p);
    expect(cancelled).toMatchObject({
      reason_code: "staff_cancelled",
      actor_staff_user_id: consultant,
    });
    await expect(cancelBooking(bookingId)).rejects.toMatchObject(failsWith("booking_cancelled"));
    const started = await book(await create(), await participation());
    const { appointment_id } = await booking(started);
    await shift(appointment_id, -49);
    await expect(cancelBooking(started)).rejects.toMatchObject(failsWith("appointment_started"));
    await expect(cancelBooking(randomUUID())).rejects.toMatchObject(failsWith("booking_not_found"));
  });
});

describe("a terminal status (process-and-lifecycle.md, main status)", () => {
  it("cancels the bookings of unstarted appointments only, as the system", async () => {
    const p = await participation();
    const future = await book(await create({ capacity: 5 }), p);
    const startedSlot = await create({
      kind: "consultation",
      host: projectLead,
      start: 30,
      end: 31,
    });
    const started = await book(startedSlot, p);
    await shift(startedSlot, -31);
    await changeStatus(app, p, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2026-10-20",
    });
    expect(await booking(future)).toMatchObject({
      status: "cancelled",
      cancel_reason: "participation_closed",
      cancelled_by: null,
    });
    expect((await booking(started)).status).toBe("booked");
    expect(await events(["appointment_booking_cancelled"], p)).toEqual([
      expect.objectContaining({
        actor_type: "system",
        system_job: "terminal-booking-cancellation",
        reason_code: "participation_closed",
      }),
    ]);
  });
});

/** A live staff session of the user, through its function. */
const session = async (staffUserId: string) => {
  const tokenHash = randomBytes(32).toString("hex");
  await call(app, "start_staff_session", {
    staffUserId,
    tokenHash,
    method: "dev",
    oidcIssuer: null,
    oidcSubject: null,
    supersededTokenHash: null,
    requestId: "req-login",
  });
  return tokenHash;
};

describe("the audit trail", () => {
  it("refuses the new event types through record_audit_event", async () => {
    for (const type of [
      "appointment_created",
      "appointment_changed",
      "appointment_cancelled",
      "appointment_booked",
      "appointment_booking_cancelled",
    ]) {
      await expect(
        call(app, "record_audit_event", {
          projectId: werkNord,
          participationId: null,
          eventType: type,
          context: pl,
        }),
      ).rejects.toMatchObject(failsWith("event_type_reserved"));
    }
  });

  it("shows booking rows to the PL and the assigned consultant, not to back office", async () => {
    const p = await participation({ assignTo: consultant });
    await cancelBooking(await book(await create({ title: "Geheim", venue: "Raum 9" }), p));
    const rows = async (staffUserId: string) =>
      (
        await app.query("select * from audit_history($1, $2, null, 100, 'req-history')", [
          await session(staffUserId),
          p,
        ])
      ).rows.filter((row) => row.event_type.startsWith("appointment_"));
    for (const viewer of [projectLead, consultant]) {
      const shown = await rows(viewer);
      expect(shown.map((row) => row.event_type)).toEqual([
        "appointment_booking_cancelled",
        "appointment_booked",
      ]);
      expect(shown[0]).toMatchObject({ reason_code: "staff_cancelled" });
      expect(Object.keys(shown[1].details).toSorted()).toEqual([
        "appointmentId",
        "appointmentKind",
        "origin",
        "startsAt",
      ]);
    }
    expect(await rows(backOffice)).toEqual([]);
    const details = await all("select details from audit_event");
    expect(JSON.stringify(details)).not.toMatch(/Geheim|Raum 9/);
  });
});

/** Each outcome: "ok" or the refusal code. */
const settle = (promises: Promise<unknown>[]) =>
  Promise.allSettled(promises).then((results) =>
    results.map((result) =>
      result.status === "fulfilled" ? "ok" : (result.reason as { message: string }).message,
    ),
  );

// The lock order (ADR-0002, appointments): races between connections, each its own transaction.
describe("concurrency", () => {
  const clients: Client[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const client = new Client({ connectionString: urls.app });
      await client.connect();
      clients.push(client);
    }
  });
  afterAll(() => Promise.all(clients.map((client) => client.end())));
  const [c1, c2, c3] = [0, 1, 2].map((i) => ({
    query: (text: string, values?: unknown[]) => clients[i]!.query(text, values),
  }));

  it("gives the last seat to one of two racing bookings", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await create({ capacity: 1, start: 48 + round * 3 });
      const [a, b] = [await participation(), await participation()];
      const outcomes = await settle([book(id, a, pl, c1 as never), book(id, b, pl, c2 as never)]);
      expect(outcomes.toSorted()).toEqual(["appointment_full", "ok"]);
      const live = await one(
        "select count(*)::int as n from appointment_booking where appointment_id = $1 and status = 'booked'",
        [id],
      );
      expect(live.n).toBe(1);
    }
  });

  it("books one participation once when the same booking races", async () => {
    const id = await create({ capacity: 5 });
    const p = await participation();
    const outcomes = await settle([book(id, p, pl, c1 as never), book(id, p, pl, c2 as never)]);
    expect(outcomes.toSorted()).toEqual(["already_booked", "ok"]);
  });

  it("runs booking, appointment cancellation and a terminal transition together without deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await create({ capacity: 5, start: 48 + round * 3 });
      const [stays, leaves, joins] = [
        await participation(),
        await participation(),
        await participation(),
      ];
      await book(id, stays);
      await book(id, leaves);
      const outcomes = await settle([
        book(id, joins, pl, c1 as never),
        cancel(id, pl, "too_few_bookings", c2 as never),
        changeStatus(c3 as never, leaves, {
          field: "status",
          from: "contacted",
          to: "withdrawn",
          endReason: "no_response",
          effectiveDate: "2026-10-20",
        }),
      ]);
      // The cancellation and the withdrawal always succeed; the booking either came first (and
      // was cancelled with the appointment) or is refused on the cancelled appointment.
      expect(outcomes[1]).toBe("ok");
      expect(outcomes[2]).toBe("ok");
      expect(["ok", "appointment_cancelled"]).toContain(outcomes[0]);
      const live = await one(
        "select count(*)::int as n from appointment_booking where appointment_id = $1 and status = 'booked'",
        [id],
      );
      expect(live.n).toBe(0);
      const left = await all(
        "select cancel_reason::text from appointment_booking where participation_id = $1",
        [leaves],
      );
      expect(["appointment_cancelled", "participation_closed"]).toContain(left[0].cancel_reason);
    }
  });
});
