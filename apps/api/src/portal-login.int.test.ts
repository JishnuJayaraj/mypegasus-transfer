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
  ChannelRemovalResult,
  ParticipationActivation,
  PortalChannels,
  PortalMe,
  RecoveryCodeResult,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, origin, readJson, testApp } from "./testing";

// PR 3f: portal login (ADR-0007), channels (Q123) and lost-access recovery (Q130) end to
// end against transfer_test.
const clock = new ManualClock(new Date("2026-10-21T10:00:00Z"));
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const { app, db, logs, detached } = testApp({ clock, outbox, mailer, smsSender });
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.werkNord;
const PRIVATE = "erika.privat@example.org";
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
  // A new throttle window for every test: 10 code submissions per 15 minutes and IP (Q128) and
  // 5 login codes per address and hour (ADR-0007).
  nextWindow(61);
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

function nextWindow(minutes = 16) {
  clock.set(new Date(clock.now().getTime() + minutes * 60_000));
}

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
    workEmail: "erika.beispiel@werk.example",
  });
  return id;
}

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
    const init =
      method === "GET"
        ? { headers }
        : method === "DELETE"
          ? { method, headers: { ...headers, Origin: origin } }
          : jsonRequest(method, body ?? {}, headers);
    const res = await app.request(`/api/v1/portal${path}`, init);
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
    delete: (path: string) => request("DELETE", path),
  };
}

const lastCode = () => /\b(\d{6})\b/.exec(outbox.list().at(-1)!.text)![1]!;

const completion = (oneTimeCode: string) => ({
  oneTimeCode,
  noticeVersion: "art14-activation:v1",
  consent: true,
  consentVersion: "portal-contact-consent:v1",
  language: "de",
});

/** Activates a letter's participation through the portal with `address` as its channel. */
async function activated(address = PRIVATE) {
  const participationId = await person();
  const code = await letter(participationId);
  const browser = portal();
  await browser.post("/activation", { code });
  await browser.post("/activation/birth-date", { birthDate: "1970-01-01" });
  await browser.post("/activation/channel", { kind: "email", address, language: "de" });
  const done = await browser.post("/activation/completion", completion(lastCode()));
  expect(done.status).toBe(201);
  return { participationId, code, browser };
}

/** Requests a login code and waits for its detached send. */
async function requestLoginCode(
  browser: ReturnType<typeof portal>,
  address: string,
  kind = "email",
) {
  const res = await browser.post("/login/code-request", { kind, address, language: "de" });
  await detached.settle();
  return res;
}

const events = (participationId: string) =>
  owner
    .select({ type: auditEvent.eventType, reason: auditEvent.reasonCode })
    .from(auditEvent)
    .where(eq(auditEvent.participationId, participationId))
    .orderBy(auditEvent.seq);

/** Checks that no response, log line or audit row carried a code, address or hash. */
async function expectNoSecrets(secrets: string[]) {
  const codeHashes = (
    await owner.select({ hash: activationCode.codeHash }).from(activationCode)
  ).map((row) => row.hash);
  const challenges = await owner
    .select({ hash: oneTimeCodeChallenge.codeHash, address: oneTimeCodeChallenge.address })
    .from(oneTimeCodeChallenge);
  const channels = await owner
    .select({ address: participantChannel.address })
    .from(participantChannel);
  const audit = JSON.stringify(await owner.select().from(auditEvent));
  const needles = [
    ...secrets,
    ...codeHashes,
    ...challenges.flatMap((challenge) => [challenge.hash, challenge.address]),
    ...channels.map((channel) => channel.address),
  ];
  for (const haystack of [answered.join("\n"), logs.join("\n"), audit]) {
    for (const needle of needles) expect(haystack).not.toContain(needle);
  }
}

