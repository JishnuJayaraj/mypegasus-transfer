import {
  createPdfRenderer,
  imageToPdf,
  MemoryFileStorage,
  pageCount,
  type PdfRenderer,
} from "@transfer/adapters";
import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  DocumentView,
  ExportLink,
  Kug200bBatchCreated,
  Kug200bBatchesView,
} from "@transfer/domain";
import { loadFont } from "@transfer/forms/load";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fieldEncryptionKey } from "./field-encryption";
import { expectProblem, jsonRequest, login, readJson, testApp, testEnv } from "./testing";

// A batch's official artifacts (ba-forms.md, the Kug 200a as built; data-protection.md, exports;
// regional-variation.md, the accepted alternative; Q197, Q203 (6), Q205) against transfer_test with
// memory storage: the tab's checklist and capabilities, the Kug 200a, the alternative list and the
// scans PDF through the export link, each rechecked in full at the download and compared by what
// it prints. Synthetic names, addresses and RV-Nummern only.
const storage = new MemoryFileStorage();
/** Runs before the renderer fills a form: a change between the read and the record. */
let beforeFill: (() => Promise<void>) | undefined;
const real = createPdfRenderer({ adapter: "mock", production: false, font: loadFont() });
const renderer: PdfRenderer = {
  async fillForm(input) {
    await beforeFill?.();
    return real.fillForm(input);
  },
  renderHtml: (document) => real.renderHtml(document),
};
const { app, db } = testApp({ fileStorage: storage, pdfRenderer: renderer });
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const fieldKey = fieldEncryptionKey(testEnv.fieldEncryptionKey!);
const ost = "beispielstadt-ost";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  beforeFill = undefined;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

