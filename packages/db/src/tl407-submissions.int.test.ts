import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// The TL 407's submission to the Agentur (process-and-lifecycle.md, TL 407 submission; D26, Q188,
// Q189) as transfer_app calls the functions: every attempt its own row, the API's settings
// compared under the lock, the original and the rejection, which reopens the work and leaves the
// scan, its signatures and the profiling track alone; the regional view's refusal dates.
// Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { verwaltung } = seedProjectIds;
const agenturKey = "beispielstadt-nord";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const daysAgo = async (n: number) =>
  (await one(`select (berlin_today() - $1::int)::text as d`, [n])).d as string;

/** An informed participation of Verwaltung, assigned to the consultant, placed with Nord. */
async function participation() {
  const id = await call(app, "create_participation", { projectId: verwaltung, context: pl });
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(app, id, { field: "status", from: "contacted", to: "informed" });
  await call(app, "assign_participations", {
    projectId: verwaltung,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  await owner.query(
    `update participation set placement_agentur_key = $2, placement_agentur_set_at = now()
     where id = $1`,
    [id, agenturKey],
  );
  return id;
}

/** An external paper TL 407 08/2025 signed `signedDaysAgo` days ago and accepted: its id. */
async function acceptedScan(id: string, signedDaysAgo = 10) {
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
  const signedOn = await daysAgo(signedDaysAgo);
  await call(app, "review_document", {
    context: asConsultant,
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
  return documentId;
}

type Submit = {
  id: string;
  documentId: string;
  submittedOn?: string;
  context?: string;
  agenturKey?: string | null;
  channel?: string | null;
  originalRequired?: boolean | null;
  outdatedVersions?: string[];
};

async function submit(args: Submit) {
  const submissionId = randomUUID();
  await call(app, "submit_tl407", {
    context: args.context ?? pl,
    participationId: args.id,
    submissionId,
    documentId: args.documentId,
    submittedOn: args.submittedOn ?? (await daysAgo(5)),
    agenturKey: args.agenturKey === undefined ? agenturKey : args.agenturKey,
    channel: args.channel === undefined ? "email" : args.channel,
    originalRequired: args.originalRequired === undefined ? true : args.originalRequired,
    outdatedVersions: args.outdatedVersions ?? [],
  });
  return submissionId;
}

const reject = async (submissionId: string, rejectedOn?: string, context = pl) =>
  call(app, "record_agentur_rejection", {
    context,
    submissionId,
    rejectedOn: rejectedOn ?? (await daysAgo(3)),
    reason: "incomplete",
  });
const original = async (submissionId: string, originalSentOn?: string, context = pl) =>
  call(app, "record_original_sent", {
    context,
    submissionId,
    originalSentOn: originalSentOn ?? (await daysAgo(4)),
  });

const rows = (id: string) =>
  all(
    `select form_code::text, form_version, agentur_key, channel::text, batch_id,
       original_required, original_sent_on is not null as original, rejected_on is not null as rejected,
       rejection_reason::text
     from agentur_submission where participation_id = $1 order by recorded_at, id`,
    [id],
  );
const events = (id: string) =>
  all(
    `select event_type::text, details from audit_event where participation_id = $1
       and event_type::text like 'agentur_submission%' order by occurred_at, id`,
    [id],
  );

describe("submit_tl407 (D26)", () => {
  it("records an attempt of an accepted scan for the PL, with the resolved settings", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    const submissionId = await submit({ id, documentId });
    expect(await rows(id)).toEqual([
      {
        form_code: "tl407",
        form_version: "08-2025",
        agentur_key: agenturKey,
        channel: "email",
        batch_id: null,
        original_required: true,
        original: false,
        rejected: false,
        rejection_reason: null,
      },
    ]);
    expect(await events(id)).toEqual([
      {
        event_type: "agentur_submission_recorded",
        details: {
          submissionId,
          documentId,
          formCode: "tl407",
          formVersion: "08-2025",
          channel: "email",
          submittedOn: await daysAgo(5),
        },
      },
    ]);
  });

  it("refuses another role, another participation's scan and a closed participation", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    for (const context of [asConsultant, asBackOffice]) {
      await expect(submit({ id, documentId, context })).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    const other = await participation();
    await expect(submit({ id: other, documentId })).rejects.toMatchObject(
      failsWith("document_not_found"),
    );
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "placed_direct",
      effectiveDate: await daysAgo(0),
    });
    await expect(submit({ id, documentId })).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });

  it("needs the placement Agentur the API resolved and all four settings (Q92)", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    await expect(
      submit({ id, documentId, agenturKey: "beispielstadt-sued" }),
    ).rejects.toMatchObject(failsWith("settings_changed"));
    await expect(
      submit({ id, documentId, channel: null, originalRequired: null }),
    ).rejects.toMatchObject(failsWith("submission_settings_missing"));
    await expect(submit({ id, documentId, channel: null })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await owner.query(
      "update participation set placement_agentur_key = null, placement_agentur_set_at = null where id = $1",
      [id],
    );
    await expect(submit({ id, documentId, agenturKey: null })).rejects.toMatchObject(
      failsWith("placement_agentur_missing"),
    );
  });

  it("supports no submission with a quarantined or unreviewed scan", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId,
      reason: "suspected_wrong_person",
    });
    await expect(submit({ id, documentId })).rejects.toMatchObject(failsWith("scan_unusable"));
    await call(app, "lift_document_quarantine", { context: pl, documentId });
    await submit({ id, documentId });
  });

  it("refuses an outdated version only where the API passes it as rejected (Q188)", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    await expect(submit({ id, documentId, outdatedVersions: ["08-2025"] })).rejects.toMatchObject(
      failsWith("form_version_outdated"),
    );
    await submit({ id, documentId, outdatedVersions: ["01-2020"] });
  });

  it("checks the date against today, the signature and the last rejection", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id, 10);
    await expect(submit({ id, documentId, submittedOn: await daysAgo(-1) })).rejects.toMatchObject(
      failsWith("submitted_on_in_future"),
    );
    await expect(submit({ id, documentId, submittedOn: await daysAgo(11) })).rejects.toMatchObject(
      failsWith("submitted_before_signature"),
    );
    const first = await submit({ id, documentId, submittedOn: await daysAgo(8) });
    await reject(first, await daysAgo(4));
    await expect(submit({ id, documentId, submittedOn: await daysAgo(5) })).rejects.toMatchObject(
      failsWith("submitted_before_rejection"),
    );
  });
});

