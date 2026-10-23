import {
  DevelopmentOutbox,
  ManualClock,
  MemoryFileStorage,
  MockMailer,
  MockSmsSender,
  MockVirusScanner,
  type FileStorage,
} from "@transfer/adapters";
import {
  createDb,
  participantAssignment,
  participantDetails,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  AssistedModeView,
  BatchActivationCodeResult,
  DocumentList,
  DocumentOpening,
  DocumentView,
  selfServiceMissing,
  type CompletenessRule,
} from "@transfer/domain";
import { createHash, randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { failClosedFacts } from "./participations/guard-facts";
import { loadSelfService } from "./participations/self-service";
import { documentPurgeQueue, startJobs, type Jobs } from "./jobs/jobs";
import { Slots } from "./imports/slots";
import { loadRelease } from "./projects/template-pins";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Documents in the API (ADR-0010, uploads; data-protection.md, uploads and documents; Q142–Q149)
// against transfer_test with memory storage and the mock scanner: the upload path, the opening
// and its link, review and deletion per role, assisted mode, the limits, and what never leaves in
// logs. Synthetic files only; the EICAR marker is assembled at runtime.
const clock = new ManualClock(new Date("2026-10-22T10:00:00Z"));
const outbox = new DevelopmentOutbox(clock);
const mailer = new MockMailer(outbox);
const smsSender = new MockSmsSender(outbox);
const storage = new MemoryFileStorage();
const scanner = new MockVirusScanner();
const { app, db, logs, detached } = testApp({
  clock,
  outbox,
  mailer,
  smsSender,
  fileStorage: storage,
  virusScanner: scanner,
});
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.verwaltung;
const FILE_NAME = "Lebenslauf Erika Beispiel.pdf";
const staff: Record<string, { Cookie: string }> = {};
/** Every response body of the test, to check what leaves. */
const answered: string[] = [];

const latin1 = (text: string) => Buffer.from(text, "latin1");
const pdf = (body = "synthetic CV") =>
  latin1(`%PDF-1.7\n1 0 obj\n<< /Title (${body}) >>\nendobj\ntrailer\n<<>>\n%%EOF\n`);
const PDF = pdf();
const eicar = () => pdf(`X5O ${["EICAR-STANDARD", "ANTIVIRUS-TEST-FILE!"].join("-")} $H+H*`);
const encryptedPdf = () => latin1("%PDF-1.7\ntrailer\n<< /Encrypt 5 0 R >>\n%%EOF\n");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const upload = (content: Buffer, extra: Record<string, unknown> = {}) => ({
  type: "cv",
  fileName: FILE_NAME,
  content: content.toString("base64"),
  ...extra,
});

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const user of ["projectLead", "consultant", "backOffice", "admin"] as const) {
    staff[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const key of storage.keys()) await storage.delete(key);
  scanner.available = true;
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

/** A browser on the portal (or any path): keeps the portal cookie as the server sets it. */
function browser() {
  let cookie: string | undefined;
  const request = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
    const init = method === "GET" ? { headers } : jsonRequest(method, body ?? {}, headers);
    const res = await app.request(path.startsWith("/api") ? path : `/api/v1/portal${path}`, init);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    answered.push(await res.clone().text());
    return res;
  };
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
    delete: (path: string) => request("DELETE", path),
    cookie: () => cookie!,
  };
}
type Browser = ReturnType<typeof browser>;

const lastCode = () => /\b(\d{6})\b/.exec(outbox.list().at(-1)!.text)![1]!;

/** Issues an activation code and enters it: an `activating` session. */
async function activating() {
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
  const portal = browser();
  await portal.post("/activation", { code });
  return { participationId, portal };
}

/** An activated participant with a live active session. */
async function activated() {
  const { participationId, portal } = await activating();
  await portal.post("/activation/birth-date", { birthDate: "1970-01-01" });
  await portal.post("/activation/channel", {
    kind: "email",
    address: `erika-${participationId.slice(-8)}@example.org`,
    language: "de",
  });
  const done = await portal.post("/activation/completion", {
    oneTimeCode: lastCode(),
    noticeVersion: "art14-activation:v1",
    consent: true,
    consentVersion: "portal-contact-consent:v2",
    language: "de",
  });
  expect(done.status).toBe(201);
  return { participationId, portal };
}

