import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  nightly,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// Attendance and `informed` (process-and-lifecycle.md and data-protection.md, appointments:
// attendance; ADR-0002, the lock order), as transfer_app calls the functions. Synthetic data
// only. Times are relative to the database's clock: an appointment is created in the future and
// moved into the past by the owner (a fixture), as attendance is recorded after the fact.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { werkNord } = seedProjectIds;

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(async () => {
  base = Math.ceil(Date.now() / 60_000) * 60_000;
  await resetTestDatabase({ seed: true, active: true, keepSessions: false });
});

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
/** The test's clock base, on a whole minute. */
let base = 0;
const hours = (h: number) => new Date(base + h * 3600_000).toISOString();

/** A new appointment 48 hours from now, two hours long. */
async function create(
  options: { kind?: "info_event" | "consultation"; start?: number; capacity?: number } = {},
) {
  const { kind = "info_event", start = 48 } = options;
  return call(app, "create_appointment", {
    context: pl,
    projectId: werkNord,
    id: randomUUID(),
    kind,
    hostStaffUserId: kind === "consultation" ? consultant : null,
    audienceWaveId: null,
    startsAt: hours(start),
    endsAt: hours(start + 2),
    bookingClosesAt: hours(start - 24),
    capacity: options.capacity ?? 5,
    title: "Infoveranstaltung",
    venue: "Kantine Werk 2",
  });
}

/** Moves an appointment so it started `h` hours ago (it ends two hours after its start). */
const startedAgo = (id: string, h: number) =>
  owner.query(
    `update appointment set starts_at = now() - $2 * interval '1 hour',
       ends_at = now() - ($2 - 2) * interval '1 hour',
       booking_closes_at = now() - ($2 + 24) * interval '1 hour' where id = $1`,
    [id, h],
  );