describe("a rejection reopens the work until a new attempt (Q189)", () => {
  it("keeps every attempt, refuses a second standing one and leaves the scan and track alone", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    const first = await submit({ id, documentId, submittedOn: await daysAgo(6) });
    await expect(submit({ id, documentId })).rejects.toMatchObject(failsWith("already_submitted"));
    const before = await one(
      "select review_state::text, signed_on, countersigned_on, quarantined_at from document where id = $1",
      [documentId],
    );
    const track = await one("select profiling_status::text from participation where id = $1", [id]);
    await reject(first, await daysAgo(3));
    await expect(reject(first)).rejects.toMatchObject(failsWith("already_rejected"));
    expect(
      await one(
        "select review_state::text, signed_on, countersigned_on, quarantined_at from document where id = $1",
        [documentId],
      ),
    ).toEqual(before);
    expect(
      await one("select profiling_status::text from participation where id = $1", [id]),
    ).toEqual(track);
    const second = await submit({ id, documentId, submittedOn: await daysAgo(2) });
    expect((await rows(id)).map((r) => r.rejected)).toEqual([true, false]);
    expect((await events(id)).map((e) => e.event_type)).toEqual([
      "agentur_submission_recorded",
      "agentur_submission_rejected",
      "agentur_submission_recorded",
    ]);
    expect((await events(id))[1].details).toEqual({
      submissionId: first,
      rejectedOn: await daysAgo(3),
      reason: "incomplete",
    });
    expect(second).not.toBe(first);
  });

  it("dates a rejection from the submission to today; the PL only; never a batch's Kug 200b", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    const submissionId = await submit({ id, documentId, submittedOn: await daysAgo(5) });
    await expect(reject(submissionId, await daysAgo(-1))).rejects.toMatchObject(
      failsWith("date_in_future"),
    );
    await expect(reject(submissionId, await daysAgo(6))).rejects.toMatchObject(
      failsWith("date_before_submission"),
    );
    await expect(reject(submissionId, undefined, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(reject(randomUUID())).rejects.toMatchObject(failsWith("submission_not_found"));
    // A batch's Kug 200b has no rejection yet (Q204), nor a separate original.
    const batchId = randomUUID();
    await owner.query(
      `insert into kug200b_batch (id, project_id, agentur_key, channel, artifact, status,
         member_count, created_by, created_at, submitted_on, submitted_by, submitted_at)
       values ($1, $2, $3, 'scan_email', 'kug200a', 'submitted', 1, $4, now() - interval '2 days',
         berlin_today() - 1, $4, now())`,
      [batchId, verwaltung, agenturKey, seedStaffUserIds.projectLead],
    );
    const kug200b = randomUUID();
    await owner.query(
      `insert into agentur_submission (id, project_id, participation_id, document_id, form_code,
         form_version, agentur_key, channel, batch_id, submitted_on, recorded_by)
       values ($1, $2, $3, $4, 'kug200b', '07-2025', $5, 'scan_email', $6, berlin_today() - 1, $7)`,
      [kug200b, verwaltung, id, documentId, agenturKey, batchId, seedStaffUserIds.projectLead],
    );
    await expect(reject(kug200b, await daysAgo(0))).rejects.toMatchObject(
      failsWith("rejection_not_applicable"),
    );
    await expect(original(kug200b, await daysAgo(0))).rejects.toMatchObject(
      failsWith("original_not_required"),
    );
  });
});

