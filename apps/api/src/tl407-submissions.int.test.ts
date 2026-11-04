import { randomBytes, randomUUID } from "node:crypto";
import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  Escalations,
  matchesWorklistFilter,
  ProfilingView,
  ProjectDashboard,
  Tl407SubmissionCreated,
  Worklist,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, origin, readJson, testApp } from "./testing";

// The TL 407's submission and the escalations (process-and-lifecycle.md, TL 407 submission;
// data-protection.md, the regional view; D26, D27, Q54, Q57, Q92, Q189) against transfer_test:
// submission, original and rejection with ADR-0010's order, the tab's attempts, the work list's
// deadline, items and counts, and the regional admin's counts. Synthetic data only; the Agentur
// `beispielstadt-ost` has no template, so its settings come from an Agentur-scoped setting.
const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, lagerSued } = seedProjectIds;
const { projectLead, consultant, backOffice, regionalAdmin, admin, regionalOperationsManager } =
  seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const ost = "beispielstadt-ost";
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const all = { submissionChannel: "email", originalRequired: true, leadTimeDays: 10 } as const;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [
    projectLead,
    consultant,
    backOffice,
    regionalAdmin,
    admin,
    regionalOperationsManager,
  ]) {
    staff[id] = await login(app, id);
  }
});
beforeEach(() => resetTestDatabase({ seed: true, active: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

function request(method: string, path: string, as: string = projectLead, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  return app.request(`/api/v1${path}`, init);
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const day = async (offset = 0) =>
  (await sql("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d as string;

/** Ost's Agentur-scoped `agentur_submission` settings (all four unless overridden). */
async function settings(
  values: Record<string, unknown> = { ...all, rejectsOutdatedFormVersions: false },
) {
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
      settings: { agentur_submission: values },
      source: "email_agentur",
      confirmedOn: await day(),
    },
  );
  expect(res.status).toBe(200);
}

/**
 * An informed participation of Werk Nord placed with Ost, assigned to the consultant, its TG start
 * `tgStartIn` days from today, with an accepted TL 407 signed `signedDaysAgo` days ago.
 */
async function ready({ tgStartIn = 20, signedDaysAgo = 5, scan = true, assign = true } = {}) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  if (assign) {
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
  }
  await sql(
    `update participation set placement_agentur_key = $2, placement_agentur_set_at = now(),
       entry_wave_id = null, tg_start = berlin_today() + $3::int, tg_end = berlin_today() + 400
     where id = $1`,
    [id, ost, tgStartIn],
  );
  if (!scan) return { id, documentId: null as unknown as string };
  const documentId = await call(owner.$client, "add_document", {
    context: pl,
    participationId: id,
    id: randomUUID(),
    type: "tl407_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    contentSha256: hex(),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    scanOrigin: "external_paper",
    generationDocumentId: null,
  });
  const signedOn = await day(-signedDaysAgo);
  await call(owner.$client, "review_document", {
    context: pl,
    documentId,
    decision: "accepted",
    reason: null,
    signedOn,
    countersignedOn: signedOn,
    confirmations: ["signatures_present", "all_pages_present"],
    formVersion: "08-2025",
    declarations: JSON.stringify({
      kind: "as_marked",
      jobboerseChoice: "none",
      baContactConsent: false,
    }),
  });
  return { id, documentId };
}

const profiling = async (id: string, as: string = projectLead) =>
  readJson(await request("GET", `/participations/${id}/profiling`, as), ProfilingView);
const submit = async (
  id: string,
  documentId: string,
  body: Record<string, unknown> = {},
  as: string = projectLead,
) =>
  request("POST", `/participations/${id}/tl407-submissions`, as, {
    documentId,
    channel: "email",
    originalRequired: true,
    submittedOn: await day(-1),
    ...body,
  });
async function submitted(id: string, documentId: string, body: Record<string, unknown> = {}) {
  const res = await submit(id, documentId, body);
  expect(res.status).toBe(201);
  return (await readJson(res, Tl407SubmissionCreated)).submissionId;
}
const codes = async (res: Response, status = 422) =>
  (await expectProblem(res, status, status === 409 ? "conflict" : "domain-error")).errors?.map(
    (e) => e.code,
  );
const worklist = async () =>
  readJson(await request("GET", `/projects/${werkNord}/worklist`), Worklist);
const row = async (id: string) => (await worklist()).items.find((i) => i.id === id)!;

describe("POST /participations/{id}/tl407-submissions (D26)", () => {
  it("records the PL's submission with the resolved channel; the tab lists the attempt", async () => {
    await settings();
    const { id, documentId } = await ready();
    const before = await profiling(id);
    expect(before.tl407Submission).toEqual({
      attempts: [],
      next: {
        documentId,
        formVersion: "08-2025",
        agenturKey: ost,
        channel: "email",
        originalRequired: true,
        problem: null,
      },
    });
    const submissionId = await submitted(id, documentId);
    const after = await profiling(id);
    expect(after.tl407Submission.attempts).toEqual([
      expect.objectContaining({
        id: submissionId,
        documentId,
        channel: "email",
        submittedOn: await day(-1),
        originalRequired: true,
        originalSentOn: null,
        rejection: null,
        capabilities: { recordOriginal: true, recordRejection: true },
      }),
    ]);
    expect(after.tl407Submission.next?.problem).toBe("already_submitted");
    // The assigned consultant reads the attempts, records nothing, and gets no next submission.
    const seen = await profiling(id, consultant);
    expect(seen.tl407Submission.next).toBeNull();
    expect(seen.tl407Submission.attempts[0]!.capabilities).toEqual({
      recordOriginal: false,
      recordRejection: false,
    });
  });

  it("answers visibility before permission before state", async () => {
    await settings();
    const { id, documentId } = await ready();
    const hidden = await ready({ assign: false });
    // An unassigned consultant: 404, whatever the state (here also a missing document).
    await expectProblem(await submit(hidden.id, randomUUID(), {}, consultant), 404, "not-found");
    await expectProblem(await submit(id, documentId, {}, consultant), 403, "forbidden");
    await expectProblem(await submit(id, documentId, {}, backOffice), 403, "forbidden");
    await expectProblem(await submit(randomUUID(), documentId), 404, "not-found");
    expect(await codes(await submit(id, randomUUID()))).toEqual(["document_not_found"]);
    const empty = await app.request(`/api/v1/participations/${id}/tl407-submissions`, {
      method: "POST",
      headers: { ...staff[projectLead]!, Origin: origin },
    });
    expect(empty.status).toBe(415);
  });

  it("is refused with the agentur_submission blocker until all four settings are set (Q92)", async () => {
    const { id, documentId } = await ready();
    expect((await profiling(id)).tl407Submission.next).toMatchObject({
      channel: null,
      problem: "submission_settings_missing",
    });
    expect(await codes(await submit(id, documentId))).toEqual(["submission_settings_missing"]);
    await settings({ ...all });
    expect(await codes(await submit(id, documentId))).toEqual(["submission_settings_missing"]);
    await sql(
      "update participation set placement_agentur_key = null, placement_agentur_set_at = null where id = $1",
      [id],
    );
    expect(await codes(await submit(id, documentId))).toEqual(["placement_agentur_missing"]);
  });

  it("refuses with source_changed when the settings the PL saw changed", async () => {
    await settings();
    const { id, documentId } = await ready();
    expect(await codes(await submit(id, documentId, { channel: "upload" }), 409)).toEqual([
      "source_changed",
    ]);
    expect(await codes(await submit(id, documentId, { originalRequired: false }), 409)).toEqual([
      "source_changed",
    ]);
  });

  it("supports no submission with a quarantined scan", async () => {
    await settings();
    const { id, documentId } = await ready();
    await call(owner.$client, "quarantine_document", {
      context: pl,
      documentId,
      reason: "suspected_wrong_person",
    });
    expect((await profiling(id)).tl407Submission.next).toMatchObject({
      documentId: null,
      problem: "scan_unusable",
    });
    expect(await codes(await submit(id, documentId))).toEqual(["scan_unusable"]);
  });
});

describe("the rejection, the resubmission and the original (Q189)", () => {
  it("reopens the work until a new submission; the signatures and profiling stay", async () => {
    await settings();
    const { id, documentId } = await ready();
    const first = await submitted(id, documentId, { submittedOn: await day(-3) });
    expect(await codes(await submit(id, documentId))).toEqual(["already_submitted"]);
    const before = await profiling(id);
    const reject = (body: Record<string, unknown>, as: string = projectLead, submission = first) =>
      request("POST", `/agentur-submissions/${submission}/rejection`, as, body);
    expect(await codes(await reject({ rejectedOn: await day(1), reason: "incomplete" }))).toEqual([
      "date_in_future",
    ]);
    await expectProblem(
      await reject({ rejectedOn: await day(-2), reason: "incomplete" }, consultant),
      403,
      "forbidden",
    );
    await expectProblem(
      await reject({ rejectedOn: await day(-2), reason: "incomplete" }, projectLead, randomUUID()),
      404,
      "not-found",
    );
    expect((await reject({ rejectedOn: await day(-2), reason: "incomplete" })).status).toBe(204);
    const rejected = await profiling(id);
    expect(rejected.tl407Scans).toEqual(before.tl407Scans);
    expect(rejected.tl407SignedOn).toBe(before.tl407SignedOn);
    expect(rejected.tl407Submission.attempts[0]!.rejection).toEqual({
      rejectedOn: await day(-2),
      reason: "incomplete",
    });
    expect(rejected.tl407Submission.next?.problem).toBeNull();
    expect((await row(id)).agenturItems).toEqual([
      { kind: "tl407_resubmission_open", date: await day(-2) },
    ]);
    const second = await submitted(id, documentId, { submittedOn: await day(-1) });
    expect((await profiling(id)).tl407Submission.attempts.map((a) => a.id)).toEqual([
      second,
      first,
    ]);
    expect((await row(id)).agenturItems).toEqual([
      { kind: "tl407_original_missing", date: await day(-1) },
    ]);
    const original = (originalSentOn: string) =>
      request("POST", `/agentur-submissions/${second}/original`, projectLead, { originalSentOn });
    expect(await codes(await original(await day(-2)))).toEqual(["date_before_submission"]);
    expect((await original(await day(0))).status).toBe(204);
    expect(await codes(await original(await day(0)))).toEqual(["original_recorded"]);
    expect((await row(id)).agenturItems).toEqual([]);
    const history = await request("GET", `/participations/${id}/history?stream=profiling`);
    expect(history.status).toBe(200);
  });
});

describe("the work list's deadline, items and counts (D27)", () => {
  it("dates tl407_submission by the lead time and counts the tile and group from the same items", async () => {
    await settings();
    const { id } = await ready({ tgStartIn: 20, scan: false });
    expect((await row(id)).deadlines).toContainEqual({
      kind: "tl407_submission",
      date: await day(10),
      state: "upcoming",
    });
    const late = await ready({ tgStartIn: -15, scan: false });
    expect((await row(late.id)).agenturItems).toEqual([
      { kind: "tl407_escalated", date: await day(-1) },
    ]);
    const items = (await worklist()).items;
    const dashboard = readJson(
      await request("GET", `/projects/${werkNord}/dashboard`),
      ProjectDashboard,
    );
    const counts = (await dashboard).counts;
    for (const entry of [
      ...counts.agentur,
      ...counts.tiles.filter((t) => t.key === "agentur_open"),
    ]) {
      expect(entry.count).toBe(items.filter((i) => matchesWorklistFilter(i, entry.filter)).length);
    }
    expect(counts.agentur.find((c) => c.key === "tl407_escalated")!.count).toBeGreaterThan(0);
  });
});

const view = async (as: string) => readJson(await request("GET", "/escalations", as), Escalations);
const countOf = (rows: Escalations["rows"], type: string) =>
  rows.find((r) => r.projectId === werkNord)?.counts.find((c) => c.type === type);
const tl407Count = (rows: Escalations["rows"]) => countOf(rows, "tl407_not_submitted")?.count ?? 0;
const complianceOf = (rows: Escalations["rows"]) => countOf(rows, "profiling_compliance");

describe("GET /escalations (data-protection.md, the regional view; Q57)", () => {
  it("counts a TL 407 unsubmitted 14 days after TG start for the regional admin, no participant", async () => {
    const before = await view(regionalAdmin);
    const { id } = await ready({ tgStartIn: -14, scan: false });
    const after = await view(regionalAdmin);
    expect(tl407Count(after.rows)).toBe(tl407Count(before.rows) + 1);
    const nord = after.rows.find((r) => r.projectId === werkNord)!;
    expect(nord.leads.length).toBeGreaterThan(0);
    const text = JSON.stringify(after);
    expect(text).not.toContain(id);
    expect(text).not.toContain("Erika");
    // Lager Süd is outside the regional admin's region; the admin sees every project.
    expect(after.rows.some((r) => r.projectId === lagerSued)).toBe(false);
    const adminView = await view(admin);
    expect(tl407Count(adminView.rows)).toBe(tl407Count(after.rows));
  });

  it("is nobody else's: the PL, a consultant, back office and the operations manager get 403", async () => {
    for (const as of [projectLead, consultant, backOffice, regionalOperationsManager]) {
      await expectProblem(await request("GET", "/escalations", as), 403, "forbidden");
    }
  });

  it("escalates a refusal after entry the same day (profiling_compliance)", async () => {
    const before = complianceOf((await view(admin)).rows)?.count ?? 0;
    const { id } = await ready({ tgStartIn: -5, scan: false });
    await sql(
      `update participation set status = 'active_in_tg', tg_entry_date = berlin_today() - 5,
         entry_wave_id = (select id from project_entry_wave where project_id = $2 limit 1),
         dsv_status = 'dsv_signed', profiling_status = 'profiling_declined' where id = $1`,
      [id, werkNord],
    );
    const after = complianceOf((await view(admin)).rows)!;
    expect(after.count).toBe(before + 1);
    expect(after.oldestDaysOverdue).toBeGreaterThanOrEqual(0);
  });
});
