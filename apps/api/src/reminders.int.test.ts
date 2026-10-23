import { DevelopmentOutbox, ManualClock, MockMailer, MockSmsSender } from "@transfer/adapters";
import {
  auditEvent,
  createDb,
  eq,
  participantDetails,
  participantIdentity,
  participantReminder,
  participation,
  seedProjectIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  BatchActivationCodeResult,
  ConsentUpgradeResult,
  ParticipationActivation,
  PortalMe,
  ReminderPage,
  ReminderRequestResult,
  Worklist,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startJobs, reminderQueue, type Jobs } from "./jobs/jobs";
import { failClosedFacts } from "./participations/guard-facts";
import { loadRelease } from "./projects/template-pins";
import { sendReminder } from "./reminders/send";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Reminders and consent v2 (data-protection.md, reminders and consent v2) against transfer_test.
// The ta_only project, so no wave cutoff stands in the way of an activation. Synthetic values only.
const clock = new ManualClock(new Date("2026-10-21T10:00:00Z"));
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const { app, db, logs, detached } = testApp({ clock, outbox, mailer, smsSender });
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.verwaltung;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const PORTAL_URL = "https://portal.test/portal/";
const GERMAN_EMAIL =
  "In Ihrem Teilnehmerportal ist noch etwas offen. Bitte melden Sie sich an und prüfen Sie Ihre " +
  `Angaben oder Unterlagen: ${PORTAL_URL}\n\n` +
  "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.";
const staff = {} as Record<string, { Cookie: string }>;
/** Every response body of the test, to check that no address leaves where it mustn't. */
const answered: string[] = [];
let addresses = 0;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  // A send the previous test started after its response must not outlive it.
  await detached.settle();
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
  answered.length = 0;
  outbox.mode = "sent";
  clock.set(new Date(clock.now().getTime() + 61 * 60_000));
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

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
    answered.push(await res.clone().text());
    return res;
  };
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
  };
}

const lastCode = () => /\b(\d{6})\b/.exec(outbox.list().at(-1)!.text)![1]!;

/** An activated participant (consent v2) with an active portal session and open items. */
async function activated() {
  // A fresh window of the per-IP throttle for each activation's submissions.
  clock.set(new Date(clock.now().getTime() + 16 * 60_000));
  const address = `erika.${++addresses}@example.org`;
  const participationId = await person();
  const res = await app.request(
    `/api/v1/projects/${projectId}/activation-codes`,
    jsonRequest(
      "POST",
      { participationIds: [participationId], channel: "letter", language: "de" },
      staff[projectLead],
    ),
  );
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
  const me = await readJson(done, PortalMe);
  return { participationId, browser, address, channelId: me.channels[0]!.id };
}

/** The owner fixture of the e2e spec: the channel's consent as v1, as before Slice 5. */
const makeV1 = (participationId: string) =>
  owner.execute(sql`update consent_record set text_version = 'portal-contact-consent:v1'
    where participation_id = ${participationId}`);

const remind = (participationIds: string[], auth = staff[projectLead], target = app) =>
  target.request(
    `/api/v1/projects/${projectId}/reminders`,
    jsonRequest("POST", { kind: "open_items", participationIds }, auth),
  );
const reminders = (participationId: string, auth = staff[projectLead]) =>
  app.request(`/api/v1/participations/${participationId}/reminders`, { headers: auth });
const rows = () => owner.select().from(participantReminder);
const reminderEvents = async () =>
  (await owner.select().from(auditEvent)).filter((e) => e.eventType.startsWith("reminder_"));
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));
const assign = (ids: string[]) =>
  app.request(
    `/api/v1/projects/${projectId}/assignments`,
    jsonRequest("POST", { staffUserId: consultant, participationIds: ids }, staff[projectLead]),
  );

