import { DevelopmentOutbox, ManualClock, MockMailer, MockSmsSender } from "@transfer/adapters";
import {
  and,
  auditEvent,
  createDb,
  eq,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { changeStatus, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  BatchActivationCodeResult,
  ImportPreview,
  ParticipationDetail,
  ParticipationSelfService,
  PortalConsents,
  PortalSelfService,
  PortalSelfServiceWrite,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, origin, readJson, testApp } from "./testing";

// Self-service data in the portal and for staff (data-protection.md, self-service; Q112, Q138,
// Q139, Q140) against transfer_test. Synthetic values only.
const clock = new ManualClock(new Date("2026-10-21T10:00:00Z"));
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const { app, db, logs } = testApp({ clock, outbox, mailer, smsSender });
const owner = createDb(testDatabaseUrls().owner);
// The ta_only project pins only Süd: placing a participation with Nord pins Nord's latest (3).
const projectId = seedProjectIds.verwaltung;
const NOTICE = "self-service-purposes:v1";
const staff: Record<string, { Cookie: string }> = {};
/** Every response body of the test, to check that no value leaves where it mustn't. */
const answered: string[] = [];

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const user of ["projectLead", "consultant", "backOffice", "admin"] as const) {
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

async function person(personnelNumber = `SYN-${randomUUID().slice(-8)}`) {
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
    personnelNumber,
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
    mobile: "0171 3920000",
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
    answered.push(await res.clone().text());
    return res;
  };
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
    put: (path: string, body?: unknown) => request("PUT", path, body),
  };
}

const lastCode = () => /\b(\d{6})\b/.exec(outbox.list().at(-1)!.text)![1]!;

/** An activated participant of the ta_only project, with an active portal session. */
async function activated(address = "erika.privat@example.org") {
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
  await browser.post("/activation/channel", { kind: "email", address, language: "de" });
  const done = await browser.post("/activation/completion", {
    oneTimeCode: lastCode(),
    noticeVersion: "art14-activation:v1",
    consent: true,
    consentVersion: "portal-contact-consent:v1",
    language: "de",
  });
  expect(done.status).toBe(201);
  return { participationId, browser };
}

type Browser = ReturnType<typeof portal>;
const state = async (browser: Browser) =>
  readJson(await browser.get("/self-service"), PortalSelfService);
const acknowledge = (browser: Browser) =>
  browser.post("/self-service/notice", { version: NOTICE, language: "de" });
const save = (browser: Browser, page: string, values: object, revision: number) =>
  browser.put(`/self-service/pages/${page}`, { revision, values });

const placeAt = (participationId: string, agenturKey: string) =>
  app.request(
    `/api/v1/participations/${participationId}/placement-agentur`,
    jsonRequest("PUT", { agenturKey }, staff.projectLead),
  );

const post = (path: string, payload: object) =>
  app.request(
    `/api/v1/projects/${projectId}/${path}`,
    jsonRequest("POST", payload, staff.projectLead!),
  );

const errorsOf = async (res: Response, status = 422) => {
  const type = status === 409 ? "conflict" : "domain-error";
  return (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({
    code,
    pointer,
  }));
};

const required = (body: PortalSelfService) =>
  body.pages.flatMap((p) => p.fields.filter((f) => f.required).map((f) => f.key));

