import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedRegionIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  acceptDsvScan,
  auditContext,
  call,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// process-and-lifecycle.md, TG entry guard, "Entry after the planned date" case 2 (Q68), and the
// reconciliation's review (Q80, Q216): the PL enters a missed participation with the TG start as its
// effective date when every fact held on it though recorded later; the region's manager reviews it
// after the fact, asks the PL, who replies, and resolves or escalates. Never a reversal.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const as = (staffUserId: string) => auditContext({ actorType: "user", staffUserId });
const manager = as(seedStaffUserIds.regionalOperationsManager);
const w1 = seedWaves.find((w) => w.code === "W1")!;
const source = "Akte 12, Vermerk vom 3.4.";

const version = async (id: string): Promise<number> =>
  (await owner.query("select status_version from participation where id=$1", [id])).rows[0]
    .status_version;
const day = async (offset: number): Promise<string> =>
  (await owner.query("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d;

type Signed = { id: string; packet: string; signedOn: string; tgStart: string };

/**
 * A signed DSV with its complete packet (all three signatures three days ago), informed, whose
 * planned start was `startOffset` days from today.
 */
async function signedWithPacket(startOffset = -1, signedOffset = -3): Promise<Signed> {
  const id = await informedParticipation(app, {
    projectId: seedProjectIds.werkNord,
    entryWaveId: w1.id,
  });
  await call(app, "offer_dsv", {
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
  const signedOn = await day(signedOffset);
  const packet = await acceptDsvScan(app, id, {
    participant: signedOn,
    customer: signedOn,
    transfergesellschaft: signedOn,
  });
  await call(app, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: packet,
    statusVersion: await version(id),
  });
  const tgStart = await day(startOffset);
  await owner.query(
    "update participation set offer_deadline = berlin_today() - 20, tg_start = $2 where id = $1",
    [id, tgStart],
  );
  return { id, packet, signedOn, tgStart };
}

/** The evidence as the dialog lists it: the packet, a registration and a TL 407 (synthetic ids). */
const evidenceOf = (s: Signed, over: Partial<Record<string, string>> = {}) => [
  {
    kind: "dsv_packet",
    id: over.packet ?? s.packet,
    validOn: over.packetOn ?? s.signedOn,
    recordedAt: "2026-01-01T09:00:00.000Z",
  },
  {
    kind: "asu_registration",
    id: "00000000-0000-4000-8000-0000000000a1",
    validOn: over.asuOn ?? s.signedOn,
    recordedAt: "2026-01-01T09:00:00.000Z",
  },
  {
    kind: over.profilingKind ?? "tl407",
    id: "00000000-0000-4000-8000-0000000000a2",
    validOn: s.signedOn,
    recordedAt: "2026-01-01T09:00:00.000Z",
  },
];

const reconcile = async (s: Signed, over: Record<string, unknown> = {}) =>
  call<string>(app, "reconcile_tg_entry", {
    context: pl,
    participationId: s.id,
    statusVersion: await version(s.id),
    evidence: JSON.stringify(evidenceOf(s)),
    confirmed: true,
    ...over,
  });
const reconciliation = async (id: string) =>
  (await owner.query("select * from tg_entry_reconciliation where id=$1", [id])).rows[0];
const review = async (
  id: string,
  outcome: string,
  over: Record<string, unknown> = {},
  context = manager,
) =>
  call<string>(app, "review_reconciliation", {
    context,
    reconciliationId: id,
    outcome,
    code: outcome === "clarification_requested" ? "date_unclear" : null,
    source: outcome === "no_objection" ? null : "Weisung DSB, Az. 7",
    expectedRevision:
      "expectedRevision" in over ? over.expectedRevision : (await reconciliation(id)).revision,
    ...over,
  });
const reply = async (id: string, over: Record<string, unknown> = {}, context = pl) =>
  call<string>(app, "reply_reconciliation_clarification", {
    context,
    reconciliationId: id,
    code: "explained",
    source,
    expectedRevision: (await reconciliation(id)).revision,
    ...over,
  });
const events = async (participationId: string, like: string) =>
  (
    await owner.query(
      "select event_type::text as type, details, effective_date, flagged_for_review from audit_event where participation_id=$1 and event_type::text like $2 order by seq",
      [participationId, like],
    )
  ).rows;

describe("reconcile_tg_entry", () => {
  it("a packet quarantined and lifted after the TG start's run keeps its date: the scheduled entry fails, the reconciliation passes", async () => {
    const s = await signedWithPacket();
    await call(app, "quarantine_document", {
      context: pl,
      documentId: s.packet,
      reason: "suspected_wrong_acceptance",
    });
    // The run of the TG start takes its snapshot while the packet is quarantined.
    const {
      rows: [{ run }],
    } = await owner.query("select now() as run");
    const scheduled = {
      id: s.id,
      field: "status",
      expectedFrom: "informed",
      to: "active_in_tg",
      context: auditContext({ actorType: "system", systemJob: "lifecycle.evaluate-project" }),
      entryKind: "scheduled_entry_catchup",
      scheduledAt: run,
      effectiveDate: s.tgStart,
    };
    await expect(call(app, "change_participation_status", scheduled)).rejects.toMatchObject(
      failsWith("dsv_packet_missing"),
    );
    await owner.query("select pg_sleep(0.01)");
    await call(app, "lift_document_quarantine", { context: pl, documentId: s.packet });
    // Lifted after the run: the scheduled entry still fails (the snapshot rule) …
    await expect(call(app, "change_participation_status", scheduled)).rejects.toMatchObject(
      failsWith("dsv_packet_missing"),
    );
    // … the packet's date stays the signatures', so the reconciliation passes.
    const id = await reconcile(s);
    const {
      rows: [p],
    } = await owner.query("select status, tg_entry_date from participation where id=$1", [s.id]);
    expect(p).toEqual({ status: "active_in_tg", tg_entry_date: s.tgStart });
    const row = await reconciliation(id);
    expect(row).toMatchObject({
      participation_id: s.id,
      effective_date: s.tgStart,
      confirmed: true,
      reconciled_by: seedStaffUserIds.projectLead,
      stage: "requested",
      revision: 0,
    });
    expect(row.evidence[0]).toMatchObject({
      kind: "dsv_packet",
      id: s.packet,
      validOn: s.signedOn,
    });
    // One status change, flagged for review and linked, and the reconciliation's own event.
    const [status] = await events(s.id, "status_changed");
    const changes = await owner.query(
      "select id, details, effective_date, flagged_for_review from audit_event where participation_id=$1 and event_type='status_changed' and to_value='active_in_tg'",
      [s.id],
    );
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0]).toMatchObject({
      id: row.status_event_id,
      details: { entryKind: "reconciliation" },
      effective_date: s.tgStart,
      flagged_for_review: true,
    });
    expect(status).toBeTruthy();
    expect(await events(s.id, "tg_entry_reconciled")).toEqual([
      {
        type: "tg_entry_reconciled",
        details: {
          reconciliationId: id,
          evidenceKinds: ["dsv_packet", "asu_registration", "tl407"],
        },
        effective_date: s.tgStart,
        flagged_for_review: false,
      },
    ]);
  });

  it("refuses evidence valid only after the TG start: never backdated, no later day invented", async () => {
    // The packet was signed yesterday, the planned start was three days ago.
    const s = await signedWithPacket(-3, -1);
    await expect(reconcile(s)).rejects.toMatchObject(failsWith("evidence_after_tg_start"));
    const t = await signedWithPacket();
    await expect(
      reconcile(t, { evidence: JSON.stringify(evidenceOf(t, { asuOn: await day(0) })) }),
    ).rejects.toMatchObject(failsWith("evidence_after_tg_start"));
    // Claiming the packet on another day than its signatures': the database knows its date.
    await expect(
      reconcile(t, { evidence: JSON.stringify(evidenceOf(t, { packetOn: await day(-4) })) }),
    ).rejects.toMatchObject(failsWith("source_changed"));
    expect(
      (await owner.query("select count(*)::int as n from tg_entry_reconciliation")).rows[0].n,
    ).toBe(0);
  });

  it("refuses a packet that changed between the read and the write (source_changed)", async () => {
    const s = await signedWithPacket();
    const read = JSON.stringify(evidenceOf(s));
    await call(app, "quarantine_document", {
      context: pl,
      documentId: s.packet,
      reason: "suspected_wrong_acceptance",
    });
    await expect(reconcile(s, { evidence: read })).rejects.toMatchObject(
      failsWith("source_changed"),
    );
    await expect(
      reconcile(s, { evidence: JSON.stringify(evidenceOf(s, { packet: randomUUID() })) }),
    ).rejects.toMatchObject(failsWith("source_changed"));
  });

  it("refuses a stale status version, a missing confirmation and a malformed evidence list", async () => {
    const s = await signedWithPacket();
    const read = await version(s.id);
    await owner.query("update participation set status_version = status_version + 1 where id=$1", [
      s.id,
    ]);
    await expect(reconcile(s, { statusVersion: read })).rejects.toMatchObject(
      failsWith("stale_status_version"),
    );
    await expect(reconcile(s, { confirmed: false })).rejects.toMatchObject(
      failsWith("confirmation_required"),
    );
    const two = evidenceOf(s).slice(0, 2);
    await expect(reconcile(s, { evidence: JSON.stringify(two) })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    const both = [...two, { ...evidenceOf(s)[2]!, kind: "asu_registration" }];
    await expect(reconcile(s, { evidence: JSON.stringify(both) })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    const extra = evidenceOf(s).map((e) => ({ ...e, name: "x" }));
    await expect(reconcile(s, { evidence: JSON.stringify(extra) })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
  });

  it("is the PL's only, for an informed participation, once", async () => {
    const s = await signedWithPacket();
    for (const who of [
      seedStaffUserIds.backOffice,
      seedStaffUserIds.consultant,
      seedStaffUserIds.regionalOperationsManager,
    ]) {
      await expect(reconcile(s, { context: as(who) })).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    const assisted = auditContext({
      actorType: "user",
      staffUserId: seedStaffUserIds.projectLead,
      onBehalfOf: s.id,
    });
    await expect(reconcile(s, { context: assisted })).rejects.toMatchObject({ code: "P0001" });
    // Membership lost: the former PL may not.
    await owner.query(
      "delete from project_membership where project_id=$1 and staff_user_id=$2 and role='project_lead'",
      [seedProjectIds.werkNord, seedStaffUserIds.projectLead],
    );
    await expect(reconcile(s)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await owner.query(
      "insert into project_membership(project_id, staff_user_id, role) values ($1,$2,'project_lead')",
      [seedProjectIds.werkNord, seedStaffUserIds.projectLead],
    );
    await reconcile(s);
    await expect(reconcile(s)).rejects.toMatchObject(failsWith("not_informed"));
  });
});

async function reconciled() {
  const s = await signedWithPacket();
  return { s, id: await reconcile(s) };
}
const stepsOf = async (id: string) =>
  (
    await owner.query(
      "select seq, kind, code, source, by from tg_entry_reconciliation_step where reconciliation_id=$1 order by seq",
      [id],
    )
  ).rows;

describe("the review, the reply and the resolution (Q216)", () => {
  it("closes with no objection, once", async () => {
    const { s, id } = await reconciled();
    await review(id, "no_objection");
    expect(await reconciliation(id)).toMatchObject({ stage: "no_objection", revision: 1 });
    await expect(review(id, "no_objection")).rejects.toMatchObject(failsWith("not_awaiting"));
    expect(await events(s.id, "reconciliation_%")).toEqual([
      {
        type: "reconciliation_reviewed",
        details: { reconciliationId: id, outcome: "no_objection" },
        effective_date: null,
        flagged_for_review: false,
      },
    ]);
  });

  it("keeps a clarification open through the reply until the manager resolves it", async () => {
    const { s, id } = await reconciled();
    await review(id, "clarification_requested");
    expect(await reconciliation(id)).toMatchObject({ stage: "clarification_requested" });
    // With the PL now: the manager can't answer until the reply.
    await expect(review(id, "resolved_no_objection")).rejects.toMatchObject(
      failsWith("not_awaiting"),
    );
    await reply(id);
    expect(await reconciliation(id)).toMatchObject({ stage: "replied", revision: 2 });
    await expect(reply(id)).rejects.toMatchObject(failsWith("not_awaiting"));
    await expect(review(id, "no_objection")).rejects.toMatchObject(
      failsWith("outcome_not_allowed"),
    );
    // Asked again, replied again, resolved.
    await review(id, "clarification_requested", { code: "evidence_unclear" });
    await reply(id, { code: "evidence_supplemented" });
    await review(id, "resolved_no_objection");
    expect(await reconciliation(id)).toMatchObject({
      stage: "resolved_no_objection",
      revision: 5,
    });
    expect((await stepsOf(id)).map((r) => [r.seq, r.kind, r.code, r.source])).toEqual([
      [1, "clarification_requested", "date_unclear", "Weisung DSB, Az. 7"],
      [2, "replied", "explained", source],
      [3, "clarification_requested", "evidence_unclear", "Weisung DSB, Az. 7"],
      [4, "replied", "evidence_supplemented", source],
      [5, "resolved_no_objection", null, "Weisung DSB, Az. 7"],
    ]);
    // The audit events carry codes, never a source; the entry is never reversed.
    const audited = await events(s.id, "reconciliation_%");
    expect(audited.map((e) => e.details)).toEqual([
      { reconciliationId: id, outcome: "clarification_requested", reasonCode: "date_unclear" },
      { reconciliationId: id, replyCode: "explained" },
      { reconciliationId: id, outcome: "clarification_requested", reasonCode: "evidence_unclear" },
      { reconciliationId: id, replyCode: "evidence_supplemented" },
      { reconciliationId: id, outcome: "resolved_no_objection" },
    ]);
    expect(JSON.stringify(audited)).not.toMatch(/Akte|Weisung/);
    expect(
      (await owner.query("select status from participation where id=$1", [s.id])).rows[0].status,
    ).toBe("active_in_tg");
  });

  it("keeps an escalation open until it is resolved on the DPO's documented instruction", async () => {
    const { id } = await reconciled();
    await review(id, "clarification_requested");
    await reply(id, { code: "correction_requested" });
    await review(id, "escalated_to_dpo");
    expect(await reconciliation(id)).toMatchObject({ stage: "escalated_to_dpo" });
    await expect(review(id, "clarification_requested")).rejects.toMatchObject(
      failsWith("outcome_not_allowed"),
    );
    await expect(reply(id)).rejects.toMatchObject(failsWith("not_awaiting"));
    await expect(review(id, "resolved_no_objection", { source: null })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await review(id, "resolved_no_objection");
    expect(await reconciliation(id)).toMatchObject({ stage: "resolved_no_objection" });
  });

  it("refuses an outcome that isn't open and the arguments its outcome forbids", async () => {
    const { id } = await reconciled();
    await expect(review(id, "escalated_to_dpo")).rejects.toMatchObject(
      failsWith("outcome_not_allowed"),
    );
    await expect(review(id, "clarification_requested", { code: null })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(review(id, "no_objection", { source: "x" })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(review(id, "clarification_requested", { source: "a\nb" })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(
      review(randomUUID(), "no_objection", { expectedRevision: 0 }),
    ).rejects.toMatchObject(failsWith("reconciliation_not_found"));
  });

  it("compares the revision read under the lock", async () => {
    const { id } = await reconciled();
    await review(id, "clarification_requested");
    await expect(reply(id, { expectedRevision: 0 })).rejects.toMatchObject(
      failsWith("stale_reconciliation"),
    );
    await reply(id);
    await expect(
      review(id, "resolved_no_objection", { expectedRevision: 1 }),
    ).rejects.toMatchObject(failsWith("stale_reconciliation"));
  });

  it("is never the PL who reconciled, even holding both roles (four_eyes)", async () => {
    await owner.query(
      "insert into staff_org_role(staff_user_id, role, region_id) values ($1, 'regional_operations_manager', $2)",
      [seedStaffUserIds.projectLead, seedRegionIds.nord],
    );
    const { id } = await reconciled();
    await expect(review(id, "no_objection", {}, pl)).rejects.toMatchObject(failsWith("four_eyes"));
    await review(id, "no_objection");
  });

  it("is the manager of the project's region only: another role, region or a lost role is refused", async () => {
    const { id } = await reconciled();
    for (const who of [
      seedStaffUserIds.backOffice,
      seedStaffUserIds.admin,
      seedStaffUserIds.regionalAdmin,
    ]) {
      await expect(review(id, "no_objection", {}, as(who))).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    await owner.query("update project set region_id=$2 where id=$1", [
      seedProjectIds.werkNord,
      seedRegionIds.sued,
    ]);
    await expect(review(id, "no_objection")).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await owner.query("update project set region_id=$2 where id=$1", [
      seedProjectIds.werkNord,
      seedRegionIds.nord,
    ]);
    await owner.query("update staff_user set deactivated_at = now() where id=$1", [
      seedStaffUserIds.regionalOperationsManager,
    ]);
    await expect(review(id, "no_objection")).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await owner.query("update staff_user set deactivated_at = null where id=$1", [
      seedStaffUserIds.regionalOperationsManager,
    ]);
    await owner.query("delete from staff_org_role where staff_user_id=$1", [
      seedStaffUserIds.regionalOperationsManager,
    ]);
    await expect(review(id, "no_objection")).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });

  it("takes the reply from a PL of the project only", async () => {
    const { id } = await reconciled();
    await review(id, "clarification_requested");
    for (const who of [
      seedStaffUserIds.backOffice,
      seedStaffUserIds.consultant,
      seedStaffUserIds.regionalOperationsManager,
    ]) {
      await expect(reply(id, {}, as(who))).rejects.toMatchObject(failsWith("actor_not_allowed"));
    }
    await owner.query(
      "delete from project_membership where project_id=$1 and staff_user_id=$2 and role='project_lead'",
      [seedProjectIds.werkNord, seedStaffUserIds.projectLead],
    );
    await expect(reply(id)).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });
});

describe("grants (ADR-0002)", () => {
  it("lets the runtime role read the tables and write them only through the functions", async () => {
    await expect(app.query("select count(*) from tg_entry_reconciliation")).resolves.toBeTruthy();
    await expect(
      app.query("select count(*) from tg_entry_reconciliation_step"),
    ).resolves.toBeTruthy();
    const s = await signedWithPacket();
    await expect(
      app.query(
        `insert into tg_entry_reconciliation(project_id, participation_id, effective_date, evidence, confirmed, reconciled_by)
         values ($1, $2, $3, '[]', true, $4)`,
        [seedProjectIds.werkNord, s.id, s.tgStart, seedStaffUserIds.projectLead],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const id = await reconcile(s);
    await expect(
      app.query("update tg_entry_reconciliation set stage='no_objection' where id=$1", [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query("select record_audit_event($1, $2, 'reconciliation_reviewed', $3::audit_context)", [
        seedProjectIds.werkNord,
        s.id,
        manager,
      ]),
    ).rejects.toMatchObject(failsWith("event_type_reserved"));
  });
});
