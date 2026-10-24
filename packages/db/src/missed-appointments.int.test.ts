import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// The work list's missed appointments (process-and-lifecycle.md, appointment items;
// ADR-0002, the lock order), as transfer_app calls the functions: the explicit resolution and a
// consultation booked as a missed one's follow-up. Synthetic data only. Appointments are created
// in the future and moved into the past by the owner (a fixture); one time base per test.
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
/** The test's clock base, on a whole minute. */
let base = 0;
const hours = (h: number) => new Date(base + h * 3600_000).toISOString();

/** A new appointment `start` hours from now, two hours long; slots are the consultant's. */
const create = (kind: "info_event" | "consultation", start: number) =>
  call(app, "create_appointment", {
    context: pl,
    projectId: werkNord,
    id: randomUUID(),
    kind,
    hostStaffUserId: kind === "consultation" ? consultant : null,
    audienceWaveId: null,
    startsAt: hours(start),
    endsAt: hours(start + 2),
    bookingClosesAt: hours(start - 24),
    capacity: 5,
    title: null,
    venue: "Raum 1",
  });

/** Moves an appointment so it started `ago` hours ago and ended two hours later. */
const ended = (id: string, ago = 3) =>
  owner.query(
    `update appointment set starts_at = now() - $2 * interval '1 hour',
       ends_at = now() - ($2 - 2) * interval '1 hour',
       booking_closes_at = now() - ($2 + 24) * interval '1 hour'
     where id = $1`,
    [id, ago],
  );

