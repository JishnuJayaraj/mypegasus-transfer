import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalEvidence } from "@transfer/domain";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  baEvidence,
  call,
  informedParticipation,
  pl,
  resetTestDatabase,
  reviewer,
  testDatabaseUrls,
  textDates,
} from "./testing";

// Profiling exception evidence (data-protection.md, exception evidence; process-and-lifecycle.md,
// profiling exceptions; D30, Q194, round 17) as transfer_app calls the functions: records from
// accepted documents or a BA confirmation, the fingerprint the domain mirrors, the request reading
// its record, the decision naming it. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const { consultant } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** An informed participation of Werk Nord, assigned to the consultant. */
async function participation() {
  const id = await informedParticipation(app);
  await call(app, "assign_participations", {
    projectId: seedProjectIds.werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

/** An evidence document of `content` uploaded by the PL; its id. */
const upload = (participationId: string, content: string = randomUUID(), context = pl) =>
  call(app, "add_document", {
    context,
    participationId,
    id: randomUUID(),
    type: "profiling_exception_evidence",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    contentSha256: sha256(content),
    fileName: null,
    keyId: randomBytes(8).toString("hex"),
    wrappedKey: randomBytes(60),
  });

const review = (documentId: string, decision = "accepted", context = asConsultant) =>
  call(app, "review_document", {
    context,
    documentId,
    decision,
    reason: decision === "rejected" ? "unreadable" : null,
  });

/** An accepted evidence document of `content`. */
async function accepted(participationId: string, content?: string) {
  const id = await upload(participationId, content);
  await review(id);
  return id;
}

const fromDocuments = (participationId: string, documentIds: string[], context = pl) =>
  call(app, "create_exception_evidence_record", {
    context,
    participationId,
    kind: "documents",
    documentIds,
    agenturKey: null,
    reference: null,
    confirmedOn: null,
  });

const confirmation = (
  participationId: string,
  facts: { agenturKey?: string; reference?: string; confirmedOn?: string } = {},
) =>
  call(app, "create_exception_evidence_record", {
    context: pl,
    participationId,
    kind: "ba_confirmation",
    documentIds: null,
    agenturKey: facts.agenturKey ?? "beispielstadt-nord",
    reference: facts.reference ?? "AZ 4711",
    confirmedOn: facts.confirmedOn ?? "2026-01-15",
  });

const record = (id: string) =>
  one("select * from profiling_exception_evidence_record where id = $1", [id]);

const request = (participationId: string, evidenceRecordId: string, reason = "force_majeure") =>
  call(app, "request_profiling_exception", {
    id: participationId,
    reason,
    requestedOn: "2027-02-01",
    evidenceRecordId,
    context: pl,
  });

const decide = (requestId: string, approve: boolean, evidenceRecordId: string) =>
  call(app, "decide_profiling_exception", {
    requestId,
    approve,
    decidedOn: "2027-02-03",
    evidenceRecordId,
    context: reviewer,
  });

describe("create_exception_evidence_record from documents", () => {
  it("records accepted versions in id order with the domain's fingerprint, audited by kind", async () => {
    const id = await participation();
    const first = await accepted(id, "Bescheinigung A");
    const second = await accepted(id, "Bescheinigung B");
    const recordId = await fromDocuments(id, [second, first, second]);
    const row = await record(recordId);
    expect(row).toMatchObject({
      kind: "documents",
      document_ids: [first, second].toSorted(),
      agentur_key: null,
      reference: null,
      created_by: seedStaffUserIds.projectLead,
    });
    // The SQL fingerprint is the SHA-256 of the domain's canonical payload (round 17).
    const payload = canonicalEvidence(id, {
      kind: "documents",
      contentDigests: [sha256("Bescheinigung A"), sha256("Bescheinigung B")],
    });
    expect(row.fingerprint).toBe(`sha256:v1:${sha256(payload)}`);
    const event = await one(
      `select details from audit_event where participation_id = $1
         and event_type::text = 'exception_evidence_recorded'`,
      [id],
    );
    expect(event.details).toEqual({
      evidenceRecordId: recordId,
      kind: "documents",
      documentCount: 2,
    });
  });

  it("gives identical bytes under another id and another order the same fingerprint", async () => {
    const id = await participation();
    const a = await accepted(id, "Attest");
    const b = await accepted(id, "Ladung");
    const again = await accepted(id, "Attest");
    const fingerprints: string[] = [];
    for (const ids of [
      [a, b],
      [b, again],
      [again, b, a],
    ]) {
      fingerprints.push((await record(await fromDocuments(id, ids))).fingerprint);
    }
    expect(new Set(fingerprints).size).toBe(1);
    // The same bytes of another participant aren't the same evidence.
    const other = await participation();
    const otherRecord = await fromDocuments(other, [
      await accepted(other, "Attest"),
      await accepted(other, "Ladung"),
    ]);
    expect((await record(otherRecord)).fingerprint).not.toBe(fingerprints[0]);
  });

  it("refuses an unreviewed, rejected or quarantined document: a file's presence is no verification", async () => {
    const id = await participation();
    const unreviewed = await upload(id);
    await expect(fromDocuments(id, [unreviewed])).rejects.toMatchObject(
      failsWith("evidence_missing"),
    );
    const rejected = await upload(id);
    await review(rejected, "rejected");
    await expect(fromDocuments(id, [rejected])).rejects.toMatchObject(
      failsWith("evidence_missing"),
    );
    const quarantined = await accepted(id);
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: quarantined,
      reason: "suspected_wrong_person",
    });
    await expect(fromDocuments(id, [quarantined])).rejects.toMatchObject(
      failsWith("evidence_missing"),
    );
  });

  it("refuses another participation's document, another type and an unknown id", async () => {
    const id = await participation();
    const other = await participation();
    const foreign = await accepted(other);
    await expect(fromDocuments(id, [foreign])).rejects.toMatchObject(
      failsWith("document_not_found"),
    );
    await expect(fromDocuments(id, [randomUUID()])).rejects.toMatchObject(
      failsWith("document_not_found"),
    );
    const cv = await call(app, "add_document", {
      context: pl,
      participationId: id,
      id: randomUUID(),
      type: "cv",
      mediaType: "application/pdf",
      sizeBytes: 10,
      contentSha256: sha256("cv"),
      fileName: "cv.pdf",
      keyId: randomBytes(8).toString("hex"),
      wrappedKey: randomBytes(60),
    });
    await expect(fromDocuments(id, [cv])).rejects.toMatchObject(failsWith("document_not_found"));
  });

  it("is recorded by the PL only, while informed", async () => {
    const id = await participation();
    const doc = await accepted(id);
    await expect(fromDocuments(id, [doc], asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const imported = await call(app, "create_participation", {
      projectId: seedProjectIds.werkNord,
      context: pl,
    });
    await expect(confirmation(imported)).rejects.toMatchObject(failsWith("not_informed"));
  });
});

describe("create_exception_evidence_record from a BA confirmation", () => {
  it("normalises the reference; an equal confirmation re-entered has the same fingerprint", async () => {
    const id = await participation();
    const first = await record(await confirmation(id, { reference: "  AZ   4711 " }));
    const again = await record(await confirmation(id, { reference: "az 4711" }));
    expect(first).toMatchObject({
      kind: "ba_confirmation",
      document_ids: null,
      agentur_key: "beispielstadt-nord",
      reference: "az 4711",
      confirmed_on: "2026-01-15",
    });
    expect(again.fingerprint).toBe(first.fingerprint);
    const payload = canonicalEvidence(id, {
      kind: "ba_confirmation",
      confirmation: {
        agenturKey: "beispielstadt-nord",
        reference: "az 4711",
        confirmedOn: "2026-01-15",
      },
    });
    expect(first.fingerprint).toBe(`sha256:v1:${sha256(payload)}`);
    const other = await record(await confirmation(id, { reference: "Frau Ünal" }));
    expect(other.reference).toBe("frau ünal");
    expect(other.fingerprint).not.toBe(first.fingerprint);
  });

  it("refuses a future date, an unusable reference and a mixed shape", async () => {
    const id = await participation();
    await expect(confirmation(id, { confirmedOn: "2999-01-01" })).rejects.toMatchObject(
      failsWith("confirmation_in_future"),
    );
    await expect(confirmation(id, { reference: "   " })).rejects.toMatchObject(
      failsWith("reference_invalid"),
    );
    await expect(confirmation(id, { reference: "zeile\nzwei" })).rejects.toMatchObject(
      failsWith("reference_invalid"),
    );
    await expect(
      call(app, "create_exception_evidence_record", {
        context: pl,
        participationId: id,
        kind: "ba_confirmation",
        documentIds: [randomUUID()],
        agenturKey: "nord",
        reference: "x",
        confirmedOn: "2026-01-15",
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });
});

describe("the request and the decision read the record", () => {
  it("refuses another participation's record, and needs changed evidence after a rejection", async () => {
    const id = await participation();
    const other = await participation();
    await expect(request(id, await baEvidence(app, other))).rejects.toMatchObject(
      failsWith("evidence_missing"),
    );
    const first = await baEvidence(app, id, "az-1");
    const requestId = await request(id, first);
    await decide(requestId, false, first);
    // A new row with the same facts is unchanged evidence.
    await expect(request(id, await baEvidence(app, id, " AZ-1 "))).rejects.toMatchObject(
      failsWith("evidence_unchanged"),
    );
    await request(id, await baEvidence(app, id, "az-2"));
  });

  it("refuses identical re-uploads after a rejection; `ba_confirmed_other` needs a BA confirmation", async () => {
    const id = await participation();
    const documents = await fromDocuments(id, [await accepted(id, "Attest")]);
    await expect(request(id, documents, "ba_confirmed_other")).rejects.toMatchObject(
      failsWith("ba_confirmation_missing"),
    );
    const requestId = await request(id, documents);
    await decide(requestId, false, documents);
    const reupload = await fromDocuments(id, [await accepted(id, "Attest")]);
    await expect(request(id, reupload)).rejects.toMatchObject(failsWith("evidence_unchanged"));
  });

  it("names the record the approver saw and approves only while its documents count", async () => {
    const id = await participation();
    const doc = await accepted(id, "Attest");
    const evidence = await fromDocuments(id, [doc]);
    const requestId = await request(id, evidence);
    await expect(decide(requestId, true, await baEvidence(app, id))).rejects.toMatchObject(
      failsWith("source_changed"),
    );
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: doc,
      reason: "suspected_wrong_person",
    });
    await expect(decide(requestId, true, evidence)).rejects.toMatchObject(
      failsWith("evidence_missing"),
    );
    // A rejection needs no usable evidence.
    await decide(requestId, false, evidence);
    expect(
      (await one("select status from profiling_exception_request where id = $1", [requestId]))
        .status,
    ).toBe("rejected");
  });

  it("refuses a request whose documents were quarantined after the record", async () => {
    const id = await participation();
    const doc = await accepted(id);
    const evidence = await fromDocuments(id, [doc]);
    await call(app, "quarantine_document", {
      context: pl,
      documentId: doc,
      reason: "suspected_wrong_person",
    });
    await expect(request(id, evidence)).rejects.toMatchObject(failsWith("evidence_missing"));
  });

  it("keeps the record immutable: transfer_app writes nothing", async () => {
    const id = await participation();
    const evidence = await baEvidence(app, id);
    await expect(
      app.query("update profiling_exception_evidence_record set reference = 'x' where id = $1", [
        evidence,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query("delete from profiling_exception_evidence_record where id = $1", [evidence]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      owner.query("update profiling_exception_evidence_record set reference = 'x' where id = $1", [
        evidence,
      ]),
    ).rejects.toMatchObject(failsWith("record_immutable"));
  });
});