const staffRequest = async (
  user: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const init =
    method === "GET" ? { headers: staff[user]! } : jsonRequest(method, body ?? {}, staff[user]);
  const res = await app.request(`/api/v1${path}`, init);
  answered.push(await res.clone().text());
  return res;
};

const assign = (participationId: string) =>
  owner.insert(participantAssignment).values({
    projectId,
    participationId,
    staffUserId: seedStaffUserIds.consultant,
    assignedBy: seedStaffUserIds.projectLead,
  });

const audited = async (participationId: string) =>
  (
    await owner.$client.query(
      `select event_type, actor_type, actor_staff_user_id, on_behalf_of_participation_id,
         reason_code, details
       from audit_event where participation_id = $1 and event_type::text like 'document%'
       order by seq`,
      [participationId],
    )
  ).rows;
const documentRows = (participationId: string) =>
  owner.$client
    .query(
      `select id, type, file_name, review_state, deleted_by, delete_reason, deleted_at, purged_at
       from document where participation_id = $1 order by added_at`,
      [participationId],
    )
    .then((r) => r.rows);
const codesOf = async (res: Response, status: number, type: string) =>
  (await expectProblem(res, status, type)).errors?.map(({ code }) => code);

describe("the portal (data-protection.md, uploads)", () => {
  let participationId: string;
  let portal: Browser;
  beforeEach(async () => {
    ({ participationId, portal } = await activated());
  });

  it("stores one encrypted object and one row, audited document_added, and lists it", async () => {
    const res = await portal.post("/documents", upload(PDF));
    expect(res.status).toBe(201);
    const created = await readJson(res, DocumentView);
    expect(created).toMatchObject({
      type: "cv",
      mediaType: "application/pdf",
      sizeBytes: PDF.length,
      fileName: FILE_NAME,
      addedBy: "participant",
      onBehalf: false,
      review: { state: "unreviewed", reasonCode: null, reviewedAt: null },
      capabilities: { open: true, review: false, delete: true },
    });
    expect(storage.keys()).toEqual([`documents/${created.id}`]);
    const object = Buffer.from(await storage.get(`documents/${created.id}`));
    expect(object.subarray(0, 4).toString("latin1")).toBe("TPD1");
    expect(object.includes("synthetic CV")).toBe(false);
    expect(await audited(participationId)).toEqual([
      expect.objectContaining({
        event_type: "document_added",
        actor_type: "participant",
        details: { documentId: created.id, documentType: "cv", source: "portal" },
      }),
    ]);
    const list = await readJson(await portal.get("/documents"), DocumentList);
    expect(list).toEqual({
      documents: [created],
      addableTypes: ["cv", "participant_upload", "qualification_certificate"],
      limits: { maxBytes: 10 * 1024 * 1024, maxLiveDocuments: 50, maxUploadsPerHour: 20 },
    });
  });

  it("opens through a 60 s link of the same live session, as an exact attachment", async () => {
    const { id } = await readJson(await portal.post("/documents", upload(PDF)), DocumentView);
    const opened = await portal.post(`/documents/${id}/opening`);
    expect(opened.status).toBe(201);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    const { url } = await readJson(opened, DocumentOpening);
    const file = await portal.get(url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect(Object.fromEntries(file.headers)).toMatchObject({
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${FILE_NAME}"; filename*=UTF-8''${encodeURIComponent(FILE_NAME)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    // Reusable within the 60 s (mobile viewers ask twice), never without the session or by staff.
    expect((await portal.get(url)).status).toBe(200);
    expect((await app.request(url)).status).toBe(404);
    expect((await app.request(url, { headers: staff.projectLead })).status).toBe(404);
    expect(
      (await audited(participationId)).filter((e) => e.event_type === "document_opened"),
    ).toEqual([expect.objectContaining({ details: { documentType: "cv", documentId: id } })]);
    await owner.$client.query(
      "update document_link set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 second'",
    );
    await expectProblem(await portal.get(url), 404, "not-found");
  });

  it("refuses an infected or unscannable file: no object, no row, only document_upload_rejected", async () => {
    expect(
      await codesOf(await portal.post("/documents", upload(eicar())), 422, "domain-error"),
    ).toEqual(["file_infected"]);
    expect(
      await codesOf(await portal.post("/documents", upload(encryptedPdf())), 422, "domain-error"),
    ).toEqual(["file_unscannable"]);
    expect(storage.keys()).toEqual([]);
    expect(await documentRows(participationId)).toEqual([]);
    expect(
      (await audited(participationId)).map((e) => [e.event_type, e.reason_code, e.details]),
    ).toEqual([
      ["document_upload_rejected", "file_infected", { documentType: "cv" }],
      ["document_upload_rejected", "file_unscannable", { documentType: "cv" }],
    ]);
  });

  it("stores nothing when the scanner or the store is unavailable", async () => {
    scanner.available = false;
    const res = await portal.post("/documents", upload(PDF));
    expect(await codesOf(res, 503, "service-unavailable")).toEqual(["scan_unavailable"]);
    expect(res.headers.get("retry-after")).toBe("30");
    scanner.available = true;
    const broken: FileStorage = {
      put: () => Promise.reject(new Error("synthetic outage")),
      get: (key) => storage.get(key),
      delete: (key) => storage.delete(key),
    };
    const failing = testApp({ clock, fileStorage: broken, virusScanner: scanner });
    const failed = await failing.app.request(
      "/api/v1/portal/documents",
      jsonRequest("POST", upload(PDF), { Cookie: portal.cookie() }),
    );
    expect(await codesOf(failed, 503, "service-unavailable")).toEqual(["storage_unavailable"]);
    await failing.db.$client.end();
    expect(await documentRows(participationId)).toEqual([]);
    expect(await audited(participationId)).toEqual([]);
  });

  it("checks the file by its content and the limits (Q143)", async () => {
    const codes = async (body: unknown) =>
      codesOf(await portal.post("/documents", body), 422, "domain-error");
    expect(await codes(upload(Buffer.alloc(0)))).toEqual(["file_empty"]);
    expect(await codes(upload(latin1("<html><script></script></html>")))).toEqual([
      "file_type_not_allowed",
    ]);
    expect(await codes(upload(Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])))).toEqual([
      "file_too_large",
    ]);
    expect(await codes(upload(PDF, { type: "asu_proof" }))).toEqual([
      "document_type_not_supported",
    ]);
    expect(
      await codesOf(
        await portal.post("/documents", upload(PDF, { fileName: "x".repeat(201) })),
        400,
        "validation-error",
      ),
    ).toEqual(["file_name_invalid"]);
    // A PNG sent with a PDF name is a PNG; its download name gets the right extension.
    const res = await portal.post("/documents", upload(png, { fileName: "foto.pdf" }));
    expect(await readJson(res, DocumentView)).toMatchObject({ mediaType: "image/png" });
    const { id } = (await readJson(await portal.get("/documents"), DocumentList)).documents[0]!;
    const { url } = await readJson(await portal.post(`/documents/${id}/opening`), DocumentOpening);
    const file = await portal.get(url);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("content-disposition")).toContain('filename="foto.pdf.png"');
  });

  it("allows 20 uploads an hour (429 rate_limited)", async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await portal.post("/documents", upload(PDF))).status).toBe(201);
    }
    const res = await portal.post("/documents", upload(PDF));
    expect(await codesOf(res, 429, "too-many-requests")).toEqual(["rate_limited"]);
    expect(storage.keys()).toHaveLength(20);
  });

  it("deletes the own upload: the object purged, the row a tombstone without its name", async () => {
    const { id } = await readJson(await portal.post("/documents", upload(PDF)), DocumentView);
    expect((await portal.delete(`/documents/${id}`)).status).toBe(204);
    await detached.settle();
    expect(storage.keys()).toEqual([]);
    expect(await documentRows(participationId)).toEqual([
      expect.objectContaining({
        id,
        file_name: null,
        deleted_by: "participant",
        delete_reason: null,
        purged_at: expect.anything(),
      }),
    ]);
    expect((await readJson(await portal.get("/documents"), DocumentList)).documents).toEqual([]);
    await expectProblem(await portal.delete(`/documents/${id}`), 404, "not-found");
  });

  it("refuses an activating session and another participation's document", async () => {
    const pending = await activating();
    await expectProblem(await pending.portal.get("/documents"), 401, "unauthenticated");
    await expectProblem(
      await pending.portal.post("/documents", upload(PDF)),
      401,
      "unauthenticated",
    );
    const other = await activated();
    const { id } = await readJson(await other.portal.post("/documents", upload(PDF)), DocumentView);
    await expectProblem(await portal.post(`/documents/${id}/opening`), 404, "not-found");
    await expectProblem(await portal.delete(`/documents/${id}`), 404, "not-found");
  });
});