describe("POST /projects/{id}/reminders", () => {
  it("queues, sends exactly the fixed text with the plain URL and skips the next request", async () => {
    const { participationId, address } = await activated();
    const sent = outbox.list().length;
    const res = await remind([participationId]);
    expect(res.status).toBe(201);
    const body = await readJson(res, ReminderRequestResult);
    expect(body).toEqual({
      batchId: expect.any(String),
      queued: [{ participationId, channel: "email" }],
      skipped: [],
    });
    await detached.settle();
    const messages = outbox.list().slice(sent);
    expect(messages).toEqual([
      expect.objectContaining({
        kind: "email",
        to: address,
        subject: "Im Teilnehmerportal ist noch etwas offen",
        text: GERMAN_EMAIL,
        idempotencyKey: expect.stringMatching(/^reminder:[0-9a-f-]{36}$/),
      }),
    ]);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "sent", channelKind: "email", language: "de" });
    expect((await reminderEvents()).map((e) => e.eventType)).toEqual([
      "reminder_queued",
      "reminder_delivery",
    ]);
    const again = await readJson(await remind([participationId]), ReminderRequestResult);
    expect(again.skipped).toEqual([{ participationId, code: "reminded_recently" }]);
    expect(await rows()).toHaveLength(1);
  });

  it("skips no channel and a v1 consent apart, and the v1 channel still logs in", async () => {
    const { participationId: v1, address } = await activated();
    await makeV1(v1);
    const noAccount = await person();
    const body = await readJson(await remind([noAccount, v1]), ReminderRequestResult);
    expect(body.queued).toEqual([]);
    expect(body.skipped).toEqual([
      { participationId: noAccount, code: "no_channel" },
      { participationId: v1, code: "consent_required" },
    ]);
    expect(await rows()).toEqual([]);
    const codeRequest = await app.request(
      "/api/v1/portal/login/code-request",
      jsonRequest("POST", { kind: "email", address, language: "de" }),
    );
    expect(codeRequest.status).toBe(202);
    await detached.settle();
    expect(outbox.list().at(-1)).toMatchObject({
      to: address,
      subject: expect.stringMatching(/Anmeldecode/),
    });
  });

  it("refuses hidden participations, back office and duplicates before writing anything", async () => {
    const { participationId } = await activated();
    const other = randomUUID();
    expect(await codes(await remind([participationId, other]))).toEqual([
      { code: "participation_not_found", pointer: "/participationIds/1" },
    ]);
    expect(await codes(await remind([participationId], staff[consultant]))).toEqual([
      { code: "participation_not_found", pointer: "/participationIds/0" },
    ]);
    await expectProblem(await remind([participationId], staff[backOffice]), 403, "forbidden");
    await expectProblem(await remind([participationId, participationId]), 400, "validation-error");
    expect(await rows()).toEqual([]);
  });

  it("lets the assigned consultant remind", async () => {
    const { participationId } = await activated();
    expect((await assign([participationId])).status).toBe(200);
    const body = await readJson(
      await remind([participationId], staff[consultant]),
      ReminderRequestResult,
    );
    expect(body.queued).toHaveLength(1);
  });

  it("answers 503 in production without pg-boss or a sender, writing nothing", async () => {
    const { participationId } = await activated();
    const production = testApp({ env: { nodeEnv: "production" }, clock });
    const auth = await login(production.app, projectLead);
    expect(
      await codes(
        await remind([participationId], auth, production.app),
        503,
        "service-unavailable",
      ),
    ).toEqual([{ code: "jobs_unavailable", pointer: "" }]);
    const queued = testApp({
      env: { nodeEnv: "production" },
      clock,
      reminders: { enqueue: async () => undefined },
    });
    const queuedAuth = await login(queued.app, projectLead);
    expect(
      await codes(
        await remind([participationId], queuedAuth, queued.app),
        503,
        "service-unavailable",
      ),
    ).toEqual([{ code: "delivery_unavailable", pointer: "" }]);
    expect(await rows()).toEqual([]);
    expect(await reminderEvents()).toEqual([]);
    await Promise.all([production.db.$client.end(), queued.db.$client.end()]);
  });

  it("rolls rows and events back when a job can't be queued", async () => {
    const [a, b] = [await activated(), await activated()];
    let calls = 0;
    const failing = testApp({
      clock,
      mailer,
      smsSender,
      outbox,
      reminders: {
        async enqueue() {
          if (++calls === 2) throw new Error("queue down");
        },
      },
    });
    const auth = await login(failing.app, projectLead);
    expect((await remind([a.participationId, b.participationId], auth, failing.app)).status).toBe(
      500,
    );
    expect(await rows()).toEqual([]);
    expect(await reminderEvents()).toEqual([]);
    await failing.db.$client.end();
  });
});

