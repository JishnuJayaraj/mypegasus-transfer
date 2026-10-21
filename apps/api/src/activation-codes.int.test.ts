import { DevelopmentOutbox, ManualClock, MockMailer, MockSmsSender } from "@transfer/adapters";
import {
  activationCode,
  and,
  createDb,
  eq,
  participantDetails,
  participantIdentity,
  participation,
  privacyNoticeDelivery,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  BatchActivationCodeResult,
  ParticipationActivation,
  ParticipationPage,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

const clock = new ManualClock(new Date("2026-10-21T10:00:00Z"));
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const { app, db, logs } = testApp({ clock, outbox, mailer, smsSender });
const owner = createDb(testDatabaseUrls().owner);
const auth: Record<string, { Cookie: string }> = {};
const projectId = seedProjectIds.werkNord;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const user of ["projectLead", "backOffice", "consultant", "admin"] as const) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  outbox.mode = "sent";
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

async function person(options: { birthDate?: string | null; address?: boolean } = {}) {
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
    ...(options.address === false
      ? {}
      : {
          addressStreet: "Musterweg 1",
          addressPostalCode: "10115",
          addressCity: "Berlin",
          addressCountry: "DE",
        }),
  });
  return id;
}

const issueBatch = (
  participationIds: string[],
  channel: "letter" | "sheet" = "letter",
  user = "projectLead",
  replaceOpenCode = false,
) =>
  app.request(
    `/api/v1/projects/${projectId}/activation-codes`,
    jsonRequest("POST", { participationIds, channel, language: "de", replaceOpenCode }, auth[user]),
  );

const issueInPerson = (
  participationId: string,
  user = "projectLead",
  deliveryKind: "email" | "sms" = "email",
) =>
  app.request(
    `/api/v1/participations/${participationId}/activation-codes/in-person`,
    jsonRequest(
      "POST",
      {
        deliveryKind,
        deliveryAddress: deliveryKind === "email" ? "Erika@Example.org" : "0171 3920000",
        language: "de",
        identityChecked: true,
        replaceOpenCode: false,
      },
      auth[user],
    ),
  );

const activation = (participationId: string, user = "projectLead") =>
  app.request(`/api/v1/participations/${participationId}/activation`, {
    headers: auth[user],
  });

describe("activation-code issuance API", () => {
  it("issues a no-store letter batch all or nothing and never logs its codes", async () => {
    const complete = await person();
    const incomplete = await person({ birthDate: null });
    const refused = await issueBatch([complete, incomplete]);
    expect((await expectProblem(refused, 422, "domain-error")).errors).toContainEqual(
      expect.objectContaining({ code: "birth_date_required" }),
    );
    expect(await owner.select().from(activationCode)).toEqual([]);

    const response = await issueBatch([complete]);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await readJson(response, BatchActivationCodeResult);
    const [item] = body.items;
    expect(item).toMatchObject({
      participationId: complete,
      firstName: "Erika",
      lastName: "Beispiel",
      noticeVersion: "art14-activation:v1",
      noticeLanguage: "de",
    });
    expect(new URL(item!.activationUrl).hash).toBe(`#${item!.code.replaceAll("-", "")}`);
    expect(logs.join("\n")).not.toContain(item!.code);
    expect(logs.join("\n")).not.toContain("Musterweg");
  });

  it("allows project lead and back office, but no consultant, admin or anonymous caller", async () => {
    const ids = [await person(), await person(), await person(), await person(), await person()];
    expect((await issueBatch([ids[0]!], "sheet", "projectLead")).status).toBe(201);
    expect((await issueBatch([ids[1]!], "sheet", "backOffice")).status).toBe(201);
    await expectProblem(await issueBatch([ids[2]!], "sheet", "consultant"), 403, "forbidden");
    await expectProblem(await issueBatch([ids[3]!], "sheet", "admin"), 403, "forbidden");
    const anonymous = await app.request(
      `/api/v1/projects/${projectId}/activation-codes`,
      jsonRequest("POST", {
        participationIds: [ids[4]!],
        channel: "sheet",
        language: "de",
        replaceOpenCode: false,
      }),
    );
    expect(anonymous.status).toBe(401);
  });

  it("sends an in-person secret after commit and returns no code, destination or hash", async () => {
    const participationId = await person({ birthDate: null, address: false });
    const response = await issueInPerson(participationId);
    expect(response.status).toBe(201);
    const body = await readJson(response, ParticipationActivation);
    expect(body.status.code).toBe("open");
    expect(body.current).toMatchObject({ deliveryKind: "email", deliveryStatus: "sent" });
    const [message] = outbox.list().slice(-1);
    expect(message).toMatchObject({ kind: "email", to: "erika@example.org" });
    const code = /activate#([0-9A-HJKMNP-TV-Z]{12})/.exec(message!.text)?.[1];
    expect(code).toBeDefined();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("erika@example.org");
    expect(serialised).not.toContain(code!);

    expect(message!.text).toContain("https://portal.test/portal/activate#");
    expect(message!.text).toContain("https://portal.test/portal/notice/art14/art14-activation:v1");
    const [stored] = await owner
      .select({ hash: activationCode.deliveryAddressHash })
      .from(activationCode)
      .where(eq(activationCode.participationId, participationId));
    expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.hash).not.toContain("example");
    expect(
      await owner
        .select()
        .from(privacyNoticeDelivery)
        .where(eq(privacyNoticeDelivery.participationId, participationId)),
    ).toHaveLength(1);
  });

  it("revokes a definitive delivery failure and keeps an unknown outcome valid and visible", async () => {
    const failedId = await person({ address: false });
    outbox.mode = "failed";
    const failed = await issueInPerson(failedId, "projectLead", "sms");
    expect((await expectProblem(failed, 503, "service-unavailable")).errors).toContainEqual(
      expect.objectContaining({ code: "delivery_failed" }),
    );
    expect((await readJson(await activation(failedId), ParticipationActivation)).status.code).toBe(
      "revoked",
    );

    const unknownId = await person({ address: false });
    outbox.mode = "unknown";
    expect((await issueInPerson(unknownId, "backOffice", "sms")).status).toBe(201);
    const unknown = await readJson(await activation(unknownId), ParticipationActivation);
    expect(unknown.status.code).toBe("delivery_unknown");
    expect(unknown.current?.deliveryStatus).toBe("unknown");
    expect(
      await owner
        .select()
        .from(privacyNoticeDelivery)
        .where(eq(privacyNoticeDelivery.participationId, unknownId)),
    ).toEqual([]);
  });

  it("treats any provider error as an unknown outcome and never logs it", async () => {
    const failing = testApp({
      clock,
      outbox,
      mailer: {
        send: () => Promise.reject(new Error("rejected recipient erika@example.org")),
      },
      smsSender,
    });
    const participationId = await person({ address: false });
    const response = await failing.app.request(
      `/api/v1/participations/${participationId}/activation-codes/in-person`,
      jsonRequest(
        "POST",
        {
          deliveryKind: "email",
          deliveryAddress: "erika@example.org",
          language: "en",
          identityChecked: true,
        },
        await login(failing.app, seedStaffUserIds.projectLead),
      ),
    );
    expect(response.status).toBe(201);
    const body = await readJson(response, ParticipationActivation);
    expect(body.status.code).toBe("delivery_unknown");
    expect(body.current?.noticeLanguage).toBe("en");
    expect(failing.logs.join("\n")).not.toContain("example.org");
    await failing.db.$client.end();
  });

  it("refuses in-person issuance before any code exists when no provider is configured", async () => {
    const production = testApp({ clock, env: { nodeEnv: "production" } });
    const participationId = await person({ address: false });
    const response = await production.app.request(
      `/api/v1/participations/${participationId}/activation-codes/in-person`,
      jsonRequest(
        "POST",
        { deliveryKind: "sms", deliveryAddress: "0171 3920000", identityChecked: true },
        await login(production.app, seedStaffUserIds.projectLead),
      ),
    );
    expect((await expectProblem(response, 503, "service-unavailable")).errors).toContainEqual(
      expect.objectContaining({ code: "delivery_unavailable" }),
    );
    expect(
      await owner
        .select()
        .from(activationCode)
        .where(eq(activationCode.participationId, participationId)),
    ).toEqual([]);
    await production.db.$client.end();
  });
});