describe("staff (Q146)", () => {
  let participationId: string;
  let portal: Browser;
  let documentId: string;
  beforeEach(async () => {
    ({ participationId, portal } = await activated());
    ({ id: documentId } = await readJson(
      await portal.post("/documents", upload(PDF)),
      DocumentView,
    ));
  });
  const path = (rest = "") => `/participations/${participationId}/documents${rest}`;

  it("lets the PL upload as themselves, review and delete with a reason", async () => {
    const res = await staffRequest(
      "projectLead",
      "POST",
      path(),
      upload(PDF, { type: "qualification_certificate", fileName: "Zeugnis.pdf" }),
    );
    expect(res.status).toBe(201);
    expect(await readJson(res, DocumentView)).toMatchObject({ addedBy: "staff", onBehalf: false });
    const list = await readJson(await staffRequest("projectLead", "GET", path()), DocumentList);
    expect(list.documents.map((d) => d.capabilities)).toEqual([
      { open: true, review: true, delete: true },
      { open: true, review: true, delete: true },
    ]);
    const reviewed = await staffRequest("projectLead", "POST", path(`/${documentId}/review`), {
      decision: "accepted",
    });
    expect(await readJson(reviewed, DocumentView)).toMatchObject({
      review: { state: "accepted", reasonCode: null },
      capabilities: { review: false },
    });
    expect(
      await codesOf(
        await staffRequest("projectLead", "POST", path(`/${documentId}/review`), {
          decision: "rejected",
          reasonCode: "unreadable",
        }),
        422,
        "domain-error",
      ),
    ).toEqual(["document_reviewed"]);
    // The participant can't delete an accepted one, nor one staff added.
    expect(
      await codesOf(await portal.delete(`/documents/${documentId}`), 422, "domain-error"),
    ).toEqual(["document_accepted"]);
    const staffAdded = list.documents[1]!.id;
    await expectProblem(await portal.delete(`/documents/${staffAdded}`), 403, "forbidden");
    await expectProblem(
      await staffRequest("projectLead", "DELETE", path(`/${documentId}`)),
      400,
      "validation-error",
    );
    expect(
      (await staffRequest("projectLead", "DELETE", path(`/${documentId}?reasonCode=wrong_person`)))
        .status,
    ).toBe(204);
    await detached.settle();
    expect(storage.keys()).toHaveLength(1);
    expect((await audited(participationId)).map((e) => [e.event_type, e.reason_code])).toEqual([
      ["document_added", null],
      ["document_added", null],
      ["document_reviewed", null],
      ["document_deleted", "wrong_person"],
    ]);
  });

  it("lets the assigned consultant reject; completeness counts the live documents only", async () => {
    await expectProblem(await staffRequest("consultant", "GET", path()), 404, "not-found");
    await expectProblem(
      await staffRequest("consultant", "POST", path(), upload(PDF)),
      404,
      "not-found",
    );
    await assign(participationId);
    const release = loadRelease(undefined);
    const rule = { id: "r-cv", kind: "documentPresent", documentType: "cv" } as CompletenessRule;
    const missing = async () => {
      const { wizard } = (await loadSelfService(db, release, participationId))!;
      return selfServiceMissing({ ...wizard, rules: { profiling: [rule] } }).map((i) => i.reason);
    };
    expect(await missing()).toEqual([]);
    const rejected = await staffRequest("consultant", "POST", path(`/${documentId}/review`), {
      decision: "rejected",
      reasonCode: "unreadable",
    });
    expect(await readJson(rejected, DocumentView)).toMatchObject({
      review: { state: "rejected", reasonCode: "unreadable" },
    });
    expect(await missing()).toEqual(["not_accepted"]);
    expect(
      (await readJson(await portal.get("/documents"), DocumentList)).documents[0],
    ).toMatchObject({ review: { state: "rejected" }, capabilities: { delete: true } });
    expect((await portal.delete(`/documents/${documentId}`)).status).toBe(204);
    expect(await missing()).toEqual(["missing"]);
  });

  it("gives back office and the admin no document rights", async () => {
    for (const user of ["backOffice", "admin"]) {
      const list = await readJson(await staffRequest(user, "GET", path()), DocumentList);
      expect(list).toMatchObject({ documents: [], addableTypes: [] });
      await expectProblem(await staffRequest(user, "POST", path(), upload(PDF)), 403, "forbidden");
      await expectProblem(
        await staffRequest(user, "POST", path(`/${documentId}/opening`)),
        404,
        "not-found",
      );
    }
    expect(
      await codesOf(
        await staffRequest(
          "projectLead",
          "POST",
          `/participations/${participationId}/documents/${documentId}/review`,
          { decision: "rejected" },
        ),
        400,
        "validation-error",
      ),
    ).toEqual(["reason_code_mismatch"]);
  });

  it("opens for staff with a link bound to the staff session", async () => {
    const opened = await staffRequest("projectLead", "POST", path(`/${documentId}/opening`));
    const { url } = await readJson(opened, DocumentOpening);
    const file = await app.request(url, { headers: staff.projectLead });
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await app.request(url, { headers: staff.backOffice })).status).toBe(404);
    expect((await portal.get(url)).status).toBe(404);
    const other = await activated();
    const { id } = await readJson(await other.portal.post("/documents", upload(PDF)), DocumentView);
    await expectProblem(
      await staffRequest("projectLead", "POST", path(`/${id}/opening`)),
      404,
      "not-found",
    );
  });

  it("refuses uploads after a terminal status, but staff still delete", async () => {
    await owner.$client.query(
      `update participation set status = 'withdrawn', end_reason = 'other',
         end_reason_source = 'user', withdrawn_on = '2026-10-22' where id = $1`,
      [participationId],
    );
    expect(
      await codesOf(
        await staffRequest("projectLead", "POST", path(), upload(PDF)),
        422,
        "domain-error",
      ),
    ).toEqual(["participation_closed"]);
    expect(
      (await staffRequest("projectLead", "DELETE", path(`/${documentId}?reasonCode=wrong_person`)))
        .status,
    ).toBe(204);
  });
});