describe("GET /portal/self-service (Q140)", () => {
  it("shows the pages with the base TL 407 requirements, values, missing items and the notice", async () => {
    const { browser } = await activated();
    const res = await browser.get("/self-service");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await readJson(res, PortalSelfService);
    expect(body.pages.map((p) => [p.page, p.sensitive])).toEqual([
      ["personal", false],
      ["contact", false],
      ["ba_details", true],
      ["education", false],
      ["work_history", false],
      ["languages_mobility", false],
      ["job_wish", false],
      ["health", true],
    ]);
    expect(required(body)).toEqual([
      "gender",
      "maritalStatus",
      "address",
      "pensionInsuranceNumber",
      "nationality",
      "buergergeld",
      "educationHistory",
      "workHistory",
      "languageSkills",
      "drivingLicence",
      "vehicleAvailable",
      "workingTimePreferences",
      "jobWishes",
      "desiredWorkLocations",
      "maxCommuteDistance",
      "earliestStartDate",
      "healthRestrictions",
      "severeDisability",
    ]);
    expect(body).toMatchObject({
      revision: 0,
      notice: { version: NOTICE, acknowledged: false },
      identity: { firstName: "Erika", lastName: "Beispiel", birthDate: "1970-01-01" },
      values: { gender: null, mobile: "0171 3920000", address: { city: "Berlin" } },
      customValues: {},
    });
    expect(body.missing.map((item) => item.ruleId)).toContain("base-tl407-gender");
    expect(body.missing.map((item) => item.key)).not.toContain("address");
  });

  it("adds the placement Agentur's rules, custom field and help texts (template version 3)", async () => {
    const { participationId, browser } = await activated();
    expect((await placeAt(participationId, "beispielstadt-nord")).status).toBe(200);
    const body = await state(browser);
    expect(required(body)).toEqual(expect.arrayContaining(["mobile", "privateEmail"]));
    expect(body.pages.at(-1)).toEqual({
      page: "further",
      sensitive: false,
      complete: false,
      fields: [
        {
          key: "custom.beispiel_zusatznachweis_nr",
          required: true,
          helpText: {
            de: "Beispiel: Die Nummer steht oben rechts auf Ihrem Zusatznachweis.",
            en: "Sample: the number is at the top right of your additional certificate.",
          },
          custom: {
            label: {
              de: "Zusatznachweis-Nr. (Beispiel)",
              en: "Additional certificate no. (sample)",
            },
            schema: expect.objectContaining({ type: "string", maxLength: 40 }),
          },
        },
      ],
    });
    expect(body.missing.map((item) => item.ruleId)).toEqual(
      expect.arrayContaining([
        "beispielstadt-nord-private-email",
        "beispielstadt-nord-zusatznachweis",
      ]),
    );
  });

  it("needs an active session", async () => {
    await expectProblem(await portal().get("/self-service"), 401, "unauthenticated");
  });
});

describe("the purposes notice (Q138)", () => {
  it("must be acknowledged before the first write, once per version, audited", async () => {
    const { participationId, browser } = await activated();
    expect(await errorsOf(await save(browser, "personal", { gender: "female" }, 0), 409)).toEqual([
      { code: "notice_required", pointer: "" },
    ]);
    expect((await acknowledge(browser)).status).toBe(204);
    expect((await acknowledge(browser)).status).toBe(204);
    expect((await state(browser)).notice.acknowledged).toBe(true);
    const events = await owner
      .select({ type: auditEvent.eventType, actor: auditEvent.actorType })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.participationId, participationId),
          eq(auditEvent.eventType, "self_service_notice_acknowledged"),
        ),
      );
    expect(events).toEqual([{ type: "self_service_notice_acknowledged", actor: "participant" }]);
  });

  it("takes only the current version", async () => {
    const { browser } = await activated();
    await expectProblem(
      await browser.post("/self-service/notice", {
        version: "self-service-purposes:v0",
        language: "de",
      }),
      400,
      "validation-error",
    );
  });
});