/** A participation of Werk Nord in `status` (`imported`, `contacted` or `unreachable`). */
async function participation(
  options: { status?: "imported" | "contacted" | "unreachable"; wave?: string } = {},
) {
  const { status = "contacted" } = options;
  const id = await call(app, "create_participation", {
    projectId: werkNord,
    context: pl,
    ...(options.wave && { entryWaveId: options.wave }),
  });
  if (status !== "imported") {
    await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  }
  if (status === "unreachable") {
    await changeStatus(app, id, { field: "status", from: "contacted", to: "unreachable" });
  }
  await call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

const book = (appointmentId: string, participationId: string, client: unknown = app) =>
  call(client as Client, "book_appointment", {
    context: pl,
    appointmentId,
    participationId,
    id: randomUUID(),
  });

type Entry = { participationId: string; attendance: "attended" | "absent"; markInformed?: boolean };

const record = (
  appointmentId: string,
  entries: Entry[],
  options: { context?: string; delivered?: boolean; reason?: string; client?: unknown } = {},
) =>
  call<{ recorded: number; informed: number; statusChanges: number }>(
    (options.client as Client) ?? app,
    "record_attendance",
    {
      context: options.context ?? pl,
      appointmentId,
      participationIds: entries.map((e) => e.participationId),
      attendance: entries.map((e) => e.attendance),
      markInformed: entries.map((e) => e.markInformed ?? false),
      informationDelivered: options.delivered ?? false,
      afterCloseReason: options.reason ?? null,
    },
  );

const confirm = (bookingId: string, context = pl) =>
  call<number>(app, "confirm_information_delivered", {
    context,
    bookingId,
    informationDelivered: true,
  });
const escalate = (bookingId: string, context = pl) =>
  call(app, "escalate_attendance_conflict", { context, bookingId });
const attest = (bookingId: string, context = pl) =>
  call(app, "resolve_attendance_conflict", {
    context,
    bookingId,
    resolution: "information_delivered_otherwise",
  });

const status = async (id: string) =>
  (await one("select status::text from participation where id = $1", [id])).status;
const bookingOf = (appointmentId: string, participationId: string) =>
  one(
    `select * from appointment_booking where appointment_id = $1 and participation_id = $2
     order by booked_at desc limit 1`,
    [appointmentId, participationId],
  );
const events = (participationId: string) =>
  all(
    `select event_type::text, actor_type::text, actor_staff_user_id, from_value, to_value,
       reason_code, details
     from audit_event where participation_id = $1
       and event_type::text in ('status_changed', 'attendance_recorded', 'attendance_superseded',
         'information_delivery_confirmed', 'attendance_conflict_escalated',
         'attendance_conflict_resolved', 'appointment_booked', 'appointment_booking_cancelled')
     order by seq`,
    [participationId],
  );
const conflictOpen = async (bookingId: string) =>
  (
    await one(
      `select informed_basis_at is not null and attendance = 'absent'
         and conflict_resolution is null as open from appointment_booking where id = $1`,
      [bookingId],
    )
  ).open;

/** A started info event with live bookings of the participations. */
async function startedEvent(participations: string[], startedHoursAgo = 1) {
  const id = await create({ capacity: Math.max(participations.length, 1) + 3 });
  for (const p of participations) await book(id, p);
  await startedAgo(id, startedHoursAgo);
  return id;
}

describe("record_attendance", () => {
  it("records attendance and walk-ins, and informs the ticked rows along the manual edges", async () => {
    const [contacted, imported, absent] = [
      await participation(),
      await participation({ status: "imported" }),
      await participation(),
    ];
    const walkIn = await participation({ status: "unreachable" });
    const event = await startedEvent([contacted, imported, absent], 3);
    const result = await record(
      event,
      [
        { participationId: contacted, attendance: "attended", markInformed: true },
        { participationId: imported, attendance: "attended", markInformed: true },
        { participationId: absent, attendance: "absent" },
        { participationId: walkIn, attendance: "attended", markInformed: true },
      ],
      { delivered: true },
    );
    expect(result).toEqual({ recorded: 4, informed: 3, statusChanges: 5 });
    for (const p of [contacted, imported, walkIn]) expect(await status(p)).toBe("informed");
    expect(await status(absent)).toBe("contacted");
    expect(await bookingOf(event, walkIn)).toMatchObject({
      origin: "walk_in",
      booked_by: projectLead,
      attendance: "attended",
      attendance_recorded_by: projectLead,
      informed_basis_by: projectLead,
    });
    expect((await bookingOf(event, absent)).informed_basis_at).toBeNull();
    const imp = await events(imported);
    expect(imp.slice(-4).map((e) => [e.event_type, e.from_value, e.to_value])).toEqual([
      ["attendance_recorded", null, null],
      ["information_delivery_confirmed", null, null],
      ["status_changed", "imported", "contacted"],
      ["status_changed", "contacted", "informed"],
    ]);
    expect(imp.at(-1)).toMatchObject({ actor_type: "user", actor_staff_user_id: projectLead });
    expect(imp.at(-4).details).toMatchObject({
      appointmentId: event,
      appointmentKind: "info_event",
      attendance: "attended",
      previousAttendance: null,
      afterClose: false,
    });
    expect(imp.at(-3).details).toMatchObject({ statusChanged: true });
    const walked = await events(walkIn);
    expect(walked.slice(-5).map((e) => [e.event_type, e.to_value])).toEqual([
      ["appointment_booked", null],
      ["attendance_recorded", null],
      ["information_delivery_confirmed", null],
      ["status_changed", "contacted"],
      ["status_changed", "informed"],
    ]);
    expect(walked.find((e) => e.event_type === "appointment_booked").details.origin).toBe(
      "walk_in",
    );
    expect(JSON.stringify(await all("select details from audit_event"))).not.toMatch(
      /Kantine|Infoveranstaltung/,
    );
  });

  it("refuses a ticked row without the delivery confirmation", async () => {
    const p = await participation();
    const event = await startedEvent([p]);
    await expect(
      record(event, [{ participationId: p, attendance: "attended", markInformed: true }]),
    ).rejects.toMatchObject(failsWith("information_delivery_unconfirmed"));
    expect((await bookingOf(event, p)).attendance).toBeNull();
  });

  it("records nothing and changes no status when one row is refused", async () => {
    const [first, second] = [await participation(), await participation()];
    // Started an hour ago: `absent` only after the end.
    const event = await startedEvent([first, second]);
    await expect(
      record(
        event,
        [
          { participationId: first, attendance: "attended", markInformed: true },
          { participationId: second, attendance: "absent" },
        ],
        { delivered: true },
      ),
    ).rejects.toMatchObject(failsWith("appointment_not_ended"));
    expect(await status(first)).toBe("contacted");
    expect((await bookingOf(event, first)).attendance).toBeNull();
    expect((await events(first)).map((e) => e.event_type)).not.toContain("attendance_recorded");
  });

  it("refuses an `unreachable` attendee after the cutoff `before_cutoff`", async () => {
    const wave = (
      await one(
        `insert into project_entry_wave (project_id, code, name, latest_entry_date)
         values ($1, 'T9', 'T9', current_date + 30) returning id`,
        [werkNord],
      )
    ).id;
    const p = await participation({ status: "unreachable", wave });
    const event = await startedEvent([p]);
    await owner.query(
      `update project_entry_wave set latest_entry_date = current_date - 1 where id = $1`,
      [wave],
    );
    await expect(
      record(event, [{ participationId: p, attendance: "attended", markInformed: true }], {
        delivered: true,
      }),
    ).rejects.toMatchObject(failsWith("before_cutoff"));
    expect(await status(p)).toBe("unreachable");
    // Recording what happened, without the tick, still works.
    await record(event, [{ participationId: p, attendance: "attended" }]);
    expect(await status(p)).toBe("unreachable");
  });

  it("checks timing, permission and each row's rule", async () => {
    const [p, q] = [await participation(), await participation()];
    const event = await create();
    await book(event, p);
    await expect(
      record(event, [{ participationId: p, attendance: "attended" }]),
    ).rejects.toMatchObject(failsWith("appointment_not_started"));
    await startedAgo(event, 3);
    await expect(
      record(event, [{ participationId: p, attendance: "attended" }], { context: asBackOffice }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(
      record(event, [{ participationId: q, attendance: "absent" }]),
    ).rejects.toMatchObject(failsWith("not_booked"));
    await record(event, [{ participationId: p, attendance: "attended" }], {
      context: asConsultant,
    });
    await expect(
      record(event, [{ participationId: p, attendance: "attended" }]),
    ).rejects.toMatchObject(failsWith("attendance_unchanged"));
    await expect(
      record(event, [{ participationId: p, attendance: "absent", markInformed: true }], {
        delivered: true,
      }),
    ).rejects.toMatchObject(failsWith("mark_informed_not_allowed"));
    await expect(
      record(event, [{ participationId: randomUUID(), attendance: "attended" }]),
    ).rejects.toMatchObject(failsWith("participation_not_found"));
    await expect(
      record(event, [
        { participationId: p, attendance: "absent" },
        { participationId: p, attendance: "absent" },
      ]),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });

  it("takes a consultation's walk-in only when its host may list them", async () => {
    const slot = await create({ kind: "consultation", capacity: 1 });
    await startedAgo(slot, 3);
    const unassigned = await call(app, "create_participation", {
      projectId: werkNord,
      context: pl,
    });
    await expect(
      record(slot, [{ participationId: unassigned, attendance: "attended" }]),
    ).rejects.toMatchObject(failsWith("host_not_responsible"));
    await record(slot, [{ participationId: await participation(), attendance: "attended" }]);
  });
});

describe("corrections (the required scenarios)", () => {
  it("corrects `absent` to `attended`, then informs through the separate action", async () => {
    const p = await participation();
    const event = await startedEvent([p], 3);
    await record(event, [{ participationId: p, attendance: "absent" }]);
    // A correction never changes a status, so it takes no tick.
    await expect(
      record(event, [{ participationId: p, attendance: "attended", markInformed: true }], {
        delivered: true,
      }),
    ).rejects.toMatchObject(failsWith("mark_informed_not_allowed"));
    await record(event, [{ participationId: p, attendance: "attended" }], {
      context: asConsultant,
    });
    expect(await status(p)).toBe("contacted");
    const booking = await bookingOf(event, p);
    expect(await confirm(booking.id, asConsultant)).toBe(1);
    expect(await status(p)).toBe("informed");
    await expect(confirm(booking.id)).rejects.toMatchObject(failsWith("already_basis"));
    const recorded = (await events(p)).filter((e) => e.event_type === "attendance_recorded");
    expect(recorded.map((e) => [e.details.previousAttendance, e.details.attendance])).toEqual([
      [null, "absent"],
      ["absent", "attended"],
    ]);
  });

  it("leaves the status when the basis is corrected to `absent`; a replacement basis clears the conflict", async () => {
    const p = await participation();
    const first = await startedEvent([p], 30);
    await record(first, [{ participationId: p, attendance: "attended", markInformed: true }], {
      delivered: true,
    });
    const basis = (await bookingOf(first, p)).id;
    await record(first, [{ participationId: p, attendance: "absent" }]);
    expect(await status(p)).toBe("informed");
    expect(await conflictOpen(basis)).toBe(true);
    // `escalated` is a handling state: the conflict stays open.
    await expect(escalate(basis, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await escalate(basis);
    await expect(escalate(basis)).rejects.toMatchObject(failsWith("already_escalated"));
    expect(await conflictOpen(basis)).toBe(true);
    // Another attended appointment of the participation becomes the basis, without a status change.
    const second = await startedEvent([p], 3);
    await record(second, [{ participationId: p, attendance: "attended" }]);
    const replacement = (await bookingOf(second, p)).id;
    expect(await confirm(replacement, asConsultant)).toBe(0);
    expect(await conflictOpen(basis)).toBe(false);
    expect(await one("select * from appointment_booking where id = $1", [basis])).toMatchObject({
      conflict_resolution: "replacement_basis",
      conflict_resolved_by: consultant,
      conflict_escalated_by: projectLead,
    });
    const [confirmed, resolved] = (await events(p)).slice(-2);
    expect(confirmed).toMatchObject({
      event_type: "information_delivery_confirmed",
      details: expect.objectContaining({ appointmentId: second, statusChanged: false }),
    });
    expect(resolved).toMatchObject({
      event_type: "attendance_conflict_resolved",
      reason_code: "replacement_basis",
      details: expect.objectContaining({ appointmentId: first, basisBookingId: replacement }),
    });
  });

  it("keeps an unresolved conflict after the close, for the PL's attestation there", async () => {
    const p = await participation();
    const event = await startedEvent([p], 30);
    await record(event, [{ participationId: p, attendance: "attended", markInformed: true }], {
      delivered: true,
    });
    const basis = (await bookingOf(event, p)).id;
    await record(event, [{ participationId: p, attendance: "absent" }]);
    await changeStatus(app, p, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "declined_dsv",
      effectiveDate: "2026-10-20",
    });
    expect(await conflictOpen(basis)).toBe(true);
    await expect(attest(basis, asConsultant)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await attest(basis);
    expect(await conflictOpen(basis)).toBe(false);
    await expect(attest(basis)).rejects.toMatchObject(failsWith("no_conflict"));
    expect((await events(p)).at(-1)).toMatchObject({
      event_type: "attendance_conflict_resolved",
      reason_code: "information_delivered_otherwise",
    });
    expect(await status(p)).toBe("withdrawn");
  });
});

describe("the closed-case flow (the required scenario)", () => {
  it("takes last-day attendance after the cutoff withdrawal from the PL with `late_entry`, never the consultant", async () => {
    const p = await participation();
    const event = await startedEvent([p], 20);
    await changeStatus(app, p, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      context: nightly,
      endReason: "not_informed",
      effectiveDate: "2026-10-20",
    });
    expect((await bookingOf(event, p)).status).toBe("booked");
    const attended = [{ participationId: p, attendance: "attended" as const }];
    await expect(
      record(event, attended, { context: asConsultant, reason: "late_entry" }),
    ).rejects.toMatchObject(failsWith("participation_closed"));
    await expect(record(event, attended)).rejects.toMatchObject(
      failsWith("after_close_reason_required"),
    );
    await expect(
      record(event, [{ ...attended[0]!, markInformed: true }], {
        delivered: true,
        reason: "late_entry",
      }),
    ).rejects.toMatchObject(failsWith("mark_informed_not_allowed"));
    expect(await record(event, attended, { reason: "late_entry" })).toEqual({
      recorded: 1,
      informed: 0,
      statusChanges: 0,
    });
    expect(await status(p)).toBe("withdrawn");
    expect(await bookingOf(event, p)).toMatchObject({
      attendance: "attended",
      after_close_reason: "late_entry",
    });
    expect((await events(p)).at(-1)).toMatchObject({
      event_type: "attendance_recorded",
      reason_code: "late_entry",
      details: expect.objectContaining({ afterClose: true }),
    });
    // Never "Als informiert erfassen" after the close.
    await expect(confirm((await bookingOf(event, p)).id)).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });

  it("refuses a walk-in of a closed participation", async () => {
    const p = await participation();
    const event = await startedEvent([], 3);
    await changeStatus(app, p, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2026-10-20",
    });
    await expect(
      record(event, [{ participationId: p, attendance: "attended" }], { reason: "late_entry" }),
    ).rejects.toMatchObject(failsWith("participation_closed"));
  });
});

describe("the PL's `did_not_take_place` correction (the required scenario)", () => {
  it("supersedes absences only, keeps them in the history, and is refused by one `attended`", async () => {
    const [p, q] = [await participation(), await participation()];
    const event = await startedEvent([p, q], 3);
    await record(event, [
      { participationId: p, attendance: "absent" },
      { participationId: q, attendance: "absent" },
    ]);
    const cancel = (reason: string, context = pl) =>
      call<number>(app, "cancel_appointment", { context, id: event, reason });
    await expect(cancel("too_few_bookings")).rejects.toMatchObject(
      failsWith("attendance_recorded"),
    );
    expect(await cancel("did_not_take_place")).toBe(2);
    expect(await bookingOf(event, p)).toMatchObject({
      status: "cancelled",
      cancel_reason: "appointment_cancelled",
      attendance: "absent",
      attendance_superseded_by: projectLead,
    });
    expect((await events(p)).slice(-2).map((e) => e.event_type)).toEqual([
      "attendance_superseded",
      "appointment_booking_cancelled",
    ]);
    expect(
      await one(
        `select reason_code, details from audit_event where event_type = 'appointment_cancelled'`,
      ),
    ).toMatchObject({ reason_code: "did_not_take_place", details: { correction: true } });

    const other = await startedEvent([p, q], 3);
    await record(other, [
      { participationId: p, attendance: "absent" },
      { participationId: q, attendance: "attended" },
    ]);
    await expect(
      call(app, "cancel_appointment", { context: pl, id: other, reason: "did_not_take_place" }),
    ).rejects.toMatchObject(failsWith("attendance_recorded"));
    const booked = (await bookingOf(other, q)).id;
    await expect(
      call(app, "cancel_appointment_booking", { context: pl, bookingId: booked }),
    ).rejects.toMatchObject(failsWith("attendance_recorded"));
  });

  it("leaves the correction to the PL, not the host of a slot", async () => {
    const p = await participation();
    const slot = await create({ kind: "consultation", capacity: 1 });
    await book(slot, p);
    await startedAgo(slot, 3);
    await record(slot, [{ participationId: p, attendance: "absent" }], { context: asConsultant });
    await expect(
      call(app, "cancel_appointment", {
        context: asConsultant,
        id: slot,
        reason: "did_not_take_place",
      }),
    ).rejects.toMatchObject(failsWith("attendance_recorded"));
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
      "attendance_recorded",
      "attendance_superseded",
      "information_delivery_confirmed",
      "attendance_conflict_escalated",
      "attendance_conflict_resolved",
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

  it("shows attendance rows to the PL and the assigned consultant, not to back office", async () => {
    const p = await participation();
    const event = await startedEvent([p], 3);
    await record(event, [{ participationId: p, attendance: "attended", markInformed: true }], {
      delivered: true,
    });
    const rows = async (staffUserId: string) =>
      (
        await app.query("select * from audit_history($1, $2, null, 100, 'req-history')", [
          await session(staffUserId),
          p,
        ])
      ).rows
        .filter((row) =>
          ["attendance_recorded", "information_delivery_confirmed"].includes(row.event_type),
        )
        .map((row) => [row.event_type, Object.keys(row.details).toSorted()]);
    for (const viewer of [projectLead, consultant]) {
      expect(await rows(viewer)).toEqual([
        [
          "information_delivery_confirmed",
          ["appointmentId", "appointmentKind", "startsAt", "statusChanged"],
        ],
        [
          "attendance_recorded",
          [
            "afterClose",
            "appointmentId",
            "appointmentKind",
            "attendance",
            "previousAttendance",
            "startsAt",
          ],
        ],
      ]);
    }
    expect(await rows(backOffice)).toEqual([]);
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

  it("runs the bulk recording, a booking and a terminal transition together without deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const [stays, leaves, joins] = [
        await participation(),
        await participation(),
        await participation(),
      ];
      const event = await startedEvent([stays, leaves], 3);
      const later = await create({ start: 48 + round * 3 });
      const outcomes = await settle([
        record(
          event,
          [
            { participationId: stays, attendance: "attended", markInformed: true },
            { participationId: leaves, attendance: "attended", markInformed: true },
          ],
          { delivered: true, client: clients[0] },
        ),
        book(later, joins, clients[1]),
        changeStatus(clients[2]!, leaves, {
          field: "status",
          from: "contacted",
          to: "withdrawn",
          endReason: "no_response",
          effectiveDate: "2026-10-20",
        }),
      ]);
      // Either the recording came first (and the withdrawal finds `informed`), or the withdrawal
      // did (and the recording's row of the closed participation is refused): never a deadlock.
      expect(outcomes[1]).toBe("ok");
      expect([
        ["ok", "stale_status"],
        ["after_close_reason_required", "ok"],
      ]).toContainEqual([outcomes[0], outcomes[2]]);
      const informed = await status(stays);
      expect(informed).toBe(outcomes[0] === "ok" ? "informed" : "contacted");
    }
  });
});
