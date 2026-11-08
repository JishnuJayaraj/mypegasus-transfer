import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  call,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";
const context = (id: string) => `(user,${id},,,,,)`;
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));
async function fixture() {
  const wave = seedWaves.find((w) => w.code === "W1")!;
  const id = await informedParticipation(app, {
    projectId: seedProjectIds.werkNord,
    entryWaveId: wave.id,
  });
  const {
    rows: [r],
  } = await owner.query(
    `select p.status_version, w.signing_deadline::text, w.default_tg_start::text, w.default_tg_end::text, berlin_today()::text as today from participation p join project_entry_wave w on w.id = p.entry_wave_id where p.id = $1`,
    [id],
  );
  const offer = await call(app, "offer_dsv", {
    context: pl,
    participationId: id,
    generationId: null,
    external: JSON.stringify({
      deadline: r.signing_deadline,
      printedTgStart: r.default_tg_start,
      printedTgEnd: r.default_tg_end,
    }),
    expectedStatusVersion: r.status_version,
  });
  return { id, offer, today: r.today as string, version: r.status_version + 1 };
}
async function upload(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await call(app, "add_document", {
    context: pl,
    participationId: f.id,
    id,
    type: "dsv_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 100,
    contentSha256: "a".repeat(64),
    fileName: null,
    keyId: "b".repeat(16),
    wrappedKey: Buffer.alloc(60),
    dsv: JSON.stringify({
      offerId: f.offer,
      signatures: { participant: f.today },
      receivedBy: seedStaffUserIds.projectLead,
      receivedOn: f.today,
    }),
  });
  return id;
}
it("requires reviewed counting evidence, withholds it in quarantine and preserves dates on lift", async () => {
  const f = await fixture();
  const scan = await upload(f);
  const sign = () =>
    call(app, "sign_dsv", {
      context: pl,
      participationId: f.id,
      scanId: scan,
      statusVersion: f.version,
    });
  await expect(sign()).rejects.toMatchObject({ message: "dsv_scan_missing" });
  await expect(
    call(app, "review_document", {
      context: pl,
      documentId: scan,
      decision: "accepted",
      reason: null,
      dsv: JSON.stringify({ signatures: { participant: f.today }, termsConfirmed: false }),
    }),
  ).rejects.toMatchObject({ message: "terms_mismatch" });
  await call(app, "review_document", {
    context: pl,
    documentId: scan,
    decision: "accepted",
    reason: null,
    dsv: JSON.stringify({ signatures: { participant: f.today }, termsConfirmed: true }),
  });
  const facts = () => app.query("select * from dsv_facts($1)", [[f.id]]);
  const before = (await facts()).rows[0];
  await call(app, "quarantine_document", {
    context: pl,
    documentId: scan,
    reason: "suspected_wrong_acceptance",
  });
  expect((await facts()).rows).toEqual([]);
  await expect(sign()).rejects.toMatchObject({ message: "dsv_scan_missing" });
  await call(app, "lift_document_quarantine", { context: pl, documentId: scan });
  const after = (await facts()).rows[0];
  expect(after.signed_on).toBe(before.signed_on);
  expect(new Date(after.recorded_at).getTime()).toBeGreaterThan(
    new Date(before.recorded_at).getTime(),
  );
  await sign();
  expect(
    (await owner.query("select dsv_status from participation where id=$1", [f.id])).rows[0]
      .dsv_status,
  ).toBe("dsv_signed");
});

it("refuses foreign offers, missing receiver, future dates and direct status guard bypasses", async () => {
  const f = await fixture();
  const other = await fixture();
  const add = (metadata: object) =>
    call(app, "add_document", {
      context: pl,
      participationId: f.id,
      id: randomUUID(),
      type: "dsv_signed_scan",
      mediaType: "application/pdf",
      sizeBytes: 100,
      contentSha256: "a".repeat(64),
      fileName: null,
      keyId: "b".repeat(16),
      wrappedKey: Buffer.alloc(60),
      dsv: JSON.stringify(metadata),
    });
  const metadata = {
    offerId: f.offer,
    receivedBy: seedStaffUserIds.projectLead,
    receivedOn: f.today,
    signatures: { participant: f.today },
  };
  await expect(add({ ...metadata, offerId: other.offer })).rejects.toMatchObject({
    message: "offer_not_found",
  });
  await expect(add({ ...metadata, receivedBy: null })).rejects.toMatchObject({
    message: "receiver_required",
  });
  await expect(add({ ...metadata, receivedOn: "2199-01-01" })).rejects.toMatchObject({
    message: "received_in_future",
  });
  await expect(add({ ...metadata, signatures: { customer: "2199-01-01" } })).rejects.toMatchObject({
    message: "signature_in_future",
  });
  await expect(add({ ...metadata, receivedOn: "2000-01-01" })).rejects.toMatchObject({
    message: "received_before_signature",
  });
  await expect(
    call(app, "change_participation_status", {
      id: f.id,
      field: "dsv_status",
      expectedFrom: "dsv_offered",
      to: "dsv_signed",
      context: pl,
    }),
  ).rejects.toMatchObject({ message: "dsv_scan_missing" });
  await expect(
    app.query("update participation set dsv_status='dsv_signed' where id=$1", [f.id]),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    app.query(
      "insert into dsv_scan_signature(project_id,participation_id,document_id,kind,signed_on) values ($1,$2,$3,'participant',current_date)",
      [seedProjectIds.werkNord, f.id, randomUUID()],
    ),
  ).rejects.toMatchObject({ code: "42501" });
});

