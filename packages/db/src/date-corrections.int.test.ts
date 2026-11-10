import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  acceptDsvScan,
  auditContext,
  call,
  changeStatus,
  informedParticipation,
  nightly,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// Date corrections (data-protection.md, evidence corrections: field targets and the DSV
// signature-date supersession; process-and-lifecycle.md, the profiling track and the DSV
// signature): the PL requests a corrected `profilingDoneOn` or manual `withdrawnOn`, the PL or back
// office a superseded signature date; the region's manager approves (four eyes). The corrected fact
// is recorded at the approval; nothing past changes. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const as = (staffUserId: string) => auditContext({ actorType: "user", staffUserId });
const { projectLead, backOffice, consultant, regionalOperationsManager } = seedStaffUserIds;
const manager = as(regionalOperationsManager);
const asBackOffice = as(backOffice);
const asConsultant = as(consultant);
const w1 = seedWaves.find((w) => w.code === "W1")!;
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const day = async (offset: number): Promise<string> =>
  (await one("select (berlin_today() + $1::int)::text as d", [offset])).d;
const version = async (id: string): Promise<number> =>
  (await one("select status_version from participation where id=$1", [id])).status_version;

type Request = {
  context?: string;
  participationId: string;
  targetKind: "field" | "dsv_signature";
  targetId?: string | null;
  fieldKey?: string | null;
  correctedOn: string;
  paper?: string | null;
  signature?: string | null;
};
const request = (r: Request) =>
  call(app, "request_evidence_correction", {
    context: r.context ?? pl,
    participationId: r.participationId,
    targetKind: r.targetKind,
    action: "supersede",
    targetId: r.targetId ?? null,
    wrongPerson: null,
    correctedRegisteredOn: null,
    reason: "documented_internal_error",
    source: "Personalakte, Vermerk 3",
    fieldKey: r.fieldKey ?? null,
    correctedOn: r.correctedOn,
    signaturePaper: r.paper ?? null,
    signatureKind: r.signature ?? null,
  });
const decide = (correctionId: string, approve = true, context = manager) =>
  call(app, "decide_evidence_correction", { context, correctionId, approve });
const field = (participationId: string, fieldKey: string, correctedOn: string, context = pl) =>
  request({ context, participationId, targetKind: "field", fieldKey, correctedOn });
const signature = (
  f: { id: string; offer: string },
  correctedOn: string,
  kind = "participant",
  context = pl,
  paper = "dsv_signed_scan",
) =>
  request({
    context,
    participationId: f.id,
    targetKind: "dsv_signature",
    targetId: f.offer,
    correctedOn,
    paper,
    signature: kind,
  });

/** What must not move: statuses, versions, the audit trail before the correction. */
const snapshot = async (id: string) => ({
  participation: await one(
    `select status::text, profiling_status::text, dsv_status::text, status_version,
       tg_entry_date::text from participation where id = $1`,
    [id],
  ),
  audit: await all(
    `select id, event_type::text, to_value, effective_date::text, details from audit_event
     where participation_id = $1 and event_type::text not like 'evidence_correction_%'
     order by seq`,
    [id],
  ),
});

// --- The DSV: a signed offer whose participant date was typed wrong (14.04. for 14.03.) ---

/** A signed DSV: the participant's scan and then the complete packet, both dated `wrong`. */
async function signedDsv(wrong: string, packetOn: string) {
  const id = await informedParticipation(app, {
    projectId: seedProjectIds.werkNord,
    entryWaveId: w1.id,
  });
  const offer = await call<string>(app, "offer_dsv", {
    context: pl,
    participationId: id,
    generationId: null,
    external: JSON.stringify({
      deadline: w1.signingDeadline,
      printedTgStart: w1.defaultTgStart,
      printedTgEnd: w1.defaultTgEnd,
    }),
    expectedStatusVersion: await version(id),
  });
  const first = await acceptDsvScan(app, id, { participant: wrong });
  await call(app, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: first,
    statusVersion: await version(id),
  });
  const packet = await acceptDsvScan(app, id, {
    participant: wrong,
    customer: packetOn,
    transfergesellschaft: packetOn,
  });
  return { id, offer, first, packet };
}

const dsvFacts = async (id: string) =>
  all(
    `select document_id, signed_on::text, executed_on::text, recorded_at
     from dsv_facts(array[$1::uuid]) order by document_id`,
    [id],
  );