describe("record_original_sent (D26)", () => {
  it("records the original once where the Agentur needs it apart from the submission", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    const submissionId = await submit({ id, documentId, submittedOn: await daysAgo(5) });
    await expect(original(submissionId, await daysAgo(6))).rejects.toMatchObject(
      failsWith("date_before_submission"),
    );
    await expect(original(submissionId, await daysAgo(-1))).rejects.toMatchObject(
      failsWith("date_in_future"),
    );
    await expect(original(submissionId, undefined, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await original(submissionId, await daysAgo(5));
    await expect(original(submissionId)).rejects.toMatchObject(failsWith("original_recorded"));
    expect((await events(id)).at(-1)).toEqual({
      event_type: "agentur_submission_original_sent",
      details: { submissionId, originalSentOn: await daysAgo(5) },
    });
  });

  it("refuses where no separate original is needed", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    const notRequired = await submit({ id, documentId, originalRequired: false });
    await expect(original(notRequired)).rejects.toMatchObject(failsWith("original_not_required"));
    await reject(notRequired, await daysAgo(5));
    const withPaper = await submit({ id, documentId, channel: "paper_original" });
    await expect(original(withPaper)).rejects.toMatchObject(failsWith("original_not_required"));
  });
});

const retain = (submissionId: string, retainedFrom: string, context = pl) =>
  call(app, "record_original_retained", { context, submissionId, retainedFrom });

