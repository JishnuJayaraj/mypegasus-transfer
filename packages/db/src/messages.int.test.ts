import { randomBytes, randomUUID } from "node:crypto";
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

// Invitations, the organizer's notices, the participant's own booking and a notice's follow-up
// (data-protection.md, messages and appointments: the portal; ADR-0002, the lock order), as
// transfer_app calls the functions. Synthetic data only. Times are relative to the database's
// clock, on one base per test.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = () => randomBytes(32).toString("hex");
const { werkNord, verwaltung } = seedProjectIds;
const { consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const asParticipant = (participationId: string) =>
  auditContext({ actorType: "participant", participationId, requestId: "req-portal" });

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(async () => {
  base = Math.ceil(Date.now() / 60_000) * 60_000;
  await resetTestDatabase({ seed: true, active: true, keepSessions: false });
});

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
let base = 0;
const hours = (h: number) => new Date(base + h * 3600_000).toISOString();

let addresses = 0;

/** A participation of Werk Nord without an account (no channel), `contacted`. */
async function participation(projectId: string = werkNord) {
  const id = await call(app, "create_participation", { projectId, context: pl });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', '1970-01-01')`,
    [id, projectId, `SYN-${id.slice(-8)}`],
  );
  await owner.query(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE')`,
    [id, projectId],
  );
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  return id;
}

/** An activated participant (consent v2, one email channel, a live session), `contacted`. */
async function activated(projectId: string = werkNord) {
  const participationId = await participation(projectId);
  const codeHash = hex();
  await call(app, "issue_activation_code", {
    participationId,
    codeHash,
    channel: "letter",
    language: "de",
    noticeVersion: "art14-activation:v1",
    replaceOpenCode: false,
    deliveryKind: null,
    deliveryAddressHash: null,
    identityChecked: false,
    context: pl,
    id: randomUUID(),
    purpose: "activation",
  });
  const tokenHash = hex();
  await call(app, "start_activation", { codeHash, tokenHash, requestId: "req-1" });
  await call(app, "check_activation_birth_date", {
    tokenHash,
    birthDate: "1970-01-01",
    requestId: "req-2",
  });
  const oneTimeCodeHash = hex();
  await call(app, "create_one_time_code", {
    tokenHash,
    kind: "email",
    address: `person-${++addresses}@example.invalid`,
    codeHash: oneTimeCodeHash,
    id: randomUUID(),
  });
  const active = hex();
  await call(app, "complete_activation", {
    tokenHash,
    newTokenHash: active,
    noticeVersion: "art14-activation:v1",
    consentVersion: "portal-contact-consent:v2",
    language: "en",
    channelId: randomUUID(),
    consentId: randomUUID(),
    requestId: "req-3",
    oneTimeCodeHash,
  });
  const channel = await one(
    "select id, consent_id from participant_channel where participation_id = $1",
    [participationId],
  );
  return {
    participationId,
    tokenHash: active,
    channelId: channel.id,
    consentId: channel.consent_id,
  };
}

/** A new appointment `start` hours from now, two hours long, its public cutoff a day before. */
async function create(
  options: { start?: number; kind?: "info_event" | "consultation"; capacity?: number } = {},
) {
  const { start = 48, kind = "info_event" } = options;
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
    title: null,
    venue: "Kantine Werk 2",
  });
}

const assign = (participationId: string, staffUserId = consultant) =>
  call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [participationId],
    staffUserId,
    context: pl,
  });
const unassign = (participationId: string) =>
  call(app, "unassign_participation", { participationId, staffUserId: consultant, context: pl });
const book = (appointmentId: string, participationId: string, context = pl, client = app) =>
  call(client, "book_appointment", { context, appointmentId, participationId, id: randomUUID() });
