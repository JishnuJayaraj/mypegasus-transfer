import { DevelopmentOutbox, ManualClock, MockMailer, MockSmsSender } from "@transfer/adapters";
import {
  and,
  auditEvent,
  createDb,
  eq,
  inArray,
  participantAccount,
  participantAssignment,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  BatchActivationCodeResult,
  ParticipationSelfService,
  ParticipationSensitiveValues,
  PortalSelfService,
  PortalSelfServiceWrite,
  PortalSensitiveValues,
  PortalStepUp,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The encrypted self-service fields and the step-up in the portal and for staff (ADR-0002,
// encryption; ADR-0007, step-up; data-protection.md, self-service; Q135, Q137) against
// transfer_test. Synthetic values only.
const clock = new ManualClock(new Date("2026-10-21T10:00:00Z"));
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const { app, db, logs, detached } = testApp({ clock, outbox, mailer, smsSender });
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.verwaltung;
const NOTICE = "self-service-purposes:v1";
const ADDRESS = "erika.privat@example.org";
const staff: Record<string, { Cookie: string }> = {};
/** Every response body of the test, to check where a value leaves. */
const answered: { path: string; body: string }[] = [];

const RV = "65170839J003";
const baDetails = {
  pensionInsuranceNumber: RV,
  nationality: { kind: "other", country: "PL" },
  entryToGermanyDate: "2015-09-05",
  residenceStatus: "settlement_permit",
  buergergeld: false,
};
const health = { healthRestrictions: true, severeDisability: false };
/** Values that must leave only through the sensitive routes. */
const secrets = [RV, "settlement_permit", "2015-09-05", '"PL"'];

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const user of ["projectLead", "consultant", "backOffice"] as const) {
    staff[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
  answered.length = 0;
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

/** A browser on the portal: keeps the portal cookie as the server sets and clears it. */
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
    answered.push({ path, body: await res.clone().text() });
    return res;
  };
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
    put: (path: string, body?: unknown) => request("PUT", path, body),
  };
}
type Browser = ReturnType<typeof portal>;

const lastCode = () => /\b(\d{6})\b/.exec(outbox.list().at(-1)!.text)![1]!;

/** An activated participant (letter, birth-date step) with the session that follows it. */
async function activated() {
  const participationId = await person();
  const res = await app.request(
    `/api/v1/projects/${projectId}/activation-codes`,
    jsonRequest(
      "POST",
      { participationIds: [participationId], channel: "letter", language: "de" },
      staff.projectLead,
    ),
  );
  const code = (await readJson(res, BatchActivationCodeResult)).items[0]!.code;
  const browser = portal();
  await browser.post("/activation", { code });
  await browser.post("/activation/birth-date", { birthDate: "1970-01-01" });
  await browser.post("/activation/channel", { kind: "email", address: ADDRESS, language: "de" });
  const done = await browser.post("/activation/completion", {
    oneTimeCode: lastCode(),
    noticeVersion: "art14-activation:v1",
    consent: true,
    consentVersion: "portal-contact-consent:v2",
    language: "de",
  });
  expect(done.status).toBe(201);
  expect(
    (await browser.post("/self-service/notice", { version: NOTICE, language: "de" })).status,
  ).toBe(204);
  return { participationId, browser };
}

/** A new session through a login code: the step-up isn't carried over. */
async function loggedIn() {
  const browser = portal();
  await browser.post("/login/code-request", { kind: "email", address: ADDRESS, language: "de" });
  await detached.settle();
  const res = await browser.post("/login", {
    kind: "email",
    address: ADDRESS,
    oneTimeCode: lastCode(),
  });
  expect(res.status).toBe(200);
  return browser;
}

const state = async (browser: Browser) =>
  readJson(await browser.get("/self-service"), PortalSelfService);
const saveGroup = (browser: Browser, group: string, values: object, revision: number) =>
  browser.put(`/self-service/sensitive/${group}`, { revision, values });

