import { DevelopmentOutbox, ManualClock, MockMailer, MockSmsSender } from "@transfer/adapters";
import {
  activationCode,
  auditEvent,
  createDb,
  eq,
  oneTimeCodeChallenge,
  participantChannel,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  ActivationState,
  BatchActivationCodeResult,
  ParticipationActivation,
  ParticipationPage,
  PortalMe,
} from "@transfer/domain";
import { failClosedFacts } from "./participations/guard-facts";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sendActivationNotice } from "./jobs/activation-notice";
import { activationNoticeQueue, startJobs, type Jobs } from "./jobs/jobs";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Slice 3 plan, PR 3e: the portal activation API (D21–D29) end to end against transfer_test.
const clock = new ManualClock(new Date("2026-10-21T10:00:00Z"));
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const { app, db, logs } = testApp({ clock, outbox, mailer, smsSender });
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.werkNord;
let staff: { Cookie: string };
/** Everything the API answered in a test, to check that no secret ever leaves it. */
const answered: string[] = [];

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  staff = await login(app, seedStaffUserIds.projectLead);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  outbox.mode = "sent";
  logs.length = 0;
  answered.length = 0;
  // A new throttle window for every test (D14: 10 submissions per 15 minutes and IP).
  clock.set(new Date(clock.now().getTime() + 16 * 60_000));
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

async function person(options: { birthDate?: string | null } = {}) {
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
    birthDate: options.birthDate === undefined ? "1970-01-01" : options.birthDate,
  });
  await owner.insert(participantDetails).values({
    participationId: id,
    projectId,
    addressStreet: "Musterweg 1",
    addressPostalCode: "10115",
    addressCity: "Berlin",
    addressCountry: "DE",
    workEmail: "erika.beispiel@werk.example",
  });
  return id;
}

/** A printed letter's code, as the PL's print view shows it (`XXXX-XXXX-XXXX`). */
async function letter(participationId: string) {
  const res = await app.request(
    `/api/v1/projects/${projectId}/activation-codes`,
    jsonRequest(
      "POST",
      { participationIds: [participationId], channel: "letter", language: "de" },
      staff,
    ),
  );
  return (await readJson(res, BatchActivationCodeResult)).items[0]!.code;
}

/** A browser on the portal: keeps the portal cookie as the server sets and clears it. */
function portal() {
  let cookie: string | undefined;
  const request = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
    const res = await app.request(
      `/api/v1/portal${path}`,
      method === "GET" ? { headers } : jsonRequest(method, body ?? {}, headers),
    );
    const set = res.headers.get("set-cookie");
    if (set) {
      const value = set.split(";")[0]!;
      cookie = value.endsWith("=") ? undefined : value;
    }
    answered.push(`${set ?? ""}\n${await res.clone().text()}`);
    return res;
  };
  return {
    get cookie() {
      return cookie;
    },
    post: (path: string, body?: unknown) => request("POST", path, body),
    get: (path: string) => request("GET", path),
  };
}

const completion = (verification: { oneTimeCode: string } | { deliveryAddress: string }) => ({
  ...verification,
  noticeVersion: "art14-activation:v1",
  consent: true,
  consentVersion: "portal-contact-consent:v2",
  language: "de",
});

const lastOneTimeCode = () => /\b(\d{6})\b/.exec(outbox.list().at(-1)!.text)![1]!;

/** Activates a letter's participation through the portal; returns the browser and its secrets. */
async function activateByLetter(address = " Erika.Privat@Example.org ") {
  const participationId = await person();
  const code = await letter(participationId);
  const browser = portal();
  expect((await browser.post("/activation", { code: code.toLowerCase() })).status).toBe(200);
  expect((await browser.post("/activation/birth-date", { birthDate: "1970-01-01" })).status).toBe(
    200,
  );
  expect(
    (await browser.post("/activation/channel", { kind: "email", address, language: "de" })).status,
  ).toBe(202);
  const oneTimeCode = lastOneTimeCode();
  const done = await browser.post("/activation/completion", completion({ oneTimeCode }));
  return { participationId, code, browser, oneTimeCode, done };
}

