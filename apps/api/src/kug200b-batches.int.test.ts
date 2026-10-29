import { randomBytes, randomUUID } from "node:crypto";
import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, changeStatus, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  AsuView,
  canTransition,
  ExportLink,
  Kug200bBatchCreated,
  Kug200bBatchesView,
  Kug200bBatchSubmitted,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbGuardFacts } from "./participations/guard-facts";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The project tab "Agentur" and the Agentur's confirmation (process-and-lifecycle.md, Kug 200b
// batches; regional-variation.md, the accepted alternative; data-protection.md, exports; D24,
// D25, D33, Q203) against transfer_test: the PL's view, a batch built, rechecked, submitted or
// discarded, its work list through the export link, the members' registrations and the guard on
// the TG start. Synthetic data only; the Agentur `beispielstadt-ost` has no template, so its batch
// settings come from an Agentur-scoped setting.
const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, verwaltung } = seedProjectIds;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const ost = "beispielstadt-ost";
const three = ["declarations_ticked", "mandatory_completed", "signature_present"];
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(() => resetTestDatabase({ seed: true, active: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

function request(method: string, path: string, as: string = projectLead, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  return app.request(`/api/v1${path}`, init);
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const today = async () => (await sql("select berlin_today()::text as d")).rows[0].d as string;

/** The Agentur's scoped setting: the batch channel and, with `alternative`, the accepted alternative. */
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

/** An informed participant placed with `ost`, on `route`, with an accepted Kug 200b scan. */
async function ready({ lastName = "Beispiel", route = "kug_200b" as string | null } = {}) {
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
  await sql(
    `insert into participant_identity (participation_id, project_id, personnel_number, first_name,
       last_name, birth_date) values ($1, $2, $3, 'Erika', $4, '1970-01-01')`,
    [id, werkNord, `P-${id.slice(0, 8)}`, lastName],
  );
  await sql(
    `update participation set placement_agentur_key = $2, placement_agentur_set_at = now()
     where id = $1`,
    [id, ost],
  );
  if (route) {
    await call(owner.$client, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: route,
      version: 0,
    });
  }
  const documentId = await call(owner.$client, "add_document", {
    context: pl,
    participationId: id,
    id: randomUUID(),
    type: "kug200b_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    contentSha256: hex(),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    scanOrigin: "external_paper",
    generationDocumentId: null,
  });
  await call(owner.$client, "review_document", {
    context: pl,
    documentId,
    decision: "accepted",
    reason: null,
    signedOn: await today(),
    countersignedOn: null,
    confirmations: three,
    formVersion: "09-2021",
    declarations: null,
  });
  return { id, documentId };
}

const tab = async (as: string = projectLead) =>
  readJson(await request("GET", `/projects/${werkNord}/kug200b-batches`, as), Kug200bBatchesView);
const build = (documentIds: string[], as: string = projectLead) =>
  request("POST", `/projects/${werkNord}/kug200b-batches`, as, { agenturKey: ost, documentIds });
async function built(documentIds: string[]) {
  const res = await build(documentIds);
  expect(res.status).toBe(201);
  return (await readJson(res, Kug200bBatchCreated)).batchId;
}
const submitBatch = async (batchId: string, as: string = projectLead, submittedOn?: string) =>
  request("POST", `/kug200b-batches/${batchId}/submission`, as, {
    submittedOn: submittedOn ?? (await today()),
  });
const staleOf = async (res: Response) => {
  const body = await expectProblem(res, 422, "domain-error");
  expect(body.errors?.map((e) => e.code)).toEqual(["batch_stale"]);
  return body.staleRows;
};

describe("GET /projects/{id}/kug200b-batches (the tab Agentur)", () => {
  it("is the PL's: others of the project 403, an unknown project 404", async () => {
    await agenturSetting();
    const { id, documentId } = await ready();
    const view = await tab();
    expect(view.agenturen).toEqual([
      {
        agenturKey: ost,
        channel: "scan_email",
        artifact: { kind: "kug200a" },
        candidates: [
          {
            participationId: id,
            documentId,
            lastName: "Beispiel",
            firstName: "Erika",
            formVersion: "09-2021",
            asuChannel: "kug_200b",
          },
        ],
        routeMissing: [],
        capabilities: { createBatch: true },
      },
    ]);
    for (const as of [consultant, backOffice]) {
      await expectProblem(
        await request("GET", `/projects/${werkNord}/kug200b-batches`, as),
        403,
        "forbidden",
      );
    }
    await expectProblem(
      await request("GET", `/projects/${randomUUID()}/kug200b-batches`),
      404,
      "not-found",
    );
    await expectProblem(
      await request("GET", `/projects/${verwaltung}/kug200b-batches`),
      422,
      "domain-error",
    );
  });

  it('shows "Einstellungen fehlen" without the batch channel and refuses a batch (Q91)', async () => {
    const { documentId } = await ready();
    expect((await tab()).agenturen[0]).toMatchObject({
      channel: null,
      capabilities: { createBatch: false },
    });
    const res = await build([documentId]);
    expect((await expectProblem(res, 422, "domain-error")).errors?.[0]?.code).toBe(
      "batch_settings_missing",
    );
  });

  it("names the accepted alternative with its confirmation; the batch records it", async () => {
    await agenturSetting(true);
    const { documentId } = await ready();
    expect((await tab()).agenturen[0]!.artifact).toEqual({
      kind: "accepted_alternative",
      source: "email_agentur",
      confirmedBy: projectLead,
      confirmedOn: await today(),
    });
    const batchId = await built([documentId]);
    expect((await tab()).batches[0]).toMatchObject({
      id: batchId,
      artifact: "accepted_alternative",
    });
    // The acceptance withdrawn: the open batch is stale as a whole.
    await agenturSetting(false);
    const stale = (await tab()).batches[0]!;
    expect(stale.staleRows).toEqual([
      { participationId: null, documentId: null, reason: "settings_changed" },
    ]);
    expect(stale.capabilities).toEqual({ submit: false, discard: true, exportIndex: false });
    expect(await staleOf(await submitBatch(batchId))).toEqual(stale.staleRows);
  });
});

describe("a batch from building to the Agentur's confirmation (D19, D25)", () => {
  it("builds, submits and registers the kug_200b members; the Agentur's date follows", async () => {
    await agenturSetting();
    const onBatch = await ready({ lastName: "Albers" });
    const online = await ready({ lastName: "Zander", route: "online_self" });
    const batchId = await built([onBatch.documentId, online.documentId]);
    const view = await tab();
    expect(view.agenturen[0]!.candidates).toEqual([]);
    expect(view.batches[0]).toMatchObject({
      id: batchId,
      status: "open",
      channel: "scan_email",
      artifact: "kug200a",
      createdOn: await today(),
      staleRows: [],
      capabilities: { submit: true, discard: true, exportIndex: true },
    });
    expect(view.batches[0]!.members.map((m) => m.lastName)).toEqual(["Albers", "Zander"]);
    // Hidden from everyone but its PL, whatever its state.
    await expectProblem(await submitBatch(batchId, consultant), 404, "not-found");
    await expectProblem(
      await request("POST", `/kug200b-batches/${batchId}/discard`, consultant),
      404,
      "not-found",
    );
    await expectProblem(await submitBatch(randomUUID()), 404, "not-found");

    const res = await submitBatch(batchId);
    expect(res.status).toBe(200);
    expect(await readJson(res, Kug200bBatchSubmitted)).toEqual({
      submissions: 2,
      registrations: 1,
    });
    const asu = await readJson(await request("GET", `/participations/${onBatch.id}/asu`), AsuView);
    expect(asu.registration).toMatchObject({
      channel: "kug_200b",
      registeredOn: await today(),
      proof: { kind: "kug200b_submission" },
      confirmedOn: null,
    });
    expect(asu.capabilities.recordConfirmation).toBe(true);
    const consultantView = await readJson(
      await request("GET", `/participations/${onBatch.id}/asu`, consultant),
      AsuView,
    );
    expect(consultantView.capabilities.recordConfirmation).toBe(false);
    const confirm = (as: string, confirmedOn: string) =>
      request("POST", `/participations/${onBatch.id}/asu/confirmation`, as, {
        registrationId: asu.registration!.id,
        confirmedOn,
      });
    await expectProblem(await confirm(consultant, await today()), 403, "forbidden");
    await expectProblem(await confirm(backOffice, await today()), 403, "forbidden");
    const confirmed = await readJson(await confirm(projectLead, await today()), AsuView);
    expect(confirmed.registration!.confirmedOn).toBe(await today());
    expect(confirmed.capabilities.recordConfirmation).toBe(false);
    const again = await expectProblem(
      await confirm(projectLead, await today()),
      422,
      "domain-error",
    );
    expect(again.errors?.[0]?.code).toBe("asu_confirmed");
    // The other route got its submission, no registration.
    expect(
      (await readJson(await request("GET", `/participations/${online.id}/asu`), AsuView))
        .registration,
    ).toBeNull();
  });

  it("passes asu_registered_with_proof on the TG start through the batch submission (D33)", async () => {
    await agenturSetting();
    const { id, documentId } = await ready();
    const factsOf = () =>
      db.transaction((tx) => dbGuardFacts.facts(tx, { participationId: id, currentRequest: null }));
    expect((await factsOf()).asuRegisteredWithProof).toBeUndefined();
    await submitBatch(await built([documentId]));
    const { asuRegisteredWithProof } = await factsOf();
    const sentOn = await today();
    expect(asuRegisteredWithProof?.validOn).toBe(sentOn);
    const check = canTransition("main", "informed", "active_in_tg", {
      projectType: "ta_tg",
      current: { status: "informed", profilingStatus: "profiling_done", dsvStatus: "dsv_signed" },
      actor: { type: "system" },
      entryKind: "scheduled_entry",
      today: sentOn,
      scheduledAt: new Date(Date.now() + 1000),
      wave: null,
      participation: { tgStart: sentOn, tgEnd: null, offerDeadline: null },
      facts: { asuRegisteredWithProof },
    });
    expect(check.ok ? [] : check.failedGuards).not.toContain("asu_registered_with_proof");
  });

  it("refuses a stale batch with its rows; the terminal member gets no registration (D33)", async () => {
    await agenturSetting();
    const stays = await ready();
    const leaves = await ready();
    const batchId = await built([stays.documentId, leaves.documentId]);
    await changeStatus(owner.$client, leaves.id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await today(),
    });
    const rows = [
      { participationId: leaves.id, documentId: leaves.documentId, reason: "participation_closed" },
    ];
    expect((await tab()).batches[0]!.staleRows).toEqual(rows);
    expect(await staleOf(await submitBatch(batchId))).toEqual(rows);
    expect((await sql("select count(*)::int as n from asu_registration")).rows[0].n).toBe(0);
    // Discard and rebuild with the one who stays.
    expect((await request("POST", `/kug200b-batches/${batchId}/discard`)).status).toBe(204);
    expect((await tab()).agenturen[0]!.candidates.map((c) => c.participationId)).toEqual([
      stays.id,
    ]);
    const rebuilt = await built([stays.documentId]);
    expect((await submitBatch(rebuilt)).status).toBe(200);
  });

  it("refuses a scan that can't join with its row, and a sent date outside the batch's days", async () => {
    await agenturSetting();
    const { id, documentId } = await ready();
    const batchId = await built([documentId]);
    expect(await staleOf(await build([documentId]))).toEqual([
      { participationId: id, documentId, reason: "in_open_batch" },
    ]);
    const future = await expectProblem(
      await submitBatch(batchId, projectLead, "2999-01-01"),
      422,
      "domain-error",
    );
    expect(future.errors).toEqual([
      { pointer: "/submittedOn", code: "submitted_on_in_future", detail: expect.any(String) },
    ]);
  });
});

describe("the batch's work list (data-protection.md, exports; D24)", () => {
  it("issues a link, re-authorizes and streams the CSV with the download policy", async () => {
    await agenturSetting();
    const { documentId } = await ready({ lastName: "=Formel" });
    const batchId = await built([documentId]);
    // A body of the other kind is refused; another viewer learns nothing.
    const mismatch = await request("POST", "/exports/kug200b_print", projectLead, { batchId });
    expect((await expectProblem(mismatch, 422, "domain-error")).errors?.[0]?.code).toBe(
      "invalid_argument",
    );
    await expectProblem(
      await request("POST", "/exports/kug200b_batch_index", consultant, { batchId }),
      404,
      "not-found",
    );
    const res = await request("POST", "/exports/kug200b_batch_index", projectLead, { batchId });
    expect(res.status).toBe(201);
    const { url } = await readJson(res, ExportLink);
    const download = await app.request(url, { headers: staff[projectLead]! });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(download.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="kug200b-arbeitsliste-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      new Uint8Array(await download.arrayBuffer()),
    );
    expect(text).toBe("﻿Nachname;Vorname;Formularversion\r\n'=Formel;Erika;09-2021\r\n");
    // Another session never opens the link.
    const other = await login(app, projectLead);
    expect((await app.request(url, { headers: other })).status).toBe(404);
    const events = (
      await sql(
        `select event_type::text as type, participation_id, details from audit_event
         where event_type::text in ('export_created', 'export_downloaded') order by seq`,
      )
    ).rows;
    expect(events).toEqual([
      {
        type: "export_created",
        participation_id: null,
        details: { exportKind: "kug200b_batch_index", count: 1 },
      },
      {
        type: "export_downloaded",
        participation_id: null,
        details: { exportKind: "kug200b_batch_index", count: 1 },
      },
    ]);
  });

  it("refuses a stale batch's link with its rows and a stale download", async () => {
    await agenturSetting();
    const { id, documentId } = await ready();
    const batchId = await built([documentId]);
    const res = await request("POST", "/exports/kug200b_batch_index", projectLead, { batchId });
    const { url } = await readJson(res, ExportLink);
    await call(owner.$client, "quarantine_document", {
      context: pl,
      documentId,
      reason: "suspected_wrong_person",
    });
    const download = await app.request(url, { headers: staff[projectLead]! });
    expect((await expectProblem(download, 422, "domain-error")).errors?.[0]?.code).toBe(
      "export_stale",
    );
    expect(
      await staleOf(
        await request("POST", "/exports/kug200b_batch_index", projectLead, { batchId }),
      ),
    ).toEqual([{ participationId: id, documentId, reason: "scan_unusable" }]);
  });
});

describe("from the review of PR #98", () => {
  it("keeps the tab when the last participant of an Agentur closes before any batch", async () => {
    const { id } = await ready();
    await changeStatus(owner.$client, id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await today(),
    });
    const view = await tab();
    expect(view.agenturen).toEqual([]);
    expect(view.withoutPlacementAgentur).toBe(0);
  });

  it("names the participants without a route and refuses them in a batch (Q203)", async () => {
    await agenturSetting();
    const { id, documentId } = await ready({ route: null });
    const agentur = (await tab()).agenturen[0]!;
    expect(agentur.candidates).toEqual([]);
    expect(agentur.routeMissing).toEqual([
      { participationId: id, lastName: "Beispiel", firstName: "Erika" },
    ]);
    expect(agentur.capabilities.createBatch).toBe(false);
    expect(await staleOf(await build([documentId]))).toEqual([
      { participationId: id, documentId, reason: "asu_route_unset" },
    ]);
  });

  it("withholds the guard fact while the submitted scan is quarantined, from the lift on again", async () => {
    await agenturSetting();
    const { id, documentId } = await ready();
    await submitBatch(await built([documentId]));
    const factsOf = () =>
      db.transaction((tx) => dbGuardFacts.facts(tx, { participationId: id, currentRequest: null }));
    const submitted = (await factsOf()).asuRegisteredWithProof!;
    expect(submitted.validOn).toBe(await today());
    await call(owner.$client, "quarantine_document", {
      context: pl,
      documentId,
      reason: "suspected_wrong_person",
    });
    expect((await factsOf()).asuRegisteredWithProof).toBeUndefined();
    // The registration stays as history; the tab says its proof is unusable.
    const asu = await readJson(await request("GET", `/participations/${id}/asu`), AsuView);
    expect(asu.registration).toMatchObject({
      channel: "kug_200b",
      proof: { kind: "kug200b_submission" },
      withProofSince: null,
    });
    await call(owner.$client, "lift_document_quarantine", { context: pl, documentId });
    const { rows } = await sql(
      `select to_char(quarantine_lifted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
       from document where id = $1`,
      [documentId],
    );
    const lifted = (await factsOf()).asuRegisteredWithProof!;
    expect(lifted.validOn).toBe(submitted.validOn);
    expect(lifted.recordedAt.toISOString()).toBe(new Date(rows[0].at).toISOString());
    expect(lifted.recordedAt.getTime()).toBeGreaterThan(submitted.recordedAt.getTime());
    // No lifecycle status moved with either.
    expect(
      (await sql("select status::text from participation where id = $1", [id])).rows[0].status,
    ).toBe("informed");
  });
});