describe("portal login (ADR-0007)", () => {
  it("sends a code with a link and logs in with it once, audited", async () => {
    const { participationId, browser } = await activated();
    expect((await browser.post("/logout")).status).toBe(204);
    nextWindow();

    const requested = await requestLoginCode(browser, " Erika.Privat@Example.org ");
    expect(requested.status).toBe(202);
    expect(await requested.text()).toBe("");
    expect(browser.cookie).toBeUndefined();
    const message = outbox.list().at(-1)!;
    expect(message).toMatchObject({ kind: "email", to: PRIVATE });
    const code = lastCode();
    expect(message.text).toContain(`Ihr Anmeldecode lautet ${code}`);
    // The link carries the code in the fragment only; the page posts it on a click.
    expect(message.text).toContain(`https://portal.test/portal/login#${code}`);

    const loggedIn = await browser.post("/login", {
      kind: "email",
      address: PRIVATE,
      oneTimeCode: code,
    });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(loggedIn, PortalMe)).toMatchObject({
      firstName: "Erika",
      channels: [{ kind: "email", maskedAddress: "e…@example.org" }],
    });
    expect(browser.cookie).toMatch(/^__Host-tp_portal=/);
    expect((await browser.get("/me")).status).toBe(200);
    expect((await events(participationId)).at(-1)).toEqual({
      type: "participant_login",
      reason: null,
    });

    // Single use: the same code again is the generic answer.
    const again = portal();
    const body = await expectProblem(
      await again.post("/login", { kind: "email", address: PRIVATE, oneTimeCode: code }),
      422,
      "domain-error",
    );
    expect(body.errors).toEqual([expect.objectContaining({ code: "one_time_code_invalid" })]);
    await expectNoSecrets([code, PRIVATE, "Erika.Privat"]);
  });

  it("answers an unknown address exactly like a known one and sends nothing", async () => {
    await activated();
    const sent = outbox.list().length;
    const browser = portal();
    const unknown = await requestLoginCode(browser, "nobody@example.org");
    expect(unknown.status).toBe(202);
    expect(await unknown.text()).toBe("");
    expect(outbox.list()).toHaveLength(sent);
    // A mobile no account registered, and the imported work email: the same.
    expect((await requestLoginCode(browser, "0151 00000000", "sms")).status).toBe(202);
    expect((await requestLoginCode(browser, "erika.beispiel@werk.example")).status).toBe(202);
    expect(outbox.list()).toHaveLength(sent);
    expect(
      await owner
        .select()
        .from(oneTimeCodeChallenge)
        .where(sql`purpose = 'login'`),
    ).toEqual([]);
    for (const address of ["nobody@example.org", PRIVATE]) {
      const body = await expectProblem(
        await browser.post("/login", { kind: "email", address, oneTimeCode: "123456" }),
        422,
        "domain-error",
      );
      expect(body.errors).toEqual([expect.objectContaining({ code: "one_time_code_invalid" })]);
    }
    // Not an address at all is a syntax error, which says nothing about any account.
    const malformed = await expectProblem(
      await browser.post("/login/code-request", { kind: "email", address: "nobody" }),
      422,
      "domain-error",
    );
    expect(malformed.errors).toEqual([expect.objectContaining({ code: "channel_invalid" })]);
  });

  it("kills a code after five wrong entries with the same generic answer", async () => {
    await activated();
    nextWindow();
    const browser = portal();
    await requestLoginCode(browser, PRIVATE);
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const body = await expectProblem(
        await browser.post("/login", { kind: "email", address: PRIVATE, oneTimeCode: wrong }),
        422,
        "domain-error",
      );
      expect(body.errors).toEqual([expect.objectContaining({ code: "one_time_code_invalid" })]);
    }
    await expectProblem(
      await browser.post("/login", { kind: "email", address: PRIVATE, oneTimeCode: code }),
      422,
      "domain-error",
    );
    expect(browser.cookie).toBeUndefined();
  });

  it("refuses the sixth code request an hour per address with a 429, known or not", async () => {
    await activated();
    nextWindow();
    const browser = portal();
    const sent = outbox.list().length;
    for (let i = 0; i < 5; i++) expect((await requestLoginCode(browser, PRIVATE)).status).toBe(202);
    // The activation's verification code counts too (ADR-0007): the fifth login code went nowhere.
    expect(outbox.list().length - sent).toBe(4);
    const limited = await requestLoginCode(browser, PRIVATE);
    await expectProblem(limited, 429, "too-many-requests");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    nextWindow();
    for (let i = 0; i < 5; i++)
      expect((await requestLoginCode(browser, "nobody@example.org")).status).toBe(202);
    await expectProblem(
      await requestLoginCode(browser, "nobody@example.org"),
      429,
      "too-many-requests",
    );
  });

  it("records a failed send after the 202 and invalidates the code (ADR-0006)", async () => {
    await activated();
    outbox.mode = "failed";
    const browser = portal();
    expect((await requestLoginCode(browser, PRIVATE)).status).toBe(202);
    const [challenge] = await owner
      .select({
        delivery: oneTimeCodeChallenge.deliveryStatus,
        reason: oneTimeCodeChallenge.invalidationReason,
      })
      .from(oneTimeCodeChallenge)
      .where(sql`purpose = 'login'`);
    expect(challenge).toEqual({ delivery: "failed", reason: "delivery_failed" });
    expect(logs.join("\n")).not.toContain(PRIVATE);
  });

  it("refuses a code request without a provider before a challenge exists", async () => {
    const production = testApp({ clock, env: { nodeEnv: "production" } });
    const refused = await production.app.request(
      "/api/v1/portal/login/code-request",
      jsonRequest("POST", { kind: "sms", address: "0151 00000000" }),
    );
    expect((await expectProblem(refused, 503, "service-unavailable")).errors![0]!.code).toBe(
      "delivery_unavailable",
    );
    expect(await owner.select().from(oneTimeCodeChallenge)).toEqual([]);
    await production.db.$client.end();
  });
});

