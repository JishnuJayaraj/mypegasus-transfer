import { DevelopmentOutbox, ManualClock, MockMailer, MockSmsSender } from "@transfer/adapters";
import {
  createDb,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { call, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  Appointment,
  BatchActivationCodeResult,
  InvitationRequestResult,
  PortalAppointments,
  PortalBookingResult,
  PortalMe,
  ReminderPage,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The portal's "Termine", invitations, the organizer's notices and their follow-up
// (data-protection.md, messages and appointments: the portal; ADR-0010) against transfer_test. The
// ta_only project, so no wave cutoff stands in the way of an activation. Synthetic values only.
const clock = new ManualClock(new Date());
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const { app, db, detached } = testApp({ clock, outbox, mailer, smsSender });
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.verwaltung;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const PORTAL_URL = "https://portal.test/portal/";
const staff = {} as Record<string, { Cookie: string }>;
const VENUE = "Kantine Verwaltung";
let addresses = 0;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await detached.settle();
  await resetTestDatabase({ seed: true, active: true });
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

const hours = (h: number) =>
  new Date(Math.ceil(Date.now() / 60_000) * 60_000 + h * 3600_000).toISOString();
const post = (path: string, body: unknown, as: string = projectLead) =>
  app.request(`/api/v1${path}`, jsonRequest("POST", body, staff[as]!));
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));

async function person() {
  const id = randomUUID();
  await owner.insert(participation).values({
    id,
    projectId,
    status: "imported",
    profilingStatus: "not_started",
    dsvStatus: "not_offered",
  });
  await owner.insert(participantIdentity).values({
    participationId: id,
    projectId,
    personnelNumber: `SYN-${id.slice(-8)}`,
    firstName: "Erika",
    lastName: "Beispiel",
    birthDate: "1970-01-01",
  });
  await owner.insert(participantDetails).values({
    participationId: id,
    projectId,
    addressStreet: "Musterweg 1",
    addressPostalCode: "10115",
    addressCity: "Berlin",
    addressCountry: "DE",
  });
  return id;
}

function portal() {
  let cookie: string | undefined;
  const request = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
    const init = method === "GET" ? { headers } : jsonRequest(method, body ?? {}, headers);
    const res = await app.request(`/api/v1/portal${path}`, init);
    const set = res.headers.get("set-cookie");
    if (set) {
      const value = set.split(";")[0]!;
      cookie = value.endsWith("=") ? undefined : value;
    }
    return res;
  };
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
  };
}

const lastCode = () => /\b(\d{6})\b/.exec(outbox.list().at(-1)!.text)![1]!;

/** An activated participant (consent v2, an email channel) with an active portal session. */
async function activated() {
  clock.set(new Date(clock.now().getTime() + 16 * 60_000));
  const address = `erika.${++addresses}@example.org`;
  const participationId = await person();
  const res = await post(`/projects/${projectId}/activation-codes`, {
    participationIds: [participationId],
    channel: "letter",
    language: "de",
  });
  const code = (await readJson(res, BatchActivationCodeResult)).items[0]!.code;
  const browser = portal();
  await browser.post("/activation", { code });
  await browser.post("/activation/birth-date", { birthDate: "1970-01-01" });
  await browser.post("/activation/channel", { kind: "email", address, language: "de" });
  const done = await browser.post("/activation/completion", {
    oneTimeCode: lastCode(),
    noticeVersion: "art14-activation:v1",
    consent: true,
    consentVersion: "portal-contact-consent:v2",
    language: "de",
  });
  expect(done.status).toBe(201);
  await readJson(done, PortalMe);
  return { participationId, browser, address };
}

async function appointment(body: Record<string, unknown> = {}) {
  const res = await post(`/projects/${projectId}/appointments`, {
    kind: "info_event",
    startsAt: hours(48),
    endsAt: hours(50),
    capacity: 5,
    title: "Infoveranstaltung",
    venue: VENUE,
    ...body,
  });
  expect(res.status).toBe(201);
  return readJson(res, Appointment);
}

const sections = async (browser: ReturnType<typeof portal>) => {
  const res = await browser.get("/appointments");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  return readJson(res, PortalAppointments);
};
const invite = (appointmentId: string, participationIds: string[], as: string = projectLead) =>
  post(`/appointments/${appointmentId}/invitations`, { participationIds }, as);

