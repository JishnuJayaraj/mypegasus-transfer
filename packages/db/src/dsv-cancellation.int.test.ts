import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  acceptDsvScan,
  auditContext,
  call,
  informedParticipation,
  nightly,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// process-and-lifecycle.md, the cancellation of a signed DSV, the withdrawal it allows and the
// customer notice (Q46 verify, Q213 accepted provisionally): expected results from the plan's D10
// and D28, never from the implementation.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const as = (staffUserId: string) => auditContext({ actorType: "user", staffUserId });
const backOffice = as(seedStaffUserIds.backOffice);
const consultant = as(seedStaffUserIds.consultant);
const w1 = seedWaves.find((w) => w.code === "W1")!;

const day = async (offset: number): Promise<string> =>
  (await owner.query("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d;
const version = async (id: string): Promise<number> =>
  (await owner.query("select status_version from participation where id=$1", [id])).rows[0]
    .status_version;

/**
 * An informed participation with a signed DSV (the participant's signature 5 days ago) whose
 * planned TG start is `startIn` days from today.
 */
async function signed(startIn = 10) {
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
  const signedOn = await day(-5);
  const scan = await acceptDsvScan(app, id, { participant: signedOn });
  await call(app, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: scan,
    statusVersion: await version(id),
  });
  await owner.query(
    "update participation set offer_deadline = berlin_today() - 6, tg_start = berlin_today() + $2::int where id = $1",
    [id, startIn],
  );
  return { id, offer };
}

type Signatures = { participant?: string; customer?: string; transfergesellschaft?: string };

async function upload(
  f: { id: string; offer: string },
  signatures: Signatures,
  context = pl,
  offerId = f.offer,
) {
  const documentId = randomUUID();
  await call(app, "add_document", {
    context,
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
      offerId,
      signatures,
      receivedBy: seedStaffUserIds.backOffice,
      receivedOn: await day(0),
    }),
  });
  return documentId;
}

const review = (documentId: string, signatures: Signatures, context = pl) =>
  call(app, "review_document", {
    context,
    documentId,
    decision: "accepted",
    reason: null,
    dsv: JSON.stringify({ signatures }),
  });

/** An accepted cancellation with the three signatures on `on` (default 2 days ago). */
async function cancelled(f: { id: string; offer: string }, on?: string) {
  const date = on ?? (await day(-2));
  const all = { participant: date, customer: date, transfergesellschaft: date };
  const documentId = await upload(f, all);
  await review(documentId, all);
  return { documentId, date };
}

const withdraw = async (id: string, effectiveDate: string, context = pl, from = "informed") =>
  call(app, "change_participation_status", {
    id,
    field: "status",
    expectedFrom: from,
    to: "withdrawn",
    context,
    endReason: "placed_direct",
    effectiveDate,
  });

const facts = async (id: string) =>
  (
    await owner.query(
      `select document_id, valid_on::text, recorded_at from dsv_cancellation_facts(array[$1::uuid])`,
      [id],
    )
  ).rows;