describe("portal channels (Q123)", () => {
  it("adds a verified channel with its consent and removes one with its consent ended", async () => {
    const { participationId, browser } = await activated();
    const listed = await readJson(await browser.get("/channels"), PortalChannels);
    expect(listed.channels).toEqual([expect.objectContaining({ kind: "email" })]);

    const requested = await browser.post("/channels", {
      kind: "sms",
      address: "0151 2345 6789",
      language: "en",
    });
    expect(requested.status).toBe(202);
    expect(outbox.list().at(-1)).toMatchObject({ kind: "sms", to: "+4915123456789" });
    const code = lastCode();
    const added = await browser.post("/channels/verification", {
      oneTimeCode: code,
      consent: true,
      consentVersion: "portal-contact-consent:v1",
      language: "en",
    });
    expect(added.status).toBe(201);
    const { channels } = await readJson(added, PortalChannels);
    expect(channels.map((channel) => [channel.kind, channel.maskedAddress])).toEqual([
      ["email", "e…@example.org"],
      ["sms", "+49 … 789"],
    ]);

    const first = channels[0]!.id;
    const removed = await browser.delete(`/channels/${first}`);
    expect(await readJson(removed, ChannelRemovalResult)).toEqual({ sessionEnded: false });
    expect((await browser.get("/me")).status).toBe(200);
    const staffView = await readJson(
      await app.request(`/api/v1/participations/${participationId}/activation`, {
        headers: staff,
      }),
      ParticipationActivation,
    );
    expect(
      staffView.channels.map((c) => [c.kind, c.removedAt !== null, c.consentEndedAt !== null]),
    ).toEqual([
      ["email", true, true],
      ["sms", false, false],
    ]);
    expect((await events(participationId)).slice(-4)).toEqual([
      { type: "consent_given", reason: null },
      { type: "contact_channel_added", reason: null },
      { type: "consent_ended", reason: "revoked" },
      { type: "contact_channel_removed", reason: "consent_revoked" },
    ]);
    // The removed address no longer logs in.
    nextWindow();
    const sent = outbox.list().length;
    await requestLoginCode(portal(), PRIVATE);
    expect(outbox.list()).toHaveLength(sent);
    await expectNoSecrets([code, PRIVATE, "+4915123456789", "0151 2345 6789"]);
  });

  it("ends every session when the last channel goes", async () => {
    const { browser } = await activated();
    const { channels } = await readJson(await browser.get("/channels"), PortalChannels);
    const removed = await browser.delete(`/channels/${channels[0]!.id}`);
    expect(await readJson(removed, ChannelRemovalResult)).toEqual({ sessionEnded: true });
    expect(browser.cookie).toBeUndefined();
    await expectProblem(await browser.get("/me"), 401, "unauthenticated");
  });

  it("refuses a taken or work address generically and someone else's channel as not found", async () => {
    const other = await activated("other@example.org");
    const { browser } = await activated();
    for (const [address, code] of [
      ["other@example.org", "channel_in_use"],
      [PRIVATE, "channel_in_use"],
      ["erika.beispiel@werk.example", "channel_invalid"],
    ] as const) {
      const body = await expectProblem(
        await browser.post("/channels", { kind: "email", address, language: "de" }),
        422,
        "domain-error",
      );
      expect(body.errors).toEqual([expect.objectContaining({ code })]);
      expect(JSON.stringify(body)).not.toContain(other.participationId);
    }
    const [otherChannel] = await owner
      .select({ id: participantChannel.id })
      .from(participantChannel)
      .where(eq(participantChannel.participationId, other.participationId));
    await expectProblem(await browser.delete(`/channels/${otherChannel!.id}`), 404, "not-found");
    const wrong = await expectProblem(
      await browser.post("/channels/verification", {
        oneTimeCode: "123456",
        consent: true,
        consentVersion: "portal-contact-consent:v1",
        language: "de",
      }),
      422,
      "domain-error",
    );
    expect(wrong.errors).toEqual([expect.objectContaining({ code: "one_time_code_invalid" })]);
  });

  it("needs an active session", async () => {
    const browser = portal();
    await expectProblem(await browser.get("/channels"), 401, "unauthenticated");
    await expectProblem(
      await browser.post("/channels", { kind: "email", address: PRIVATE, language: "de" }),
      401,
      "unauthenticated",
    );
    await expectProblem(await browser.delete(`/channels/${randomUUID()}`), 401, "unauthenticated");
  });
});

