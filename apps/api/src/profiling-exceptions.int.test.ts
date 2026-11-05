import {
  createDb,
  eq,
  participation as participationTable,
  profilingExceptionRequest,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import { ProfilingView, ReviewQueue } from "@transfer/domain";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbGuardFacts } from "./participations/guard-facts";
import { exceptionOf } from "./participations/status-service";
import { expectProblem, jsonRequest, login, origin, readJson, testApp } from "./testing";

// Profiling exceptions with evidence (process-and-lifecycle.md, profiling exceptions;
// data-protection.md, exception evidence; D30, Q80, Q194, Q208) against transfer_test on the
// system clock: the evidence records, the request, the decision from "Freigaben" and the
// revocation, in ADR-0010's order; the PL can't open the evidence; the queue holds no evidence.
// Synthetic data only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const {
  projectLead,
  consultant,
  backOffice,
  regionalOperationsManager: manager,
} = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const answered: string[] = [];
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice, manager]) {
    staff[id] = await login(app, id);
  }
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

/** An informed participation with a TG start in 60 days, assigned to the consultant. */
async function participation(projectId: string = werkNord) {
  const id = await call(owner.$client, "create_participation", { projectId, context: pl });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  await owner.$client.query(
    "update participation set tg_start = berlin_today() + 60, tg_end = berlin_today() + 400 where id = $1",
    [id],
  );
  await call(owner.$client, "assign_participations", {
    projectId,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

/** An evidence document of `content` uploaded by the PL and, unless `review` is false, accepted. */
async function evidenceDocument(id: string, content: string = randomUUID(), review = true) {
  const documentId = await call(owner.$client, "add_document", {
    context: pl,
    participationId: id,
    id: randomUUID(),
    type: "profiling_exception_evidence",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    contentSha256: createHash("sha256").update(content).digest("hex"),
    fileName: null,
    keyId: randomBytes(8).toString("hex"),
    wrappedKey: randomBytes(60),
  });
  if (review) {
    await call(owner.$client, "review_document", {
      context: asConsultant,
      documentId,
      decision: "accepted",
      reason: null,
    });
  }
  return documentId;
}

const confirmation = {
  kind: "ba_confirmation",
  agenturKey: "beispielstadt-nord",
  reference: " AZ  4711 ",
  confirmedOn: "2026-01-15",
};
const record = (id: string, body: unknown = confirmation, as: string = projectLead) =>
  request("POST", `/participations/${id}/exception-evidence`, as, body);
const recordId = async (id: string, body: unknown = confirmation) => {
  const res = await record(id, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { evidenceRecordId: string }).evidenceRecordId;
};
const ask = (
  id: string,
  evidenceRecordId: string,
  as: string = projectLead,
  reason = "force_majeure",
) =>
  request("POST", `/participations/${id}/profiling-exception-requests`, as, {
    reason,
    evidenceRecordId,
  });
const requested = async (id: string, evidenceRecordId: string) => {
  const res = await ask(id, evidenceRecordId);
  expect(res.status).toBe(201);
  return ((await res.json()) as { requestId: string }).requestId;
};
const decide = (requestId: string, body: object, as: string = manager) =>
  request("POST", `/profiling-exception-requests/${requestId}/decision`, as, body);
const revoke = (requestId: string, status: string, as: string = projectLead) =>
  request("POST", `/profiling-exception-requests/${requestId}/revocation`, as, { status });
const tab = async (id: string, as: string = projectLead) =>
  readJson(await request("GET", `/participations/${id}/profiling`, as), ProfilingView);
const queue = async (as: string = manager) => {
  const res = await request("GET", "/reviews", as);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, ReviewQueue);
};
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map((e) => e.code);

describe("POST /participations/{id}/exception-evidence", () => {
  it("records accepted documents or a BA confirmation; the tab shows ids and states only", async () => {
    const id = await participation();
    const pending = await evidenceDocument(id, "Attest", false);
    const accepted = await evidenceDocument(id, "Ladung");
    expect((await tab(id)).exception).toEqual({
      current: null,
      evidenceDocuments: [
        {
          documentId: pending,
          addedAt: expect.any(String),
          reviewState: "unreviewed",
          usable: false,
          quarantined: false,
          capabilities: {
            delete: true,
            quarantine: true,
            liftQuarantine: false,
            requestCorrection: false,
          },
        },
        {
          documentId: accepted,
          addedAt: expect.any(String),
          reviewState: "accepted",
          usable: true,
          quarantined: false,
          // The PL requests its correction without reading it (data-protection.md, evidence
          // corrections).
          capabilities: {
            delete: false,
            quarantine: true,
            liftQuarantine: false,
            requestCorrection: true,
          },
        },
      ],
      capabilities: { addEvidence: true, request: true, revoke: false },
    });
    // An unreviewed document is no evidence (a file's presence is no verification).
    expect(await codes(await record(id, { kind: "documents", documentIds: [pending] }))).toEqual([
      "evidence_missing",
    ]);
    const documents = await recordId(id, { kind: "documents", documentIds: [accepted] });
    const ba = await recordId(id);
    expect(documents).not.toBe(ba);
    // The response and the logs carry no fingerprint and no reference.
    expect(answered.join("")).not.toMatch(/sha256:v1|az {1,2}4711/i);
    expect(logs.join("")).not.toMatch(/sha256:v1|4711/);
  });

  it("is 404 for a hidden participation or document, 403 for the consultant, 422 for the state", async () => {
    const id = await participation();
    await expectProblem(await record(randomUUID()), 404, "not-found");
    // An unassigned consultant doesn't see the participation's profiling ("assigned is strict").
    await owner.$client.query("delete from participant_assignment where participation_id = $1", [
      id,
    ]);
    await expectProblem(await record(id, confirmation, consultant), 404, "not-found");
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
    const otherDocument = await evidenceDocument(await participation());
    await expectProblem(
      await record(id, { kind: "documents", documentIds: [otherDocument] }),
      404,
      "not-found",
    );
    await expectProblem(await record(id, confirmation, consultant), 403, "forbidden");
    expect(await codes(await record(id, { ...confirmation, confirmedOn: "2999-01-01" }))).toEqual([
      "confirmation_in_future",
    ]);
    expect(await codes(await record(id, { ...confirmation, reference: "a\nb" }))).toEqual([
      "reference_invalid",
    ]);
  });

  it("refuses an Agentur outside the participation's choices (Q208 (6))", async () => {
    const id = await participation();
    const res = await record(id, { ...confirmation, agenturKey: "no-such-agentur" });
    expect((await expectProblem(res, 422, "domain-error")).errors).toEqual([
      expect.objectContaining({ code: "agentur_unknown", pointer: "/agenturKey" }),
    ]);
    // The consultant is refused by permission first, whatever the Agentur.
    await expectProblem(
      await record(id, { ...confirmation, agenturKey: "no-such-agentur" }, consultant),
      403,
      "forbidden",
    );
  });

  it("lets the PL quarantine, lift and delete their upload without reading it", async () => {
    const id = await participation();
    const documentId = await evidenceDocument(id, randomUUID(), false);
    const path = `/participations/${id}/documents/${documentId}`;
    expect((await tab(id)).exception.evidenceDocuments[0]).toMatchObject({
      quarantined: false,
      capabilities: { delete: true, quarantine: true, liftQuarantine: false },
    });
    expect(
      (
        await request("POST", `${path}/quarantine`, projectLead, {
          reasonCode: "suspected_wrong_person",
        })
      ).status,
    ).toBe(200);
    expect((await tab(id)).exception.evidenceDocuments[0]).toMatchObject({
      quarantined: true,
      usable: false,
      capabilities: { quarantine: false, liftQuarantine: true },
    });
    expect((await request("POST", `${path}/quarantine-lift`, projectLead, {})).status).toBe(200);
    const removed = await app.request(`/api/v1${path}?reasonCode=wrong_file`, {
      method: "DELETE",
      headers: { ...staff[projectLead]!, Origin: origin },
    });
    expect(removed.status).toBe(204);
    expect((await tab(id)).exception.evidenceDocuments).toEqual([]);
    // Still no opening for the PL.
    const opening = await request("POST", `${path}/opening`, projectLead, {});
    expect([403, 404]).toContain(opening.status);
  });

  it("never lets the PL open the evidence; the consultant who reviews it may", async () => {
    const id = await participation();
    const documentId = await evidenceDocument(id);
    const opening = (as: string) =>
      request("POST", `/participations/${id}/documents/${documentId}/opening`, as, {});
    expect([403, 404]).toContain((await opening(projectLead)).status);
    expect([403, 404]).toContain((await opening(manager)).status);
    expect((await opening(consultant)).status).toBe(201);
  });
});

describe("requests, Freigaben and decisions", () => {
  it("requests, lists in Freigaben without evidence content, approves by the manager", async () => {
    const id = await participation();
    const evidenceRecordId = await recordId(id);
    const requestId = await requested(id, evidenceRecordId);
    const { items } = await queue();
    expect(items).toEqual([
      {
        requestId,
        projectId: werkNord,
        projectName: "Restrukturierung Werk Nord",
        reason: "force_majeure",
        requestedOn: expect.any(String),
        tgStart: expect.any(String),
        evidenceRecordId,
        evidenceKind: "ba_confirmation",
        evidencePresent: true,
        capabilities: { decide: true },
      },
    ]);
    expect(answered.join("")).not.toMatch(/sha256:v1|az 4711|beispielstadt/i);
    // The queue is the manager's alone; the PL may not decide.
    await expectProblem(await request("GET", "/reviews", projectLead), 403, "forbidden");
    await expectProblem(
      await decide(requestId, { decision: "approve", evidenceRecordId }, projectLead),
      403,
      "forbidden",
    );
    // Another record than the one shown is a stale decision.
    expect(
      await codes(
        await decide(requestId, { decision: "approve", evidenceRecordId: randomUUID() }),
        409,
        "conflict",
      ),
    ).toEqual(["source_changed"]);
    expect((await decide(requestId, { decision: "approve", evidenceRecordId })).status).toBe(204);
    expect((await queue()).items).toEqual([]);
    expect((await tab(id)).exception.current).toMatchObject({
      requestId,
      status: "approved",
      evidenceKind: "ba_confirmation",
      decidedOn: expect.any(String),
    });
    expect((await tab(id)).exception.capabilities).toEqual({
      addEvidence: true,
      request: false,
      revoke: true,
    });
  });

  it("is 404 for an unknown request or a viewer without the participation; 422 on unusable evidence", async () => {
    await expectProblem(
      await decide(randomUUID(), { decision: "approve", evidenceRecordId: randomUUID() }),
      404,
      "not-found",
    );
    const id = await participation();
    const documentId = await evidenceDocument(id);
    const evidenceRecordId = await recordId(id, { kind: "documents", documentIds: [documentId] });
    const requestId = await requested(id, evidenceRecordId);
    // Back office sees the project but not the profiling: 404, whatever the request's state.
    await expectProblem(
      await decide(requestId, { decision: "approve", evidenceRecordId }, backOffice),
      404,
      "not-found",
    );
    await call(owner.$client, "quarantine_document", {
      context: asConsultant,
      documentId,
      reason: "suspected_wrong_person",
    });
    expect((await queue()).items[0]).toMatchObject({ requestId, evidencePresent: false });
    expect(await codes(await decide(requestId, { decision: "approve", evidenceRecordId }))).toEqual(
      ["evidence_missing"],
    );
    expect((await decide(requestId, { decision: "reject", evidenceRecordId })).status).toBe(204);
  });

  it("needs changed evidence after a rejection; identical bytes under a new id aren't", async () => {
    const id = await participation();
    const first = await recordId(id, {
      kind: "documents",
      documentIds: [await evidenceDocument(id, "Attest")],
    });
    const requestId = await requested(id, first);
    await decide(requestId, { decision: "reject", evidenceRecordId: first });
    const reupload = await recordId(id, {
      kind: "documents",
      documentIds: [await evidenceDocument(id, "Attest")],
    });
    expect(await codes(await ask(id, reupload))).toEqual(["evidence_unchanged"]);
    expect(await codes(await ask(id, first, projectLead, "ba_confirmed_other"))).toEqual([
      "evidence_unchanged",
    ]);
    const changed = await recordId(id, {
      kind: "documents",
      documentIds: [await evidenceDocument(id, "Neuer Nachweis")],
    });
    expect(await codes(await ask(id, changed, projectLead, "ba_confirmed_other"))).toEqual([
      "ba_confirmation_missing",
    ]);
    expect((await ask(id, changed)).status).toBe(201);
  });

  it("revokes before entry with the status the PL saw", async () => {
    const id = await participation();
    const evidenceRecordId = await recordId(id);
    const requestId = await requested(id, evidenceRecordId);
    await expectProblem(await revoke(requestId, "requested", manager), 403, "forbidden");
    await decide(requestId, { decision: "approve", evidenceRecordId });
    expect(await codes(await revoke(requestId, "requested"), 409, "conflict")).toEqual([
      "source_changed",
    ]);
    expect((await revoke(requestId, "approved")).status).toBe(204);
    expect((await tab(id)).exception.current).toMatchObject({ status: "revoked" });
  });

  it("withholds the approval while its evidence is quarantined and restores it from the lift", async () => {
    const id = await participation();
    const documentId = await evidenceDocument(id);
    const evidenceRecordId = await recordId(id, { kind: "documents", documentIds: [documentId] });
    const requestId = await requested(id, evidenceRecordId);
    await decide(requestId, { decision: "approve", evidenceRecordId });
    const approval = () =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(profilingExceptionRequest)
          .innerJoin(
            participationTable,
            eq(participationTable.profilingExceptionRequestId, profilingExceptionRequest.id),
          )
          .where(eq(participationTable.id, id));
        const facts = await dbGuardFacts.facts(tx, {
          participationId: id,
          currentRequest: exceptionOf(row!.profiling_exception_request),
        });
        return facts.profilingExceptionApproved;
      });
    const decided = await approval();
    expect(decided).toBeDefined();
    await call(owner.$client, "quarantine_document", {
      context: asConsultant,
      documentId,
      reason: "suspected_wrong_person",
    });
    expect(await approval()).toBeUndefined();
    await call(owner.$client, "lift_document_quarantine", { context: asConsultant, documentId });
    const { rows } = await owner.$client.query(
      "select quarantine_lifted_at from document where id = $1",
      [documentId],
    );
    const restored = await approval();
    expect(restored?.recordedAt.getTime()).toBe(new Date(rows[0].quarantine_lifted_at).getTime());
    expect(restored!.recordedAt.getTime()).toBeGreaterThan(decided!.recordedAt.getTime());
    // The approval itself stays as decided.
    expect((await tab(id)).exception.current).toMatchObject({ requestId, status: "approved" });
  });
});