/** Checks that no response, log line or audit row carried a code, address or hash. */
async function expectNoSecrets(secrets: string[]) {
  const codeHashes = (
    await owner.select({ hash: activationCode.codeHash }).from(activationCode)
  ).map((row) => row.hash);
  const challenges = await owner
    .select({ hash: oneTimeCodeChallenge.codeHash, address: oneTimeCodeChallenge.address })
    .from(oneTimeCodeChallenge);
  const audit = JSON.stringify(await owner.select().from(auditEvent));
  const needles = [
    ...secrets,
    ...codeHashes,
    ...challenges.flatMap((challenge) => [challenge.hash, challenge.address]),
  ];
  for (const haystack of [answered.join("\n"), logs.join("\n"), audit]) {
    for (const needle of needles) expect(haystack).not.toContain(needle);
  }
}

describe("portal activation by letter (D22–D25, D28, D29)", () => {
  it("walks code, birth date, channel and one-time code into an active session", async () => {
    const participationId = await person();
    const code = await letter(participationId);
    const browser = portal();

    const started = await browser.post("/activation", { code: ` ${code.toLowerCase()} ` });
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(started, ActivationState)).toEqual({
      nextStep: "birth_date",
      purpose: "activation",
      channel: "letter",
      deliveryKind: null,
      language: "de",
      noticeVersion: "art14-activation:v1",
      consentVersion: "portal-contact-consent:v2",
    });
    expect(browser.cookie).toMatch(/^__Host-tp_portal=/);
    const activatingCookie = browser.cookie;

    const checked = await browser.post("/activation/birth-date", { birthDate: "1970-01-01" });
    expect((await readJson(checked, ActivationState)).nextStep).toBe("channel");
    const sent = await browser.post("/activation/channel", {
      kind: "email",
      address: " Erika.Privat@Example.org ",
      language: "en",
    });
    expect(sent.status).toBe(202);
    expect((await readJson(sent, ActivationState)).nextStep).toBe("one_time_code");
    const message = outbox.list().at(-1)!;
    expect(message).toMatchObject({ kind: "email", to: "erika.privat@example.org" });
    expect(message.text).toMatch(/Your confirmation code is \d{6}/);
    const oneTimeCode = lastOneTimeCode();

    const done = await browser.post("/activation/completion", completion({ oneTimeCode }));
    expect(done.status).toBe(201);
    const me = await readJson(done, PortalMe);
    expect(me).toMatchObject({
      firstName: "Erika",
      language: "de",
      channels: [{ kind: "email", maskedAddress: "e…@example.org" }],
    });
    expect(browser.cookie).not.toBe(activatingCookie);
    expect((await browser.get("/me")).status).toBe(200);

    // The old token is dead; the status moved by the participant; staff see the account.
    const stale = await app.request("/api/v1/portal/me", {
      headers: { Cookie: activatingCookie! },
    });
    await expectProblem(stale, 401, "unauthenticated");
    const [row] = await owner
      .select({ status: participation.status })
      .from(participation)
      .where(eq(participation.id, participationId));
    expect(row).toEqual({ status: "contacted" });
    const staffView = await readJson(
      await app.request(`/api/v1/participations/${participationId}/activation`, { headers: staff }),
      ParticipationActivation,
    );
    expect(staffView.status.account).toBe("activated");
    expect(staffView.account).toMatchObject({ identityAssurance: "birth_date" });
    expect(staffView.channels).toEqual([
      expect.objectContaining({ kind: "email", verifiedBy: "one_time_code", consentEndedAt: null }),
    ]);
    const list = await readJson(
      await app.request(`/api/v1/projects/${projectId}/participations?activation=activated`, {
        headers: staff,
      }),
      ParticipationPage,
    );
    expect(list.items.map((item) => item.id)).toEqual([participationId]);

    await expectNoSecrets([
      code,
      code.replaceAll("-", ""),
      oneTimeCode,
      "erika.privat@example.org",
      "Erika.Privat",
    ]);
  });

  it("answers every unusable code with the one generic code_invalid and counts nothing", async () => {
    const browser = portal();
    for (const code of ["not-a-code", "0000-0000-0000"]) {
      const body = await expectProblem(
        await browser.post("/activation", { code }),
        422,
        "domain-error",
      );
      expect(body.errors).toEqual([expect.objectContaining({ code: "code_invalid" })]);
    }
    const participationId = await person();
    const code = await letter(participationId);
    await owner.update(activationCode).set({
      revokedAt: sql`now()`,
      revokeReason: "lost",
      revokedBy: seedStaffUserIds.projectLead,
    });
    const revoked = await browser.post("/activation", { code });
    expect((await expectProblem(revoked, 422, "domain-error")).errors![0]!.code).toBe(
      "code_invalid",
    );
    expect(
      (await owner.select({ n: activationCode.failedAttempts }).from(activationCode)).map(
        (r) => r.n,
      ),
    ).toEqual([0]);
    expect(browser.cookie).toBeUndefined();
  });

  it("counts wrong birth dates and locks the code at the fifth with the generic answer", async () => {
    const participationId = await person();
    const browser = portal();
    await browser.post("/activation", { code: await letter(participationId) });
    for (let i = 0; i < 4; i++) {
      const wrong = await browser.post("/activation/birth-date", { birthDate: "1971-02-02" });
      expect((await expectProblem(wrong, 422, "domain-error")).errors![0]!.code).toBe(
        "knowledge_check_failed",
      );
    }
    const locked = await browser.post("/activation/birth-date", { birthDate: "1971-02-02" });
    expect((await expectProblem(locked, 422, "domain-error")).errors![0]!.code).toBe(
      "code_invalid",
    );
    expect(browser.cookie).toBeUndefined();
    const events = await owner
      .select({ type: auditEvent.eventType, actor: auditEvent.actorType })
      .from(auditEvent)
      .where(eq(auditEvent.participationId, participationId));
    expect(events).toContainEqual({ type: "activation_code_locked", actor: "system" });
  });

  it("throttles every code submission per IP (D14)", async () => {
    const browser = portal();
    for (let i = 0; i < 10; i++) {
      expect((await browser.post("/activation", { code: "0000-0000-0000" })).status).toBe(422);
    }
    const limited = await browser.post("/activation", { code: "0000-0000-0000" });
    const body = await expectProblem(limited, 429, "too-many-requests");
    expect(body.errors![0]!.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses a wrong one-time code without activating", async () => {
    const participationId = await person();
    const browser = portal();
    await browser.post("/activation", { code: await letter(participationId) });
    await browser.post("/activation/birth-date", { birthDate: "1970-01-01" });
    await browser.post("/activation/channel", {
      kind: "sms",
      address: "0151 2345678",
      language: "de",
    });
    expect(outbox.list().at(-1)).toMatchObject({ kind: "sms", to: "+491512345678" });
    const wrong = String((Number(lastOneTimeCode()) + 1) % 1_000_000).padStart(6, "0");
    const refused = await browser.post(
      "/activation/completion",
      completion({ oneTimeCode: wrong }),
    );
    expect((await expectProblem(refused, 422, "domain-error")).errors![0]!.code).toBe(
      "one_time_code_invalid",
    );
    expect(await owner.select().from(participantChannel)).toEqual([]);
  });

  it("refuses the imported work email and an address another account holds", async () => {
    const first = await activateByLetter("taken@example.org");
    expect(first.done.status).toBe(201);
    const participationId = await person();
    const browser = portal();
    await browser.post("/activation", { code: await letter(participationId) });
    await browser.post("/activation/birth-date", { birthDate: "1970-01-01" });
    for (const [address, code] of [
      ["erika.beispiel@werk.example", "channel_invalid"],
      ["Taken@Example.org", "channel_in_use"],
      ["no address", "channel_invalid"],
    ] as const) {
      const refused = await browser.post("/activation/channel", {
        kind: "email",
        address,
        language: "de",
      });
      expect((await expectProblem(refused, 422, "domain-error")).errors![0]!.code).toBe(code);
    }
  });

  it("records the send's outcome: a failure is a 503, an unknown outcome stays usable (D20)", async () => {
    const participationId = await person();
    const browser = portal();
    await browser.post("/activation", { code: await letter(participationId) });
    await browser.post("/activation/birth-date", { birthDate: "1970-01-01" });
    outbox.mode = "failed";
    const failed = await browser.post("/activation/channel", {
      kind: "email",
      address: "a@example.org",
      language: "de",
    });
    expect((await expectProblem(failed, 503, "service-unavailable")).errors![0]!.code).toBe(
      "delivery_failed",
    );
    outbox.mode = "unknown";
    expect(
      (
        await browser.post("/activation/channel", {
          kind: "email",
          address: "a@example.org",
          language: "de",
        })
      ).status,
    ).toBe(202);
    outbox.mode = "sent";
    const done = await browser.post(
      "/activation/completion",
      completion({ oneTimeCode: lastOneTimeCode() }),
    );
    expect(done.status).toBe(201);
    expect(logs.join("\n")).not.toContain("a@example.org");
  });

  it("refuses a one-time code send without a provider before a challenge exists", async () => {
    const production = testApp({ clock, env: { nodeEnv: "production" } });
    const participationId = await person();
    const code = await letter(participationId);
    const start = await production.app.request(
      "/api/v1/portal/activation",
      jsonRequest("POST", { code }),
    );
    const cookie = { Cookie: start.headers.get("set-cookie")!.split(";")[0]! };
    await production.app.request(
      "/api/v1/portal/activation/birth-date",
      jsonRequest("POST", { birthDate: "1970-01-01" }, cookie),
    );
    const refused = await production.app.request(
      "/api/v1/portal/activation/channel",
      jsonRequest("POST", { kind: "email", address: "a@example.org", language: "de" }, cookie),
    );
    expect((await expectProblem(refused, 503, "service-unavailable")).errors![0]!.code).toBe(
      "delivery_unavailable",
    );
    expect(await owner.select().from(oneTimeCodeChallenge)).toEqual([]);
    await production.db.$client.end();
  });

  it("allows only the activation steps in an activating session", async () => {
    const browser = portal();
    await browser.post("/activation", { code: await letter(await person()) });
    await expectProblem(await browser.get("/me"), 401, "unauthenticated");
    const early = await browser.post("/activation/channel", {
      kind: "email",
      address: "a@example.org",
      language: "de",
    });
    expect((await expectProblem(early, 422, "domain-error")).errors![0]!.code).toBe(
      "step_not_allowed",
    );
    await expectProblem(
      await app.request(
        "/api/v1/portal/activation/birth-date",
        jsonRequest("POST", { birthDate: "1970-01-01" }),
      ),
      401,
      "unauthenticated",
    );
  });
});