const bookAsParticipant = (
  appointmentId: string,
  participant: { participationId: string; tokenHash: string },
  client = app,
) =>
  call(client, "book_appointment", {
    context: asParticipant(participant.participationId),
    appointmentId,
    participationId: participant.participationId,
    id: randomUUID(),
    tokenHash: participant.tokenHash,
  });
const cancelBooking = (bookingId: string, context = pl) =>
  call(app, "cancel_appointment_booking", { context, bookingId });
const cancel = (id: string, reason = "too_few_bookings", client = app) =>
  call<number>(client, "cancel_appointment", { context: pl, id, reason });

type Row = {
  participation_id: string;
  reminder_id: string | null;
  channel_kind: string | null;
  not_deliverable: string | null;
  skip: string | null;
};
async function invite(appointmentId: string, ids: string[], context = pl) {
  const { rows } = await app.query<Row>(
    `select * from request_invitations(p_context => $1, p_appointment_id => $2,
       p_participation_ids => $3::uuid[], p_batch_id => $4)`,
    [context, appointmentId, ids, randomUUID()],
  );
  return rows;
}
const invited = async (appointmentId: string, participationId: string, context = pl) =>
  (await invite(appointmentId, [participationId], context))[0]!;
const claim = (reminderId: string, client = app) =>
  call(client, "claim_reminder_dispatch", { reminderId, hasActions: true, jobId: "job-1" });
const outcome = (reminderId: string, value: string) =>
  call<boolean>(app, "record_reminder_outcome", {
    reminderId,
    outcome: value,
    cancelReason: null,
    jobId: "job-1",
  });
const message = (id: string) => one("select * from participant_reminder where id = $1", [id]);
const notices = (appointmentId: string) =>
  all(
    `select r.*, r.kind::text as kind, r.status::text as status, r.cancel_reason::text as reason
     from participant_reminder r
     where appointment_id = $1 and kind::text <> 'appointment_invitation'
     order by participation_id`,
    [appointmentId],
  );
const events = (participationId: string, types: string[]) =>
  all(
    `select event_type::text, actor_type::text, actor_staff_user_id, actor_participation_id,
       system_job, reason_code, details
     from audit_event where participation_id = $1 and event_type::text = any($2) order by seq`,
    [participationId, types],
  );
const bookingOf = (appointmentId: string, participationId: string) =>
  one(
    `select * from appointment_booking where appointment_id = $1 and participation_id = $2
     order by booked_at desc limit 1`,
    [appointmentId, participationId],
  );
const removeChannel = (channelId: string) =>
  owner.query(
    "update participant_channel set removed_at = now(), removed_reason = 'consent_revoked' where id = $1",
    [channelId],
  );
const restoreChannel = (channelId: string) =>
  owner.query(
    "update participant_channel set removed_at = null, removed_reason = null where id = $1",
    [channelId],
  );
/** Moves an appointment's times `h` hours (a fixture as the owner: e.g. into the past). */
const shift = (id: string, h: number) =>
  owner.query(
    `update appointment set starts_at = starts_at + $2 * interval '1 hour',
       ends_at = ends_at + $2 * interval '1 hour',
       booking_closes_at = booking_closes_at + $2 * interval '1 hour' where id = $1`,
    [id, h],
  );