describe("lost-access recovery (Q130)", () => {
  it("ends the sessions and suspends the channels at issuance; completion replaces them", async () => {
    const { participationId, browser } = await activated();
    const issued = await app.request(
      `/api/v1/participations/${participationId}/activation-codes`,
      jsonRequest(
        "POST",
        { purpose: "recovery", channel: "letter", language: "de", identityVerified: true },
        staff,
      ),
    );
    expect(issued.status).toBe(201);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const { item, activation } = await readJson(issued, RecoveryCodeResult);
    expect(item).toMatchObject({ participationId, firstName: "Erika", noticeLanguage: "de" });
    expect(activation.current).toMatchObject({ purpose: "recovery", channel: "letter" });
    expect(activation.status).toMatchObject({ account: "activated", code: "open" });
    expect(activation.channels).toEqual([
      expect.objectContaining({ kind: "email", suspendedAt: expect.any(String), removedAt: null }),
    ]);
    // At once: the participant's session is dead and the old address logs in no more.
    await expectProblem(await browser.get("/me"), 401, "unauthenticated");
    const sent = outbox.list().length;
    await requestLoginCode(portal(), PRIVATE);
    expect(outbox.list()).toHaveLength(sent);

    nextWindow();
    const recovering = portal();
    const started = await recovering.post("/activation", { code: item!.code });
    expect(await readJson(started, ActivationState)).toMatchObject({
      purpose: "recovery",
      nextStep: "birth_date",
    });
    await recovering.post("/activation/birth-date", { birthDate: "1970-01-01" });
    await recovering.post("/activation/channel", {
      kind: "sms",
      address: "0151 9876 5432",
      language: "de",
    });
    const done = await recovering.post("/activation/completion", completion(lastCode()));
    expect(done.status).toBe(201);
    expect((await readJson(done, PortalMe)).channels).toEqual([
      expect.objectContaining({ kind: "sms", maskedAddress: "+49 … 432" }),
    ]);
    const after = await readJson(
      await app.request(`/api/v1/participations/${participationId}/activation`, {
        headers: staff,
      }),
      ParticipationActivation,
    );
    expect(after.status).toMatchObject({ account: "activated", code: "used" });
    expect(
      after.channels.map((c) => [c.kind, c.removedAt !== null, c.consentEndedAt !== null]),
    ).toEqual([
      ["email", true, true],
      ["sms", false, false],
    ]);
    const types = (await events(participationId)).map((event) => event.type);
    expect(types).toContain("contact_channels_suspended");
    expect(types.at(-1)).toBe("participant_login");
    const [row] = await owner
      .select({ status: participation.status })
      .from(participation)
      .where(eq(participation.id, participationId));
    expect(row).toEqual({ status: "contacted" });
    await expectNoSecrets([item!.code, item!.code.replaceAll("-", ""), PRIVATE, "+4915198765432"]);
  });

  it("sends an in-person recovery to the typed address and never returns it", async () => {
    const { participationId } = await activated();
    const issued = await app.request(
      `/api/v1/participations/${participationId}/activation-codes`,
      jsonRequest(
        "POST",
        {
          purpose: "recovery",
          channel: "in_person",
          language: "en",
          identityVerified: true,
          identityChecked: true,
          deliveryKind: "email",
          deliveryAddress: "New.Address@Example.org",
        },
        staff,
      ),
    );
    expect(issued.status).toBe(201);
    const result = await readJson(issued, RecoveryCodeResult);
    expect(result.item).toBeNull();
    expect(result.activation.current).toMatchObject({
      purpose: "recovery",
      channel: "in_person",
      deliveryStatus: "sent",
    });
    expect(outbox.list().at(-1)).toMatchObject({ kind: "email", to: "new.address@example.org" });
    await expectNoSecrets(["new.address@example.org", "New.Address"]);
  });

  it("refuses a recovery for an account not activated and needs the staff's confirmation", async () => {
    const participationId = await person();
    const body = await expectProblem(
      await app.request(
        `/api/v1/participations/${participationId}/activation-codes`,
        jsonRequest(
          "POST",
          { purpose: "recovery", channel: "sheet", identityVerified: true },
          staff,
        ),
      ),
      422,
      "domain-error",
    );
    expect(body.errors).toEqual([expect.objectContaining({ code: "not_activated" })]);
    await expectProblem(
      await app.request(
        `/api/v1/participations/${participationId}/activation-codes`,
        jsonRequest("POST", { purpose: "recovery", channel: "sheet" }, staff),
      ),
      400,
      "validation-error",
    );
    const consultant = await login(app, seedStaffUserIds.consultant);
    await expectProblem(
      await app.request(
        `/api/v1/participations/${participationId}/activation-codes`,
        jsonRequest(
          "POST",
          { purpose: "recovery", channel: "sheet", identityVerified: true },
          consultant,
        ),
      ),
      403,
      "forbidden",
    );
  });
});