const codesOf = async (res: Response, status: number, type: string) =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));

const audited = (participationId: string, types: string[]) =>
  owner
    .select({
      type: auditEvent.eventType,
      actor: auditEvent.actorType,
      details: auditEvent.details,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.participationId, participationId),
        inArray(auditEvent.eventType, types as never),
      ),
    )
    .orderBy(auditEvent.seq);

/** No log line and no audit row carries a value; only the sensitive GETs answer with one. */
async function expectNoValueLeft(participationId: string) {
  const trail = JSON.stringify(
    await owner.select().from(auditEvent).where(eq(auditEvent.participationId, participationId)),
  );
  // A sensitive GET's values are its own; a problem from any route never names one.
  const elsewhere = answered.filter(
    ({ path, body }) => !path.startsWith("/self-service/sensitive/") || body.includes('"type"'),
  );
  for (const value of secrets) {
    expect(logs.join("\n")).not.toContain(value);
    expect(trail).not.toContain(value);
    expect(elsewhere.filter(({ body }) => body.includes(value)).map(({ path }) => path)).toEqual(
      [],
    );
  }
}

describe("the sensitive groups in the portal (Q135)", () => {
  it("write encrypted, read back on their own route and show presence elsewhere", async () => {
    const { participationId, browser } = await activated();
    const before = await state(browser);
    expect(before.sensitive).toEqual({
      pensionInsuranceNumber: false,
      nationality: false,
      entryToGermanyDate: false,
      residenceStatus: false,
      buergergeld: false,
      healthRestrictions: false,
      severeDisability: false,
    });
    expect(before.missing.map((m) => m.key)).toEqual(
      expect.arrayContaining(["pensionInsuranceNumber", "nationality", "buergergeld"]),
    );

    const res = await saveGroup(browser, "ba_details", baDetails, before.revision);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const after = await readJson(res, PortalSelfServiceWrite);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.sensitive).toMatchObject({
      pensionInsuranceNumber: true,
      nationality: true,
      entryToGermanyDate: true,
      residenceStatus: true,
      buergergeld: true,
      healthRestrictions: false,
    });
    expect(after.pages.find((p) => p.page === "ba_details")!.complete).toBe(true);
    expect(after.missing.map((m) => m.key)).not.toContain("pensionInsuranceNumber");

    const read = await browser.get("/self-service/sensitive/ba_details");
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(read, PortalSensitiveValues)).toEqual({
      group: "ba_details",
      values: baDetails,
    });
    expect(
      (await audited(participationId, ["sensitive_write", "sensitive_read"])).map((e) => [
        e.type,
        e.actor,
        e.details,
      ]),
    ).toEqual([
      ...Object.keys(baDetails).map((key) => ["sensitive_write", "participant", { key }]),
      ...Object.keys(baDetails).map((key) => ["sensitive_read", "participant", { key }]),
    ]);
    await expectNoValueLeft(participationId);
  });

  it("refuses invalid values with codes and locations, never the value", async () => {
    const { participationId, browser } = await activated();
    const res = await saveGroup(browser, "ba_details", { healthRestrictions: true }, 0);
    expect(await codesOf(res, 422, "domain-error")).toEqual([
      { code: "unknown_field", pointer: "/values/healthRestrictions" },
    ]);
    const bad = await saveGroup(
      browser,
      "ba_details",
      { ...baDetails, pensionInsuranceNumber: "65170839j003", nationality: { kind: "german" } },
      0,
    );
    expect(await codesOf(bad, 422, "domain-error")).toEqual([
      { code: "pension_insurance_number_invalid", pointer: "/values/pensionInsuranceNumber" },
      { code: "not_applicable", pointer: "/values/entryToGermanyDate" },
      { code: "not_applicable", pointer: "/values/residenceStatus" },
    ]);
    expect(
      await codesOf(await saveGroup(browser, "ba_details", baDetails, 7), 409, "conflict"),
    ).toEqual([{ code: "stale_revision", pointer: "" }]);
    expect(answered.at(-2)!.body).not.toContain("65170839j003");
    await expectNoValueLeft(participationId);
  });

  it("keeps the values off the staff projection and the participation list", async () => {
    const { participationId, browser } = await activated();
    await saveGroup(browser, "ba_details", baDetails, 0);
    for (const path of [
      `/api/v1/participations/${participationId}/self-service`,
      `/api/v1/participations/${participationId}`,
      `/api/v1/projects/${projectId}/participations`,
    ]) {
      const res = await app.request(path, { headers: staff.backOffice });
      const body = await res.text();
      expect({ path, status: res.status, leaked: secrets.filter((v) => body.includes(v)) }).toEqual(
        { path, status: 200, leaked: [] },
      );
    }
    const view = ParticipationSelfService.parse(
      await (
        await app.request(`/api/v1/participations/${participationId}/self-service`, {
          headers: staff.backOffice,
        })
      ).json(),
    );
    expect(Object.keys(view.values)).not.toContain("pensionInsuranceNumber");
  });
});