const deps = () => ({
  db,
  logger: pino({ level: "silent" }),
  release: loadRelease(undefined),
  mailer,
  smsSender,
  portalPublicUrl: PORTAL_URL,
});
/** Queues one reminder without running its job: a queue that holds it. */
async function queuedReminder() {
  const participant = await activated();
  const holding = testApp({ clock, reminders: { enqueue: async () => undefined } });
  const auth = await login(holding.app, projectLead);
  expect((await remind([participant.participationId], auth, holding.app)).status).toBe(201);
  await holding.db.$client.end();
  const [row] = await owner
    .select()
    .from(participantReminder)
    .where(eq(participantReminder.participationId, participant.participationId));
  return { ...participant, reminderId: row!.id };
}
const statusOf = async (id: string) =>
  (await owner.select().from(participantReminder).where(eq(participantReminder.id, id)))[0]!;

describe("the dispatch (reminders.send)", () => {
  it("retries an unknown outcome with the same key, then settles delivery_unknown when the claim fails", async () => {
    const { reminderId, channelId } = await queuedReminder();
    const before = outbox.list().length;
    outbox.mode = "unknown";
    await expect(sendReminder(deps(), reminderId, "job-1", false)).rejects.toThrow(
      "delivery_unknown",
    );
    expect((await statusOf(reminderId)).status).toBe("dispatching");
    outbox.mode = "sent";
    // The channel is removed before the retry's claim: no second send.
    await owner.execute(sql`update participant_channel set removed_at = now(),
      removed_reason = 'consent_revoked' where id = ${channelId}`);
    expect(await sendReminder(deps(), reminderId, "job-2", false)).toBe("settled");
    expect(await statusOf(reminderId)).toMatchObject({ status: "delivery_unknown" });
    expect(outbox.list().length - before).toBe(1);
  });

  it("sends a retry with the same key once the outcome is known", async () => {
    const { reminderId } = await queuedReminder();
    const before = outbox.list().length;
    outbox.mode = "unknown";
    await expect(sendReminder(deps(), reminderId, "job-1", false)).rejects.toThrow(
      "delivery_unknown",
    );
    outbox.mode = "sent";
    expect(await sendReminder(deps(), reminderId, "job-2", false)).toBe("sent");
    const messages = outbox.list().slice(before);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.idempotencyKey).toBe(`reminder:${reminderId}`);
  });

  it("keeps a definitive failure, ends the last attempt's error unknown and cancels without a sender", async () => {
    const failed = await queuedReminder();
    const unknown = await queuedReminder();
    outbox.mode = "failed";
    expect(await sendReminder(deps(), failed.reminderId, "job-1", false)).toBe("failed");
    expect(await sendReminder(deps(), failed.reminderId, "job-2", false)).toBe("skipped");
    outbox.mode = "unknown";
    expect(await sendReminder(deps(), unknown.reminderId, "job-1", true)).toBe("delivery_unknown");
    outbox.mode = "sent";
    const unavailable = await queuedReminder();
    expect(
      await sendReminder({ ...deps(), mailer: undefined }, unavailable.reminderId, "job-1", false),
    ).toBe("cancelled");
    expect(await statusOf(unavailable.reminderId)).toMatchObject({
      status: "cancelled",
      cancelReason: "delivery_unavailable",
    });
  });

  it("cancels a reminder whose consent ended before the claim", async () => {
    const ended = await queuedReminder();
    await owner.execute(sql`update consent_record set ended_at = now(), end_reason = 'revoked'
      where participation_id = ${ended.participationId}`);
    expect(await sendReminder(deps(), ended.reminderId, "job-1", false)).toBe("settled");
    expect(
      outbox.list().filter((m) => m.idempotencyKey === `reminder:${ended.reminderId}`),
    ).toEqual([]);
    expect(await statusOf(ended.reminderId)).toMatchObject({ cancelReason: "consent_ended" });
  });

  it("runs as a pg-boss job queued in the request's transaction, its payload the id only", async () => {
    const jobLogs: string[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => jobLogs.push(line) });
    let jobs: Jobs | undefined;
    try {
      jobs = await startJobs({
        connectionString: testDatabaseUrls().app,
        lifecycleTime: "04:15",
        logger,
        work: {
          db,
          clock,
          facts: failClosedFacts,
          pollingIntervalSeconds: 0.5,
          notices: { mailer, smsSender, portalPublicUrl: PORTAL_URL },
          release: loadRelease(undefined),
        },
      });
      const withQueue = testApp({ clock, reminders: reminderQueue(jobs.boss) });
      const { participationId, address } = await activated();
      const auth = await login(withQueue.app, projectLead);
      expect((await remind([participationId], auth, withQueue.app)).status).toBe(201);
      const [row] = await rows();
      const { rows: payloads } = await owner.execute<{ data: unknown }>(
        sql`select data from pgboss.job where name = 'reminders.send'`,
      );
      expect(payloads).toEqual([{ data: { reminderId: row!.id } }]);
      for (let i = 0; i < 100 && (await rows())[0]!.status !== "sent"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await rows())[0]!.status).toBe("sent");
      const logged = jobLogs.join("\n");
      expect(logged).toContain(`"reminderId":"${row!.id}"`);
      for (const secret of [address, "Teilnehmerportal", "Erika", "Beispiel"]) {
        expect(logged).not.toContain(secret);
      }
      await withQueue.db.$client.end();
    } finally {
      await jobs?.stop();
    }
  });
});