describe("portal activation in person (D23, Q129)", () => {
  it("retypes the address the link came to; a mismatch counts; no birth date means photo ID", async () => {
    const participationId = await person({ birthDate: null });
    const issued = await app.request(
      `/api/v1/participations/${participationId}/activation-codes/in-person`,
      jsonRequest(
        "POST",
        {
          deliveryKind: "sms",
          deliveryAddress: "0171 3920000",
          language: "en",
          identityChecked: true,
        },
        staff,
      ),
    );
    expect(issued.status).toBe(201);
    const link = /https:\/\/\S+#([0-9A-Z]{12})/.exec(outbox.list().at(-1)!.text)!;
    const code = link[1]!;
    const browser = portal();
    const started = await readJson(await browser.post("/activation", { code }), ActivationState);
    expect(started).toMatchObject({
      nextStep: "delivery_address",
      deliveryKind: "sms",
      language: "en",
    });

    const wrong = await browser.post("/activation/delivery-address", {
      deliveryAddress: "0171 3920001",
    });
    expect((await expectProblem(wrong, 422, "domain-error")).errors![0]!.code).toBe(
      "knowledge_check_failed",
    );
    const matched = await browser.post("/activation/delivery-address", {
      deliveryAddress: "+49 171 3920000",
    });
    expect((await readJson(matched, ActivationState)).nextStep).toBe("complete");
    const done = await browser.post(
      "/activation/completion",
      completion({ deliveryAddress: "01713920000" }),
    );
    expect(done.status).toBe(201);
    expect((await readJson(done, PortalMe)).channels).toEqual([
      expect.objectContaining({ kind: "sms", maskedAddress: "+49 … 000" }),
    ]);
    const staffView = await readJson(
      await app.request(`/api/v1/participations/${participationId}/activation`, { headers: staff }),
      ParticipationActivation,
    );
    expect(staffView.account).toMatchObject({ identityAssurance: "photo_id" });
    expect(staffView.channels[0]).toMatchObject({ verifiedBy: "activation_link" });
    await expectNoSecrets([code, "+491713920000", "0171 3920000"]);
  });
});

