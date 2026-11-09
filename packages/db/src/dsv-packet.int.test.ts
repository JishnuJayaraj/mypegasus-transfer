import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  call,
  informedParticipation,
  nightly,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// process-and-lifecycle.md, DSV packet and original: full execution rests on one reviewed packet;
// the database refuses the TG entry without it, whoever calls the status function.
const context = (id: string) => `(user,${id},,,,,)`;
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

type Dates = { participant?: string; customer?: string; transfergesellschaft?: string };

async function fixture() {
  const wave = seedWaves.find((w) => w.code === "W1")!;
  const id = await informedParticipation(app, {
    projectId: seedProjectIds.werkNord,
    entryWaveId: wave.id,
  });
  const {
    rows: [r],
  } = await owner.query(
    `select p.status_version, w.signing_deadline::text, w.default_tg_start::text, w.default_tg_end::text,
      berlin_today()::text as today, (berlin_today() - 3)::text as earlier
     from participation p join project_entry_wave w on w.id = p.entry_wave_id where p.id = $1`,
    [id],
  );
  const offer = await call<string>(app, "offer_dsv", {
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
  return {
    id,
    offer,
    today: r.today as string,
    earlier: r.earlier as string,
    version: r.status_version + 1,
    tgStart: r.default_tg_start as string,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const upload = (f: F, signatures: Dates, offerId = f.offer) => {
  const id = randomUUID();
  return call(app, "add_document", {
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
      offerId,
      signatures,
      receivedBy: seedStaffUserIds.backOffice,
      receivedOn: f.today,
    }),
  }).then(() => id);
};
const review = (scan: string, signatures: Dates, ctx = pl) =>
  call(app, "review_document", {
    context: ctx,
    documentId: scan,
    decision: "accepted",
    reason: null,
    dsv: JSON.stringify({ signatures, termsConfirmed: true }),
  });
const accepted = async (f: F, signatures: Dates) => {
  const scan = await upload(f, signatures);
  await review(scan, signatures);
  return scan;
};
const sign = (f: F, scan: string) =>
  call(app, "sign_dsv", {
    context: pl,
    participationId: f.id,
    scanId: scan,
    statusVersion: f.version,
  });
const facts = (f: F) => app.query("select * from dsv_facts($1)", [[f.id]]).then((r) => r.rows);
const enter = (f: F, over: Record<string, unknown> = {}) =>
  call(app, "change_participation_status", {
    id: f.id,
    field: "status",
    expectedFrom: "informed",
    to: "active_in_tg",
    context: pl,
    entryKind: "reconciliation",
    effectiveDate: f.tgStart,
    ...over,
  });

it("completes only from one scan with all three signatures, valid on the latest date", async () => {
  const f = await fixture();
  const first = await accepted(f, { participant: f.earlier, customer: f.earlier });
  await sign(f, first);
  // Two scans never add up: the customer's date is on one, the TG's on the other.
  await accepted(f, { participant: f.earlier, transfergesellschaft: f.today });
  expect((await facts(f)).map((row) => row.executed_on)).toEqual([null, null]);
  await expect(enter(f)).rejects.toMatchObject({ message: "dsv_packet_missing" });
  const packet = await accepted(f, {
    participant: f.earlier,
    customer: f.today,
    transfergesellschaft: f.earlier,
  });
  const row = (await facts(f)).find((x) => x.document_id === packet)!;
  expect(row.executed_on).toBe(f.today);
  await enter(f);
  expect(
    (await owner.query("select status from participation where id=$1", [f.id])).rows[0].status,
  ).toBe("active_in_tg");
});

it("refuses a participant date that differs between scans; an identical date is accepted", async () => {
  const f = await fixture();
  const first = await accepted(f, { participant: f.earlier });
  await expect(upload(f, { participant: f.today })).rejects.toMatchObject({
    message: "signature_date_mismatch",
  });
  // The date at review is the confirmed one, not the uploaded one.
  const second = await upload(f, { participant: f.earlier });
  await expect(review(second, { participant: f.today })).rejects.toMatchObject({
    message: "signature_date_mismatch",
  });
  await review(second, { participant: f.earlier, customer: f.today });
  await sign(f, first);
  // The countersigned original is a scan of the signed offer.
  const original = await accepted(f, {
    participant: f.earlier,
    customer: f.today,
    transfergesellschaft: f.today,
  });
  expect((await facts(f)).find((x) => x.document_id === original)!.executed_on).toBe(f.today);
});

it("refuses the entry whoever calls the status function, and by the snapshot of an automatic run", async () => {
  const f = await fixture();
  const single = await accepted(f, { participant: f.earlier });
  await sign(f, single);
  await expect(enter(f)).rejects.toMatchObject({ message: "dsv_packet_missing" });
  const run = `${f.tgStart}T03:15:00Z`;
  const automatic = {
    context: nightly,
    entryKind: "scheduled_entry",
    scheduledAt: run,
    effectiveDate: f.tgStart,
  };
  await expect(enter(f, automatic)).rejects.toMatchObject({ message: "dsv_packet_missing" });
  const packet = await accepted(f, {
    participant: f.earlier,
    customer: f.earlier,
    transfergesellschaft: f.earlier,
  });
  // Recorded now: a run that took its snapshot before is refused, the reconciliation is not.
  await expect(
    enter(f, { ...automatic, scheduledAt: "2020-01-01T03:15:00Z" }),
  ).rejects.toMatchObject({ message: "dsv_packet_missing" });
  // The packet is valid on the entry date only when the entry date is not before its latest date.
  await expect(enter(f, { effectiveDate: "2020-01-01" })).rejects.toMatchObject({
    message: "dsv_packet_missing",
  });
  await enter(f, automatic);
  expect((await facts(f)).find((x) => x.document_id === packet)).toBeTruthy();
});

it("withholds a quarantined packet, keeps its dates on the lift and refuses a rejected one", async () => {
  const f = await fixture();
  const packet = await upload(f, {
    participant: f.earlier,
    customer: f.earlier,
    transfergesellschaft: f.earlier,
  });
  await review(packet, {
    participant: f.earlier,
    customer: f.earlier,
    transfergesellschaft: f.earlier,
  });
  await sign(f, packet);
  const before = (await facts(f))[0];
  await call(app, "quarantine_document", {
    context: pl,
    documentId: packet,
    reason: "suspected_wrong_acceptance",
  });
  expect(await facts(f)).toEqual([]);
  await expect(enter(f)).rejects.toMatchObject({ message: "dsv_packet_missing" });
  await call(app, "lift_document_quarantine", { context: pl, documentId: packet });
  const after = (await facts(f))[0];
  expect(after.executed_on).toBe(before.executed_on);
  expect(new Date(after.recorded_at).getTime()).toBeGreaterThan(
    new Date(before.recorded_at).getTime(),
  );
  await enter(f);
});

it("takes no scan for a declined offer, but lets staff reject it", async () => {
  const f = await fixture();
  const pending = await upload(f, { participant: f.earlier });
  const accept = await upload(f, { participant: f.earlier });
  await call(app, "decline_dsv_offer", {
    context: pl,
    participationId: f.id,
    offerId: f.offer,
    expectedStatusVersion: f.version,
  });
  await expect(upload(f, { participant: f.earlier })).rejects.toMatchObject({
    message: "source_changed",
  });
  await expect(review(accept, { participant: f.earlier })).rejects.toMatchObject({
    message: "source_changed",
  });
  await call(app, "review_document", {
    context: context(seedStaffUserIds.backOffice),
    documentId: pending,
    decision: "rejected",
    reason: "wrong_document",
  });
  expect(await facts(f)).toEqual([]);
});

it("keeps the retained facts and the original on a contract per signed offer", async () => {
  const f = await fixture();
  const packet = await accepted(f, {
    participant: f.earlier,
    customer: f.today,
    transfergesellschaft: f.earlier,
  });
  expect((await owner.query("select * from dsv_contract")).rows).toEqual([]);
  await sign(f, packet);
  const {
    rows: [contract],
  } = await owner.query("select * from dsv_contract where participation_id=$1", [f.id]);
  expect(contract).toMatchObject({
    dsv_offer_id: f.offer,
    participant_signed_on: f.earlier,
    customer_signed_on: f.today,
    tg_signed_on: f.earlier,
    fully_executed_on: f.today,
    fully_executed_accepted_on: f.today,
    fully_executed_accepted_by_role: "project_lead",
    received_by_role: "back_office",
    original_location: null,
  });
  const record = (field: string, value: string, expected: string | null, ctx = pl) =>
    call(app, "record_dsv_original", {
      context: ctx,
      participationId: f.id,
      field,
      value,
      expected,
    });
  await record("originalLocation", "paper_personnel_file", null);
  await record("originalReceivedOn", f.earlier, null);
  await expect(record("originalReceivedOn", f.today, null)).rejects.toMatchObject({
    message: "stale_value",
  });
  await record("originalReceivedOn", f.today, f.earlier);
  await expect(record("sentToCustomerOn", "2199-01-01", null)).rejects.toMatchObject({
    message: "date_in_future",
  });
  await expect(record("originalLocation", "attic", "paper_personnel_file")).rejects.toMatchObject({
    message: "invalid_argument",
  });
  await expect(record("originalReceivedOn", f.today, f.today)).rejects.toMatchObject({
    message: "value_unchanged",
  });
  const { rows: events } = await owner.query(
    `select details from audit_event where participation_id=$1 and event_type='dsv_original_recorded' order by seq`,
    [f.id],
  );
  expect(events.map((e) => e.details)).toEqual([
    { field: "originalLocation", location: "paper_personnel_file" },
    { field: "originalReceivedOn" },
    { field: "originalReceivedOn" },
  ]);
  await expect(
    app.query("update dsv_contract set original_location='paper_personnel_file'"),
  ).rejects.toMatchObject({ code: "42501" });
});

it("allows the original to the PL and back office only, and not after losing the role", async () => {
  const f = await fixture();
  await sign(f, await accepted(f, { participant: f.earlier }));
  const record = (ctx: string) =>
    call(app, "record_dsv_original", {
      context: ctx,
      participationId: f.id,
      field: "originalLocation",
      value: "paper_personnel_file",
      expected: null,
    });
  await expect(record(context(seedStaffUserIds.consultant))).rejects.toMatchObject({
    message: "actor_not_allowed",
  });
  await owner.query("delete from project_membership where project_id=$1 and staff_user_id=$2", [
    seedProjectIds.werkNord,
    seedStaffUserIds.backOffice,
  ]);
  await expect(record(context(seedStaffUserIds.backOffice))).rejects.toMatchObject({
    message: "actor_not_allowed",
  });
  await record(pl);
});

it("refuses an original before the offer is signed", async () => {
  const f = await fixture();
  await expect(
    call(app, "record_dsv_original", {
      context: pl,
      participationId: f.id,
      field: "originalLocation",
      value: "paper_personnel_file",
      expected: null,
    }),
  ).rejects.toMatchObject({ message: "contract_not_found" });
});