describe("PUT /portal/self-service/pages/{page} (Q140)", () => {
  it("saves a page, bumps the revision and audits field names only", async () => {
    const { participationId, browser } = await activated();
    await acknowledge(browser);
    const res = await save(
      browser,
      "education",
      {
        educationHistory: [
          {
            from: "2005-09-01",
            to: "2004-07-15",
            institution: "Berufsschule Beispielstadt",
            qualification: "Industriemechaniker",
            completed: true,
          },
        ],
      },
      0,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res, PortalSelfServiceWrite);
    expect(body.revision).toBe(1);
    expect(body.warnings).toEqual([{ code: "from_after_to", path: ["educationHistory", 0] }]);
    expect(body.pages.find((p) => p.page === "education")!.complete).toBe(true);
    const events = await owner
      .select({ details: auditEvent.details, actor: auditEvent.actorType })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.participationId, participationId),
          eq(auditEvent.eventType, "participant_data_changed"),
        ),
      );
    expect(events).toEqual([{ details: { fields: ["educationHistory"] }, actor: "participant" }]);
    expect(logs.join("\n")).not.toContain("Industriemechaniker");
  });

  it("refuses a stale revision with 409", async () => {
    const { browser } = await activated();
    await acknowledge(browser);
    expect((await save(browser, "personal", { gender: "female" }, 0)).status).toBe(200);
    expect(await errorsOf(await save(browser, "personal", { gender: "male" }, 0), 409)).toEqual([
      { code: "stale_revision", pointer: "" },
    ]);
  });

  it("refuses invalid values with codes and locations, never the value", async () => {
    const { browser } = await activated();
    await acknowledge(browser);
    const res = await save(
      browser,
      "job_wish",
      {
        earliestStartDate: "2027-02-29",
        maxCommuteDistance: { kind: "km", km: 5000 },
        jobWishes: { desired: "Geheimwunsch", alternative: null, salary: 1 },
      },
      0,
    );
    expect(await errorsOf(res)).toEqual([
      { code: "unknown_field", pointer: "/values/jobWishes/salary" },
      { code: "out_of_range", pointer: "/values/maxCommuteDistance/km" },
      { code: "invalid_date", pointer: "/values/earliestStartDate" },
    ]);
    expect(answered.join("\n")).not.toMatch(/Geheimwunsch|5000|2027-02-29/);
    const outOfSet = await save(browser, "personal", { gender: "other" }, 0);
    expect(await errorsOf(outOfSet)).toEqual([
      { code: "value_not_allowed", pointer: "/values/gender" },
    ]);
  });

  it("accepts nothing sensitive: unknown keys are 422 and the sensitive pages aren't writable", async () => {
    const { browser } = await activated();
    await acknowledge(browser);
    const res = await save(browser, "personal", { gender: "male", nationality: "DE" }, 0);
    expect(await errorsOf(res)).toEqual([
      { code: "unknown_field", pointer: "/values/nationality" },
    ]);
    for (const page of ["health", "ba_details"]) {
      await expectProblem(
        await save(browser, page, { healthRestrictions: true }, 0),
        400,
        "validation-error",
      );
    }
  });

  it("validates custom fields with the participation's chain", async () => {
    const { participationId, browser } = await activated();
    await placeAt(participationId, "beispielstadt-nord");
    await acknowledge(browser);
    const key = "custom.beispiel_zusatznachweis_nr";
    expect(await errorsOf(await save(browser, "further", { [key]: "x".repeat(41) }, 0))).toEqual([
      { code: "too_long", pointer: `/values/${key}` },
    ]);
    const ok = await readJson(
      await save(browser, "further", { [key]: "ZN-123" }, 0),
      PortalSelfServiceWrite,
    );
    expect(ok.customValues).toEqual({ [key]: "ZN-123" });
    expect(ok.pages.at(-1)!.complete).toBe(true);
  });

  it("is refused for an activating session and once the participation is closed", async () => {
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
    const activating = portal();
    expect((await activating.post("/activation", { code })).status).toBe(200);
    await expectProblem(
      await save(activating, "personal", { gender: "male" }, 0),
      401,
      "unauthenticated",
    );

    const { participationId: closed, browser } = await activated();
    await acknowledge(browser);
    await changeStatus(owner.$client, closed, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-10-21",
    });
    // The terminal status ends the sessions; the function refuses it as closed too.
    await expectProblem(
      await save(browser, "personal", { gender: "male" }, 0),
      401,
      "unauthenticated",
    );
  });
});

