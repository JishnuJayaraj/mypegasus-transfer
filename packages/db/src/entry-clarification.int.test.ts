import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedRegionIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  acceptDsvScan,
  auditContext,
  call,
  informedParticipation,
  pendingReconciliation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// process-and-lifecycle.md, the entry clarification: a signed DSV still `informed` after its
// planned TG start has an owned clarification (the PL's pending code, the escalation, the region's
// manager's instruction). Never a status change; closed when the participation leaves `informed`.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const as = (staffUserId: string) => auditContext({ actorType: "user", staffUserId });
const manager = as(seedStaffUserIds.regionalOperationsManager);
const backOffice = as(seedStaffUserIds.backOffice);
const consultant = as(seedStaffUserIds.consultant);
const w1 = seedWaves.find((w) => w.code === "W1")!;
const source = "Akte 12, Vermerk vom 3.4.";

/** A signed DSV (participant only) of an informed participation whose planned start was yesterday. */
async function signedPastStart(options: { packet?: boolean } = {}) {
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
    expectedStatusVersion: (
      await owner.query("select status_version from participation where id=$1", [id])
    ).rows[0].status_version,
  });
  const {
    rows: [{ today, earlier }],
  } = await owner.query(
    "select berlin_today()::text as today, (berlin_today() - 3)::text as earlier",
  );
  const scan = await acceptDsvScan(
    app,
    id,
    options.packet
      ? { participant: earlier, customer: earlier, transfergesellschaft: earlier }
      : { participant: earlier },
  );
  await call(app, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: scan,
    statusVersion: await version(id),
  });
  await owner.query(
    "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 1 where id = $1",
    [id],
  );
  return { id, offer, today: today as string };
}
const version = async (id: string): Promise<number> =>
  (await owner.query("select status_version from participation where id=$1", [id])).rows[0]
    .status_version;
const rows = async (id: string) =>
  (await owner.query("select * from entry_clarification where participation_id=$1", [id])).rows;
const events = async (id: string) =>
  (
    await owner.query(
      "select event_type::text as type, details, actor_staff_user_id from audit_event where participation_id=$1 and event_type::text like 'entry_clarification_%' order by seq",
      [id],
    )
  ).rows;

/** The revision of the participation's unresolved clarification, or 0 while there is none. */
const revisionOf = async (id: string): Promise<number> =>
  (
    await owner.query(
      "select coalesce(max(revision) filter (where stage <> 'instructed'), 0)::int as r from entry_clarification where participation_id = $1",
      [id],
    )
  ).rows[0].r;
const revisionOfCase = async (clarificationId: string): Promise<number> =>
  (await owner.query("select revision from entry_clarification where id = $1", [clarificationId]))
    .rows[0].revision;
const record = async (id: string, v: number, over: Record<string, unknown> = {}) =>
  call<string>(app, "record_entry_clarification", {
    context: pl,
    participationId: id,
    code: "awaiting_asu_proof",
    source,
    statusVersion: v,
    expectedRevision: await revisionOf(id),
    ...over,
  });
const escalate = async (id: string, v: number, context = pl, over: Record<string, unknown> = {}) =>
  call<string>(app, "escalate_entry_clarification", {
    context,
    participationId: id,
    statusVersion: v,
    expectedRevision: await revisionOf(id),
    ...over,
  });
const instruct = async (
  clarificationId: string,
  v: number,
  over: Record<string, unknown> = {},
  fn = "record_clarification_instruction",
) =>
  call<string>(app, fn, {
    context: manager,
    clarificationId,
    code: fn === "record_clarification_instruction" ? "legal_advice_obtained" : "date_unclear",
    source: "Rechtsrat der Kanzlei, Az. 77",
    statusVersion: v,
    expectedRevision:
      "expectedRevision" in over ? undefined : await revisionOfCase(clarificationId),
    ...over,
  });
const ask = (clarificationId: string, v: number, over: Record<string, unknown> = {}) =>
  instruct(clarificationId, v, over, "request_entry_clarification_reply");