describe("handover, revocation and list state", () => {
  it("binds handover and revocation actions to the participation in the path", async () => {
    const first = await person();
    const second = await person();
    const issued = await readJson(await issueBatch([first], "sheet"), BatchActivationCodeResult);
    const activationCodeId = issued.items[0]!.activationCodeId;
    const action = (participationId: string, path: "handover" | "revocation") =>
      app.request(
        `/api/v1/participations/${participationId}/activation-codes/${path}`,
        jsonRequest(
          "POST",
          path === "handover"
            ? { activationCodeId }
            : { activationCodeId, reason: "not_handed_over" },
          auth.projectLead,
        ),
      );
    await expectProblem(await action(second, "handover"), 404, "not-found");
    await expectProblem(await action(second, "revocation"), 404, "not-found");
    expect((await readJson(await activation(first), ParticipationActivation)).status.code).toBe(
      "printed",
    );
    expect((await action(first, "handover")).status).toBe(200);
    expect((await readJson(await activation(first), ParticipationActivation)).status.code).toBe(
      "open",
    );
  });

  it("filters before pagination by activation and notice state", async () => {
    const none = await person();
    const printed = await person();
    await issueBatch([printed], "sheet");
    const response = await app.request(
      `/api/v1/projects/${projectId}/participations?limit=1&activation=printed&privacyNotice=due`,
      { headers: auth.projectLead },
    );
    const page = await readJson(response, ParticipationPage);
    expect(page.items.map(({ id }) => id)).toEqual([printed]);
    expect(page.items[0]).toMatchObject({
      activationStatus: { code: "printed" },
      privacyNoticeState: { state: "due" },
    });
    expect(page.items.some(({ id }) => id === none)).toBe(false);
  });

  it("returns only non-secret activation metadata and hides inaccessible participations", async () => {
    const participationId = await person();
    await issueBatch([participationId]);
    const body = await readJson(await activation(participationId), ParticipationActivation);
    expect(body.current).toMatchObject({
      channel: "letter",
      issuedBy: seedStaffUserIds.projectLead,
      issuedByDisplayName: "Petra Projektleitung",
      failedAttempts: 0,
      attemptsLeft: 5,
    });
    expect(JSON.stringify(body)).not.toContain("codeHash");
    expect(JSON.stringify(body)).not.toContain("deliveryAddress");
    await expectProblem(await activation(participationId, "consultant"), 403, "forbidden");
    await expectProblem(await activation(randomUUID()), 404, "not-found");
  });

  it("stores one notice-only letter for the requested participation", async () => {
    const participationId = await person();
    const response = await app.request(
      `/api/v1/projects/${projectId}/privacy-notices`,
      jsonRequest(
        "POST",
        { participationIds: [participationId], language: "en" },
        auth.projectLead,
      ),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      await owner
        .select({ method: privacyNoticeDelivery.method })
        .from(privacyNoticeDelivery)
        .where(
          and(
            eq(privacyNoticeDelivery.participationId, participationId),
            eq(privacyNoticeDelivery.method, "letter"),
          ),
        ),
    ).toEqual([{ method: "letter" }]);
  });
});
