import { MemoryFileStorage, pageCount } from "@transfer/adapters";
import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  AsuView,
  DocumentOpening,
  DocumentView,
  ExportLink,
  Kug200bBulkGeneration,
  Kug200bGeneration,
  Worklist,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fieldEncryptionKey } from "./field-encryption";
import { expectProblem, jsonRequest, login, readJson, testApp, testEnv } from "./testing";

// The Kug 200b on the tab "Arbeitsuche" (process-and-lifecycle.md, the Kug 200b offer;
// data-protection.md, generated forms, signed scans, signed declarations and exports; Q179,
// Q184, Q185, Q197) against transfer_test, with memory storage: the generation, one and in
// bulk, its handwriting checklist, the print file's export link, the signed scan's review, the
// offer's outcome, a withdrawal and its BA notice, and the work list's items. Synthetic data only;
// the RV-Nummer is made up.
const storage = new MemoryFileStorage();
const { app, db, logs } = testApp({ fileStorage: storage });
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, verwaltung } = seedProjectIds;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const fieldKey = fieldEncryptionKey(testEnv.fieldEncryptionKey!);
const rvNummer = "12290751D123";
const answered: string[] = [];
const scanPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Title (synthetic scan) >>\nendobj\n%%EOF\n");
const three = ["declarations_ticked", "mandatory_completed", "signature_present"];

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
  answered.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