describe("request_invitations", () => {
  it("queues an invitation per participation, also without a usable channel", async () => {
    const reachable = await activated();
    const withoutChannel = await participation();
    const v1 = await activated();
    await owner.query(
      "update consent_record set text_version = 'portal-contact-consent:v1' where id = $1",
      [v1.consentId],
    );
    const id = await create();
    const rows = await invite(id, [reachable.participationId, withoutChannel, v1.participationId]);
    expect(
      rows.map(({ channel_kind, not_deliverable, skip }) => [channel_kind, not_deliverable, skip]),
    ).toEqual([
      ["email", null, null],
      [null, "no_channel", null],
      [null, "consent_required", null],
    ]);
    expect(await message(rows[0]!.reminder_id!)).toMatchObject({
      kind: "appointment_invitation",
      message_version: "portal-invitation:v1",
      status: "queued",
      appointment_id: id,
      booking_id: null,
      channel_id: reachable.channelId,
      consent_id: reachable.consentId,
      language: "en",
      requested_by: seedStaffUserIds.projectLead,
    });
    expect(await message(rows[1]!.reminder_id!)).toMatchObject({
      status: "cancelled",
      cancel_reason: "no_channel",
      channel_id: null,
      consent_id: null,
      language: "de",
    });
    expect(await events(withoutChannel, ["reminder_queued", "reminder_delivery"])).toEqual([
      expect.objectContaining({
        event_type: "reminder_queued",
        actor_type: "user",
        details: expect.objectContaining({
          kind: "appointment_invitation",
          channelKind: null,
          appointmentId: id,
          startsAt: expect.stringMatching(/Z$/),
        }),
      }),
      expect.objectContaining({
        event_type: "reminder_delivery",
        actor_type: "user",
        reason_code: "no_channel",
        details: {
          reminderId: rows[1]!.reminder_id,
          outcome: "cancelled",
          kind: "appointment_invitation",
          appointmentId: id,
        },
      }),
    ]);
    const details = await all("select details from audit_event");
    expect(JSON.stringify(details)).not.toMatch(/Kantine|example\.invalid/);
  });

  it("skips closed, ineligible, booked and invited participations", async () => {
    const [closed, booked, again, ok] = [
      await participation(),
      await participation(),
      await activated(),
      await participation(),
    ];
    await changeStatus(app, closed, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2026-10-20",
    });
    const id = await create();
    await book(id, booked);
    await invited(id, again.participationId);
    const other = await create({ kind: "consultation", start: 72 });
    const rows = await invite(id, [closed, booked, again.participationId, ok]);
    expect(rows.map((row) => row.skip)).toEqual([
      "participation_closed",
      "already_booked",
      "already_invited",
      null,
    ]);
    // A consultation whose host may not list the participation: not eligible.
    expect((await invited(other, ok)).skip).toBe("not_eligible");
  });

  it("refuses the whole request for an appointment no one can book from the portal", async () => {
    const p = await participation();
    const full = await create({ capacity: 1 });
    await book(full, await participation());
    await expect(invite(full, [p])).rejects.toMatchObject(failsWith("appointment_full"));
    const closed = await create();
    await owner.query("update appointment set booking_closes_at = now() where id = $1", [closed]);
    await expect(invite(closed, [p])).rejects.toMatchObject(failsWith("booking_closed"));
    const cancelled = await create();
    await cancel(cancelled);
    await expect(invite(cancelled, [p])).rejects.toMatchObject(failsWith("appointment_cancelled"));
    await expect(invite(randomUUID(), [p])).rejects.toMatchObject(
      failsWith("appointment_not_found"),
    );
  });

  it("lets the PL and the assigned consultant invite, nobody else", async () => {
    const [mine, theirs] = [await participation(), await participation()];
    await assign(mine);
    const id = await create();
    expect((await invited(id, mine, asConsultant)).skip).toBeNull();
    await expect(invite(id, [theirs], asConsultant)).rejects.toMatchObject(
      failsWith("participation_not_found"),
    );
    await expect(invite(id, [theirs], asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const elsewhere = await participation(verwaltung);
    await expect(invite(id, [elsewhere])).rejects.toMatchObject(
      failsWith("participation_not_found"),
    );
    const assisted = auditContext({
      actorType: "user",
      staffUserId: seedStaffUserIds.projectLead,
      onBehalfOf: theirs,
    });
    await expect(invite(id, [theirs], assisted)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await owner.query(
      "update project set status = 'draft', activated_at = null, activated_by = null where id = $1",
      [werkNord],
    );
    await expect(invite(id, [theirs])).rejects.toMatchObject(failsWith("project_not_active"));
  });

  it("puts the appointment in use: its times freeze", async () => {
    const id = await create();
    await invited(id, await participation());
    const a = await one("select * from appointment where id = $1", [id]);
    await expect(
      call(app, "update_appointment", {
        context: pl,
        id,
        expectedVersion: a.version,
        startsAt: hours(50),
        endsAt: hours(52),
        bookingClosesAt: hours(26),
        capacity: a.capacity,
        title: a.title,
        venue: a.venue,
        audienceWaveId: null,
      }),
    ).rejects.toMatchObject(failsWith("appointment_in_use"));
  });
});

describe("the invitation retry policy", () => {
  it("allows a new invitation after a failure, refused while sent or uncertain", async () => {
    const p = await activated();
    const id = await create();
    const first = await invited(id, p.participationId);
    expect(await claim(first.reminder_id!)).toBe("dispatching");
    await outcome(first.reminder_id!, "failed");
    const second = await invited(id, p.participationId);
    expect(second.skip).toBeNull();
    expect(await claim(second.reminder_id!)).toBe("dispatching");
    await outcome(second.reminder_id!, "sent");
    expect((await invited(id, p.participationId)).skip).toBe("already_invited");
    const other = await create({ start: 72 });
    const unknown = await invited(other, p.participationId);
    await claim(unknown.reminder_id!);
    await outcome(unknown.reminder_id!, "delivery_unknown");
    expect((await invited(other, p.participationId)).skip).toBe("already_invited");
    const queued = await create({ start: 96 });
    await invited(queued, p.participationId);
    expect((await invited(queued, p.participationId)).skip).toBe("already_invited");
  });

  it("allows a new invitation after `no_channel` once a channel exists", async () => {
    const p = await activated();
    await removeChannel(p.channelId);
    const id = await create();
    expect((await invited(id, p.participationId)).not_deliverable).toBe("no_channel");
    await restoreChannel(p.channelId);
    const again = await invited(id, p.participationId);
    expect([again.skip, again.channel_kind]).toEqual([null, "email"]);
  });

  it("allows an authorized requester after `requester_no_longer_authorized`", async () => {
    const p = await activated();
    await assign(p.participationId);
    const id = await create();
    const first = await invited(id, p.participationId, asConsultant);
    await unassign(p.participationId);
    expect(await claim(first.reminder_id!)).toBe("requester_no_longer_authorized");
    await expect(invite(id, [p.participationId], asConsultant)).rejects.toMatchObject(
      failsWith("participation_not_found"),
    );
    expect((await invited(id, p.participationId)).skip).toBeNull();
  });

  it("counts three delivery attempts; rows cancelled before the provider and transport retries none", async () => {
    const p = await activated();
    const id = await create();
    // Cancelled at the request and at the claim: no attempt.
    await removeChannel(p.channelId);
    await invited(id, p.participationId);
    await restoreChannel(p.channelId);
    const atClaim = await invited(id, p.participationId);
    await removeChannel(p.channelId);
    expect(await claim(atClaim.reminder_id!)).toBe("channel_unavailable");
    await restoreChannel(p.channelId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const row = await invited(id, p.participationId);
      expect(row.skip).toBeNull();
      expect(await claim(row.reminder_id!)).toBe("dispatching");
      // A transport retry claims the same row again: still one attempt.
      expect(await claim(row.reminder_id!)).toBe("dispatching");
      await outcome(row.reminder_id!, "failed");
    }
    expect((await invited(id, p.participationId)).skip).toBe("invitation_limit");
  });

  it("neither invitations nor notices use or consume the reminder window", async () => {
    const p = await activated();
    const id = await create();
    await invited(id, p.participationId);
    const remind = () =>
      app
        .query(
          `select * from request_reminders(p_context => $1, p_project_id => $2,
             p_participation_ids => $3::uuid[], p_kind => 'open_items',
             p_message_version => 'portal-reminder:v1', p_batch_id => $4)`,
          [pl, werkNord, [p.participationId], randomUUID()],
        )
        .then(({ rows }) => rows[0].skip);
    expect(await remind()).toBeNull();
    const other = await create({ start: 72 });
    expect((await invited(other, p.participationId)).skip).toBeNull();
    await book(other, p.participationId);
    await cancel(other);
    expect(await remind()).toBe("reminded_recently");
    await owner.query(
      "update participant_reminder set requested_on = requested_on - 3 where kind = 'open_items'",
    );
    expect(await remind()).toBeNull();
  });
});

describe("the dispatch claim of an invitation", () => {
  it("cancels an invitation booked before its dispatch `nothing_open`", async () => {
    const p = await activated();
    const id = await create();
    const row = await invited(id, p.participationId);
    await bookAsParticipant(id, p);
    expect(await claim(row.reminder_id!)).toBe("nothing_open");
    expect(await message(row.reminder_id!)).toMatchObject({
      status: "cancelled",
      cancel_reason: "nothing_open",
    });
  });

  it("cancels an invitation whose appointment is no longer bookable `appointment_unavailable`", async () => {
    const p = await activated();
    const id = await create();
    const row = await invited(id, p.participationId);
    await cancel(id);
    expect(await claim(row.reminder_id!)).toBe("appointment_unavailable");
    const [delivery] = await events(p.participationId, ["reminder_delivery"]);
    expect(delivery).toMatchObject({
      actor_type: "system",
      system_job: "reminders.send",
      reason_code: "appointment_unavailable",
      details: { kind: "appointment_invitation", appointmentId: id, outcome: "cancelled" },
    });
  });
});

describe("the organizer's notices", () => {
  it("notify each person booked when the appointment is cancelled, as the system", async () => {
    const [reachable, unreachable] = [await activated(), await participation()];
    const id = await create();
    await book(id, reachable.participationId);
    await book(id, unreachable);
    await cancel(id);
    const rows = await notices(id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "appointment_cancelled",
        message_version: "portal-appointment-change:v1",
        requested_by: null,
      });
      expect(row.booking_id).toBe((await bookingOf(id, row.participation_id)).id);
    }
    const byParticipation = Object.fromEntries(rows.map((row) => [row.participation_id, row]));
    expect(byParticipation[reachable.participationId]).toMatchObject({ status: "queued" });
    // A cancellation without a usable channel writes a cancelled notice.
    expect(byParticipation[unreachable]).toMatchObject({
      status: "cancelled",
      reason: "no_channel",
    });
    expect(await events(unreachable, ["reminder_queued", "reminder_delivery"])).toEqual([
      expect.objectContaining({
        actor_type: "system",
        system_job: "appointments.notify",
        details: expect.objectContaining({ kind: "appointment_cancelled", channelKind: null }),
      }),
      expect.objectContaining({
        actor_type: "system",
        system_job: "appointments.notify",
        reason_code: "no_channel",
      }),
    ]);
  });

  it("writes a cancelled notice `consent_required` for a channel without consent v2", async () => {
    const p = await activated();
    await owner.query(
      "update consent_record set text_version = 'portal-contact-consent:v1' where id = $1",
      [p.consentId],
    );
    const id = await create();
    const bookingId = await book(id, p.participationId);
    await cancelBooking(bookingId);
    expect(await notices(id)).toEqual([
      expect.objectContaining({
        status: "cancelled",
        reason: "consent_required",
        booking_id: bookingId,
      }),
    ]);
  });

  it("still sends a staff cancellation's notice after the consultant is reassigned (system path)", async () => {
    const p = await activated();
    await assign(p.participationId);
    const id = await create();
    const bookingId = await book(id, p.participationId, asConsultant);
    await cancelBooking(bookingId, asConsultant);
    const [notice] = await notices(id);
    await unassign(p.participationId);
    expect(await claim(notice.id)).toBe("dispatching");
    await outcome(notice.id, "sent");
    const delivery = (await events(p.participationId, ["reminder_delivery"])).at(-1);
    expect(delivery).toMatchObject({
      system_job: "appointments.notify",
      details: { outcome: "sent", kind: "appointment_cancelled", appointmentId: id },
    });
  });

  it("notify the people booked of a corrected title or venue before the start only", async () => {
    const [stays, leaves] = [await activated(), await activated()];
    const id = await create();
    await book(id, stays.participationId);
    const left = await book(id, leaves.participationId);
    await cancelBooking(left);
    const change = async (changes: Record<string, unknown>) => {
      const a = await one("select * from appointment where id = $1", [id]);
      await call(app, "update_appointment", {
        context: pl,
        id,
        expectedVersion: a.version,
        startsAt: a.starts_at,
        endsAt: a.ends_at,
        bookingClosesAt: a.booking_closes_at,
        capacity: a.capacity,
        title: a.title,
        venue: a.venue,
        audienceWaveId: null,
        ...changes,
      });
    };
    await change({ capacity: 9 });
    expect((await notices(id)).filter((n) => n.kind === "appointment_changed")).toEqual([]);
    await change({ venue: "Raum 2" });
    expect(
      (await notices(id))
        .filter((n) => n.kind === "appointment_changed")
        .map((n) => n.participation_id),
    ).toEqual([stays.participationId]);
    await shift(id, -49);
    await change({ title: "Infoveranstaltung" });
    expect((await notices(id)).filter((n) => n.kind === "appointment_changed")).toHaveLength(1);
  });

  it("notify after a late cancellation, never for the PL's correction of a past event", async () => {
    const [late, absent] = [await activated(), await activated()];
    const lateId = await create();
    await book(lateId, late.participationId);
    await shift(lateId, -49);
    await cancel(lateId, "did_not_take_place");
    expect(await notices(lateId)).toHaveLength(1);
    const pastId = await create({ start: 72 });
    await book(pastId, absent.participationId);
    await shift(pastId, -75);
    await call(app, "record_attendance", {
      context: pl,
      appointmentId: pastId,
      participationIds: [absent.participationId],
      attendance: ["absent"],
      markInformed: [false],
      informationDelivered: false,
      afterCloseReason: null,
    });
    await cancel(pastId, "did_not_take_place");
    expect(await notices(pastId)).toEqual([]);
  });

  it("sends none for the participant's own cancellation", async () => {
    const p = await activated();
    const id = await create();
    const bookingId = await bookAsParticipant(id, p);
    await call(app, "cancel_appointment_booking", {
      context: asParticipant(p.participationId),
      bookingId,
      tokenHash: p.tokenHash,
    });
    expect(await notices(id)).toEqual([]);
  });
});