describe("portal sessions (D29)", () => {
  it("logs out: ends the session, clears the cookie and audits it", async () => {
    const { browser, participationId } = await activateByLetter();
    expect((await browser.post("/logout")).status).toBe(204);
    expect(browser.cookie).toBeUndefined();
    const events = await owner
      .select({ type: auditEvent.eventType })
      .from(auditEvent)
      .where(eq(auditEvent.participationId, participationId));
    expect(events.at(-1)).toEqual({ type: "participant_logout" });
  });

  it("ends a session idle for 30 minutes", async () => {
    const { browser } = await activateByLetter();
    await owner.execute(
      sql`update participant_session set last_seen_at = now() - interval '31 minutes'`,
    );
    await expectProblem(await browser.get("/me"), 401, "unauthenticated");
  });

  it("refuses a portal POST from a foreign origin (D4)", async () => {
    const res = await app.request("/api/v1/portal/activation", {
      method: "POST",
      body: JSON.stringify({ code: "0000-0000-0000" }),
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    });
    await expectProblem(res, 403, "forbidden");
  });

  it("logs portal requests with the participation id, never a code or address", async () => {
    const { participationId, code } = await activateByLetter();
    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ route: "/api/v1/portal/activation/completion", participationId }),
    );
    expect(logs.join("\n")).not.toContain(code);
  });
});