describe("assisted mode (ADR-0007)", () => {
  it("lists, adds on the participant's behalf and opens through the live mode", async () => {
    const { participationId } = await activated();
    const base = `/participations/${participationId}/assisted/documents`;
    await expectProblem(
      await staffRequest("projectLead", "GET", `${base}?assistedModeId=${randomUUID()}`),
      403,
      "forbidden",
    );
    const started = await staffRequest(
      "projectLead",
      "POST",
      `/participations/${participationId}/assisted-mode`,
      {
        confirmed: true,
        how: "phone",
      },
    );
    const { assistedModeId } = await readJson(started, AssistedModeView);
    const query = `?assistedModeId=${assistedModeId}`;
    const res = await staffRequest("projectLead", "POST", `${base}${query}`, upload(PDF));
    const created = await readJson(res, DocumentView);
    expect(created).toMatchObject({
      addedBy: "staff",
      onBehalf: true,
      capabilities: { open: true, review: false, delete: false },
    });
    const list = await readJson(
      await staffRequest("projectLead", "GET", `${base}${query}`),
      DocumentList,
    );
    expect(list.addableTypes).toEqual(["cv", "participant_upload", "qualification_certificate"]);
    const opened = await staffRequest(
      "projectLead",
      "POST",
      `${base}/${created.id}/opening${query}`,
    );
    const { url } = await readJson(opened, DocumentOpening);
    expect((await app.request(url, { headers: staff.projectLead })).status).toBe(200);
    expect(
      (await audited(participationId)).map((e) => [
        e.event_type,
        e.on_behalf_of_participation_id,
        e.details.source,
      ]),
    ).toEqual([
      ["document_added", participationId, "assisted"],
      ["document_opened", participationId, undefined],
    ]);
  });
});