describe("the step-up (Q137)", () => {
  it("counts the session after an activation with the birth-date step", async () => {
    const { browser } = await activated();
    expect((await state(browser)).stepUp).toEqual({ method: "birth_date", done: true });
    expect((await saveGroup(browser, "health", health, 0)).status).toBe(200);
    expect(
      await readJson(await browser.get("/self-service/sensitive/health"), PortalSensitiveValues),
    ).toEqual({ group: "health", values: health });
  });

  it("gates health for a login session until the birth date is entered again", async () => {
    const { participationId } = await activated();
    const browser = await loggedIn();
    expect((await state(browser)).stepUp).toEqual({ method: "birth_date", done: false });
    for (const res of [
      await browser.get("/self-service/sensitive/health"),
      await saveGroup(browser, "health", health, 0),
    ]) {
      expect(await codesOf(res, 403, "forbidden")).toEqual([
        { code: "step_up_required", pointer: "" },
      ]);
    }
    // The highly confidential group needs none.
    expect((await browser.get("/self-service/sensitive/ba_details")).status).toBe(200);

    expect(
      await codesOf(
        await browser.post("/step-up/birth-date", { birthDate: "1971-01-01" }),
        422,
        "domain-error",
      ),
    ).toEqual([{ code: "knowledge_check_failed", pointer: "" }]);
    const ok = await browser.post("/step-up/birth-date", { birthDate: "1970-01-01" });
    expect(await readJson(ok, PortalStepUp)).toEqual({ method: "birth_date", done: true });
    expect((await saveGroup(browser, "health", health, 0)).status).toBe(200);
    expect(
      (await audited(participationId, ["step_up_completed"])).map((e) => [e.actor, e.details]),
    ).toEqual([["participant", { method: "birth_date" }]]);
    expect(logs.join("\n")).not.toContain("1971-01-01");
  });

  it("ends the session at the fifth wrong birth date", async () => {
    const { participationId } = await activated();
    const browser = await loggedIn();
    for (let i = 0; i < 4; i += 1) {
      const res = await browser.post("/step-up/birth-date", { birthDate: "1971-01-01" });
      expect(res.status).toBe(422);
    }
    const fifth = await browser.post("/step-up/birth-date", { birthDate: "1971-01-01" });
    expect(await codesOf(fifth, 422, "domain-error")).toEqual([
      { code: "step_up_failed", pointer: "" },
    ]);
    expect(fifth.headers.get("set-cookie")).toMatch(/tp_portal=;/);
    expect((await browser.get("/self-service")).status).toBe(401);
    expect(await audited(participationId, ["step_up_failed"])).toEqual([
      { type: "step_up_failed", actor: "participant", details: { method: "birth_date" } },
    ]);
  });

  it("sends a photo-ID account a step-up code; the login code doesn't count", async () => {
    const { participationId } = await activated();
    // Fixture: an account assured by photo ID (a handed-over sheet or an in-person code).
    await owner
      .update(participantAccount)
      .set({
        identityAssurance: "photo_id",
        identityAssuredBy: seedStaffUserIds.backOffice,
        identityAssuredAt: "2026-10-01T10:00:00Z",
      })
      .where(eq(participantAccount.participationId, participationId));
    const browser = await loggedIn();
    const loginCode = lastCode();
    expect((await state(browser)).stepUp).toEqual({ method: "photo_id_and_code", done: false });
    expect(
      await codesOf(
        await browser.post("/step-up/birth-date", { birthDate: "1970-01-01" }),
        422,
        "domain-error",
      ),
    ).toEqual([{ code: "step_not_allowed", pointer: "" }]);
    expect(
      await codesOf(
        await browser.post("/step-up/code", { oneTimeCode: loginCode }),
        422,
        "domain-error",
      ),
    ).toEqual([{ code: "one_time_code_invalid", pointer: "" }]);

    const { channels } = (await (await browser.get("/channels")).json()) as {
      channels: { id: string }[];
    };
    expect(
      (await browser.post("/step-up/code-request", { channelId: randomUUID(), language: "en" }))
        .status,
    ).toBe(404);
    const sent = await browser.post("/step-up/code-request", {
      channelId: channels[0]!.id,
      language: "en",
    });
    expect(sent.status).toBe(202);
    expect(outbox.list().at(-1)).toMatchObject({ to: ADDRESS });
    const ok = await browser.post("/step-up/code", { oneTimeCode: lastCode() });
    expect(await readJson(ok, PortalStepUp)).toEqual({ method: "photo_id_and_code", done: true });
    expect((await saveGroup(browser, "health", health, 0)).status).toBe(200);
    for (const { body } of answered) expect(body).not.toContain(ADDRESS);
  });
});