describe("record_original_retained (Q206 (4))", () => {
  it("links the earlier dispatch of the same paper to the same Agentur and keeps its date", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id, 10);
    const first = await submit({ id, documentId, submittedOn: await daysAgo(9) });
    await original(first, await daysAgo(8));
    await reject(first, await daysAgo(4));
    const second = await submit({ id, documentId, submittedOn: await daysAgo(2) });
    // A new dated original before the new submission is refused; the retained one isn't.
    await expect(original(second, await daysAgo(8))).rejects.toMatchObject(
      failsWith("date_before_submission"),
    );
    await expect(retain(second, first, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await retain(second, first);
    expect(
      await one(
        "select original_sent_on::text as sent, original_retained_from as source from agentur_submission where id = $1",
        [second],
      ),
    ).toEqual({ sent: await daysAgo(8), source: first });
    await expect(retain(second, first)).rejects.toMatchObject(failsWith("original_recorded"));
    expect((await events(id)).at(-1)).toEqual({
      event_type: "agentur_submission_original_retained",
      details: { submissionId: second, retainedFrom: first, originalSentOn: await daysAgo(8) },
    });
  });

  it("is never assumed: only an earlier, rejected, dispatched attempt of the same scan and Agentur", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id, 10);
    const first = await submit({ id, documentId, submittedOn: await daysAgo(9) });
    await reject(first, await daysAgo(6));
    const second = await submit({ id, documentId, submittedOn: await daysAgo(5) });
    // No original was dispatched with the first attempt.
    await expect(retain(second, first)).rejects.toMatchObject(failsWith("original_not_retainable"));
    await expect(retain(second, second)).rejects.toMatchObject(
      failsWith("original_not_retainable"),
    );
    await expect(retain(second, randomUUID())).rejects.toMatchObject(
      failsWith("retained_original_not_found"),
    );
    // Another participation's attempt is not found either.
    const other = await participation();
    const otherScan = await acceptedScan(other, 10);
    const foreign = await submit({
      id: other,
      documentId: otherScan,
      submittedOn: await daysAgo(9),
    });
    await expect(retain(second, foreign)).rejects.toMatchObject(
      failsWith("retained_original_not_found"),
    );
    // A different paper: the original held is another one.
    await original(second, await daysAgo(5));
    await reject(second, await daysAgo(4));
    const newScan = await acceptedScan(id, 3);
    const third = await submit({ id, documentId: newScan, submittedOn: await daysAgo(2) });
    await expect(retain(third, second)).rejects.toMatchObject(failsWith("original_not_retainable"));
    // The same paper, but the earlier dispatch went to another Agentur.
    await owner.query("update agentur_submission set document_id = $2 where id = $1", [
      third,
      documentId,
    ]);
    await owner.query(
      "update agentur_submission set agentur_key = 'beispielstadt-sued' where id = $1",
      [second],
    );
    await expect(retain(third, second)).rejects.toMatchObject(failsWith("original_not_retainable"));
    await owner.query("update agentur_submission set agentur_key = $2 where id = $1", [
      second,
      agenturKey,
    ]);
    await retain(third, second);
  });

  it("isn't offered where no separate original is needed", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id, 10);
    const first = await submit({ id, documentId, submittedOn: await daysAgo(9) });
    await original(first, await daysAgo(8));
    await reject(first, await daysAgo(4));
    const second = await submit({
      id,
      documentId,
      submittedOn: await daysAgo(2),
      channel: "paper_original",
    });
    await expect(retain(second, first)).rejects.toMatchObject(failsWith("original_not_required"));
  });
});

describe("profiling_declined_dates (data-protection.md, the regional view)", () => {
  it("gives the latest refusal's effective date, dates only", async () => {
    const id = await participation();
    const none = await participation();
    await changeStatus(app, id, {
      field: "profiling_status",
      from: "not_started",
      to: "profiling_declined",
    });
    const { rows: dates } = await app.query(
      "select participation_id, declined_on from profiling_declined_dates($1::uuid[])",
      [[id, none]],
    );
    expect(dates).toEqual([{ participation_id: id, declined_on: await daysAgo(0) }]);
  });
});

describe("the table's rules", () => {
  it("transfer_app writes no submission directly", async () => {
    await expect(app.query("update agentur_submission set rejected_on = null")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("holds one standing TL 407 per participation and the follow-ups' shapes", async () => {
    const id = await participation();
    const documentId = await acceptedScan(id);
    const submissionId = await submit({ id, documentId, submittedOn: await daysAgo(5) });
    await expect(
      owner.query(
        `insert into agentur_submission (id, project_id, participation_id, document_id, form_code,
           form_version, agentur_key, channel, submitted_on, recorded_by, original_required)
         select gen_random_uuid(), project_id, participation_id, document_id, form_code,
           form_version, agentur_key, channel, submitted_on, recorded_by, original_required
         from agentur_submission where id = $1`,
        [submissionId],
      ),
    ).rejects.toThrow(/agentur_submission_tl407_live_unique/);
    await expect(
      owner.query("update agentur_submission set original_required = null where id = $1", [
        submissionId,
      ]),
    ).rejects.toThrow(/agentur_submission_original_required/);
    await expect(
      owner.query(
        "update agentur_submission set rejected_on = submitted_on - 1, rejection_reason = 'other', rejection_recorded_by = recorded_by, rejection_recorded_at = now() where id = $1",
        [submissionId],
      ),
    ).rejects.toThrow(/agentur_submission_rejection/);
    await expect(
      owner.query("update agentur_submission set original_sent_on = submitted_on where id = $1", [
        submissionId,
      ]),
    ).rejects.toThrow(/agentur_submission_original/);
  });
});