describe("the limits and the wiring", () => {
  it("takes 14 MB on the upload routes only, and answers 503 upload_busy when the gate is full", async () => {
    const { portal } = await activated();
    const big = { type: "cv", fileName: "x.pdf", content: "A".repeat(15 * 1024 * 1024) };
    await expectProblem(await portal.post("/documents", big), 413, "payload-too-large");
    const pid = randomUUID();
    await expectProblem(
      await staffRequest(
        "projectLead",
        "POST",
        `/participations/${pid}/documents/${randomUUID()}/review`,
        {
          decision: "accepted",
          padding: "x".repeat(200 * 1024),
        },
      ),
      413,
      "payload-too-large",
    );
    const full = testApp({
      clock,
      fileStorage: storage,
      virusScanner: scanner,
      uploadSlots: new Slots({ running: 0, waiting: 0, waitMs: 0 }),
    });
    const res = await full.app.request(
      "/api/v1/portal/documents",
      jsonRequest("POST", upload(PDF), { Cookie: portal.cookie() }),
    );
    expect(await codesOf(res, 503, "service-unavailable")).toEqual(["upload_busy"]);
    expect(res.headers.get("retry-after")).toBe("10");
    await full.db.$client.end();
  });

  it("answers 503 storage_unavailable with NODE_ENV=production", async () => {
    const { participationId, portal } = await activated();
    const { id } = await readJson(await portal.post("/documents", upload(PDF)), DocumentView);
    const production = testApp({ clock, env: { nodeEnv: "production" }, fileStorage: storage });
    const cookie = { Cookie: portal.cookie() };
    for (const res of [
      await production.app.request(
        "/api/v1/portal/documents",
        jsonRequest("POST", upload(PDF), cookie),
      ),
      await production.app.request(
        `/api/v1/portal/documents/${id}/opening`,
        jsonRequest("POST", {}, cookie),
      ),
    ]) {
      expect(await codesOf(res, 503, "service-unavailable")).toEqual(["storage_unavailable"]);
    }
    await production.db.$client.end();
    expect(await documentRows(participationId)).toHaveLength(1);
  });

  it("logs no file name, content, hash, token or key", async () => {
    const { portal } = await activated();
    const { id } = await readJson(await portal.post("/documents", upload(PDF)), DocumentView);
    await portal.post("/documents", upload(eicar()));
    const { url } = await readJson(await portal.post(`/documents/${id}/opening`), DocumentOpening);
    await portal.get(url);
    const token = url.split("/").at(-1)!;
    const sha256 = createHash("sha256").update(PDF).digest("hex");
    const [{ key_id: keyId }] = (
      await owner.$client.query("select key_id from document where id = $1", [id])
    ).rows;
    const lines = logs.join("\n");
    for (const secret of [
      "Lebenslauf",
      PDF.toString("base64").slice(0, 24),
      sha256,
      token,
      keyId,
      "EICAR",
    ]) {
      expect(lines).not.toContain(secret);
    }
    expect(answered.join("\n")).not.toContain(sha256);
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        msg: "document upload",
        documentType: "cv",
        sizeBucket: "<100k",
        outcome: "stored",
      }),
    );
  });
});