describe("the participant's own booking", () => {
  it("books as the participant until the public cutoff, origin `participant`", async () => {
    const p = await activated();
    const id = await create();
    const bookingId = await bookAsParticipant(id, p);
    expect(await one("select * from appointment_booking where id = $1", [bookingId])).toMatchObject(
      { origin: "participant", booked_by: null, status: "booked" },
    );
    const [event] = await events(p.participationId, ["appointment_booked"]);
    expect(event).toMatchObject({
      actor_type: "participant",
      actor_participation_id: p.participationId,
      details: expect.objectContaining({ origin: "participant", bookingId }),
    });
    const closed = await create({ start: 72 });
    await owner.query("update appointment set booking_closes_at = now() where id = $1", [closed]);
    await expect(bookAsParticipant(closed, p)).rejects.toMatchObject(failsWith("booking_closed"));
    // Staff still book until the start.
    expect(await book(closed, await participation())).toEqual(expect.any(String));
  });

  it("refuses another project's appointment, another session and a missing token", async () => {
    const [p, other] = [await activated(), await activated()];
    const elsewhere = await call(app, "create_appointment", {
      context: pl,
      projectId: verwaltung,
      id: randomUUID(),
      kind: "info_event",
      hostStaffUserId: null,
      audienceWaveId: null,
      startsAt: hours(48),
      endsAt: hours(50),
      bookingClosesAt: hours(24),
      capacity: 5,
      title: null,
      venue: "Raum 1",
    });
    await expect(bookAsParticipant(elsewhere, p)).rejects.toMatchObject(
      failsWith("appointment_not_found"),
    );
    const id = await create();
    await expect(
      bookAsParticipant(id, { participationId: p.participationId, tokenHash: other.tokenHash }),
    ).rejects.toMatchObject(failsWith("session_invalid"));
    await expect(
      call(app, "book_appointment", {
        context: asParticipant(p.participationId),
        appointmentId: id,
        participationId: p.participationId,
        id: randomUUID(),
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(
      call(app, "book_appointment", {
        context: pl,
        appointmentId: id,
        participationId: p.participationId,
        id: randomUUID(),
        tokenHash: p.tokenHash,
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });

  it("cancels the participant's own booking until the start, never another's", async () => {
    const [p, other] = [await activated(), await activated()];
    const id = await create();
    const own = await bookAsParticipant(id, p);
    const theirs = await bookAsParticipant(id, other);
    const cancelOwn = (bookingId: string) =>
      call(app, "cancel_appointment_booking", {
        context: asParticipant(p.participationId),
        bookingId,
        tokenHash: p.tokenHash,
      });
    await expect(cancelOwn(theirs)).rejects.toMatchObject(failsWith("booking_not_found"));
    await expect(cancelOwn(randomUUID())).rejects.toMatchObject(failsWith("booking_not_found"));
    await cancelOwn(own);
    expect(await one("select * from appointment_booking where id = $1", [own])).toMatchObject({
      status: "cancelled",
      cancel_reason: "participant_cancelled",
      cancelled_by: null,
    });
    const [event] = await events(p.participationId, ["appointment_booking_cancelled"]);
    expect(event).toMatchObject({
      actor_type: "participant",
      reason_code: "participant_cancelled",
    });
    await expect(cancelOwn(own)).rejects.toMatchObject(failsWith("booking_cancelled"));
    const started = await bookAsParticipant(await create({ start: 72 }), p);
    await owner.query(
      "update appointment set starts_at = now() - interval '1 minute', booking_closes_at = now() - interval '1 day' where id = (select appointment_id from appointment_booking where id = $1)",
      [started],
    );
    await expect(cancelOwn(started)).rejects.toMatchObject(failsWith("appointment_started"));
  });
});

const followUp = (reminderId: string, method = "phone", context = pl) =>
  call(app, "record_notice_follow_up", { context, reminderId, method });

describe("record_notice_follow_up", () => {
  it("records how the person was told of an undelivered notice, once", async () => {
    const p = await participation();
    await assign(p);
    const id = await create();
    await book(id, p);
    await cancel(id);
    const [notice] = await notices(id);
    await expect(followUp(notice.id, "phone", asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await followUp(notice.id, "phone", asConsultant);
    expect(await message(notice.id)).toMatchObject({
      followed_up_method: "phone",
      followed_up_by: consultant,
    });
    const [event] = await events(p, ["appointment_notice_followed_up"]);
    expect(event).toMatchObject({
      actor_type: "user",
      details: { reminderId: notice.id, appointmentId: id, method: "phone" },
    });
    await expect(followUp(notice.id, "letter")).rejects.toMatchObject(
      failsWith("already_followed_up"),
    );
  });

  it("refuses a delivered notice, an invitation and a closed participation", async () => {
    const p = await activated();
    const id = await create();
    const invitation = await invited(id, p.participationId);
    await expect(followUp(invitation.reminder_id!)).rejects.toMatchObject(
      failsWith("reminder_not_found"),
    );
    await book(id, p.participationId);
    await cancel(id);
    const [notice] = await notices(id);
    await expect(followUp(notice.id)).rejects.toMatchObject(failsWith("notice_delivered"));
    await claim(notice.id);
    await outcome(notice.id, "sent");
    await expect(followUp(notice.id, "not_needed")).rejects.toMatchObject(
      failsWith("notice_delivered"),
    );
    const closed = await participation();
    const other = await create({ start: 72 });
    await book(other, closed);
    await cancel(other);
    const [undelivered] = await notices(other);
    await changeStatus(app, closed, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2026-10-20",
    });
    await expect(followUp(undelivered.id)).rejects.toMatchObject(failsWith("participation_closed"));
  });
});

describe("transfer_app and the messages", () => {
  it("can't write the new columns or record the changed event types", async () => {
    for (const statement of [
      "update participant_reminder set booking_id = null",
      "update participant_reminder set followed_up_method = 'phone'",
      "update participant_reminder set requested_by = null",
    ]) {
      await expect(app.query(statement)).rejects.toMatchObject({ code: "42501" });
    }
    const p = await participation();
    for (const type of ["reminder_queued", "reminder_delivery", "appointment_notice_followed_up"]) {
      await expect(
        call(app, "record_audit_event", {
          projectId: werkNord,
          participationId: p,
          eventType: type,
          context: pl,
        }),
      ).rejects.toMatchObject(failsWith("event_type_reserved"));
    }
  });
});

/** Each outcome: "ok", the result, or the refusal code. */
const settle = (promises: Promise<unknown>[]) =>
  Promise.allSettled(promises).then((results) =>
    results.map((result) =>
      result.status === "fulfilled"
        ? typeof result.value === "string" && !/^[0-9a-f-]{36}$/.test(result.value)
          ? result.value
          : "ok"
        : (result.reason as { message: string }).message,
    ),
  );

// The lock order (ADR-0002, messages): races between connections, each its own transaction.
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

  it("runs booking, appointment cancellation and the dispatch claim together without deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await create({ start: 48 + round * 3 });
      const [booked, joins] = [await activated(), await activated()];
      await book(id, booked.participationId);
      const invitation = await invited(id, joins.participationId);
      const outcomes = await settle([
        bookAsParticipant(id, joins, clients[0]!),
        cancel(id, "too_few_bookings", clients[1]!),
        claim(invitation.reminder_id!, clients[2]!),
      ]);
      expect(outcomes.join()).not.toMatch(/deadlock/);
      expect(outcomes[1]).toBe("ok");
      expect(["ok", "appointment_cancelled"]).toContain(outcomes[0]);
      expect(["dispatching", "nothing_open", "appointment_unavailable"]).toContain(outcomes[2]);
      // No booking survives the cancelled appointment.
      const live = await one(
        "select count(*)::int as n from appointment_booking where appointment_id = $1 and status = 'booked'",
        [id],
      );
      expect(live.n).toBe(0);
      // Each cancellation notice goes to a booking the cancellation cancelled, and each such
      // booking has one.
      const rows = await all(
        `select r.booking_id, b.status::text, b.cancel_reason::text
         from participant_reminder r join appointment_booking b on b.id = r.booking_id
         where r.appointment_id = $1 and r.kind::text = 'appointment_cancelled'`,
        [id],
      );
      for (const row of rows) {
        expect([row.status, row.cancel_reason]).toEqual(["cancelled", "appointment_cancelled"]);
      }
      const cancelled = await one(
        `select count(*)::int as n from appointment_booking
         where appointment_id = $1 and cancel_reason = 'appointment_cancelled'`,
        [id],
      );
      expect(rows).toHaveLength(cancelled.n);
      expect(cancelled.n).toBe(outcomes[0] === "ok" ? 2 : 1);
    }
  });
});