describe("GET /participations/{id}/reminders", () => {
  it("lists the reminders for the PL, the assigned consultant and back office, without the address", async () => {
    const { participationId, address } = await activated();
    await remind([participationId]);
    await detached.settle();
    for (const auth of [staff[projectLead], staff[backOffice]]) {
      const res = await reminders(participationId, auth);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const page = await readJson(res, ReminderPage);
      expect(page.items.map((item) => [item.channel, item.status, item.kind])).toEqual([
        ["email", "sent", "open_items"],
      ]);
      expect(JSON.stringify(page)).not.toContain(address);
    }
    await expectProblem(await reminders(participationId, staff[consultant]), 403, "forbidden");
    await assign([participationId]);
    expect((await reminders(participationId, staff[consultant])).status).toBe(200);
    await expectProblem(await reminders(randomUUID()), 404, "not-found");
  });

  it("pages newest first with an opaque cursor", async () => {
    const { participationId } = await activated();
    await remind([participationId]);
    await detached.settle();
    await owner.execute(sql`update participant_reminder set requested_on = requested_on - 3`);
    await remind([participationId]);
    await detached.settle();
    const first = await readJson(
      await app.request(`/api/v1/participations/${participationId}/reminders?limit=1`, {
        headers: staff[projectLead],
      }),
      ReminderPage,
    );
    expect(first.items).toHaveLength(1);
    const second = await readJson(
      await app.request(
        `/api/v1/participations/${participationId}/reminders?limit=1&cursor=${first.nextCursor}`,
        { headers: staff[projectLead] },
      ),
      ReminderPage,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.requestedAt < first.items[0]!.requestedAt).toBe(true);
    expect(second.nextCursor).toBeNull();
  });
});

