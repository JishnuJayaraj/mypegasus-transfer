import { MemoryFileStorage, MockHtmlRenderer, pageCount, PdfLibRenderer } from "@transfer/adapters";
import { loadFont } from "@transfer/forms/load";
import { createDb, seedProjectIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  DocumentOpening,
  DsvGenerationResult,
  DsvTemplateView,
  DsvView,
  ParticipationDetail,
  type PrintDocument,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The tab "DSV" (process-and-lifecycle.md, the DSV: generation; data-protection.md, generated forms;
// ADR-0009, the DSV template) against transfer_test with memory storage and the
// mock renderer: the view per viewer, the project's template pin, the generation with its deadline
// chosen first, the source token compared, the generation's currency, the logged opening and the
// production refusal of an unapproved template. Synthetic data only.
const storage = new MemoryFileStorage();
/** The mock renderer, keeping what the API asked it to print. */
const printed: PrintDocument[] = [];
const font = loadFont();
const mock = new MockHtmlRenderer(font);
const renderer = new PdfLibRenderer(font, {
  render: (document: PrintDocument) => {
    printed.push(document);
    return mock.render(document);
  },
});
const { app, db, logs } = testApp({ fileStorage: storage, pdfRenderer: renderer });
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, verwaltung } = seedProjectIds;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const staff = {} as Record<string, { Cookie: string }>;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
  printed.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

async function request(method: string, path: string, as: string, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  return app.request(`/api/v1${path}`, init);
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const codesOf = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  return ((await res.json()) as { errors: { pointer: string; code: string }[] }).errors.map(
    ({ pointer, code }) => `${pointer}:${code}`,
  );
};

/** An informed participant of Werk Nord in W1 with a synthetic identity and address. */
async function participant(projectId: string = werkNord) {
  const id = await call(owner.$client, "create_participation", { projectId, context: pl });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  if (projectId === werkNord) {
    await call(owner.$client, "assign_entry_wave", { id, waveId: w1.id, context: pl });
  }
  await sql(
    `insert into participant_identity (participation_id, project_id, personnel_number, first_name,
       last_name, birth_date) values ($1, $2, $3, 'Łucja Ayşe', 'Doğan-Großmann', '2051-07-29')`,
    [id, projectId, `P-${id.slice(0, 8)}`],
  );
  await sql(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country)
     values ($1, $2, 'Weißdornweg 7', '99999', 'Beispielstadt', 'DE')`,
    [id, projectId],
  );
  return id;
}

const pin = (version = "v1", as: string = projectLead) =>
  request("PUT", `/projects/${werkNord}/dsv-template`, as, { version });
const view = async (id: string, as: string = projectLead) => {
  const res = await request("GET", `/participations/${id}/dsv`, as);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, DsvView);
};
const wave = { kind: "wave", shown: w1.signingDeadline } as const;
const generate = async (
  id: string,
  deadline: unknown = wave,
  as: string = projectLead,
  token?: string,
) =>
  request("POST", `/participations/${id}/dsv/generations`, as, {
    deadline,
    expectedSourceToken: token ?? (await view(id)).sourceToken,
  });

describe("GET /participations/{id}/dsv", () => {
  it("is the PL's and back office's; a consultant 403, an unknown participation 404", async () => {
    const id = await participant();
    const seen = await view(id);
    expect(seen).toMatchObject({
      track: "not_offered",
      template: null,
      deadline: {
        waveSigningDeadline: w1.signingDeadline,
        explicitRequired: false,
        latestEntryDate: w1.latestEntryDate,
        tgStart: w1.defaultTgStart,
      },
      checklist: [],
      blockers: ["dsv_template_not_pinned"],
      generations: [],
      facts: { dsvGenerated: null },
      capabilities: { generate: false },
    });
    expect(await view(id, backOffice)).toEqual(seen);
    await expectProblem(
      await request("GET", `/participations/${id}/dsv`, consultant),
      403,
      "forbidden",
    );
    await expectProblem(
      await request("GET", `/participations/${randomUUID()}/dsv`, projectLead),
      404,
      "not-found",
    );
    // the participation page offers the tab by the same rule, also to an assigned consultant not
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
    const detail = await readJson(
      await request("GET", `/participations/${id}`, consultant),
      ParticipationDetail,
    );
    expect(detail.capabilities.viewDsv).toBe(false);
    const forPl = await readJson(
      await request("GET", `/participations/${id}`, projectLead),
      ParticipationDetail,
    );
    expect(forPl.capabilities.viewDsv).toBe(true);
  });

  it("lists a blank address for the hand and names no value", async () => {
    await pin();
    const id = await participant();
    await sql(
      `update participant_details set address_street = null, address_postal_code = null,
         address_city = null, address_country = null where participation_id = $1`,
      [id],
    );
    const dsv = await view(id);
    expect(dsv.checklist).toEqual([{ code: "required_blank", key: "address" }]);
    expect(dsv.capabilities.generate).toBe(true);
    expect(JSON.stringify(dsv)).not.toMatch(/Łucja|Doğan|2051/);
  });
});

describe("PUT /projects/{id}/dsv-template", () => {
  it("pins a known version by the PL, fixed from the first generation", async () => {
    await expectProblem(await pin("v1", backOffice), 403, "forbidden");
    expect(await codesOf(await pin("v9"), 422)).toEqual(["/version:template_unknown"]);
    const pinned = await readJson(await pin(), DsvTemplateView);
    expect(pinned).toEqual({
      version: "v1",
      fixed: false,
      versions: [{ version: "v1", approvedForLive: false }],
      capabilities: { pin: true },
    });
    expect(await codesOf(await pin(), 422)).toEqual([":project_unchanged"]);
    const forBackOffice = await readJson(
      await request("GET", `/projects/${werkNord}/dsv-template`, backOffice),
      DsvTemplateView,
    );
    expect(forBackOffice.capabilities.pin).toBe(false);
    await expectProblem(
      await request("GET", `/projects/${werkNord}/dsv-template`, consultant),
      403,
      "forbidden",
    );
    expect((await generate(await participant())).status).toBe(201);
    const fixed = await readJson(
      await request("GET", `/projects/${werkNord}/dsv-template`, projectLead),
      DsvTemplateView,
    );
    expect(fixed).toMatchObject({ version: "v1", fixed: true, capabilities: { pin: false } });
    expect(await codesOf(await pin(), 422)).toEqual([":template_pinned"]);
    const audit = await sql(
      `select details from audit_event where event_type = 'dsv_template_pinned' and project_id = $1`,
      [werkNord],
    );
    expect(audit.rows).toEqual([{ details: { templateVersion: "v1" } }]);
  });

  it("refuses a ta_only project", async () => {
    const res = await request("PUT", `/projects/${verwaltung}/dsv-template`, projectLead, {
      version: "v1",
    });
    expect(await codesOf(res, 422)).toEqual([":not_ta_tg"]);
  });
});

describe("POST /participations/{id}/dsv/generations", () => {
  it("generates with the wave's deadline, opens through the logged opening, prints the deadline", async () => {
    await pin();
    const id = await participant();
    const res = await generate(id, wave, backOffice);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const result = await readJson(res, DsvGenerationResult);
    expect(result).toMatchObject({
      templateVersion: "v1",
      offerDeadline: w1.signingDeadline,
      checklist: [],
    });
    const dsv = await view(id);
    expect(dsv.generations).toEqual([
      expect.objectContaining({
        documentId: result.documentId,
        deadlineKind: "wave",
        offerDeadline: w1.signingDeadline,
        stale: false,
        capabilities: { open: true },
      }),
    ]);
    expect(dsv.facts.dsvGenerated?.recordedAt).toBe(dsv.generations[0]!.generatedAt);

    for (const as of [projectLead, backOffice]) {
      const opening = await request(
        "POST",
        `/participations/${id}/documents/${result.documentId}/opening`,
        as,
      );
      const { url } = await readJson(opening, DocumentOpening);
      const file = await app.request(url, { headers: staff[as]! });
      expect(file.status).toBe(200);
      expect(file.headers.get("content-disposition")).toMatch(/dsv-\d{4}-\d{2}-\d{2}\.pdf/);
      expect(await pageCount(new Uint8Array(await file.arrayBuffer()))).toBeGreaterThanOrEqual(1);
    }
    // what was printed: the template's variable parts with the deadline, the sample stamp
    expect(printed).toHaveLength(1);
    expect(printed[0]!.html).toContain("Łucja Ayşe Doğan-Großmann");
    expect(printed[0]!.html).toContain("bis einschließlich <strong>15.02.2091</strong>");
    expect(printed[0]!.html).toContain(
      "vom\n      <strong>01.03.2091</strong> bis zum <strong>29.02.2092</strong>",
    );
    expect(printed[0]!.headerHtml).toContain("MUSTER – NICHT ZUR VERWENDUNG");
    const byConsultant = await request(
      "POST",
      `/participations/${id}/documents/${result.documentId}/opening`,
      consultant,
    );
    expect([403, 404]).toContain(byConsultant.status);
    expect(logs.join("\n")).not.toMatch(/Łucja|Doğan|Weißdorn|2051-07-29/);
  });

  it("is refused for a consultant (403) and an unknown participation (404)", async () => {
    await pin();
    const id = await participant();
    const token = (await view(id)).sourceToken!;
    await expectProblem(await generate(id, wave, consultant, token), 403, "forbidden");
    await expectProblem(await generate(randomUUID(), wave, projectLead, token), 404, "not-found");
  });

  it("requires the deadline and validates it at /deadline", async () => {
    await pin();
    const id = await participant();
    const token = (await view(id)).sourceToken!;
    await expectProblem(
      await request("POST", `/participations/${id}/dsv/generations`, projectLead, {
        expectedSourceToken: token,
      }),
      400,
      "validation-error",
    );
    expect(
      await codesOf(await generate(id, { kind: "explicit", date: "2020-01-01" }), 422),
    ).toEqual(["/deadline:offer_deadline_invalid"]);
    expect(
      await codesOf(await generate(id, { kind: "explicit", date: "2091-03-02" }), 422),
    ).toEqual(["/deadline:offer_deadline_invalid"]);
    expect(await codesOf(await generate(id, { kind: "wave", shown: "2091-02-14" }), 409)).toEqual([
      "/expectedSourceToken:source_changed",
    ]);
    // a re-offer needs its own deadline
    await sql("update participation set dsv_status = 'dsv_expired' where id = $1", [id]);
    expect((await view(id)).deadline.explicitRequired).toBe(true);
    expect(await codesOf(await generate(id, wave), 422)).toEqual([
      "/deadline:explicit_deadline_required",
    ]);
    const reoffer = await generate(id, { kind: "explicit", date: "2091-02-20" });
    expect(reoffer.status).toBe(201);
    expect((await readJson(reoffer, DsvGenerationResult)).offerDeadline).toBe("2091-02-20");
  });

  it("names every state it can't be generated in", async () => {
    const id = await participant();
    expect(await codesOf(await generate(id), 422)).toEqual([":dsv_template_not_pinned"]);
    await pin();
    await sql("update participation set dsv_status = 'dsv_offered' where id = $1", [id]);
    expect(await codesOf(await generate(id), 422)).toEqual([":dsv_offer_open"]);
    const waveless = await call(owner.$client, "create_participation", {
      projectId: werkNord,
      context: pl,
    });
    expect(await codesOf(await generate(waveless), 422)).toEqual([
      ":no_entry_wave",
      ":tg_dates_missing",
    ]);
  });

  it("compares the source token: a value changed since the view is 409, the generation goes stale", async () => {
    await pin();
    const id = await participant();
    const before = await view(id);
    expect((await generate(id, wave, projectLead, before.sourceToken!)).status).toBe(201);
    await sql(
      "update participant_details set address_street = 'Ahornweg 2' where participation_id = $1",
      [id],
    );
    expect(await codesOf(await generate(id, wave, projectLead, before.sourceToken!), 409)).toEqual([
      "/expectedSourceToken:source_changed",
    ]);
    const after = await view(id);
    expect(after.sourceToken).not.toBe(before.sourceToken);
    expect(after.generations[0]!.stale).toBe(true);
    expect(after.facts.dsvGenerated).toBeNull();
    // a fresh generation is current again; a passed deadline makes it stale
    expect((await generate(id)).status).toBe(201);
    expect((await view(id)).generations.map((generation) => generation.stale)).toEqual([
      false,
      true,
    ]);
    await sql(
      "update form_generation set offer_deadline = berlin_today() - 1 where participation_id = $1",
      [id],
    );
    expect((await view(id)).generations.every((generation) => generation.stale)).toBe(true);
  });
});

describe("NODE_ENV=production", () => {
  it("refuses a template not approved for live use (dsv_template_not_approved)", async () => {
    await pin();
    const id = await participant();
    const production = testApp({ env: { nodeEnv: "production" }, fileStorage: storage });
    // the dev session (testApp keeps AUTH_MODE=dev; the env refuses it in a real production start)
    const cookie = await login(production.app, projectLead);
    const res = await production.app.request(`/api/v1/participations/${id}/dsv`, {
      headers: cookie,
    });
    const dsv = await readJson(res, DsvView);
    expect(dsv.blockers).toEqual(["dsv_template_not_approved"]);
    expect(dsv.template).toEqual({ version: "v1", approvedForLive: false });
    expect(dsv.capabilities.generate).toBe(false);
    const generated = await production.app.request(
      `/api/v1/participations/${id}/dsv/generations`,
      jsonRequest("POST", { deadline: wave, expectedSourceToken: dsv.sourceToken }, cookie),
    );
    expect(await codesOf(generated, 422)).toEqual([":dsv_template_not_approved"]);
    await production.db.$client.end();
    const rows = await sql(
      "select count(*)::int as n from form_generation where participation_id = $1",
      [id],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