describe("the DSV signature-date supersession (process-and-lifecycle.md)", () => {
  it("supersedes a wrong participant date on every scan of the offer at once, recorded at the approval", async () => {
    const wrong = await day(-3);
    const right = await day(-8);
    const f = await signedDsv(wrong, await day(-2));
    const before = await snapshot(f.id);
    // A scheduled run before the approval sees the original fact, recorded at the acceptance.
    const run = await dsvFacts(f.id);
    expect(run.map((r) => r.signed_on)).toEqual([wrong, wrong]);
    const runAt = (await one("select now() as t")).t as Date;

    const correctionId = await signature(f, right, "participant", asBackOffice);
    // Nothing changes until the approval.
    expect(await dsvFacts(f.id)).toEqual(run);
    expect(
      await one(
        `select target_kind::text, dsv_offer_id, signature_paper, signature_kind, corrected_on::text,
           original_on::text, retention_class from evidence_correction where id = $1`,
        [correctionId],
      ),
    ).toEqual({
      target_kind: "dsv_signature",
      dsv_offer_id: f.offer,
      signature_paper: "dsv_signed_scan",
      signature_kind: "participant",
      corrected_on: right,
      original_on: wrong,
      retention_class: "personnel_file",
    });

    await decide(correctionId);
    const { decided_at } = await one("select decided_at from evidence_correction where id=$1", [
      correctionId,
    ]);
    const after = await dsvFacts(f.id);
    expect(after.map((r) => r.signed_on)).toEqual([right, right]);
    for (const fact of after) {
      expect(fact.recorded_at.getTime()).toBeGreaterThanOrEqual(decided_at.getTime());
      // So a run at the earlier instant never counts the corrected date.
      expect(fact.recorded_at.getTime()).toBeGreaterThan(runAt.getTime());
    }
    // The packet's validity is the latest actual date, unchanged here (the countersignatures).
    expect(after.find((r) => r.document_id === f.packet)!.executed_on).toBe(await day(-2));
    // The originals stay, linked; one replacement per scan.
    const rows = await all(
      `select document_id, signed_on::text, superseded_by, correction_id from dsv_scan_signature
       where participation_id = $1 and kind = 'participant' order by document_id, recorded_at`,
      [f.id],
    );
    expect(rows).toHaveLength(4);
    for (const documentId of [f.first, f.packet]) {
      expect(rows.filter((r) => r.document_id === documentId)).toEqual([
        {
          document_id: documentId,
          signed_on: wrong,
          superseded_by: correctionId,
          correction_id: null,
        },
        {
          document_id: documentId,
          signed_on: right,
          superseded_by: null,
          correction_id: correctionId,
        },
      ]);
    }
    // The retained contract facts follow the corrected actual date.
    expect(
      await one("select participant_signed_on::text from dsv_contract where dsv_offer_id = $1", [
        f.offer,
      ]),
    ).toEqual({ participant_signed_on: right });
    // No status, version or earlier audit event changed; the history shows the kind, no date.
    expect(await snapshot(f.id)).toEqual(before);
    const audit = await all(
      `select event_type::text, details from audit_event where participation_id = $1
         and event_type::text like 'evidence_correction_%' order by seq`,
      [f.id],
    );
    expect(audit.map((a) => a.details)).toEqual([
      {
        correctionId,
        targetKind: "dsv_signature",
        action: "supersede",
        reason: "documented_internal_error",
        paper: "dsv_signed_scan",
        signatureKind: "participant",
      },
      {
        correctionId,
        targetKind: "dsv_signature",
        action: "supersede",
        reason: "documented_internal_error",
        paper: "dsv_signed_scan",
        signatureKind: "participant",
        decision: "approved",
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(right);
    expect(JSON.stringify(audit)).not.toContain(wrong);
    // A later scan with the corrected date is accepted: no signature_date_mismatch.
    await acceptDsvScan(app, f.id, { participant: right, customer: await day(-2) });
  });

  it("keeps the paper's order, refuses a future, unchanged or unshown date and another offer", async () => {
    const f = await signedDsv(await day(-3), await day(-2));
    // Received today: a participant date after today is in the future, today itself is the bound.
    await expect(signature(f, await day(1))).rejects.toMatchObject(
      failsWith("corrected_on_in_future"),
    );
    await expect(signature(f, await day(-3))).rejects.toMatchObject(
      failsWith("correction_unchanged"),
    );
    await owner.query("update document set dsv_received_on = berlin_today() - 5 where id = $1", [
      f.first,
    ]);
    await expect(signature(f, await day(-4))).rejects.toMatchObject(
      failsWith("received_before_signature"),
    );
    expect(await signature(f, await day(-5))).toEqual(expect.any(String));
    await expect(
      signature(f, await day(-6), "customer", pl, "dsv_cancellation"),
    ).rejects.toMatchObject(failsWith("signature_not_shown"));
    await expect(signature({ ...f, offer: randomUUID() }, await day(-6))).rejects.toMatchObject(
      failsWith("target_not_found"),
    );
  });

  it("refuses dates that differ between the scans; one pending request per signature", async () => {
    const f = await signedDsv(await day(-3), await day(-2));
    await owner.query(
      `update dsv_scan_signature set signed_on = berlin_today() - 4
       where document_id = $1 and kind = 'participant'`,
      [f.packet],
    );
    await expect(signature(f, await day(-6))).rejects.toMatchObject(
      failsWith("signature_date_mismatch"),
    );
    const customer = await signature(f, await day(-6), "customer", asBackOffice);
    await expect(signature(f, await day(-7), "customer")).rejects.toMatchObject(
      failsWith("correction_pending"),
    );
    await decide(customer);
    expect(
      await one(
        "select customer_signed_on::text, fully_executed_on::text from dsv_contract where dsv_offer_id = $1",
        [f.offer],
      ),
    ).toEqual({ customer_signed_on: await day(-6), fully_executed_on: await day(-2) });
    // A decided request is not decided again: the queue's 409.
    await expect(decide(customer)).rejects.toMatchObject(failsWith("correction_not_pending"));
  });

  it("is requested by the PL or back office only; a consultant is refused", async () => {
    const f = await signedDsv(await day(-3), await day(-2));
    await expect(signature(f, await day(-6), "participant", asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });

  it("refuses an approval once the scans changed meanwhile (target_corrected)", async () => {
    const f = await signedDsv(await day(-3), await day(-2));
    const correctionId = await signature(f, await day(-6));
    await owner.query(
      `update dsv_scan_signature set signed_on = berlin_today() - 4
       where participation_id = $1 and kind = 'participant'`,
      [f.id],
    );
    await expect(decide(correctionId)).rejects.toMatchObject(failsWith("target_corrected"));
  });
});

// --- The profiling track: a wrong profilingDoneOn ---

/** A Werk Nord participation with an accepted TL 407 signed `signedOn`, profiling done `doneOn`. */
async function profiled(signedOn: string, doneOn: string) {
  const id = await informedParticipation(app, {
    projectId: seedProjectIds.werkNord,
    entryWaveId: w1.id,
  });
  await call(app, "assign_participations", {
    projectId: seedProjectIds.werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  for (const [from, to] of [
    ["not_started", "profiling_accepted"],
    ["profiling_accepted", "profiling_in_progress"],
  ]) {
    await changeStatus(app, id, { field: "profiling_status", from: from!, to: to! });
  }
  const documentId = await call(app, "add_document", {
    context: asConsultant,
    participationId: id,
    id: randomUUID(),
    type: "tl407_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    scanOrigin: "external_paper",
    generationDocumentId: null,
  });
  await call(app, "review_document", {
    context: asConsultant,
    documentId,
    decision: "accepted",
    reason: null,
    signedOn,
    countersignedOn: signedOn,
    confirmations: ["signatures_present", "all_pages_present"],
    formVersion: "03-2019",
    declarations: JSON.stringify({
      kind: "as_marked",
      jobboerseChoice: "none",
      baContactConsent: false,
    }),
  });
  await changeStatus(app, id, {
    field: "profiling_status",
    from: "profiling_in_progress",
    to: "profiling_done",
    effectiveDate: doneOn,
    context: asConsultant,
  });
  return id;
}

const tl407 = async (id: string) =>
  one(
    `select profiling_done_on::text, profiling_done_recorded_at from tl407_facts(array[$1::uuid])`,
    [id],
  );

describe("a field correction of profilingDoneOn (process-and-lifecycle.md, the profiling track)", () => {
  it("is recorded at the approval by tl407_facts: a run before keeps the original, a later one the corrected date", async () => {
    const signedOn = await day(-10);
    const id = await profiled(signedOn, await day(-2));
    const before = await snapshot(id);
    const run = await tl407(id);
    expect(run.profiling_done_on).toBe(await day(-2));
    const runAt = (await one("select now() as t")).t as Date;

    const correctionId = await field(id, "profilingDoneOn", await day(-9));
    expect(await tl407(id)).toEqual(run);
    await decide(correctionId);
    const { decided_at } = await one("select decided_at from evidence_correction where id=$1", [
      correctionId,
    ]);
    const after = await tl407(id);
    expect(after.profiling_done_on).toBe(await day(-9));
    expect(after.profiling_done_recorded_at).toEqual(decided_at);
    expect(after.profiling_done_recorded_at.getTime()).toBeGreaterThan(runAt.getTime());
    expect(
      (await one("select profiling_done_on::text from participation where id=$1", [id]))
        .profiling_done_on,
    ).toBe(await day(-9));
    // No status, version or earlier audit event changed; the history shows the field key only.
    expect(await snapshot(id)).toEqual(before);
    const audit = await all(
      `select details from audit_event where participation_id = $1
         and event_type::text like 'evidence_correction_%' order by seq`,
      [id],
    );
    expect(audit.map((a) => a.details.fieldKey)).toEqual(["profilingDoneOn", "profilingDoneOn"]);
    expect(JSON.stringify(audit)).not.toContain(await day(-9));
  });

  it("refuses a future date, one before the TL 407's signature, an unchanged one and a field without a value", async () => {
    const id = await profiled(await day(-10), await day(-2));
    await expect(field(id, "profilingDoneOn", await day(1))).rejects.toMatchObject(
      failsWith("corrected_on_in_future"),
    );
    await expect(field(id, "profilingDoneOn", await day(-11))).rejects.toMatchObject(
      failsWith("effective_date_before_signature"),
    );
    await expect(field(id, "profilingDoneOn", await day(-2))).rejects.toMatchObject(
      failsWith("correction_unchanged"),
    );
    expect(await field(id, "profilingDoneOn", await day(-10))).toEqual(expect.any(String));
    await expect(field(id, "withdrawnOn", await day(-1))).rejects.toMatchObject(
      failsWith("field_not_recorded"),
    );
    // Any other field is refused by shape, and by 0105's check underneath.
    await expect(field(id, "dsvSignedOn", await day(-1))).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(
      owner.query(
        `insert into evidence_correction (project_id, participation_id, target_kind, action,
           field_key, corrected_on, original_on, reason, source, retention_class, requested_by)
         select project_id, id, 'field', 'supersede', 'tgStart', berlin_today(), berlin_today(),
           'documented_internal_error', 'x', 'participation_record', $2 from participation where id = $1`,
        [id, projectLead],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("is the PL's request; four eyes, the region's manager, and a request decided meanwhile", async () => {
    const id = await profiled(await day(-10), await day(-2));
    for (const context of [asBackOffice, asConsultant]) {
      await expect(field(id, "profilingDoneOn", await day(-9), context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    const correctionId = await field(id, "profilingDoneOn", await day(-9));
    await expect(field(id, "profilingDoneOn", await day(-8))).rejects.toMatchObject(
      failsWith("correction_pending"),
    );
    for (const context of [pl, asBackOffice, asConsultant]) {
      await expect(decide(correctionId, true, context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    // One person holding both roles still can't approve their own request.
    await owner.query(
      `insert into staff_org_role (staff_user_id, role, region_id)
       select $1, 'regional_operations_manager', region_id from project where id = $2`,
      [projectLead, seedProjectIds.werkNord],
    );
    await expect(decide(correctionId, true, pl)).rejects.toMatchObject(
      failsWith("same_person_approval"),
    );
    // The manager without the role or deactivated is refused.
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [
      regionalOperationsManager,
    ]);
    await expect(decide(correctionId)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await owner.query("update staff_user set deactivated_at = null where id = $1", [
      regionalOperationsManager,
    ]);
    await owner.query(
      "delete from staff_org_role where staff_user_id = $1 and role = 'regional_operations_manager'",
      [regionalOperationsManager],
    );
    await expect(decide(correctionId)).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });

  it("refuses an approval when the field changed after the request (target_corrected)", async () => {
    const id = await profiled(await day(-10), await day(-2));
    const correctionId = await field(id, "profilingDoneOn", await day(-9));
    await owner.query(
      "update participation set profiling_done_on = berlin_today() - 3 where id=$1",
      [id],
    );
    await expect(decide(correctionId)).rejects.toMatchObject(failsWith("target_corrected"));
    // A rejection changes nothing.
    await decide(correctionId, false);
    expect(
      (await one("select profiling_done_on::text as d from participation where id=$1", [id])).d,
    ).toBe(await day(-3));
  });
});

const withdraw = (id: string, effectiveDate: string, context = pl) =>
  call(app, "change_participation_status", {
    id,
    field: "status",
    expectedFrom: "informed",
    to: "withdrawn",
    context,
    endReason: "placed_direct",
    effectiveDate,
  });

describe("a field correction of withdrawnOn", () => {
  it("corrects a manual withdrawal's date, not into the future; the status stays", async () => {
    const id = await informedParticipation(app);
    await withdraw(id, await day(-1));
    const before = await snapshot(id);
    await expect(field(id, "withdrawnOn", await day(1))).rejects.toMatchObject(
      failsWith("corrected_on_in_future"),
    );
    const correctionId = await field(id, "withdrawnOn", await day(-4));
    await decide(correctionId);
    expect(
      (await one("select withdrawn_on::text as d from participation where id=$1", [id])).d,
    ).toBe(await day(-4));
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses a system withdrawal's derived date", async () => {
    const id = await informedParticipation(app);
    await withdraw(id, await day(0), nightly);
    await expect(field(id, "withdrawnOn", await day(-1))).rejects.toMatchObject(
      failsWith("withdrawal_by_system"),
    );
  });

  it("keeps a cancellation-based withdrawal not before the cancellation's validity", async () => {
    const f = await signedDsv(await day(-6), await day(-5));
    await owner.query(
      "update participation set offer_deadline = berlin_today() - 7, tg_start = berlin_today() + 10 where id = $1",
      [f.id],
    );
    const cancelledOn = await day(-3);
    const all3 = {
      participant: cancelledOn,
      customer: cancelledOn,
      transfergesellschaft: cancelledOn,
    };
    const documentId = randomUUID();
    await call(app, "add_document", {
      context: pl,
      participationId: f.id,
      id: documentId,
      type: "dsv_cancellation",
      mediaType: "application/pdf",
      sizeBytes: 100,
      contentSha256: "c".repeat(64),
      fileName: null,
      keyId: "d".repeat(16),
      wrappedKey: Buffer.alloc(60),
      dsv: JSON.stringify({
        offerId: f.offer,
        signatures: all3,
        receivedBy: backOffice,
        receivedOn: await day(0),
      }),
    });
    await call(app, "review_document", {
      context: pl,
      documentId,
      decision: "accepted",
      reason: null,
      dsv: JSON.stringify({ signatures: all3 }),
    });
    await withdraw(f.id, await day(-1));
    await expect(field(f.id, "withdrawnOn", await day(-4))).rejects.toMatchObject(
      failsWith("effective_date_before_cancellation"),
    );
    expect(await field(f.id, "withdrawnOn", cancelledOn)).toEqual(expect.any(String));
    // The cancellation's signature date is superseded on its own paper only.
    const cancellation = await signature(
      f,
      await day(-2),
      "customer",
      asBackOffice,
      "dsv_cancellation",
    );
    await decide(cancellation);
    expect(
      (await one("select valid_on::text as d from dsv_cancellation_facts(array[$1::uuid])", [f.id]))
        .d,
    ).toBe(await day(-2));
    // The contract's own signature rows are untouched.
    expect((await dsvFacts(f.id)).map((r) => r.signed_on)).toEqual([await day(-6), await day(-6)]);
  });
});

describe("grants (ADR-0002)", () => {
  it("leaves transfer_app no write of the corrected columns or the signature rows", async () => {
    const id = await informedParticipation(app);
    for (const sql of [
      "update participation set profiling_done_on = berlin_today() where id = $1",
      "update participation set withdrawn_on = berlin_today() where id = $1",
      "update dsv_scan_signature set superseded_by = null where participation_id = $1",
      "update evidence_correction set corrected_on = berlin_today() where participation_id = $1",
    ]) {
      await expect(app.query(sql, [id])).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      app.query("select * from field_correction_problem(null::participation, 'withdrawnOn', null)"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