describe("GET /portal/appointments and the participant's booking", () => {
  it("shows an invitation, books it, cancels it, each the participant's own only", async () => {
    const erika = await activated();
    const other = await activated();
    const event = await appointment();
    const res = await invite(event.id, [erika.participationId]);
    expect(res.status).toBe(201);
    const before = await sections(erika.browser);
    expect(before.invitations).toEqual([
      expect.objectContaining({
        appointmentId: event.id,
        state: "bookable",
        details: expect.objectContaining({ venue: VENUE }),
        capabilities: { book: true },
      }),
    ]);
    // Another participant sees the appointment to book, not the invitation.
    const theirs = await sections(other.browser);
    expect(theirs.invitations).toEqual([]);
    expect(theirs.bookable.map((b) => b.appointmentId)).toEqual([event.id]);
    expect(JSON.stringify(theirs)).not.toMatch(/capacity|bookedCount/);

    const booked = await erika.browser.post(`/appointments/${event.id}/booking`, {});
    expect(booked.status).toBe(201);
    const { bookingId } = await readJson(booked, PortalBookingResult);
    const after = await sections(erika.browser);
    expect(after.invitations).toEqual([]);
    expect(after.bookings).toEqual([
      expect.objectContaining({
        id: bookingId,
        appointmentId: event.id,
        capabilities: { cancel: true },
      }),
    ]);
    expect(await codes(await erika.browser.post(`/appointments/${event.id}/booking`, {}))).toEqual([
      { code: "already_booked", pointer: "" },
    ]);

    // Another participation's booking is a 404.
    await expectProblem(
      await other.browser.post(`/appointment-bookings/${bookingId}/cancellation`, {}),
      404,
      "not-found",
    );
    const cancelled = await erika.browser.post(
      `/appointment-bookings/${bookingId}/cancellation`,
      {},
    );
    expect(cancelled.status).toBe(204);
    const last = await sections(erika.browser);
    expect(last.bookings).toEqual([]);
    // The participant's own cancellation isn't "Abgesagt"; the invitation is back.
    expect(last.cancelled).toEqual([]);
    expect(last.invitations.map((i) => i.appointmentId)).toEqual([event.id]);
  });

  it("refuses without a session, after the public cutoff and outside the project", async () => {
    const erika = await activated();
    await expectProblem(await app.request("/api/v1/portal/appointments"), 401, "unauthenticated");
    const closed = await appointment({ bookingCutoffDays: 2 });
    await owner.execute(
      sql`update appointment set booking_closes_at = now() where id = ${closed.id}::uuid`,
    );
    expect(await codes(await erika.browser.post(`/appointments/${closed.id}/booking`, {}))).toEqual(
      [{ code: "booking_closed", pointer: "" }],
    );
    const elsewhere = await call(owner.$client, "create_appointment", {
      context: pl,
      projectId: seedProjectIds.werkNord,
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
    await expectProblem(
      await erika.browser.post(`/appointments/${elsewhere}/booking`, {}),
      404,
      "not-found",
    );
    await expectProblem(
      await erika.browser.post(`/appointments/${randomUUID()}/booking`, {}),
      404,
      "not-found",
    );
  });

  it("moves an appointment the organizer cancelled to Abgesagt and notifies with the fixed text", async () => {
    const erika = await activated();
    const event = await appointment();
    expect((await erika.browser.post(`/appointments/${event.id}/booking`, {})).status).toBe(201);
    const sent = outbox.list().length;
    const res = await post(`/appointments/${event.id}/cancellation`, {
      reason: "too_few_bookings",
    });
    expect(res.status).toBe(200);
    await detached.settle();
    expect(outbox.list().slice(sent)).toEqual([
      expect.objectContaining({
        to: erika.address,
        subject: "Änderung im Teilnehmerportal",
        text:
          "Bei einem Ihrer Termine im Teilnehmerportal gibt es eine Änderung. Bitte melden Sie " +
          `sich an: ${PORTAL_URL}\n\n` +
          "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.",
      }),
    ]);
    const { cancelled } = await sections(erika.browser);
    expect(cancelled).toEqual([
      expect.objectContaining({ appointmentId: event.id, cancelledBy: "organizer" }),
    ]);
  });
});

describe("POST /appointments/{id}/invitations", () => {
  it("queues per channel, writes the undeliverable ones and skips with codes", async () => {
    const erika = await activated();
    const [withoutChannel, booked] = [await person(), await person()];
    const event = await appointment();
    expect(
      (await post(`/appointments/${event.id}/bookings`, { participationId: booked })).status,
    ).toBe(201);
    const sent = outbox.list().length;
    const res = await invite(event.id, [erika.participationId, withoutChannel, booked]);
    expect(res.status).toBe(201);
    expect(await readJson(res, InvitationRequestResult)).toEqual({
      batchId: expect.any(String),
      queued: [{ participationId: erika.participationId, channel: "email" }],
      notDeliverable: [{ participationId: withoutChannel, code: "no_channel" }],
      skipped: [{ participationId: booked, code: "already_booked" }],
    });
    await detached.settle();
    expect(outbox.list().slice(sent)).toEqual([
      expect.objectContaining({
        to: erika.address,
        subject: "Neue Einladung im Teilnehmerportal",
        text:
          `In Ihrem Teilnehmerportal gibt es eine Einladung zu einem Termin. Bitte melden Sie sich an: ${PORTAL_URL}\n\n` +
          "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.",
      }),
    ]);
    const again = await readJson(
      await invite(event.id, [erika.participationId]),
      InvitationRequestResult,
    );
    expect(again.skipped).toEqual([
      { participationId: erika.participationId, code: "already_invited" },
    ]);
    // An invitation puts the appointment in use.
    const listed = await app.request(`/api/v1/appointments/${event.id}`, {
      headers: staff[projectLead]!,
    });
    expect((await readJson(listed, Appointment)).inUse).toBe(true);
  });

  it("follows ADR-0010's order: hidden ids, permission, state", async () => {
    const [mine, theirs] = [await person(), await person()];
    await call(owner.$client, "assign_participations", {
      projectId,
      participationIds: [mine],
      staffUserId: consultant,
      context: pl,
    });
    const event = await appointment();
    expect(await codes(await invite(event.id, [mine, theirs], consultant))).toEqual([
      { code: "participation_not_found", pointer: "/participationIds/1" },
    ]);
    expect((await invite(event.id, [mine], consultant)).status).toBe(201);
    await expectProblem(await invite(event.id, [theirs], backOffice), 403, "forbidden");
    await expectProblem(await invite(randomUUID(), [theirs]), 404, "not-found");
    await post(`/appointments/${event.id}/cancellation`, { reason: "other" });
    expect(await codes(await invite(event.id, [theirs]))).toEqual([
      { code: "appointment_cancelled", pointer: "" },
    ]);
  });
});

describe("Nachrichten and the follow-up of an undelivered notice", () => {
  it("names the new kinds and records a follow-up once", async () => {
    const p = await person();
    const event = await appointment();
    const booking = await post(`/appointments/${event.id}/bookings`, { participationId: p });
    const { bookingId } = (await booking.json()) as { bookingId: string };
    expect((await post(`/appointment-bookings/${bookingId}/cancellation`, {})).status).toBe(204);
    const page = await readJson(
      await app.request(`/api/v1/participations/${p}/reminders`, { headers: staff[projectLead]! }),
      ReminderPage,
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        kind: "appointment_cancelled",
        channel: null,
        appointmentId: event.id,
        bySystem: true,
        status: "cancelled",
        cancelReason: "no_channel",
        followUpMethod: null,
        capabilities: { followUp: true },
      }),
    ]);
    const id = page.items[0]!.id;
    const followUp = (method: string, as: string = projectLead, participationId = p) =>
      post(`/participations/${participationId}/reminders/${id}/follow-up`, { method }, as);
    await expectProblem(await followUp("phone", backOffice), 403, "forbidden");
    await expectProblem(await followUp("phone", projectLead, await person()), 404, "not-found");
    expect((await followUp("phone")).status).toBe(204);
    expect(await codes(await followUp("letter"))).toEqual([
      { code: "already_followed_up", pointer: "" },
    ]);
    const after = await readJson(
      await app.request(`/api/v1/participations/${p}/reminders`, { headers: staff[projectLead]! }),
      ReminderPage,
    );
    expect(after.items[0]).toMatchObject({
      followUpMethod: "phone",
      followedUpAt: expect.any(String),
      capabilities: { followUp: false },
    });
  });
});