describe("the purge job (ADR-0011)", () => {
  const jobLogs: string[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => jobLogs.push(line) });
  let jobs: Jobs | undefined;
  afterAll(() => jobs?.stop());

  it("is queued in the deletion's transaction and purges the object once", async () => {
    jobs = await startJobs({
      connectionString: testDatabaseUrls().app,
      lifecycleTime: "04:15",
      logger,
      work: { db, clock, facts: failClosedFacts, pollingIntervalSeconds: 0.5, storage },
    });
    const withQueue = testApp({
      clock,
      outbox,
      mailer,
      smsSender,
      fileStorage: storage,
      virusScanner: scanner,
      documentPurges: documentPurgeQueue(jobs.boss),
    });
    const { participationId, portal } = await activated();
    const { id } = await readJson(await portal.post("/documents", upload(PDF)), DocumentView);
    const res = await withQueue.app.request(
      `/api/v1/participations/${participationId}/documents/${id}?reasonCode=duplicate`,
      jsonRequest("DELETE", {}, await login(withQueue.app, seedStaffUserIds.projectLead)),
    );
    expect(res.status).toBe(204);
    for (let i = 0; i < 100 && storage.keys().length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(storage.keys()).toEqual([]);
    for (let i = 0; i < 50; i++) {
      const [row] = await documentRows(participationId);
      if (row.purged_at) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await documentRows(participationId))[0].purged_at).not.toBeNull();
    expect(jobLogs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ job: "documents.purge-object", documentId: id, outcome: "purged" }),
    );
    await withQueue.db.$client.end();
  });
});