const stepsOf = async (id: string) =>
  (
    await owner.query(
      "select seq, kind, code, source from entry_clarification_step where participation_id = $1 order by clarification_id, seq",
      [id],
    )
  ).rows;

describe("record_entry_clarification", () => {
  it("records the PL's pending code with its source; the history gets the code only", async () => {
    const { id } = await signedPastStart();
    const clarification = await record(id, await version(id));
    const [row] = await rows(id);
    expect(row).toMatchObject({
      id: clarification,
      pending_code: "awaiting_asu_proof",
      pending_source: source,
      pending_recorded_by: seedStaffUserIds.projectLead,
      escalated_at: null,
      instruction_code: null,
    });
    const [event, ...rest] = await events(id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      type: "entry_clarification_recorded",
      details: { clarificationId: clarification, pendingCode: "awaiting_asu_proof" },
    });
    // The documented source is `case_internal`: never in an audit event.
    expect(JSON.stringify(event.details)).not.toContain("Akte");
  });

  it("opens the day after the planned start, never on it, and not for another DSV track", async () => {
    const { id } = await signedPastStart();
    await owner.query(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() where id = $1",
      [id],
    );
    await expect(record(id, await version(id))).rejects.toMatchObject(
      failsWith("clarification_not_open"),
    );
    await owner.query(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 1 where id = $1",
      [id],
    );
    await record(id, await version(id));
    expect(await rows(id)).toHaveLength(1);
    const other = await informedParticipation(app, {
      projectId: seedProjectIds.werkNord,
      entryWaveId: w1.id,
    });
    await owner.query(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 1 where id = $1",
      [other],
    );
    await expect(record(other, await version(other))).rejects.toMatchObject(
      failsWith("clarification_not_open"),
    );
  });

  it("is refused against a status version that moved since it was read", async () => {
    const { id } = await signedPastStart();
    const read = await version(id);
    await owner.query("update participation set status_version = status_version + 1 where id=$1", [
      id,
    ]);
    await expect(record(id, read)).rejects.toMatchObject(failsWith("stale_status_version"));
    expect(await rows(id)).toEqual([]);
    expect(await events(id)).toEqual([]);
  });

  it("keeps one row for a second record: it replaces the code, never opens another", async () => {
    const { id } = await signedPastStart();
    const first = await record(id, await version(id));
    const second = await record(id, await version(id), {
      code: "awaiting_legal_advice",
      source: "Anfrage an die Rechtsabteilung",
    });
    expect(second).toBe(first);
    const [row, ...rest] = await rows(id);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      pending_code: "awaiting_legal_advice",
      pending_source: "Anfrage an die Rechtsabteilung",
    });
    expect((await events(id)).map((e) => e.details.pendingCode)).toEqual([
      "awaiting_asu_proof",
      "awaiting_legal_advice",
    ]);
  });

  it("reuses the unresolved case when the planned start moved", async () => {
    const { id } = await signedPastStart();
    const first = await record(id, await version(id));
    await owner.query(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 2 where id = $1",
      [id],
    );
    // Still the same unresolved case: its note is replaced, never a second case beside it.
    expect(await record(id, await version(id))).toBe(first);
    expect(await rows(id)).toHaveLength(1);
  });

  it("opens a second clarification only for a new planned start after an instruction; the first stays", async () => {
    const { id } = await signedPastStart();
    const first = await record(id, await version(id));
    await escalate(id, await version(id));
    await instruct(first, await version(id));
    // The instructed case ended with its planned start: the same start opens nothing new ...
    await expect(record(id, await version(id))).rejects.toMatchObject(
      failsWith("already_instructed"),
    );
    // ... a new start that passes without entry opens a second clarification.
    await owner.query(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 3 where id = $1",
      [id],
    );
    const second = await record(id, await version(id));
    expect(second).not.toBe(first);
    expect(await rows(id)).toHaveLength(2);
  });

  it("refuses a second tab's note against a revision it didn't read, the first record included", async () => {
    const { id } = await signedPastStart();
    const version0 = await version(id);
    // Both tabs read an empty case (revision 0); the first saves, the second is stale.
    await record(id, version0, { expectedRevision: 0 });
    await expect(
      record(id, version0, { expectedRevision: 0, source: "Anderer Vermerk" }),
    ).rejects.toMatchObject(failsWith("stale_clarification"));
    // A tab that read revision 1 saves its replacement; the other tab, still at 1, is stale.
    await record(id, version0, { expectedRevision: 1, source: "Erster Ersatz" });
    await expect(
      record(id, version0, { expectedRevision: 1, source: "Zweiter Ersatz" }),
    ).rejects.toMatchObject(failsWith("stale_clarification"));
    expect((await rows(id))[0]).toMatchObject({ pending_source: "Erster Ersatz", revision: 2 });
    expect((await stepsOf(id)).map((s) => [s.seq, s.kind, s.source])).toEqual([
      [1, "recorded", source],
      [2, "recorded", "Erster Ersatz"],
    ]);
  });

  it.each([
    ["an unknown code", { code: "other" }],
    ["a code of the instruction", { code: "dpo_instruction" }],
    ["no source", { source: null }],
    ["an empty source", { source: "   " }],
    ["a source with a line break", { source: "a\nb" }],
    ["a source over 200 characters", { source: "x".repeat(201) }],
  ])("refuses %s", async (_, over) => {
    const { id } = await signedPastStart();
    await expect(record(id, await version(id), over)).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
  });

  it("normalises the source like every documented source (Q209)", async () => {
    const { id } = await signedPastStart();
    await record(id, await version(id), { source: "  Akte   12 \t Vermerk " });
    expect((await rows(id))[0].pending_source).toBe("Akte 12 Vermerk");
  });

  it("belongs to the PL of the project: no other role, no former member", async () => {
    const { id } = await signedPastStart();
    for (const context of [backOffice, consultant, manager]) {
      await expect(record(id, await version(id), { context })).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    // Assistance on behalf of the participant is no staff act.
    await expect(
      record(id, await version(id), {
        context: auditContext({
          actorType: "user",
          staffUserId: seedStaffUserIds.projectLead,
          onBehalfOf: id,
        }),
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    // Losing the membership loses the right at the function.
    await owner.query("delete from project_membership where project_id=$1 and staff_user_id=$2", [
      seedProjectIds.werkNord,
      seedStaffUserIds.projectLead,
    ]);
    await expect(record(id, await version(id))).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    expect(await rows(id)).toEqual([]);
  });

  it("closes with the status: once the participation left informed nothing more is recorded", async () => {
    const { id } = await signedPastStart({ packet: true });
    await record(id, await version(id));
    const start = (
      await owner.query("select tg_start::text as d from participation where id=$1", [id])
    ).rows[0].d;
    await pendingReconciliation(owner, id, start);
    await call(app, "change_participation_status", {
      id,
      field: "status",
      expectedFrom: "informed",
      to: "active_in_tg",
      context: pl,
      entryKind: "reconciliation",
      effectiveDate: (
        await owner.query("select tg_start::text as d from participation where id=$1", [id])
      ).rows[0].d,
    });
    expect(
      (await owner.query("select entry_clarification_opened_on($1) as day", [id])).rows[0].day,
    ).toBeNull();
    await expect(record(id, await version(id))).rejects.toMatchObject(
      failsWith("clarification_not_open"),
    );
    await expect(escalate(id, await version(id))).rejects.toMatchObject(
      failsWith("clarification_not_open"),
    );
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("escalate_entry_clarification", () => {
  it("needs a documented case, escalates once and stops the PL's re-documenting", async () => {
    const { id } = await signedPastStart();
    await expect(escalate(id, await version(id))).rejects.toMatchObject(
      failsWith("clarification_not_documented"),
    );
    const clarification = await record(id, await version(id), { code: "awaiting_legal_advice" });
    expect(await escalate(id, await version(id))).toBe(clarification);
    const [row] = await rows(id);
    expect(row.escalated_by).toBe(seedStaffUserIds.projectLead);
    await expect(escalate(id, await version(id))).rejects.toMatchObject(
      failsWith("already_escalated"),
    );
    await expect(record(id, await version(id))).rejects.toMatchObject(
      failsWith("clarification_escalated"),
    );
    const last = (await events(id)).at(-1)!;
    expect(last).toMatchObject({
      type: "entry_clarification_escalated",
      details: { clarificationId: clarification, pendingCode: "awaiting_legal_advice" },
    });
  });

  it("is the PL's, against the status version read", async () => {
    const { id } = await signedPastStart();
    await record(id, await version(id));
    await expect(escalate(id, await version(id), manager)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(escalate(id, (await version(id)) + 1)).rejects.toMatchObject(
      failsWith("stale_status_version"),
    );
  });
});

async function escalated() {
  const f = await signedPastStart();
  const clarification = await record(f.id, await version(f.id));
  await escalate(f.id, await version(f.id));
  return { ...f, clarification };
}

describe("record_clarification_instruction", () => {
  it("records the region's manager's instruction; the case stays open and nothing changes", async () => {
    const { id, clarification } = await escalated();
    const before = (
      await owner.query("select status, dsv_status from participation where id=$1", [id])
    ).rows[0];
    expect(await instruct(clarification, await version(id))).toBe(clarification);
    const [row] = await rows(id);
    expect(row).toMatchObject({
      instruction_code: "legal_advice_obtained",
      instruction_source: "Rechtsrat der Kanzlei, Az. 77",
      instruction_by: seedStaffUserIds.regionalOperationsManager,
    });
    expect(
      (await owner.query("select status, dsv_status from participation where id=$1", [id])).rows[0],
    ).toEqual(before);
    expect(
      (await owner.query("select entry_clarification_opened_on($1) as day", [id])).rows[0].day,
    ).not.toBeNull();
    const last = (await events(id)).at(-1)!;
    expect(last).toMatchObject({
      type: "entry_clarification_instructed",
      details: { clarificationId: clarification, instructionCode: "legal_advice_obtained" },
      actor_staff_user_id: seedStaffUserIds.regionalOperationsManager,
    });
    expect(JSON.stringify(last.details)).not.toContain("Rechtsrat");
    await expect(instruct(clarification, await version(id))).rejects.toMatchObject(
      failsWith("already_instructed"),
    );
  });

  it("is never the PL's, nor another role's: the PL who tries is refused", async () => {
    const { id, clarification } = await escalated();
    for (const context of [pl, backOffice, consultant]) {
      await expect(instruct(clarification, await version(id), { context })).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    expect((await rows(id))[0].instruction_code).toBeNull();
  });

  it("is never the person who escalated, even one holding both roles", async () => {
    const { id, clarification } = await escalated();
    await owner.query(
      "insert into staff_org_role (staff_user_id, role, region_id) values ($1, 'regional_operations_manager', $2)",
      [seedStaffUserIds.projectLead, seedRegionIds.nord],
    );
    await expect(instruct(clarification, await version(id), { context: pl })).rejects.toMatchObject(
      failsWith("same_person_instruction"),
    );
  });

  it("belongs to the project's region and to a manager still in the role", async () => {
    const { id, clarification } = await escalated();
    await owner.query("update staff_org_role set region_id = $1 where staff_user_id = $2", [
      seedRegionIds.sued,
      seedStaffUserIds.regionalOperationsManager,
    ]);
    await expect(instruct(clarification, await version(id))).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await owner.query("update staff_org_role set region_id = $1 where staff_user_id = $2", [
      seedRegionIds.nord,
      seedStaffUserIds.regionalOperationsManager,
    ]);
    await owner.query("delete from staff_org_role where staff_user_id = $1", [
      seedStaffUserIds.regionalOperationsManager,
    ]);
    await expect(instruct(clarification, await version(id))).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    expect((await rows(id))[0].instruction_code).toBeNull();
  });

  it("needs the escalation first, a known case, a code of its own and the version read", async () => {
    const f = await signedPastStart();
    const clarification = await record(f.id, await version(f.id));
    await expect(instruct(clarification, await version(f.id))).rejects.toMatchObject(
      failsWith("not_escalated"),
    );
    await escalate(f.id, await version(f.id));
    await expect(instruct(randomUUID(), 0, { expectedRevision: 0 })).rejects.toMatchObject(
      failsWith("clarification_not_found"),
    );
    await expect(
      instruct(clarification, await version(f.id), { code: "awaiting_asu_proof" }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(instruct(clarification, (await version(f.id)) + 1)).rejects.toMatchObject(
      failsWith("stale_status_version"),
    );
  });

  it("stays actionable when a new start moved the planned date; it ends with the status", async () => {
    const { id, clarification } = await escalated();
    await owner.query(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() + 5 where id = $1",
      [id],
    );
    // The participation is still informed: the unresolved escalation can be answered.
    expect(
      (await owner.query("select entry_clarification_opened_on($1) as day", [id])).rows[0].day,
    ).toBeNull();
    expect(await instruct(clarification, await version(id))).toBe(clarification);
    expect((await rows(id))[0].stage).toBe("instructed");
  });

  it("is refused once the participation left informed", async () => {
    const { id, clarification } = await escalated();
    await owner.query("alter table participation disable trigger user");
    try {
      await owner.query(
        "update participation set status = 'contacted', dsv_status = 'not_offered', profiling_status = 'not_started' where id = $1",
        [id],
      );
      await expect(instruct(clarification, await version(id))).rejects.toMatchObject(
        failsWith("clarification_not_open"),
      );
    } finally {
      await owner.query(
        "update participation set status = 'informed', dsv_status = 'dsv_signed' where id = $1",
        [id],
      );
      await owner.query("alter table participation enable trigger user");
    }
  });

  it("is refused against a revision it didn't read", async () => {
    const { id, clarification } = await escalated();
    await expect(
      instruct(clarification, await version(id), {
        expectedRevision: (await revisionOfCase(clarification)) - 1,
      }),
    ).rejects.toMatchObject(failsWith("stale_clarification"));
  });
});

describe("asking the PL again (request_entry_clarification_reply)", () => {
  it("returns the case to the PL, who replies and escalates again; every step stays", async () => {
    const { id, clarification } = await escalated();
    const before = (
      await owner.query("select status, dsv_status from participation where id=$1", [id])
    ).rows[0];
    expect(await ask(clarification, await version(id))).toBe(clarification);
    expect((await rows(id))[0]).toMatchObject({ stage: "returned", escalated_at: null });
    // Back with the PL: they can't escalate the old note, or be answered by the manager.
    await expect(escalate(id, await version(id))).rejects.toMatchObject(
      failsWith("clarification_not_documented"),
    );
    await expect(instruct(clarification, await version(id))).rejects.toMatchObject(
      failsWith("not_escalated"),
    );
    // The reply is a new note; it can be escalated, and the manager continues.
    await record(id, await version(id), {
      code: "awaiting_legal_advice",
      source: "Antwort der PL",
    });
    expect((await rows(id))[0].stage).toBe("documented");
    await escalate(id, await version(id));
    await instruct(clarification, await version(id));
    expect((await stepsOf(id)).map((s) => [s.seq, s.kind, s.code])).toEqual([
      [1, "recorded", "awaiting_asu_proof"],
      [2, "escalated", "awaiting_asu_proof"],
      [3, "requested", "date_unclear"],
      [4, "recorded", "awaiting_legal_advice"],
      [5, "escalated", "awaiting_legal_advice"],
      [6, "instructed", "legal_advice_obtained"],
    ]);
    expect((await events(id)).map((e) => e.type)).toEqual([
      "entry_clarification_recorded",
      "entry_clarification_escalated",
      "entry_clarification_requested",
      "entry_clarification_recorded",
      "entry_clarification_escalated",
      "entry_clarification_instructed",
    ]);
    // The status never moved.
    expect(
      (await owner.query("select status, dsv_status from participation where id=$1", [id])).rows[0],
    ).toEqual(before);
    // The source of the request is in the steps, never in an event.
    expect(JSON.stringify((await events(id))[2]!.details)).not.toContain("Rechtsrat");
  });

  it("is the region's manager's, never the PL's nor the person who escalated, and once per escalation", async () => {
    const { id, clarification } = await escalated();
    for (const context of [pl, backOffice, consultant]) {
      await expect(ask(clarification, await version(id), { context })).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    await owner.query(
      "insert into staff_org_role (staff_user_id, role, region_id) values ($1, 'regional_operations_manager', $2)",
      [seedStaffUserIds.projectLead, seedRegionIds.nord],
    );
    await expect(ask(clarification, await version(id), { context: pl })).rejects.toMatchObject(
      failsWith("same_person_instruction"),
    );
    await ask(clarification, await version(id));
    await expect(ask(clarification, await version(id))).rejects.toMatchObject(
      failsWith("not_escalated"),
    );
  });

  it("takes only its own codes, a source and the revision read", async () => {
    const { id, clarification } = await escalated();
    await expect(
      ask(clarification, await version(id), { code: "legal_advice_obtained" }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(ask(clarification, await version(id), { source: "  " })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(
      ask(clarification, await version(id), {
        expectedRevision: (await revisionOfCase(clarification)) + 1,
      }),
    ).rejects.toMatchObject(failsWith("stale_clarification"));
  });
});

describe("escalating the note the PL saw", () => {
  it("refuses an escalation of a note another tab replaced meanwhile", async () => {
    const { id } = await signedPastStart();
    await record(id, await version(id));
    const seen = await revisionOf(id);
    // Another tab replaces the note after this PL read it.
    await record(id, await version(id), { source: "Ersetzt" });
    await expect(
      escalate(id, await version(id), pl, { expectedRevision: seen }),
    ).rejects.toMatchObject(failsWith("stale_clarification"));
    expect((await rows(id))[0].stage).toBe("documented");
    await escalate(id, await version(id));
    expect((await stepsOf(id)).at(-1)).toMatchObject({ kind: "escalated", source: "Ersetzt" });
  });
});

describe("the table", () => {
  it("is read, never written, by transfer_app", async () => {
    const { id } = await signedPastStart();
    await record(id, await version(id));
    expect((await app.query("select count(*)::int as n from entry_clarification")).rows[0].n).toBe(
      1,
    );
    await expect(
      app.query("update entry_clarification set pending_code = 'awaiting_profiling'"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("delete from entry_clarification")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      app.query(
        "insert into entry_clarification (project_id, participation_id, opened_on) values ($1,$2,'2027-01-01')",
        [seedProjectIds.werkNord, id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps each step behind the one before it", async () => {
    const { id } = await signedPastStart();
    await record(id, await version(id));
    await expect(
      owner.query(
        "update entry_clarification set instruction_code='dpo_instruction', instruction_source='x', instruction_at=now(), instruction_by=$1",
        [seedStaffUserIds.regionalOperationsManager],
      ),
    ).rejects.toMatchObject({ constraint: "entry_clarification_steps" });
  });

  it("is refused to record_audit_event, which cannot write the clarification events", async () => {
    const { id } = await signedPastStart();
    for (const type of [
      "entry_clarification_recorded",
      "entry_clarification_escalated",
      "entry_clarification_instructed",
    ]) {
      await expect(
        call(app, "record_audit_event", {
          projectId: seedProjectIds.werkNord,
          participationId: id,
          eventType: type,
          context: pl,
        }),
      ).rejects.toMatchObject(failsWith("event_type_reserved"));
    }
  });

  it("needs a participation for its events", async () => {
    await expect(
      owner.query(
        `insert into audit_event (project_id, participation_id, event_type, actor_type, system_job, details)
         values ($1, null, 'entry_clarification_recorded', 'system', 'test', '{}')`,
        [seedProjectIds.werkNord],
      ),
    ).rejects.toMatchObject({ constraint: "audit_event_lifecycle_has_participation" });
  });
});
