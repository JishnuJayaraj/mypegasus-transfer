import { MemoryFileStorage, MockHtmlRenderer, pageCount, PdfLibRenderer } from "@transfer/adapters";
import { loadFont } from "@transfer/forms/load";
import { createDb, seedProjectIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import {
  acceptDsvScan,
  call,
  changeStatus,
  externalDsvOffer,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import {
  DocumentOpening,
  DsvBulkGenerationResult,
  DsvGenerationResult,
  DsvTemplateView,
  DsvView,
  ParticipationDetail,
  type PrintDocument,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const offer = (id: string, body: object, as: string = projectLead) =>
  request("POST", `/participations/${id}/dsv/offers`, as, body);

describe("DSV offers", () => {
  it("records external paper before scans, then declines exactly that offer", async () => {
    const id = await participant();
    const before = await view(id);
    const external = {
      deadline: w1.signingDeadline,
      printedTgStart: w1.defaultTgStart,
      printedTgEnd: w1.defaultTgEnd,
    };
    const res = await offer(id, { external, statusVersion: before.statusVersion });
    expect(res.status).toBe(201);
    const recorded = await readJson(res, DsvView);
    expect(recorded.track).toBe("dsv_offered");
    expect(recorded.offers).toHaveLength(1);
    expect(recorded.offers[0]).toMatchObject({ origin: "external_paper", endedAs: null });
    expect((await offer(id, { external, statusVersion: before.statusVersion })).status).toBe(409);
    const declined = await request(
      "POST",
      `/participations/${id}/dsv/offers/${recorded.offers[0]!.id}/decline`,
      backOffice,
      { statusVersion: recorded.statusVersion },
    );
    expect(declined.status).toBe(200);
    expect((await readJson(declined, DsvView)).offers[0]!.endedAs).toBe("declined");
  });

  it("refuses mismatching external terms and a consultant", async () => {
    const id = await participant();
    const body = {
      statusVersion: (await view(id)).statusVersion,
      external: {
        deadline: w1.signingDeadline,
        printedTgStart: "2099-01-01",
        printedTgEnd: w1.defaultTgEnd,
      },
    };
    expect(await codesOf(await offer(id, body), 422)).toContain(":terms_mismatch");
    expect((await offer(id, body, consultant)).status).toBe(403);
    expect((await view(id)).offers).toHaveLength(0);
  });

  it("uses the generated paper's deadline and rejects changed sources", async () => {
    await pin();
    const id = await participant();
    const generated = await readJson(await generate(id), DsvGenerationResult);
    const { rows } = await sql(`select id from form_generation where document_id = $1`, [
      generated.documentId,
    ]);
    const before = await view(id);
    await sql(
      `update participant_identity set last_name = 'Beispiel' where participation_id = $1`,
      [id],
    );
    expect(
      (await offer(id, { generationId: rows[0].id, statusVersion: before.statusVersion })).status,
    ).toBe(409);
    const next = await readJson(await generate(id), DsvGenerationResult);
    const gen = await sql(`select id from form_generation where document_id = $1`, [
      next.documentId,
    ]);
    const res = await offer(id, {
      generationId: gen.rows[0].id,
      statusVersion: before.statusVersion,
    });
    expect(res.status).toBe(201);
    expect((await readJson(res, DsvView)).offers[0]!.offerDeadline).toBe(generated.offerDeadline);
  });
});

it("refuses a DSV offered status without its offered paper in the database", async () => {
  const other = await participant();
  await expect(
    call(owner.$client, "change_participation_status", {
      id: other,
      field: "dsv_status",
      expectedFrom: "not_offered",
      to: "dsv_offered",
      context: pl,
      offerDeadline: w1.signingDeadline,
    }),
  ).rejects.toThrow("dsv_offer_missing");
  expect((await view(other)).track).toBe("not_offered");
});

it("uploads, reviews and signs the open offered paper; enforces visibility, roles and stale versions", async () => {
  const id = await participant();
  const initial = await view(id);
  const offered = await request("POST", `/participations/${id}/dsv/offers`, backOffice, {
    external: { deadline: "2091-02-15", printedTgStart: "2091-03-01", printedTgEnd: "2092-02-29" },
    statusVersion: initial.statusVersion,
  });
  expect(offered.status).toBe(201);
  const offerView = await readJson(offered, DsvView);
  const body = {
    offerId: offerView.offers[0]!.id,
    receivedBy: backOffice,
    receivedOn: "2026-01-02",
    signatures: { participant: "2026-01-01" },
    file: {
      fileName: "synthetic.pdf",
      content: Buffer.from("%PDF-1.4\nsynthetic\n%%EOF").toString("base64"),
    },
  };
  await expectProblem(
    await request("POST", `/participations/${id}/dsv/scans`, consultant, body),
    403,
    "forbidden",
  );
  await expectProblem(
    await request("POST", `/participations/${randomUUID()}/dsv/scans`, backOffice, body),
    404,
    "not-found",
  );
  await expectProblem(
    await request("POST", `/participations/${id}/dsv/scans`, backOffice, {
      ...body,
      offerId: randomUUID(),
    }),
    404,
    "not-found",
  );
  const upload = await request("POST", `/participations/${id}/dsv/scans`, backOffice, body);
  expect(upload.status).toBe(201);
  const scan = (await upload.json()) as { id: string };
  const signed = () =>
    request("POST", `/participations/${id}/dsv/signed`, backOffice, {
      scanId: scan.id,
      statusVersion: offerView.statusVersion,
    });
  await expectProblem(await signed(), 422, "domain-error");
  await expectProblem(
    await request("POST", `/documents/${scan.id}/dsv-review`, consultant, {
      decision: "accepted",
      dsv: { signatures: body.signatures, termsConfirmed: true },
    }),
    404,
    "not-found",
  );
  await expectProblem(
    await request("POST", `/documents/${scan.id}/dsv-review`, projectLead, {
      decision: "accepted",
      dsv: { signatures: body.signatures, termsConfirmed: false },
    }),
    422,
    "domain-error",
  );
  expect(
    (
      await request("POST", `/documents/${scan.id}/dsv-review`, projectLead, {
        decision: "accepted",
        dsv: { signatures: body.signatures, termsConfirmed: true },
      })
    ).status,
  ).toBe(200);
  await expectProblem(
    await request("POST", `/participations/${id}/dsv/signed`, backOffice, {
      scanId: scan.id,
      statusVersion: initial.statusVersion,
    }),
    409,
    "conflict",
  );
  expect((await signed()).status).toBe(200);
  expect((await view(id)).track).toBe("dsv_signed");
  const { rows } = await db.$client.query("select signed_on::text from dsv_facts($1)", [[id]]);
  expect(rows[0].signed_on).toBe("2026-01-01");
});

/** A participant whose offer is signed by one packet scan dated `signed`. */
async function signedPacket(signed = "2026-01-01") {
  const id = await participant();
  await externalDsvOffer(owner.$client, id);
  const scan = await acceptDsvScan(owner.$client, id, {
    participant: signed,
    customer: signed,
    transfergesellschaft: signed,
  });
  const version = (await view(id)).statusVersion;
  const res = await request("POST", `/participations/${id}/dsv/signed`, backOffice, {
    scanId: scan,
    statusVersion: version,
  });
  expect(res.status).toBe(200);
  return id;
}
const original = (id: string, body: unknown, as: string = backOffice) =>
  request("PUT", `/participations/${id}/dsv/contract/original`, as, body);

describe("the packet and the original (process-and-lifecycle.md, DSV packet and original)", () => {
  it("shows the packet, the contract and who may record the original", async () => {
    const id = await signedPacket();
    const seen = await view(id);
    expect(seen.facts.dsvFullyExecuted).toMatchObject({ validOn: "2026-01-01" });
    expect(seen.contract).toEqual({
      offerId: seen.offers[0]!.id,
      participantSignedOn: "2026-01-01",
      customerSignedOn: "2026-01-01",
      tgSignedOn: "2026-01-01",
      fullyExecutedOn: "2026-01-01",
      originalLocation: null,
      originalReceivedOn: null,
      sentToCustomerOn: null,
    });
    // The countersigned original is a scan of the signed offer.
    expect(seen.capabilities).toMatchObject({
      uploadScan: true,
      sign: false,
      recordOriginal: true,
    });
    const detail = await readJson(
      await request("GET", `/participations/${id}`, projectLead),
      ParticipationDetail,
    );
    expect(detail).toMatchObject({ dsvSignedOn: "2026-01-01", dsvFullyExecutedOn: "2026-01-01" });
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
    const hidden = await readJson(
      await request("GET", `/participations/${id}`, consultant),
      ParticipationDetail,
    );
    expect(hidden.dsvFullyExecutedOn).toBeUndefined();
  });

  it("records the original against the value read, audited by field and location code only", async () => {
    const id = await signedPacket();
    const first = await original(id, {
      field: "originalLocation",
      value: "paper_personnel_file",
      expected: null,
    });
    expect(first.status).toBe(200);
    expect((await readJson(first, DsvView)).contract?.originalLocation).toBe(
      "paper_personnel_file",
    );
    expect(
      (await original(id, { field: "originalReceivedOn", value: "2026-01-05", expected: null }))
        .status,
    ).toBe(200);
    expect(
      await codesOf(
        await original(id, { field: "originalReceivedOn", value: "2026-01-06", expected: null }),
        409,
      ),
    ).toEqual(["/expected:stale_value"]);
    expect(
      await codesOf(
        await original(id, { field: "sentToCustomerOn", value: "2199-01-01", expected: null }),
        422,
      ),
    ).toEqual(["/value:date_in_future"]);
    expect(
      await codesOf(
        await original(id, {
          field: "originalReceivedOn",
          value: "2026-01-05",
          expected: "2026-01-05",
        }),
        422,
      ),
    ).toEqual([":value_unchanged"]);
    await expectProblem(
      await original(id, { field: "originalLocation", value: "attic", expected: null }),
      400,
      "validation-error",
    );
    const { rows } = await sql(
      `select details from audit_event where participation_id = $1 and event_type = 'dsv_original_recorded' order by seq`,
      [id],
    );
    expect(JSON.stringify(rows)).not.toContain("2026-01-05");
    expect(rows).toHaveLength(2);
  });

  it("refuses a consultant, an unknown participation and an offer that isn't signed", async () => {
    const id = await signedPacket();
    const body = { field: "originalLocation", value: "paper_personnel_file", expected: null };
    expect((await original(id, body, consultant)).status).toBeGreaterThanOrEqual(403);
    expect((await original(id, body, consultant)).status).toBeLessThanOrEqual(404);
    await expectProblem(await original(randomUUID(), body), 404, "not-found");
    const open = await participant();
    await externalDsvOffer(owner.$client, open);
    await expectProblem(await original(open, body), 404, "not-found");
    expect((await view(open)).contract).toBeNull();
  });

  it("refuses the TG entry through the status service without the packet", async () => {
    const id = await participant();
    await externalDsvOffer(owner.$client, id);
    const scan = await acceptDsvScan(owner.$client, id, { participant: "2026-01-01" });
    const version = (await view(id)).statusVersion;
    await request("POST", `/participations/${id}/dsv/signed`, backOffice, {
      scanId: scan,
      statusVersion: version,
    });
    expect((await view(id)).facts.dsvFullyExecuted).toBeNull();
  });
});

const bulk = (ids: string[], deadline: unknown = wave, as: string = projectLead) =>
  request("POST", `/projects/${werkNord}/dsv/generations`, as, {
    deadline,
    items: ids.map((participationId) => ({ participationId })),
  });

const generations = async () =>
  Number((await sql("select count(*) as n from form_generation")).rows[0].n);

describe("POST /projects/{id}/dsv/generations (bulk, D2)", () => {
  /** The stored objects the batch added (the storage outlives the tests). */
  let before: string[] = [];
  beforeEach(() => {
    before = storage.keys();
  });
  const added = () => storage.keys().filter((key) => !before.includes(key));

  it("generates 1 to 100 papers with one deadline in one call; each is audited with the batch size", async () => {
    await pin();
    const ids = [await participant(), await participant(), await participant()];
    const res = await bulk(ids, wave, backOffice);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await readJson(res, DsvBulkGenerationResult);
    expect(body.generations.map((g) => g.participationId)).toEqual(ids);
    expect(new Set(body.generations.map((g) => g.offerDeadline))).toEqual(
      new Set([w1.signingDeadline]),
    );
    expect(new Set(body.generations.map((g) => g.documentId)).size).toBe(3);
    expect(added()).toHaveLength(3);
    const audit = await sql(
      `select details from audit_event where event_type = 'dsv_form_generated' order by seq`,
    );
    expect(audit.rows.map((r) => r.details.batchSize)).toEqual([3, 3, 3]);
    for (const id of ids) {
      expect((await view(id)).generations).toHaveLength(1);
    }
    // The log carries counts and codes, never an id of a participation or a printed value.
    const text = JSON.stringify(logs);
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/Łucja|Doğan|Weißdorn/);
  });

  it("takes one explicit deadline for a mixed selection", async () => {
    await pin();
    const [a, b] = [await participant(), await participant()];
    const explicit = { kind: "explicit", date: w1.signingDeadline } as const;
    const res = await bulk([a, b], explicit);
    expect(res.status).toBe(201);
    const body = await readJson(res, DsvBulkGenerationResult);
    expect(body.generations.map((g) => g.offerDeadline)).toEqual([
      w1.signingDeadline,
      w1.signingDeadline,
    ]);
  });

  it("is all or nothing: one participation that can't be generated refuses the whole call", async () => {
    await pin();
    const [a, b, c] = [await participant(), await participant(), await participant()];
    await changeStatus(owner.$client, b, {
      field: "dsv_status",
      from: "not_offered",
      to: "dsv_offered",
    });
    const res = await bulk([a, b, c]);
    expect(await codesOf(res, 422)).toEqual(["/items/1:dsv_offer_open"]);
    expect(await generations()).toBe(0);
    expect(added()).toEqual([]);
    // Without the offending one, the same call goes through.
    expect((await bulk([a, c])).status).toBe(201);
    expect(await generations()).toBe(2);
  });

  it("lists every refused item by its position, and no id", async () => {
    const [a, b] = [await participant(), await participant()];
    const res = await bulk([a, b]);
    expect(await codesOf(res, 422)).toEqual([
      "/items/0:dsv_template_not_pinned",
      "/items/1:dsv_template_not_pinned",
    ]);
  });

  it("is refused for a deadline the wave no longer has (409), nothing recorded", async () => {
    await pin();
    const ids = [await participant(), await participant()];
    const res = await bulk(ids, { kind: "wave", shown: "2001-01-01" });
    expect(await codesOf(res, 409)).toEqual(["/items/0:source_changed", "/items/1:source_changed"]);
    expect(await generations()).toBe(0);
  });

  it("refuses an invalid deadline for the item it fails", async () => {
    await pin();
    const ids = [await participant()];
    const res = await bulk(ids, { kind: "explicit", date: "2001-01-01" });
    expect(await codesOf(res, 422)).toEqual(["/items/0/deadline:offer_deadline_invalid"]);
  });

  it("is the PL's and back office's; a participation of another project or none is a 404", async () => {
    await pin();
    const id = await participant();
    await expectProblem(await bulk([id], wave, consultant), 403, "forbidden");
    await expectProblem(await bulk([id, randomUUID()]), 404, "not-found");
    const other = await participant(verwaltung);
    await expectProblem(await bulk([id, other]), 404, "not-found");
    expect(await generations()).toBe(0);
    await expectProblem(
      await request("POST", `/projects/${randomUUID()}/dsv/generations`, projectLead, {
        deadline: wave,
        items: [{ participationId: id }],
      }),
      404,
      "not-found",
    );
  });

  it("takes 1 to 100 distinct participations", async () => {
    await pin();
    const id = await participant();
    await expectProblem(await bulk([]), 400, "validation-error");
    await expectProblem(await bulk([id, id]), 400, "validation-error");
    await expectProblem(
      await bulk(Array.from({ length: 101 }, () => randomUUID())),
      400,
      "validation-error",
    );
  });

  it("rolls the whole batch back and removes every stored paper when storage fails midway", async () => {
    await pin();
    const ids = [await participant(), await participant(), await participant()];
    const put = storage.put.bind(storage);
    let calls = 0;
    const spy = vi.spyOn(storage, "put").mockImplementation(async (key, content) => {
      if (++calls === 3) throw new Error("storage down");
      return put(key, content);
    });
    try {
      await expectProblem(await bulk(ids), 503, "service-unavailable");
    } finally {
      spy.mockRestore();
    }
    expect(await generations()).toBe(0);
    expect(added()).toEqual([]);
    expect(
      (await sql("select count(*) as n from document where type = 'dsv_form'")).rows[0].n,
    ).toBe("0");
    expect((await bulk(ids)).status).toBe(201);
  });

  it("removes every paper when the database refuses one at the record", async () => {
    await pin();
    const ids = [await participant(), await participant()];
    // A state change between the check and the record: the function refuses under the lock.
    const spy = vi.spyOn(storage, "put").mockImplementation(async function (
      this: unknown,
      key,
      content,
    ) {
      await sql(`update participation set dsv_status = 'dsv_declined' where id = $1`, [ids[1]]);
      spy.mockRestore();
      return storage.put(key, content);
    });
    const res = await bulk(ids);
    spy.mockRestore();
    expect(res.status).toBe(422);
    expect(await generations()).toBe(0);
    expect(added()).toEqual([]);
  });

  it("generates a full batch of 100", { timeout: 60_000 }, async () => {
    await pin();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push(await participant());
    const res = await bulk(ids);
    expect(res.status).toBe(201);
    expect((await readJson(res, DsvBulkGenerationResult)).generations).toHaveLength(100);
    expect(await generations()).toBe(100);
  });
});