describe("the work list's reminder facts", () => {
  it("gives the PL the channel, back office nothing to send, and the latest reminder", async () => {
    const { participationId } = await activated();
    const itemOf = async (auth: { Cookie: string }) =>
      (
        await readJson(
          await app.request(`/api/v1/projects/${projectId}/worklist`, { headers: auth }),
          Worklist,
        )
      ).items.find((item) => item.id === participationId)!;
    expect((await itemOf(staff[projectLead]!)).capabilities.remind).toEqual({
      allowed: true,
      code: null,
      channel: "email",
    });
    expect((await itemOf(staff[backOffice]!)).capabilities.remind).toEqual({
      allowed: false,
      code: null,
      channel: null,
    });
    await remind([participationId]);
    await detached.settle();
    const item = await itemOf(staff[projectLead]!);
    expect(item.reminder).toEqual({ lastRequestedOn: expect.any(String), status: "sent" });
    expect(item.capabilities.remind.code).toBe("reminded_recently");
  });
});

const upgradeBody = (version = "portal-contact-consent:v2") => ({
  consent: true,
  consentVersion: version,
  language: "de",
});

describe("consent v2 in the portal (data-protection.md, consent v2)", () => {
  it("offers the upgrade for a v1 channel, upgrades once and then reminds", async () => {
    const { participationId, browser, channelId } = await activated();
    await makeV1(participationId);
    const me = await readJson(await browser.get("/me"), PortalMe);
    expect(me.channels.map((c) => c.consentUpgrade)).toEqual([true]);
    const activation = await readJson(
      await app.request(`/api/v1/participations/${participationId}/activation`, {
        headers: staff[projectLead],
      }),
      ParticipationActivation,
    );
    expect(activation.channels[0]!.consentVersion).toBe("portal-contact-consent:v1");
    const upgrade = () =>
      browser.post(`/channels/${channelId}/consent-upgrade`, {
        consent: true,
        consentVersion: "portal-contact-consent:v2",
        language: "de",
      });
    expect(await readJson(await upgrade(), ConsentUpgradeResult)).toEqual({ result: "upgraded" });
    expect(await readJson(await upgrade(), ConsentUpgradeResult)).toEqual({
      result: "already_current",
    });
    expect((await readJson(await browser.get("/me"), PortalMe)).channels[0]!.consentUpgrade).toBe(
      false,
    );
    const body = await readJson(await remind([participationId]), ReminderRequestResult);
    expect(body.queued).toHaveLength(1);
  });

  it("refuses another participant's channel, v1, and anyone without the portal session", async () => {
    const mine = await activated();
    const theirs = await activated();
    await expectProblem(
      await mine.browser.post(`/channels/${theirs.channelId}/consent-upgrade`, upgradeBody()),
      404,
      "not-found",
    );
    await expectProblem(
      await mine.browser.post(
        `/channels/${mine.channelId}/consent-upgrade`,
        upgradeBody("portal-contact-consent:v1"),
      ),
      400,
      "validation-error",
    );
    const staffTry = await app.request(
      `/api/v1/portal/channels/${mine.channelId}/consent-upgrade`,
      jsonRequest("POST", upgradeBody(), staff[projectLead]),
    );
    await expectProblem(staffTry, 401, "unauthenticated");
  });
});

describe("logs and responses", () => {
  it("never carry the address, the text or the participant's name", async () => {
    const { participationId, address } = await activated();
    const res = await remind([participationId]);
    answered.push(await res.clone().text());
    await detached.settle();
    const audit = JSON.stringify(await reminderEvents());
    for (const haystack of [logs.join("\n"), audit, answered.slice(-1).join("\n")]) {
      for (const secret of [address, "Teilnehmerportal", "Erika", "Beispiel"]) {
        expect(haystack).not.toContain(secret);
      }
    }
    expect(logs.join("\n")).toContain('"job":"reminders.send"');
  });
});