describe("contact data (Q112) and the placement Agentur hint (Q139)", () => {
  const contact = {
    address: { street: "Neuer Weg 2", postalCode: "20095", city: "Hamburg", country: "DE" },
    phone: null,
    mobile: "0171 7654321",
    privateEmail: null,
  };

  it("makes written contact fields participant-maintained and asks to check the Agentur", async () => {
    const { participationId, browser } = await activated();
    await placeAt(participationId, "beispielstadt-nord");
    const before = await readJson(
      await app.request(`/api/v1/participations/${participationId}`, {
        headers: staff.projectLead,
      }),
      ParticipationDetail,
    );
    expect(before.hints).not.toContain("placement_agentur_check");
    await acknowledge(browser);
    expect((await save(browser, "contact", contact, 0)).status).toBe(200);
    const detail = await readJson(
      await app.request(`/api/v1/participations/${participationId}`, {
        headers: staff.projectLead,
      }),
      ParticipationDetail,
    );
    expect(detail.hints).toContain("placement_agentur_check");
    const view = await readJson(
      await app.request(`/api/v1/participations/${participationId}/self-service`, {
        headers: staff.projectLead,
      }),
      ParticipationSelfService,
    );
    expect(view.participantMaintained).toEqual(["address", "mobile"]);
  });

  it("is never overwritten by a re-import, which reports the difference by row and target", async () => {
    const number = "SYN-IMPORT-1";
    const { participationId, browser } = await activated();
    await owner
      .update(participantIdentity)
      .set({ personnelNumber: number })
      .where(eq(participantIdentity.participationId, participationId));
    await acknowledge(browser);
    await save(browser, "contact", contact, 0);
    const file = Buffer.from(
      [
        "Personalnummer;Nachname;Vorname;Geburtsdatum;Austrittsdatum;Straße;PLZ;Ort;Mobil",
        `${number};Beispiel;Erika;01.01.1970;31.03.2027;Importweg 9;10115;Berlin;0171 0000000`,
      ].join("\n"),
    ).toString("base64");
    const body = { file, country: "DE" };
    const first = await readJson(await post("imports/preview", body), ImportPreview);
    const mapping = first.suggestedMapping.map(({ column, target }) => ({ column, target }));
    const shown = await readJson(
      await post("imports/preview", { ...body, mapping }),
      ImportPreview,
    );
    const row = shown.report!.rows.find((r) => r.personnelNumber === number)!;
    expect(row.issues.filter((i) => i.code === "participant_maintained")).toEqual([
      { row: 2, target: "address", code: "participant_maintained", severity: "warning" },
      { row: 2, target: "mobile", code: "participant_maintained", severity: "warning" },
    ]);
    expect(JSON.stringify(row)).not.toMatch(/Hamburg|7654321/);
    const confirmed = await post("imports", {
      ...body,
      mapping,
      decisions: { confirmWarnings: true, possibleDuplicates: {} },
      previewToken: shown.previewToken,
    });
    expect(confirmed.status).toBe(200);
    const [details] = await owner
      .select({ city: participantDetails.addressCity, mobile: participantDetails.mobile })
      .from(participantDetails)
      .where(eq(participantDetails.participationId, participationId));
    expect(details).toEqual({ city: "Hamburg", mobile: "0171 7654321" });
  });
});

describe("GET /portal/consents (Q138)", () => {
  it("lists the participant's own consents without an address", async () => {
    const { browser } = await activated();
    const body = await readJson(await browser.get("/consents"), PortalConsents);
    expect(body.consents).toEqual([
      {
        id: expect.any(String),
        purpose: "portal_contact",
        source: "portal",
        textVersion: "portal-contact-consent:v1",
        language: "de",
        channelId: expect.any(String),
        givenAt: expect.stringMatching(/Z$/),
        endedAt: null,
        endReason: null,
      },
    ]);
    expect(answered.at(-1)).not.toContain("erika.privat");
  });
});

describe("GET /participations/{id}/self-service (normal mode)", () => {
  it("shows the PL and back office the confidential values and the missing items", async () => {
    const { participationId, browser } = await activated();
    await acknowledge(browser);
    await save(browser, "personal", { gender: "female", maritalStatus: "single" }, 0);
    for (const user of ["projectLead", "backOffice"]) {
      const res = await app.request(`/api/v1/participations/${participationId}/self-service`, {
        headers: staff[user],
      });
      expect(res.status).toBe(200);
      const view = await readJson(res, ParticipationSelfService);
      expect(view).toMatchObject({
        participationId,
        revision: 1,
        notice: { version: NOTICE, acknowledgedAt: expect.stringMatching(/Z$/) },
        values: { gender: "female", maritalStatus: "single", mobile: "0171 3920000" },
      });
      expect(view.missing.map((item) => item.ruleId)).toContain("base-tl407-workHistory");
    }
  });

  it("is a 403 for an unassigned consultant and an admin, a 404 for no participation", async () => {
    const { participationId } = await activated();
    for (const user of ["consultant", "admin"]) {
      await expectProblem(
        await app.request(`/api/v1/participations/${participationId}/self-service`, {
          headers: staff[user],
        }),
        403,
        "forbidden",
      );
    }
    await expectProblem(
      await app.request(`/api/v1/participations/${randomUUID()}/self-service`, {
        headers: staff.projectLead,
      }),
      404,
      "not-found",
    );
    await expectProblem(
      await app.request(`/api/v1/participations/${participationId}/self-service`, {
        headers: { Origin: origin },
      }),
      401,
      "unauthenticated",
    );
  });
});