function request(method: string, path: string, as: string = projectLead, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  return app.request(`/api/v1${path}`, init);
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const today = async () => (await sql("select berlin_today()::text as d")).rows[0].d as string;

/** The Agentur's scoped settings: the batch channel and, with `alternative`, the accepted list. */
async function agenturSetting(alternative = false, channel = "scan_email") {
  const { rows } = await sql(
    "select coalesce(max(version), 0)::int as v from project_config_override where project_id = $1",
    [werkNord],
  );
  const res = await request(
    "PUT",
    `/projects/${werkNord}/config/agentur-settings/${ost}`,
    projectLead,
    {
      expectedVersion: rows[0].v,
      settings: {
        asu_registration: {
          batchSubmissionChannel: channel,
          ...(alternative && { kug200aAlternativeAccepted: true }),
        },
      },
      source: "email_agentur",
      confirmedOn: await today(),
    },
  );
  expect(res.status).toBe(200);
}

/**
 * An informed participant placed with `ost` on `kug_200b`, with name, address and (unless
 * `rv: null`) an RV-Nummer, and an accepted Kug 200b scan uploaded as `scan` (PDF or PNG).
 */
async function ready({
  lastName,
  rv = "12290751D121" as string | null,
  scan = "pdf" as "pdf" | "png",
}: {
  lastName: string;
  rv?: string | null;
  scan?: "pdf" | "png";
}) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  await call(owner.$client, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  const keys = [id, werkNord];
  await sql(
    `insert into participant_identity (participation_id, project_id, personnel_number, first_name,
       last_name, birth_date) values ($1, $2, $3, 'Łucja', $4, '1970-01-01')`,
    [...keys, `P-${id.slice(0, 8)}`, lastName],
  );
  await sql(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country)
     values ($1, $2, 'Großer Weg 1', '10115', 'Berlin', 'DE')`,
    keys,
  );
  if (rv) {
    await sql(
      `insert into participant_identifier_data (participation_id, project_id,
         pension_insurance_number, pension_insurance_number_present, key_id)
       values ($1, $2, seal_sensitive_value($1, 'pensionInsuranceNumber', to_jsonb($3::text), $4),
         true, $5)`,
      [...keys, rv, fieldKey.key, fieldKey.keyId],
    );
  }
  await sql(
    "update participation set placement_agentur_key = $2, placement_agentur_set_at = now() where id = $1",
    [id, ost],
  );
  await call(owner.$client, "set_asu_route", {
    context: pl,
    participationId: id,
    channel: "kug_200b",
    version: 0,
  });
  const content = scan === "png" ? png : Buffer.from(await imageToPdf(png, "image/png"));
  const uploaded = await request("POST", `/participations/${id}/documents`, consultant, {
    type: "kug200b_signed_scan",
    fileName: scan === "png" ? "scan.png" : "scan.pdf",
    content: content.toString("base64"),
    origin: "external_paper",
  });
  expect(uploaded.status).toBe(201);
  const documentId = (await readJson(uploaded, DocumentView)).id;
  const reviewed = await request(
    "POST",
    `/participations/${id}/documents/${documentId}/review`,
    consultant,
    {
      decision: "accepted",
      kug200bScan: {
        signedOn: await today(),
        confirmations: ["declarations_ticked", "mandatory_completed", "signature_present"],
        formVersion: "09-2021",
      },
    },
  );
  expect(reviewed.status).toBe(200);
  return { id, documentId };
}

async function built(documentIds: string[]) {
  const res = await request("POST", `/projects/${werkNord}/kug200b-batches`, projectLead, {
    agenturKey: ost,
    documentIds,
  });
  expect(res.status).toBe(201);
  return (await readJson(res, Kug200bBatchCreated)).batchId;
}
const tab = async () =>
  readJson(await request("GET", `/projects/${werkNord}/kug200b-batches`), Kug200bBatchesView);
async function linkOf(kind: string, batchId: string) {
  const res = await request("POST", `/exports/${kind}`, projectLead, { batchId });
  expect(res.status).toBe(201);
  return (await readJson(res, ExportLink)).url;
}
const download = (url: string) => app.request(url, { headers: staff[projectLead]! });
const events = async (types: string[]) =>
  (
    await sql(
      `select event_type::text as type, participation_id, details from audit_event
       where event_type::text = any ($1) order by seq`,
      [types],
    )
  ).rows;

function expectDownloadPolicy(res: Response, name: RegExp) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-disposition")).toMatch(name);
}

describe("the Kug 200a of a batch", () => {
  it("shows the checklist, then streams the copies with the RV-Nummern read and audited", async () => {
    await agenturSetting();
    const members = [];
    for (let n = 1; n <= 7; n++) {
      members.push(await ready({ lastName: `Muster${n}`, rv: n === 2 ? null : "12290751D121" }));
    }
    const batchId = await built(members.map((m) => m.documentId));
    const batch = (await tab()).batches[0]!;
    expect(batch.capabilities).toEqual({
      submit: true,
      discard: true,
      exportIndex: true,
      exportArtifact: true,
      exportScans: true,
    });
    // The T-Kug-Nummer and the employer's numbers aren't set, the RV-Nummer of one and the TG
    // dates of all are missing.
    expect(
      batch.checklist!.map(({ code, key, participationIds }) => [
        code,
        key,
        participationIds.length,
      ]),
    ).toEqual([
      ["not_recorded", "tgKugNumber", 0],
      ["not_recorded", "employerBetriebsnummer", 0],
      ["not_recorded", "employerEconomicClass", 0],
      ["not_recorded", "participants.insuranceNumber", 1],
      ["not_recorded", "participants.plannedTgPeriod", 7],
      ["not_decided", "participants.lastActivity", 7],
      ["not_decided", "participants.lastActivityPeriod", 7],
    ]);
    expect(JSON.stringify(batch)).not.toContain("12290751D121");
    // Viewing the checklist decrypts nothing.
    expect(await events(["sensitive_read"])).toEqual([]);

    // Hidden from anyone but its PL.
    await expectProblem(
      await request("POST", "/exports/kug200b_batch_artifact", consultant, { batchId }),
      404,
      "not-found",
    );
    const res = await download(await linkOf("kug200b_batch_artifact", batchId));
    expectDownloadPolicy(res, /^attachment; filename="kug200a-\d{4}-\d{2}-\d{2}\.pdf"$/);
    // Seven members: two copies of two pages.
    expect(await pageCount(new Uint8Array(await res.arrayBuffer()))).toBe(4);
    const audited = await events(["export_created", "sensitive_read", "export_downloaded"]);
    expect(audited.filter((e) => e.type === "sensitive_read")).toHaveLength(6);
    expect(audited.at(0)).toEqual({
      type: "export_created",
      participation_id: null,
      details: { exportKind: "kug200b_batch_artifact", count: 7 },
    });
    expect(audited.at(-1)).toEqual({
      type: "export_downloaded",
      participation_id: null,
      details: { exportKind: "kug200b_batch_artifact", count: 7 },
    });
  });

  it("answers 409 source_changed when something printed moves while it renders", async () => {
    await agenturSetting();
    const { documentId } = await ready({ lastName: "Muster" });
    const batchId = await built([documentId]);
    const url = await linkOf("kug200b_batch_artifact", batchId);
    beforeFill = async () => {
      beforeFill = undefined;
      await request("PATCH", `/projects/${werkNord}`, projectLead, { tKugNumber: "0001" });
    };
    const res = await download(url);
    expect((await expectProblem(res, 409, "conflict")).errors?.[0]?.code).toBe("source_changed");
    expect(await events(["export_downloaded"])).toEqual([]);
    // Downloaded again, the new value is printed and the download recorded.
    expectDownloadPolicy(await download(url), /kug200a-/);
    expect(await events(["export_downloaded"])).toHaveLength(1);
  });

  it("rechecks the settings and the members at the download (export_stale)", async () => {
    await agenturSetting();
    const { documentId } = await ready({ lastName: "Muster" });
    const batchId = await built([documentId]);
    const url = await linkOf("kug200b_batch_artifact", batchId);
    // The acceptance of an alternative recorded after the link: the batch's artifact is stale.
    await agenturSetting(true);
    expect((await expectProblem(await download(url), 422, "domain-error")).errors?.[0]?.code).toBe(
      "export_stale",
    );
    await agenturSetting(false);
    await call(owner.$client, "quarantine_document", {
      context: pl,
      documentId,
      reason: "suspected_wrong_person",
    });
    expect((await expectProblem(await download(url), 422, "domain-error")).errors?.[0]?.code).toBe(
      "export_stale",
    );
    expect((await tab()).batches[0]).toMatchObject({
      checklist: null,
      capabilities: { exportArtifact: false, exportScans: false },
    });
    // Another session never opens the link.
    const other = await login(app, projectLead);
    expect((await app.request(url, { headers: other })).status).toBe(404);
  });
});

describe("the accepted alternative and the scans", () => {
  it("renders the alternative list with the Kug 200a's contents when the Agentur accepted it", async () => {
    await agenturSetting(true);
    const { documentId } = await ready({ lastName: "Muster" });
    const batchId = await built([documentId]);
    const batch = (await tab()).batches[0]!;
    expect(batch.artifact).toBe("accepted_alternative");
    expect(batch.checklist!.map((item) => item.key)).toContain("participants.lastActivity");
    const res = await download(await linkOf("kug200b_batch_artifact", batchId));
    expectDownloadPolicy(
      res,
      /^attachment; filename="sammelliste-kug200b-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    expect(await pageCount(new Uint8Array(await res.arrayBuffer()))).toBeGreaterThanOrEqual(1);
  });

  it("puts the members' accepted scans into one PDF, a PDF as it is and an image as a page", async () => {
    await agenturSetting();
    const first = await ready({ lastName: "Adler", scan: "png" });
    const second = await ready({ lastName: "Zimmer", scan: "pdf" });
    const batchId = await built([first.documentId, second.documentId]);
    const res = await download(await linkOf("kug200b_batch_scans", batchId));
    expectDownloadPolicy(res, /^attachment; filename="kug200b-scans-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(await pageCount(new Uint8Array(await res.arrayBuffer()))).toBe(2);
    expect(await events(["sensitive_read"])).toEqual([]);
    expect((await events(["export_downloaded"])).map((e) => e.details)).toEqual([
      { exportKind: "kug200b_batch_scans", count: 2 },
    ]);
  });

  it("offers no scans PDF on a paper channel: the Kug 200a goes with the originals", async () => {
    await agenturSetting(false, "paper_post");
    const { documentId } = await ready({ lastName: "Muster" });
    const batchId = await built([documentId]);
    expect((await tab()).batches[0]!.capabilities).toMatchObject({
      exportArtifact: true,
      exportScans: false,
    });
    const res = await request("POST", "/exports/kug200b_batch_scans", projectLead, { batchId });
    expect((await expectProblem(res, 422, "domain-error")).errors?.[0]?.code).toBe(
      "export_not_applicable",
    );
  });
});