describe("the cancellation scan (catalog version 10)", () => {
  it("is uploaded against the signed contract by the PL or back office, never by a consultant", async () => {
    const f = await signed();
    const date = await day(-1);
    await expect(upload(f, { participant: date }, backOffice)).resolves.toBeTruthy();
    await expect(upload(f, { participant: date }, consultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const { rows } = await owner.query(
      "select catalog_version, retention_class::text from document where participation_id=$1 and type='dsv_cancellation'",
      [f.id],
    );
    expect(rows).toEqual([{ catalog_version: 10, retention_class: "personnel_file" }]);
  });

  it("names this participation's signed offer: another's is not found, an open one isn't a contract", async () => {
    const f = await signed();
    const other = await signed();
    const date = await day(-1);
    await expect(upload(f, { participant: date }, pl, other.offer)).rejects.toMatchObject(
      failsWith("offer_not_found"),
    );
    // An open offer: the participation of a fresh offer has nothing to cancel.
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
    await expect(upload({ id, offer }, { participant: date })).rejects.toMatchObject(
      failsWith("source_changed"),
    );
  });

  it("refuses signature dates in the future", async () => {
    const f = await signed();
    await expect(upload(f, { customer: await day(1) })).rejects.toMatchObject(
      failsWith("signature_in_future"),
    );
    await expect(upload(f, { participant: await day(1) })).rejects.toMatchObject(
      failsWith("signature_in_future"),
    );
  });

  it("is accepted only with the three parties' signatures, which become its signature rows", async () => {
    const f = await signed();
    const date = await day(-2);
    const documentId = await upload(f, { participant: date, customer: date });
    await expect(review(documentId, { participant: date, customer: date })).rejects.toMatchObject(
      failsWith("cancellation_signatures_missing"),
    );
    const all = { participant: date, customer: date, transfergesellschaft: date };
    await expect(
      call(app, "review_document", {
        context: pl,
        documentId,
        decision: "accepted",
        reason: null,
        dsv: JSON.stringify({ signatures: all, termsConfirmed: true }),
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    await review(documentId, all, backOffice);
    const { rows } = await owner.query(
      "select kind from dsv_scan_signature where document_id=$1 order by kind",
      [documentId],
    );
    expect(rows.map((r) => r.kind)).toEqual(["customer", "participant", "transfergesellschaft"]);
    const { rows: audit } = await owner.query(
      "select details from audit_event where event_type='document_reviewed' and details->>'documentId'=$1",
      [documentId],
    );
    expect(audit[0].details).toMatchObject({
      documentType: "dsv_cancellation",
      decision: "accepted",
      signatureKinds: ["customer", "participant", "transfergesellschaft"],
    });
    // The signature dates stay out of the audit trail.
    expect(JSON.stringify(audit[0].details)).not.toContain(date);
    expect(await facts(f.id)).toEqual([
      expect.objectContaining({ document_id: documentId, valid_on: date }),
    ]);
  });

  it("is valid from its latest actual signature, never the day it was accepted", async () => {
    const f = await signed();
    const [a, b, c] = [await day(-4), await day(-3), await day(-1)];
    const signatures = { participant: a, customer: c, transfergesellschaft: b };
    const documentId = await upload(f, signatures);
    await review(documentId, signatures);
    expect((await facts(f.id))[0].valid_on).toBe(c);
  });

  it("is rejected without a fact, deleted by the PL before review, never by back office", async () => {
    const f = await signed();
    const date = await day(-1);
    const rejected = await upload(f, { participant: date });
    await call(app, "review_document", {
      context: backOffice,
      documentId: rejected,
      decision: "rejected",
      reason: "incomplete",
    });
    expect(await facts(f.id)).toEqual([]);
    const unreviewed = await upload(f, { participant: date });
    await expect(
      call(app, "delete_document", {
        context: backOffice,
        documentId: unreviewed,
        reason: "wrong_file",
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await call(app, "delete_document", {
      context: pl,
      documentId: unreviewed,
      reason: "wrong_file",
    });
  });
});

describe("the withdrawal of a signed DSV (apply_status_change)", () => {
  it("is refused without a counting cancellation, then allowed once one is accepted", async () => {
    const f = await signed();
    const today = await day(0);
    await expect(withdraw(f.id, today)).rejects.toMatchObject(
      failsWith("dsv_cancellation_missing"),
    );
    // Uploaded but not reviewed: it doesn't count yet.
    const date = await day(-2);
    const all = { participant: date, customer: date, transfergesellschaft: date };
    const documentId = await upload(f, all);
    await expect(withdraw(f.id, today)).rejects.toMatchObject(
      failsWith("dsv_cancellation_missing"),
    );
    await review(documentId, all);
    await withdraw(f.id, today);
    const { rows } = await owner.query(
      "select status::text, withdrawn_on::text, end_reason::text, dsv_status::text from participation where id=$1",
      [f.id],
    );
    expect(rows[0]).toEqual({
      status: "withdrawn",
      withdrawn_on: today,
      end_reason: "placed_direct",
      dsv_status: "dsv_signed",
    });
  });

  it("is refused with an effective date before the cancellation's validity", async () => {
    const f = await signed();
    const { date } = await cancelled(f);
    await expect(withdraw(f.id, await day(-3))).rejects.toMatchObject(
      failsWith("effective_date_before_cancellation"),
    );
    await withdraw(f.id, date);
  });

  it("is refused the day after the planned start, and the entry clarification is then open (D28)", async () => {
    const f = await signed(-1);
    await cancelled(f);
    await expect(withdraw(f.id, await day(0))).rejects.toMatchObject(
      failsWith("after_planned_start"),
    );
    // The case is the entry clarification's: the PL documents it as the open case it is.
    await call(app, "record_entry_clarification", {
      context: pl,
      participationId: f.id,
      code: "awaiting_legal_advice",
      source: "Aufhebungsvertrag nach Beginn, Akte 4",
      statusVersion: await version(f.id),
      expectedRevision: 0,
    });
    const { rows } = await owner.query(
      "select stage, opened_on::text from entry_clarification where participation_id=$1",
      [f.id],
    );
    expect(rows).toEqual([{ stage: "documented", opened_on: await day(0) }]);
  });

  it("is allowed on the planned start day itself", async () => {
    const f = await signed(0);
    await cancelled(f);
    await withdraw(f.id, await day(0));
    const { rows } = await owner.query("select status::text from participation where id=$1", [
      f.id,
    ]);
    expect(rows[0].status).toBe("withdrawn");
  });

  it("doesn't count a quarantined cancellation; after the lift its dates stay and its recording moves", async () => {
    const f = await signed();
    const { documentId, date } = await cancelled(f);
    const before = (await facts(f.id))[0];
    await call(app, "quarantine_document", {
      context: backOffice,
      documentId,
      reason: "suspected_wrong_person",
    });
    expect(await facts(f.id)).toEqual([]);
    await expect(withdraw(f.id, await day(0))).rejects.toMatchObject(
      failsWith("dsv_cancellation_missing"),
    );
    await call(app, "lift_document_quarantine", { context: backOffice, documentId });
    const after = (await facts(f.id))[0];
    expect(after.valid_on).toBe(date);
    expect(new Date(after.recorded_at).getTime()).toBeGreaterThan(
      new Date(before.recorded_at).getTime(),
    );
    await withdraw(f.id, await day(0));
  });

  it("never lets the system withdraw a signed DSV, whatever the evidence", async () => {
    const f = await signed();
    await cancelled(f);
    await expect(withdraw(f.id, await day(0), nightly)).rejects.toMatchObject(
      failsWith("withdrawal_after_dsv_signed"),
    );
  });

  it("is refused against a status that moved since it was read", async () => {
    const f = await signed();
    await cancelled(f);
    await expect(withdraw(f.id, await day(0), pl, "contacted")).rejects.toMatchObject(
      failsWith("stale_status"),
    );
  });

  it("leaves a withdrawal without a signed DSV as it was", async () => {
    const id = await informedParticipation(app, { projectId: seedProjectIds.werkNord });
    await withdraw(id, await day(-1));
    expect(
      (await owner.query("select status::text from participation where id=$1", [id])).rows[0],
    ).toEqual({ status: "withdrawn" });
  });

  it("refuses an upload or acceptance once the participation is withdrawn", async () => {
    const f = await signed();
    const date = await day(-2);
    const all = { participant: date, customer: date, transfergesellschaft: date };
    const pending = await upload(f, all);
    await cancelled(f);
    await withdraw(f.id, await day(0));
    await expect(review(pending, all)).rejects.toMatchObject(failsWith("cancellation_not_open"));
    await expect(upload(f, all)).rejects.toMatchObject(failsWith("participation_closed"));
  });
});

const notice = (id: string, notifiedOn: string, context = pl) =>
  call(app, "record_customer_notice", { context, participationId: id, notifiedOn });

/** A signed DSV withdrawn yesterday on its cancellation. */
async function withdrawn() {
  const f = await signed();
  await cancelled(f);
  const on = await day(-1);
  await withdraw(f.id, on);
  return { ...f, on };
}

describe("record_customer_notice", () => {
  it("records the PL's date once; the history gets the day, the customer nothing new", async () => {
    const f = await withdrawn();
    await notice(f.id, await day(0));
    await expect(notice(f.id, await day(0))).rejects.toMatchObject(failsWith("notice_recorded"));
    const { rows } = await owner.query(
      "select notified_on::text, recorded_by from dsv_customer_notice where participation_id=$1",
      [f.id],
    );
    expect(rows).toEqual([
      { notified_on: await day(0), recorded_by: seedStaffUserIds.projectLead },
    ]);
    const { rows: audit } = await owner.query(
      "select details from audit_event where participation_id=$1 and event_type='dsv_customer_notified'",
      [f.id],
    );
    expect(audit).toEqual([{ details: { notifiedOn: await day(0) } }]);
  });

  it("is due only after a cancellation-based withdrawal", async () => {
    const f = await signed();
    await expect(notice(f.id, await day(0))).rejects.toMatchObject(failsWith("notice_not_due"));
    const id = await informedParticipation(app, { projectId: seedProjectIds.werkNord });
    await withdraw(id, await day(0));
    await expect(notice(id, await day(0))).rejects.toMatchObject(failsWith("notice_not_due"));
  });

  it("takes no date in the future and none before the withdrawal", async () => {
    const f = await withdrawn();
    await expect(notice(f.id, await day(1))).rejects.toMatchObject(failsWith("date_in_future"));
    await expect(notice(f.id, await day(-2))).rejects.toMatchObject(
      failsWith("notice_before_withdrawal"),
    );
    await notice(f.id, f.on);
  });

  it("is the PL's: back office, a consultant and a former PL are refused", async () => {
    const f = await withdrawn();
    for (const context of [backOffice, consultant]) {
      await expect(notice(f.id, await day(0), context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    await owner.query("delete from project_membership where project_id=$1 and staff_user_id=$2", [
      seedProjectIds.werkNord,
      seedStaffUserIds.projectLead,
    ]);
    await expect(notice(f.id, await day(0))).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });

  it("is written only by its function and its event only by it", async () => {
    const f = await withdrawn();
    await expect(
      app.query(
        "insert into dsv_customer_notice (project_id, participation_id, notified_on, recorded_by) values ($1,$2,berlin_today(),$3)",
        [seedProjectIds.werkNord, f.id, seedStaffUserIds.projectLead],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      call(app, "record_audit_event", {
        projectId: seedProjectIds.werkNord,
        participationId: f.id,
        eventType: "dsv_customer_notified",
        context: pl,
        details: { notifiedOn: await day(0) },
      }),
    ).rejects.toMatchObject(failsWith("event_type_reserved"));
    await expect(
      owner.query(
        `insert into audit_event (project_id, participation_id, event_type, actor_type, system_job, details)
         values ($1, null, 'dsv_customer_notified', 'system', 'test', '{}')`,
        [seedProjectIds.werkNord],
      ),
    ).rejects.toMatchObject({ constraint: "audit_event_lifecycle_has_participation" });
  });
});