describe("the activation notice job (D21)", () => {
  const jobLogs: string[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => jobLogs.push(line) });
  let jobs: Jobs | undefined;
  afterAll(() => jobs?.stop());

  it("is queued in the completion's transaction and sent once with its idempotency key", async () => {
    jobs = await startJobs({
      connectionString: testDatabaseUrls().app,
      lifecycleTime: "04:15",
      logger,
      work: {
        db,
        clock,
        facts: failClosedFacts,
        pollingIntervalSeconds: 0.5,
        notices: { mailer, smsSender, portalPublicUrl: "https://portal.test/portal/" },
      },
    });
    const withQueue = testApp({
      clock,
      outbox,
      mailer,
      smsSender,
      activationNotices: activationNoticeQueue(jobs.boss),
    });
    const participationId = await person();
    const issued = await withQueue.app.request(
      `/api/v1/projects/${projectId}/activation-codes`,
      jsonRequest(
        "POST",
        { participationIds: [participationId], channel: "letter", language: "de" },
        await login(withQueue.app, seedStaffUserIds.projectLead),
      ),
    );
    const code = (await readJson(issued, BatchActivationCodeResult)).items[0]!.code;
    const post = (path: string, body: unknown, cookie?: string) =>
      withQueue.app.request(
        `/api/v1/portal${path}`,
        jsonRequest("POST", body, cookie ? { Cookie: cookie } : {}),
      );
    const started = await post("/activation", { code });
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    await post("/activation/birth-date", { birthDate: "1970-01-01" }, cookie);
    await post(
      "/activation/channel",
      { kind: "email", address: "notice@example.org", language: "de" },
      cookie,
    );
    const done = await post(
      "/activation/completion",
      completion({ oneTimeCode: lastOneTimeCode() }),
      cookie,
    );
    expect(done.status).toBe(201);
    const [channel] = await owner.select().from(participantChannel);
    const key = `activation-notice:${channel!.id}`;
    for (let i = 0; i < 100 && !outbox.list().some((m) => m.idempotencyKey === key); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const notice = outbox.list().find((m) => m.idempotencyKey === key);
    expect(notice).toMatchObject({ kind: "email", to: "notice@example.org" });
    expect(notice!.text).toContain("https://portal.test/portal/");
    for (let i = 0; i < 50; i++) {
      const [row] = await owner
        .select({ sent: participantChannel.noticeSentAt })
        .from(participantChannel);
      if (row!.sent) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // A second run (pg-boss delivers at least once) finds it sent and sends nothing more.
    expect(
      await sendActivationNotice(
        { db, logger, mailer, smsSender, portalPublicUrl: "x" },
        channel!.id,
        "job-2",
      ),
    ).toBe("skipped");
    expect(outbox.list().filter((m) => m.idempotencyKey === key)).toHaveLength(1);
    expect(jobLogs.join("\n")).not.toContain("notice@example.org");
    await withQueue.db.$client.end();
  });

  it("keeps a retry after a lost response from sending twice", async () => {
    const { participationId } = await activateByLetter("retry@example.org");
    const [channel] = await owner
      .select({ id: participantChannel.id })
      .from(participantChannel)
      .where(eq(participantChannel.participationId, participationId));
    const deps = { db, logger, mailer, smsSender, portalPublicUrl: "https://portal.test/portal/" };
    outbox.mode = "unknown";
    await expect(sendActivationNotice(deps, channel!.id, "job-1")).rejects.toMatchObject({
      code: "delivery_unknown",
    });
    outbox.mode = "sent";
    expect(await sendActivationNotice(deps, channel!.id, "job-1")).toBe("sent");
    expect(await sendActivationNotice(deps, channel!.id, "job-1")).toBe("skipped");
    expect(
      outbox.list().filter((m) => m.idempotencyKey === `activation-notice:${channel!.id}`),
    ).toHaveLength(1);
  });
});