/** A contacted participation of Werk Nord, assigned to the consultant. */
async function participation() {
  const id = await call(app, "create_participation", { projectId: werkNord, context: pl });
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  await call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

const book = (appointmentId: string, participationId: string, followUpOf?: string) =>
  call(app, "book_appointment", {
    context: pl,
    appointmentId,
    participationId,
    id: randomUUID(),
    ...(followUpOf && { followUpOf }),
  });

const absent = (appointmentId: string, participationId: string, attendance = "absent") =>
  call(app, "record_attendance", {
    context: pl,
    appointmentId,
    participationIds: [participationId],
    attendance: [attendance],
    markInformed: [false],
    informationDelivered: false,
    afterCloseReason: null,
  });

const resolve = (bookingId: string, reason = "participant_declined", context = pl) =>
  call(app, "resolve_missed_appointment", { context, bookingId, reason });

const cancel = (bookingId: string) =>
  call(app, "cancel_appointment_booking", { context: pl, bookingId });

/** A booking of the participation for an appointment that ended, recorded `absent`. */
async function missed(p: string, kind: "info_event" | "consultation" = "info_event") {
  const appointment = await create(kind, 48);
  const booking = await book(appointment, p);
  await ended(appointment);
  await absent(appointment, p);
  return { appointment, booking };
}

const bookingRow = (id: string) => one("select * from appointment_booking where id = $1", [id]);
const lastEvent = (participationId: string, type: string) =>
  one(
    `select actor_staff_user_id, reason_code, details from audit_event
     where participation_id = $1 and event_type::text = $2 order by seq desc limit 1`,
    [participationId, type],
  );

describe("resolve_missed_appointment", () => {
  it("ends a missed appointment's chain once, with the closed reason, audited", async () => {
    const p = await participation();
    const { appointment, booking } = await missed(p);
    await resolve(booking, "information_delivered_otherwise", asConsultant);
    expect(await bookingRow(booking)).toMatchObject({
      missed_resolution: "information_delivered_otherwise",
      missed_resolved_by: consultant,
    });
    expect(await lastEvent(p, "missed_appointment_resolved")).toEqual({
      actor_staff_user_id: consultant,
      reason_code: "information_delivered_otherwise",
      details: {
        bookingId: booking,
        appointmentId: appointment,
        appointmentKind: "info_event",
        startsAt: expect.any(String),
      },
    });
    await expect(resolve(booking)).rejects.toMatchObject(failsWith("already_resolved"));
  });

  it("is the PL's or the assigned consultant's, in normal mode", async () => {
    const p = await participation();
    const { booking } = await missed(p);
    await expect(resolve(booking, "no_longer_needed", asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const assisted = auditContext({
      actorType: "user",
      staffUserId: projectLead,
      onBehalfOf: p,
    });
    await expect(resolve(booking, "no_longer_needed", assisted)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await resolve(booking, "no_longer_needed");
    expect((await bookingRow(booking)).missed_resolved_by).toBe(projectLead);
  });

  it("takes the closed reasons only", async () => {
    const p = await participation();
    const { booking } = await missed(p);
    await expect(resolve(booking, "other")).rejects.toMatchObject({ code: "22P02" });
    await expect(resolve(randomUUID())).rejects.toMatchObject(failsWith("booking_not_found"));
  });

  it("only while the booking is missed: not unrecorded, attended, or with a live follow-up", async () => {
    const p = await participation();
    const appointment = await create("info_event", 48);
    const booking = await book(appointment, p);
    await ended(appointment);
    await expect(resolve(booking)).rejects.toMatchObject(failsWith("not_missed"));
    await absent(appointment, p, "attended");
    await expect(resolve(booking)).rejects.toMatchObject(failsWith("not_missed"));
    await absent(appointment, p, "absent");
    // A later info event follows it up automatically while live; cancelled, the item is back.
    const later = await book(await create("info_event", 72), p);
    await expect(resolve(booking)).rejects.toMatchObject(failsWith("not_missed"));
    await cancel(later);
    await resolve(booking);
  });

  it("not for a closed participation (no missed item remains)", async () => {
    const p = await participation();
    const { booking } = await missed(p);
    await changeStatus(app, p, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2026-10-20",
    });
    await expect(resolve(booking)).rejects.toMatchObject(failsWith("participation_closed"));
  });
});

describe("book_appointment with follow_up_of", () => {
  it("links a consultation as the follow-up of a missed one, audited with followUpOf", async () => {
    const p = await participation();
    const first = await missed(p, "consultation");
    const followUp = await book(await create("consultation", 72), p, first.booking);
    expect((await bookingRow(followUp)).follow_up_of).toBe(first.booking);
    expect((await lastEvent(p, "appointment_booked")).details).toMatchObject({
      bookingId: followUp,
      origin: "staff",
      followUpOf: first.booking,
    });
    // While the follow-up is live the missed booking is no item: nothing to resolve, no second link.
    await expect(resolve(first.booking)).rejects.toMatchObject(failsWith("not_missed"));
    const second = await create("consultation", 96);
    await expect(book(second, p, first.booking)).rejects.toMatchObject(
      failsWith("follow_up_not_missed"),
    );
    // Cancelled, the item is back and may be followed up again.
    await cancel(followUp);
    await book(second, p, first.booking);
  });

  it("writes followUpOf null without a link", async () => {
    const p = await participation();
    const booking = await book(await create("consultation", 48), p);
    expect((await bookingRow(booking)).follow_up_of).toBeNull();
    expect((await lastEvent(p, "appointment_booked")).details.followUpOf).toBeNull();
  });

  it("only for a missed consultation of the same participation, by a consultation", async () => {
    const [p, other] = [await participation(), await participation()];
    const consultation = await missed(p, "consultation");
    const event = await missed(p, "info_event");
    const otherMissed = await missed(other, "consultation");
    const slot = await create("consultation", 72);
    await expect(book(slot, p, otherMissed.booking)).rejects.toMatchObject(
      failsWith("follow_up_not_found"),
    );
    await expect(book(slot, p, randomUUID())).rejects.toMatchObject(
      failsWith("follow_up_not_found"),
    );
    await expect(book(slot, p, event.booking)).rejects.toMatchObject(
      failsWith("follow_up_kind_mismatch"),
    );
    await expect(
      book(await create("info_event", 96), p, consultation.booking),
    ).rejects.toMatchObject(failsWith("follow_up_kind_mismatch"));
    await resolve(consultation.booking);
    await expect(book(slot, p, consultation.booking)).rejects.toMatchObject(
      failsWith("follow_up_not_missed"),
    );
    // Nothing was booked by the refusals.
    expect(
      (
        await one("select count(*)::int as n from appointment_booking where appointment_id = $1", [
          slot,
        ])
      ).n,
    ).toBe(0);
  });

  it("a follow-up recorded absent is the chain's missed booking", async () => {
    const p = await participation();
    const first = await missed(p, "consultation");
    const slot = await create("consultation", 72);
    const followUp = await book(slot, p, first.booking);
    await ended(slot, 2.5);
    await absent(slot, p);
    await expect(resolve(first.booking)).rejects.toMatchObject(failsWith("not_missed"));
    await resolve(followUp, "participant_declined");
  });
});

describe("transfer_app and the resolution", () => {
  it("can't record the event type or write the columns", async () => {
    const p = await participation();
    await expect(
      call(app, "record_audit_event", {
        projectId: werkNord,
        participationId: p,
        eventType: "missed_appointment_resolved",
        context: pl,
      }),
    ).rejects.toMatchObject(failsWith("event_type_reserved"));
    await expect(
      app.query("update appointment_booking set missed_resolution = 'no_longer_needed'"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