async function request(method: string, path: string, as: string, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  const res = await app.request(`/api/v1${path}`, init);
  answered.push(await res.clone().text());
  return res;
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const berlinDay = async (offset = 0) =>
  (await sql("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d as string;
const seal = (field: string, value: unknown) =>
  `public.seal_sensitive_value($1, '${field}', '${JSON.stringify(value)}'::jsonb, $3)`;

/**
 * An informed participant of Werk Nord (`ta_tg`), assigned to the consultant, with what a Kug 200b
 * prints: the identity and address as fixtures, the sensitive answers sealed with the test key as
 * `write_sensitive_fields` would; `complete: false` leaves the RV-Nummer out.
 */
async function participant({ projectId = werkNord, complete = true } = {}) {
  const id = await call(owner.$client, "create_participation", { projectId, context: pl });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  await call(owner.$client, "assign_participations", {
    projectId,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  const keys = [id, projectId];
  await sql(
    `insert into participant_identity (participation_id, project_id, personnel_number, first_name,
       last_name, birth_date) values ($1, $2, $3, 'Erika', 'Beispiel', '1970-01-01')`,
    [...keys, `P-${id.slice(0, 8)}`],
  );
  await sql(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE')`,
    keys,
  );
  await sql(
    `insert into participant_profile (participation_id, project_id, marital_status, revision)
     values ($1, $2, 'single', 1)`,
    keys,
  );
  if (complete) {
    await sql(
      `insert into participant_identifier_data (participation_id, project_id,
         pension_insurance_number, pension_insurance_number_present, key_id)
       values ($1, $2, ${seal("pensionInsuranceNumber", rvNummer)}, true, $4)`,
      [...keys, fieldKey.key, fieldKey.keyId],
    );
  }
  await sql(
    `insert into participant_residence_social_data (participation_id, project_id, nationality,
       nationality_present, key_id)
     values ($1, $2, ${seal("nationality", { kind: "german" })}, true, $4)`,
    [...keys, fieldKey.key, fieldKey.keyId],
  );
  await sql(
    `insert into participant_health_data (participation_id, project_id, severe_disability,
       severe_disability_present, key_id)
     values ($1, $2, ${seal("severeDisability", false)}, true, $4)`,
    [...keys, fieldKey.key, fieldKey.keyId],
  );
  return id;
}

const generate = (id: string, as: string = projectLead) =>
  request("POST", `/participations/${id}/forms/kug200b`, as);
async function generated(id: string, as: string = projectLead) {
  const res = await generate(id, as);
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, Kug200bGeneration);
}
const bulk = (participationIds: string[], as: string = projectLead) =>
  request("POST", `/projects/${werkNord}/forms/kug200b`, as, { participationIds });
const view = async (id: string, as: string = projectLead) =>
  readJson(await request("GET", `/participations/${id}/asu`, as), AsuView);
const codesOf = async (res: Response) =>
  ((await res.json()) as { errors: { pointer: string; code: string }[] }).errors.map(
    ({ pointer, code }) => `${pointer}:${code}`,
  );
const events = async (types: string[]) =>
  (
    await sql(
      `select event_type::text as type, participation_id, details from audit_event
       where event_type::text = any ($1) order by seq`,
      [types],
    )
  ).rows;

describe("the Kug 200b's generation (Q179, Q197 (8))", () => {
  it("is generated by the PL with its checklist, the printed values read audited, no value answered", async () => {
    const id = await participant();
    const generation = await generated(id);
    expect(generation).toMatchObject({ participationId: id, formVersion: "09-2021" });
    // Everything a `*` field needs is there: the participant writes 13–19 by hand.
    expect(generation.checklist).toEqual([]);
    expect((await events(["sensitive_read"])).map((e) => e.details.key).toSorted()).toEqual([
      "nationality",
      "pensionInsuranceNumber",
      "severeDisability",
    ]);
    expect(answered.join("")).not.toContain(rvNummer);
    expect(logs.join("")).not.toContain(rvNummer);
    const tab = await view(id);
    expect(tab.kug200b.offeredOn).toBe(await berlinDay());
    expect(tab.kug200b.forms).toEqual([
      expect.objectContaining({
        documentId: generation.documentId,
        latest: true,
        versionInUse: true,
        checklist: [],
        capabilities: { open: true },
      }),
    ]);
    const opening = await request(
      "POST",
      `/participations/${id}/documents/${generation.documentId}/opening`,
      projectLead,
    );
    const { url } = await readJson(opening, DocumentOpening);
    const file = await app.request(url, { headers: staff[projectLead]! });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/kug200b-\d{4}-\d{2}-\d{2}\.pdf/);
    expect(await pageCount(new Uint8Array(await file.arrayBuffer()))).toBe(1);
  });

  it("lists a blank `*` field for handwriting before printing; nothing disappears silently", async () => {
    const id = await participant({ complete: false });
    const generation = await generated(id, consultant);
    expect(generation.checklist).toEqual([
      {
        code: "required_blank",
        key: "pensionInsuranceNumber",
        label: "11 Rentenversicherungsnummer",
      },
    ]);
    expect((await view(id, consultant)).kug200b.forms?.[0]?.checklist).toEqual(
      generation.checklist,
    );
  });

  it("is refused for back office, an unassigned consultant and a ta_only project", async () => {
    const id = await participant();
    await expectProblem(await generate(id, backOffice), 403, "forbidden");
    await call(owner.$client, "unassign_participation", {
      participationId: id,
      staffUserId: consultant,
      context: pl,
    });
    await expectProblem(await generate(id, consultant), 404, "not-found");
    const taOnly = await participant({ projectId: verwaltung });
    expect(await codesOf(await generate(taOnly))).toEqual([":asu_not_applicable"]);
    expect((await sql("select count(*)::int as n from form_generation")).rows).toEqual([{ n: 0 }]);
  });
});

describe("the bulk generation and its print file (data-protection.md, exports)", () => {
  it("generates all for the PL, and the print file re-authorizes at the download, audited, no file stored", async () => {
    const ids = [await participant(), await participant({ complete: false })];
    const res = await bulk(ids);
    expect(res.status).toBe(201);
    const { generations } = await readJson(res, Kug200bBulkGeneration);
    expect(generations.map((g) => [g.participationId, g.checklist.length])).toEqual([
      [ids[0], 0],
      [ids[1], 1],
    ]);
    const objects = storage.keys().length;
    const link = await readJson(
      await request("POST", "/exports/kug200b_print", projectLead, {
        documentIds: generations.map((g) => g.documentId),
      }),
      ExportLink,
    );
    const file = await app.request(link.url, { headers: staff[projectLead]! });
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(file.headers.get("content-disposition")).toMatch(
      /^attachment; filename="kug200b-druck-/,
    );
    expect(await pageCount(new Uint8Array(await file.arrayBuffer()))).toBe(2);
    expect(storage.keys().length).toBe(objects);
    // Bound to the session that asked.
    expect((await app.request(link.url, { headers: staff[consultant]! })).status).toBe(404);
    expect(
      (await events(["export_created", "export_downloaded"])).map((e) => [
        e.type,
        e.participation_id,
        e.details,
      ]),
    ).toEqual([
      ["export_created", null, { exportKind: "kug200b_print", count: 2 }],
      ["export_downloaded", null, { exportKind: "kug200b_print", count: 2 }],
    ]);
    expect(logs.join("")).not.toContain(link.url.split("/").at(-1));
    // Re-authorized at the download: a consultant's link stops with their assignment.
    const own = await readJson(
      await request("POST", "/exports/kug200b_print", consultant, {
        documentIds: [generations[0]!.documentId],
      }),
      ExportLink,
    );
    await call(owner.$client, "unassign_participation", {
      participationId: ids[0],
      staffUserId: consultant,
      context: pl,
    });
    expect(await codesOf(await app.request(own.url, { headers: staff[consultant]! }))).toEqual([
      ":export_stale",
    ]);
    // A quarantined form isn't exported (data-protection.md, quarantine).
    await sql(
      `update document set quarantine_reason = 'suspected_wrong_person', quarantined_by = $2,
         quarantined_at = now() where id = $1`,
      [generations[1]!.documentId, projectLead],
    );
    expect(await codesOf(await app.request(link.url, { headers: staff[projectLead]! }))).toEqual([
      ":export_stale",
    ]);
    expect(
      await codesOf(
        await request("POST", "/exports/kug200b_print", projectLead, {
          documentIds: [generations[1]!.documentId],
        }),
      ),
    ).toEqual([":document_quarantined"]);
  });

  it("is all or nothing: one refused member stores and records none", async () => {
    const ids = [await participant(), await participant()];
    await changeStatus(owner.$client, ids[1]!, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await berlinDay(),
    });
    const objects = storage.keys().length;
    expect(await codesOf(await bulk(ids))).toEqual([":participation_closed"]);
    expect((await sql("select count(*)::int as n from form_generation")).rows).toEqual([{ n: 0 }]);
    expect(storage.keys().length).toBe(objects);
  });

  it("is the PL's alone, for participations of the project", async () => {
    const id = await participant();
    await expectProblem(await bulk([id], consultant), 403, "forbidden");
    const other = await participant({ projectId: verwaltung });
    expect(await codesOf(await bulk([id, other]))).toEqual([
      "/participationIds/1:participation_not_found",
    ]);
    const res = await bulk(Array.from({ length: 101 }, () => id));
    expect(res.status).toBe(400);
  });
});

describe("the signed Kug 200b's review (Q184, Q185)", () => {
  async function scanOf(id: string, generationDocumentId: string | null, as = consultant) {
    const res = await request("POST", `/participations/${id}/documents`, as, {
      type: "kug200b_signed_scan",
      fileName: "scan.pdf",
      content: scanPdf.toString("base64"),
      ...(generationDocumentId
        ? { origin: "generated", generationDocumentId }
        : { origin: "external_paper" }),
    });
    expect(res.status).toBe(201);
    return (await readJson(res, DocumentView)).id;
  }
  const review = (id: string, documentId: string, body: object, as = consultant) =>
    request("POST", `/participations/${id}/documents/${documentId}/review`, as, body);

  it("is refused without 16, 17, the mandatory information and the signature confirmed", async () => {
    const id = await participant();
    const scan = await scanOf(id, (await generated(id)).documentId);
    const signedOn = await berlinDay();
    expect(
      await codesOf(
        await review(id, scan, {
          decision: "accepted",
          kug200bScan: { signedOn, confirmations: ["declarations_ticked", "signature_present"] },
        }),
      ),
    ).toEqual(["/kug200bScan/confirmations:confirmation_required"]);
    expect(await codesOf(await review(id, scan, { decision: "accepted" }))).toEqual([
      "/kug200bScan:scan_required",
    ]);
    expect((await view(id)).kug200b.outcome).toBeNull();
  });

  it("accepts with the confirmations: signed declarations, one consent record, the outcome signed", async () => {
    const id = await participant();
    const scan = await scanOf(id, (await generated(id)).documentId, projectLead);
    const signedOn = await berlinDay();
    const res = await review(
      id,
      scan,
      { decision: "accepted", kug200bScan: { signedOn, confirmations: three } },
      projectLead,
    );
    expect(res.status).toBe(200);
    const tab = await view(id);
    expect(tab.kug200b).toMatchObject({
      outcome: "signed",
      profileAccess: { givenOn: signedOn },
      capabilities: { decline: false, recordWithdrawal: true, recordBaNotice: false },
    });
    expect(tab.kug200b.scans).toEqual([
      expect.objectContaining({ documentId: scan, signedOn, formVersion: "09-2021" }),
    ]);
    expect(
      (
        await sql(
          `select declaration, value from signed_declaration where document_id = $1
           order by declaration`,
          [scan],
        )
      ).rows,
    ).toEqual([
      { declaration: "kug200bJobSeeking", value: "yes" },
      { declaration: "kug200bProfileAccess", value: "yes" },
    ]);
    // Back office reads the case summary, never the forms or scans (Q49).
    const summary = await view(id, backOffice);
    expect(summary.kug200b.outcome).toBe("signed");
    expect(summary.kug200b.forms).toBeUndefined();
    expect(summary.kug200b.scans).toBeUndefined();
    expect(summary.kug200b.capabilities).toEqual({
      generate: false,
      addScan: false,
      decline: false,
      recordWithdrawal: false,
      recordBaNotice: false,
    });
  });

  it("takes a withdrawal and its BA notice, the registration intact; the work list shows the notice item", async () => {
    const id = await participant();
    const scan = await scanOf(id, null);
    await review(id, scan, {
      decision: "accepted",
      kug200bScan: { signedOn: await berlinDay(-3), confirmations: three, formVersion: "09-2021" },
    });
    const consentId = (await view(id)).kug200b.profileAccess!.consentId;
    const receivedOn = await berlinDay();
    const withdrawn = await request("POST", `/participations/${id}/asu/withdrawal`, consultant, {
      consentId,
      receivedOn,
    });
    expect(withdrawn.status).toBe(200);
    const tab = await readJson(withdrawn, AsuView);
    expect(tab.kug200b.profileAccess).toBeNull();
    expect(tab.kug200b.withdrawals).toEqual([
      expect.objectContaining({ receivedOn, baNotifiedOn: null }),
    ]);
    const item = async () =>
      (
        await readJson(
          await request("GET", `/projects/${werkNord}/worklist`, projectLead),
          Worklist,
        )
      ).items.find((row) => row.id === id)!.caseItems;
    expect(await item()).toContainEqual({ kind: "kug200b_withdrawal_ba_notice", date: receivedOn });
    const noticed = await request(
      "POST",
      `/participations/${id}/asu/withdrawal-ba-notice`,
      projectLead,
      { withdrawalId: tab.kug200b.withdrawals[0]!.id, notifiedOn: await berlinDay() },
    );
    expect((await readJson(noticed, AsuView)).kug200b.withdrawals[0]!.baNotifiedOn).toBe(
      await berlinDay(),
    );
    expect(await item()).toEqual([]);
    expect(
      await codesOf(
        await request("POST", `/participations/${id}/asu/withdrawal`, consultant, {
          consentId,
          receivedOn,
        }),
      ),
    ).toEqual([":consent_ended"]);
  });
});

describe("the offer's decline and the work list (process-and-lifecycle.md, the Kug 200b offer)", () => {
  const decline = (id: string, declinedOn: string, as: string = projectLead) =>
    request("POST", `/participations/${id}/asu/kug200b-decline`, as, { declinedOn });
  const caseItems = async (id: string) =>
    (
      await readJson(await request("GET", `/projects/${werkNord}/worklist`, projectLead), Worklist)
    ).items.find((row) => row.id === id)!;

  it("shows an open offer on another route until it is declined; a declined offer is never missing", async () => {
    const id = await participant();
    await generated(id);
    const row = await caseItems(id);
    expect(row.caseItems).toEqual([{ kind: "kug200b_offer_open", date: await berlinDay() }]);
    expect(row.capabilities.generateKug200b).toBe(true);
    await expectProblem(await decline(id, await berlinDay(), backOffice), 403, "forbidden");
    expect(await codesOf(await decline(id, await berlinDay(1)))).toEqual([
      "/declinedOn:declined_on_in_future",
    ]);
    const res = await decline(id, await berlinDay(), consultant);
    expect((await readJson(res, AsuView)).kug200b).toMatchObject({
      outcome: "declined",
      declinedOn: await berlinDay(),
      capabilities: { decline: false },
    });
    expect((await caseItems(id)).caseItems).toEqual([]);
    expect(await codesOf(await decline(id, await berlinDay()))).toEqual([":kug200b_declined"]);
  });

  it("refuses a decline on the route kug_200b: change the route first", async () => {
    const id = await participant();
    await request("PUT", `/participations/${id}/asu/route`, projectLead, {
      channel: "kug_200b",
      version: 0,
    });
    expect((await view(id)).kug200b.capabilities.decline).toBe(false);
    expect(await codesOf(await decline(id, await berlinDay()))).toEqual([":asu_route_kug200b"]);
  });
});
