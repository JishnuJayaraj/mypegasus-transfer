import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import { addDays, addMonths, AsuView, canTransition, Worklist } from "@transfer/domain";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbGuardFacts } from "./participations/guard-facts";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The tab "Arbeitsuche" (process-and-lifecycle.md, Arbeitsuchendmeldung and dates;
// data-protection.md, the ASU record; Q184, Q186; readings Q201) against transfer_test on the
// system clock: the view per viewer, the route, the registration with the PL's attestation, the
// BA confirmation's link, the knowledge date, the fact `asuRegisteredWithProof` and the work list.
// Synthetic data only; the BA-Kundennummer is made up.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, verwaltung } = seedProjectIds;
const { projectLead, consultant, backOffice, admin } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const answered: string[] = [];
const number = "987B654321";
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice, admin]) staff[id] = await login(app, id);
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

const today = async () =>
  (await owner.$client.query("select berlin_today()::text as d")).rows[0].d as string;

/** An informed participation, assigned to the consultant. */
async function participation(projectId: string = werkNord) {
  const id = await call(owner.$client, "create_participation", { projectId, context: pl });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  await call(owner.$client, "assign_participations", {
    projectId,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  await call(owner.$client, "write_participant_data", {
    participationId: id,
    context: pl,
    personnelNumber: `P-${id.slice(0, 8)}`,
    lastName: "Beispiel",
    firstName: "Alex",
  });
  return id;
}

const view = async (id: string, as: string = projectLead) => {
  const res = await request("GET", `/participations/${id}/asu`, as);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, AsuView);
};
const route = (id: string, channel: string, version: number, as: string = projectLead) =>
  request("PUT", `/participations/${id}/asu/route`, as, { channel, version });
const register = (id: string, body: unknown, as: string = projectLead) =>
  request("POST", `/participations/${id}/asu/registration`, as, body);

/** An accepted BA confirmation added and reviewed by the consultant; its id. */
async function acceptedProof(id: string) {
  const documentId = await call(owner.$client, "add_document", {
    context: asConsultant,
    participationId: id,
    id: randomUUID(),
    type: "asu_proof",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: randomBytes(8).toString("hex"),
    wrappedKey: randomBytes(60),
  });
  await call(owner.$client, "review_document", {
    context: asConsultant,
    documentId,
    decision: "accepted",
    reason: null,
  });
  return documentId;
}

/** The facts the guards read, as the status service reads them. */
const factsOf = (id: string) =>
  db.transaction((tx) => dbGuardFacts.facts(tx, { participationId: id, currentRequest: null }));

describe("GET /participations/{id}/asu (the tab Arbeitsuche)", () => {
  it("shows the PL, the consultant and back office the record; others nothing", async () => {
    const id = await participation();
    const tab = await view(id);
    expect(tab).toMatchObject({
      applies: true,
      closed: false,
      route: { channel: null, version: 0, defaultChannel: null },
      knowledgeDate: null,
      oldEmploymentEndDate: null,
      dueDate: null,
      registration: null,
      proofDocuments: [],
      capabilities: {
        setRoute: true,
        recordRegistration: false,
        attest: false,
        linkProof: false,
        setKnowledgeDate: true,
        addProof: true,
      },
    });
    expect((await view(id, consultant)).capabilities).toMatchObject({
      setRoute: true,
      setKnowledgeDate: false,
      addProof: true,
    });
    expect(Object.values((await view(id, backOffice)).capabilities).some(Boolean)).toBe(false);
    await call(owner.$client, "unassign_participation", {
      participationId: id,
      staffUserId: consultant,
      context: pl,
    });
    await expectProblem(
      await request("GET", `/participations/${id}/asu`, consultant),
      404,
      "not-found",
    );
    expect([403, 404]).toContain((await request("GET", `/participations/${id}/asu`, admin)).status);
  });

  it("preselects the placement Agentur's default route and says nothing applies in ta_only", async () => {
    const id = await participation();
    const res = await request("PUT", `/participations/${id}/placement-agentur`, projectLead, {
      agenturKey: "beispielstadt-sued",
    });
    expect(res.status).toBe(200);
    expect((await view(id)).route.defaultChannel).toBe("online_self");
    const taOnly = await participation(verwaltung);
    const tab = await view(taOnly);
    expect(tab.applies).toBe(false);
    expect(tab.capabilities).toMatchObject({ setRoute: false, addProof: false });
    expect(tab.missing).toEqual([]);
  });
});

describe("the route and the Kug 200b rules (D19, D21)", () => {
  it("applies the rules with when only on kug_200b, the RV item only for whom may know it", async () => {
    const id = await participation();
    const asu = (tab: AsuView) => tab.missing.map((m) => m.ruleId);
    expect(asu(await view(id))).toEqual(["base-asu-proof"]);
    expect((await route(id, "kug_200b", 0)).status).toBe(200);
    expect(asu(await view(id, consultant))).toEqual([
      "base-asu-proof",
      "base-kug200b-rv-nummer",
      "base-kug200b-signed-scan",
    ]);
    // The PL doesn't know the identifiers' keys (data-protection.md, access matrix).
    expect(asu(await view(id))).toEqual(["base-asu-proof", "base-kug200b-signed-scan"]);
    const res = await route(id, "in_person", 1, consultant);
    expect(res.status).toBe(200);
    expect(asu(await readJson(res, AsuView))).toEqual(["base-asu-proof"]);
    const stale = await expectProblem(await route(id, "online_self", 1), 409, "conflict");
    expect(stale.errors?.[0]).toMatchObject({ code: "stale_revision" });
    await expectProblem(await route(id, "online_self", 2, backOffice), 403, "forbidden");
  });
});

describe("POST …/asu/registration (D19; Q184, Q186)", () => {
  it("records the PL's attestation with its date and source; the number never leaves", async () => {
    const id = await participation();
    await route(id, "online_self", 0);
    const registeredOn = addDays(await today(), -4);
    const attestation = { customerNumber: number, source: "ba_online_account_inspected" };
    await expectProblem(
      await register(id, { registeredOn, attestation }, consultant),
      403,
      "forbidden",
    );
    const half = await register(id, { registeredOn, attestation: { customerNumber: number } });
    await expectProblem(half, 400, "validation-error");
    await expectProblem(
      await register(id, { registeredOn: addDays(await today(), 1), attestation }),
      422,
      "domain-error",
    );
    const res = await register(id, { registeredOn, attestation });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tab = await readJson(res, AsuView);
    expect(tab.registration).toMatchObject({
      channel: "online_self",
      registeredOn,
      proof: { kind: "ba_customer_number", attestationSource: "ba_online_account_inspected" },
    });
    expect(tab.registration!.withProofSince).toBe(tab.registration!.recordedAt);
    expect(tab.missing).toEqual([]);
    expect(tab.capabilities).toMatchObject({ setRoute: false, recordRegistration: false });
    const again = await expectProblem(await register(id, { registeredOn }), 422, "domain-error");
    expect(again.errors?.[0]).toMatchObject({ code: "asu_registered" });
    // Never returned, logged, in an error or in an audit detail (D19).
    expect(answered.join("\n")).not.toContain(number);
    expect(JSON.stringify(logs)).not.toContain(number);
    const audit = await owner.$client.query("select details::text from audit_event");
    expect(JSON.stringify(audit.rows)).not.toContain(number);
  });

  it("refuses a malformed number without echoing it", async () => {
    const id = await participation();
    await route(id, "in_person", 0);
    const bad = "12-34-56-78";
    const res = await register(id, {
      registeredOn: await today(),
      attestation: { customerNumber: bad, source: "ba_document_inspected" },
    });
    await expectProblem(res, 400, "validation-error");
    expect(answered.join("\n")).not.toContain(bad);
  });

  it("refuses a registration on the route kug_200b (the batch submission records it)", async () => {
    const id = await participation();
    await route(id, "kug_200b", 0);
    const res = await register(id, { registeredOn: await today() }, consultant);
    expect((await expectProblem(res, 422, "domain-error")).errors?.[0]).toMatchObject({
      code: "asu_route_kug200b",
    });
  });
});

describe("the BA confirmation and its link (D19; Q201)", () => {
  it("is linked by the consultant; the PL sees metadata only and can't open it", async () => {
    const id = await participation();
    await route(id, "online_self", 0);
    await register(id, { registeredOn: addDays(await today(), -2) }, consultant);
    const documentId = await acceptedProof(id);
    const plTab = await view(id);
    expect(plTab.proofDocuments).toEqual([
      expect.objectContaining({
        documentId,
        linked: false,
        capabilities: expect.objectContaining({ open: false, review: false }),
      }),
    ]);
    expect(plTab.capabilities.linkProof).toBe(false);
    await expectProblem(
      await request(
        "POST",
        `/participations/${id}/documents/${documentId}/opening`,
        projectLead,
        {},
      ),
      403,
      "forbidden",
    );
    const registrationId = plTab.registration!.id;
    await expectProblem(
      await request("POST", `/participations/${id}/asu/proof-link`, projectLead, {
        registrationId,
        documentId,
      }),
      403,
      "forbidden",
    );
    const res = await request("POST", `/participations/${id}/asu/proof-link`, consultant, {
      registrationId,
      documentId,
    });
    expect(res.status).toBe(200);
    const tab = await readJson(res, AsuView);
    expect(tab.registration!.proof).toMatchObject({ kind: "ba_confirmation", documentId });
    expect(tab.proofDocuments[0]!.linked).toBe(true);
    expect(tab.registration!.withProofSince).toBe(tab.registration!.proof!.linkedAt);
  });

  it("an old proof linked today gives a fact recorded today, not before (D33)", async () => {
    const id = await participation();
    await route(id, "online_self", 0);
    const registeredOn = addDays(await today(), -10);
    await register(id, { registeredOn }, consultant);
    const documentId = await acceptedProof(id);
    // Accepted two days ago, linked now.
    await owner.$client.query(
      "update document set reviewed_at = now() - interval '2 days' where id = $1",
      [documentId],
    );
    const registrationId = (await view(id)).registration!.id;
    await request("POST", `/participations/${id}/asu/proof-link`, consultant, {
      registrationId,
      documentId,
    });
    const { asuRegisteredWithProof } = await factsOf(id);
    expect(asuRegisteredWithProof?.validOn).toBe(registeredOn);
    expect(Date.now() - asuRegisteredWithProof!.recordedAt.getTime()).toBeLessThan(60_000);
    // A scheduled entry whose snapshot was taken yesterday doesn't see it (the snapshot rule).
    const entry = (scheduledAt: Date) =>
      canTransition("main", "informed", "active_in_tg", {
        projectType: "ta_tg",
        current: { status: "informed", profilingStatus: "profiling_done", dsvStatus: "dsv_signed" },
        actor: { type: "system" },
        entryKind: "scheduled_entry",
        today: registeredOn,
        scheduledAt,
        wave: null,
        participation: { tgStart: addDays(registeredOn, 5), tgEnd: null, offerDeadline: null },
        facts: { asuRegisteredWithProof },
      });
    const failed = (check: ReturnType<typeof entry>) => (check.ok ? [] : check.failedGuards);
    expect(failed(entry(new Date(Date.now() - 86_400_000)))).toContain("asu_registered_with_proof");
    expect(failed(entry(new Date()))).not.toContain("asu_registered_with_proof");
  });

  it("the online_self route proven by the attestation passes the guard on the TG start (D33)", async () => {
    const id = await participation();
    await route(id, "online_self", 0);
    const registeredOn = addDays(await today(), -3);
    expect((await factsOf(id)).asuRegisteredWithProof).toBeUndefined();
    await register(id, {
      registeredOn,
      attestation: { customerNumber: number, source: "ba_document_inspected" },
    });
    const { asuRegisteredWithProof } = await factsOf(id);
    const tgStart = await today();
    const check = canTransition("main", "informed", "active_in_tg", {
      projectType: "ta_tg",
      current: { status: "informed", profilingStatus: "profiling_done", dsvStatus: "dsv_signed" },
      actor: { type: "system" },
      entryKind: "scheduled_entry",
      today: tgStart,
      scheduledAt: new Date(Date.now() + 1000),
      wave: null,
      participation: { tgStart, tgEnd: null, offerDeadline: null },
      facts: { asuRegisteredWithProof },
    });
    expect(check.ok ? [] : check.failedGuards).not.toContain("asu_registered_with_proof");
  });

  it("a quarantined proof supplies no fact; lifting restores it from the lift", async () => {
    const id = await participation();
    await route(id, "in_person", 0);
    await register(id, { registeredOn: await today() }, consultant);
    const documentId = await acceptedProof(id);
    const registrationId = (await view(id)).registration!.id;
    await request("POST", `/participations/${id}/asu/proof-link`, consultant, {
      registrationId,
      documentId,
    });
    await call(owner.$client, "quarantine_document", {
      context: asConsultant,
      documentId,
      reason: "suspected_wrong_person",
    });
    expect((await factsOf(id)).asuRegisteredWithProof).toBeUndefined();
    expect((await view(id)).registration!.withProofSince).toBeNull();
    expect((await view(id)).missing.map((m) => m.ruleId)).toEqual(["base-asu-proof"]);
    await call(owner.$client, "lift_document_quarantine", { context: asConsultant, documentId });
    const tab = await view(id);
    const lifted = (
      await owner.$client.query(
        `select to_char(quarantine_lifted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
         from document where id = $1`,
        [documentId],
      )
    ).rows[0].at;
    expect(tab.registration!.withProofSince).toBe(lifted);
  });
});

describe("the knowledge date and the due date (D22)", () => {
  async function withEnd(id: string, endDate: string) {
    await call(owner.$client, "write_participant_data", {
      participationId: id,
      context: pl,
      oldEmploymentEndDate: endDate,
    });
  }
  const setKnowledge = (
    id: string,
    knowledgeDate: string | null,
    previous: string | null,
    as: string = projectLead,
  ) => request("PUT", `/participations/${id}/knowledge-date`, as, { knowledgeDate, previous });
  const row = async (id: string) => {
    const res = await request("GET", `/projects/${werkNord}/worklist`, projectLead);
    return (await readJson(res, Worklist)).items.find((item) => item.id === id)!;
  };

  it("without a knowledge date gives the orientation item, never an overdue deadline", async () => {
    const id = await participation();
    const end = addMonths(await today(), 2); // the reference date lies in the past
    await withEnd(id, end);
    const tab = await view(id);
    expect(tab.dueDate).toEqual({ kind: "orientation", date: addMonths(end, -3) });
    const item = await row(id);
    expect(item.caseItems).toEqual([{ kind: "knowledge_date_missing", date: addMonths(end, -3) }]);
    expect(item.deadlines.map((d) => d.kind)).not.toContain("asu_due");
  });

  it("with a knowledge date is the statutory deadline asu_due until a registration with proof", async () => {
    const id = await participation();
    const now = await today();
    const end = addMonths(addDays(now, 5), 3);
    await withEnd(id, end);
    await expectProblem(
      await setKnowledge(id, addDays(now, -20), null, consultant),
      403,
      "forbidden",
    );
    const set = await setKnowledge(id, addDays(now, -20), null);
    expect(set.status).toBe(200);
    expect((await readJson(set, AsuView)).dueDate).toEqual({
      kind: "statutory",
      date: addMonths(end, -3),
      branch: "reference_date",
    });
    const stale = await expectProblem(await setKnowledge(id, now, null), 409, "conflict");
    expect(stale.errors?.[0]).toMatchObject({ code: "stale_value" });
    const item = await row(id);
    expect(item.caseItems).toEqual([]);
    expect(item.deadlines).toContainEqual({
      kind: "asu_due",
      date: addMonths(end, -3),
      state: "upcoming",
    });
    await route(id, "online_self", 0);
    await register(id, {
      registeredOn: now,
      attestation: { customerNumber: number, source: "ba_confirmed_by_phone" },
    });
    expect((await view(id)).dueDate).toBeNull();
    expect((await row(id)).deadlines.map((d) => d.kind)).not.toContain("asu_due");
  });

  it("is audited without the date", async () => {
    const id = await participation();
    const date = addDays(await today(), -7);
    await setKnowledge(id, date, null);
    const { rows } = await owner.$client.query(
      "select details from audit_event where participation_id = $1 and event_type = 'knowledge_date_set'",
      [id],
    );
    expect(rows).toEqual([{ details: { change: "set" } }]);
  });
});

describe("the detail's capability", () => {
  it("opens the tab in ta_tg for the case readers only", async () => {
    const id = await participation();
    const detail = async (participationId: string, as: string) =>
      (
        (await (await request("GET", `/participations/${participationId}`, as)).json()) as {
          capabilities: { viewAsu: boolean };
        }
      ).capabilities.viewAsu;
    expect(await detail(id, projectLead)).toBe(true);
    expect(await detail(id, backOffice)).toBe(true);
    expect(await detail(await participation(verwaltung), projectLead)).toBe(false);
  });
});