async function written() {
  const { participationId, browser } = await activated();
  await saveGroup(browser, "ba_details", baDetails, 0);
  await saveGroup(browser, "health", health, 1);
  return participationId;
}
const staffRead = (participationId: string, group: string, user: string) =>
  app.request(`/api/v1/participations/${participationId}/self-service/sensitive/${group}`, {
    headers: staff[user],
  });

describe("GET /participations/{id}/self-service/sensitive/{group} (normal mode)", () => {
  it("gives the assigned consultant every field, each read audited as the user", async () => {
    const participationId = await written();
    expect((await staffRead(participationId, "health", "consultant")).status).toBe(403);
    await owner.insert(participantAssignment).values({
      projectId,
      participationId,
      staffUserId: seedStaffUserIds.consultant,
      assignedBy: seedStaffUserIds.projectLead,
    });
    const res = await staffRead(participationId, "health", "consultant");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(res, ParticipationSensitiveValues)).toEqual({
      participationId,
      group: "health",
      values: health,
    });
    const reads = await audited(participationId, ["sensitive_read"]);
    expect(reads.filter((e) => e.actor === "user").map((e) => e.details)).toEqual([
      { key: "healthRestrictions" },
      { key: "severeDisability" },
    ]);
  });

  it("gives back office what the matrix allows, hiding the rest; the PL nothing", async () => {
    const participationId = await written();
    expect(
      await readJson(
        await staffRead(participationId, "health", "backOffice"),
        ParticipationSensitiveValues,
      ),
    ).toEqual({ participationId, group: "health", values: { severeDisability: false } });
    expect(
      (
        await readJson(
          await staffRead(participationId, "ba_details", "backOffice"),
          ParticipationSensitiveValues,
        )
      ).values,
    ).toEqual(baDetails);
    await expectProblem(
      await staffRead(participationId, "health", "projectLead"),
      403,
      "forbidden",
    );
    await expectProblem(await staffRead(randomUUID(), "health", "backOffice"), 404, "not-found");
    expect(logs.join("\n")).not.toContain(RV);
  });
});