it("rejects stale signing and one-time reviews; only the PL deletes before review", async () => {
  const f = await fixture();
  const scan = await upload(f);
  await expect(
    call(app, "sign_dsv", {
      context: pl,
      participationId: f.id,
      scanId: scan,
      statusVersion: f.version - 1,
    }),
  ).rejects.toMatchObject({ message: "stale_status" });
  await call(app, "review_document", {
    context: pl,
    documentId: scan,
    decision: "rejected",
    reason: "unreadable",
  });
  await expect(
    call(app, "review_document", {
      context: pl,
      documentId: scan,
      decision: "accepted",
      reason: null,
      dsv: JSON.stringify({ signatures: { participant: f.today }, termsConfirmed: true }),
    }),
  ).rejects.toMatchObject({ message: "document_reviewed" });
  await expect(
    call(app, "delete_document", { context: pl, documentId: scan, reason: "wrong_file" }),
  ).rejects.toMatchObject({ message: "document_immutable" });
  const second = await upload(f);
  await call(app, "delete_document", { context: pl, documentId: second, reason: "wrong_file" });
  expect((await app.query("select * from dsv_facts($1)", [[f.id]])).rows).toEqual([]);
});

it("rechecks project assignment and keeps back-office deletion forbidden", async () => {
  const f = await fixture();
  const scan = await upload(f);
  const review = (ctx: string) =>
    call(app, "review_document", {
      context: ctx,
      documentId: scan,
      decision: "accepted",
      reason: null,
      dsv: JSON.stringify({ signatures: { participant: f.today }, termsConfirmed: true }),
    });
  await expect(review(context(seedStaffUserIds.consultant))).rejects.toMatchObject({
    message: "actor_not_allowed",
  });
  await expect(
    call(app, "delete_document", {
      context: context(seedStaffUserIds.backOffice),
      documentId: scan,
      reason: "wrong_file",
    }),
  ).rejects.toMatchObject({ message: "actor_not_allowed" });
  await owner.query("delete from project_membership where project_id=$1 and staff_user_id=$2", [
    seedProjectIds.werkNord,
    seedStaffUserIds.backOffice,
  ]);
  await expect(review(context(seedStaffUserIds.backOffice))).rejects.toMatchObject({
    message: "actor_not_allowed",
  });
  await review(pl);
});

it("does not borrow another scan's signature or a previous offer's paper", async () => {
  const f = await fixture();
  const first = await upload(f);
  const empty = await upload(f);
  await call(app, "review_document", {
    context: pl,
    documentId: first,
    decision: "accepted",
    reason: null,
    dsv: JSON.stringify({ signatures: { participant: f.today }, termsConfirmed: true }),
  });
  await call(app, "review_document", {
    context: pl,
    documentId: empty,
    decision: "accepted",
    reason: null,
    dsv: JSON.stringify({ signatures: {}, termsConfirmed: true }),
  });
  await expect(
    call(app, "sign_dsv", {
      context: pl,
      participationId: f.id,
      scanId: empty,
      statusVersion: f.version,
    }),
  ).rejects.toMatchObject({ message: "dsv_scan_missing" });
  await call(app, "decline_dsv_offer", {
    context: pl,
    participationId: f.id,
    offerId: f.offer,
    expectedStatusVersion: f.version,
  });
  expect((await app.query("select * from dsv_facts($1)", [[f.id]])).rows).toEqual([]);
  await expect(upload(f)).rejects.toMatchObject({ message: "source_changed" });
});
