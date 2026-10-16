import { ManualClock } from "@transfer/adapters";
import { createDb, seedProjectIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import type { DatedFact, GuardFacts } from "@transfer/domain";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { failClosedFacts, type GuardFactsProvider } from "./guard-facts";
import { staffSubject } from "./subjects";
import { createStatusService, StatusServiceError, type ServiceActor } from "./status-service";

// AC-19 and the service's checks (plan 5.4): lock → load → permission → domain check →
// function, in one transaction; a refusal writes nothing.
const db = createDb(testDatabaseUrls().app);
const owner = createDb(testDatabaseUrls().owner).$client;
const clock = new ManualClock(new Date("2091-02-01T09:00:00Z")); // Berlin 2091-02-01
const service = createStatusService({ db, clock });

afterAll(() => Promise.all([db.$client.end(), owner.end()]));
beforeEach(async () => {
  await resetTestDatabase({ seed: true });
  clock.set(new Date("2091-02-01T09:00:00Z"));
});

const { werkNord, verwaltung } = seedProjectIds;
const [w1] = seedWaves;
const pl = staffSubject(seedStaffUserIds.projectLead, {
  [werkNord]: ["project_lead"],
  [verwaltung]: ["project_lead"],
});
const backOffice = staffSubject(seedStaffUserIds.backOffice, { [werkNord]: ["back_office"] });
const manager = staffSubject(
  seedStaffUserIds.regionalOperationsManager,
  {},
  { regional_operations_manager: "all" },
);
const consultantFor = (...assigned: string[]) =>
  staffSubject(seedStaffUserIds.consultant, { [werkNord]: ["consultant"] }, {}, assigned);
const system: ServiceActor = { kind: "system", job: "lifecycle.evaluate-project" };

const fact: DatedFact = { validOn: "2091-01-20", recordedAt: new Date("2091-01-20T10:00:00Z") };
const fingerprint = `sha256:v1:${"ab".repeat(32)}`;
/** A provider with recorded facts and evidence, as Slice 4b and later will supply. */
const withFacts = (facts: GuardFacts): GuardFactsProvider => ({
  facts: async (tx, input) => ({ ...(await failClosedFacts.facts(tx, input)), ...facts }),
  evidence: async (_tx, { evidenceRecordId }) => ({
    evidence: { ...fact, recordId: evidenceRecordId, fingerprint },
  }),
});

const refused = (kind: StatusServiceError["kind"], code: string, failedGuards: string[] = []) =>
  expect.objectContaining({ name: "StatusServiceError", kind, code, failedGuards });

async function state(id: string) {
  const { rows } = await owner.query(
    `select p.status, p.profiling_status, p.dsv_status, p.status_version, p.entry_wave_id,
       p.end_reason, p.end_reason_secondary, r.status as exception_status,
       (select count(*)::int from audit_event a where a.participation_id = p.id) as events
     from participation p left join profiling_exception_request r on r.id = p.profiling_exception_request_id
     where p.id = $1`,
    [id],
  );
  return rows[0];
}

/** A completed run, as the owner may record it (the runtime role can't state `completed_at`). */
const run = (job: string, day: string, scheduled: string) =>
  owner.query(
    "insert into job_run (job_name, run_date, scheduled_at, completed_at) values ($1, $2, $3, $3::timestamptz + interval '5 minutes')",
    [job, day, scheduled],
  );

/** A participation of Werk Nord moved to `informed`, optionally in W1. */
async function informed(options: { wave?: boolean } = {}) {
  const { participationId } = await service.createParticipation(pl, {
    projectId: werkNord,
    ...(options.wave && { entryWaveId: w1.id }),
  });
  const consultant = consultantFor(participationId);
  await service.changeStatus(consultant, {
    participationId,
    track: "main",
    from: "imported",
    to: "contacted",
  });
  await service.changeStatus(consultant, {
    participationId,
    track: "main",
    from: "contacted",
    to: "informed",
  });
  return participationId;
}

describe("status changes", () => {
  it("writes the change and its audit event through the function, with the request id", async () => {
    const id = await informed();
    expect(await state(id)).toMatchObject({ status: "informed", status_version: 2, events: 3 });
    const { rows } = await owner.query(
      "select actor_staff_user_id, request_id from audit_event where participation_id = $1 order by seq desc limit 1",
      [id],
    );
    expect(rows[0]).toEqual({ actor_staff_user_id: seedStaffUserIds.consultant, request_id: null });
    const requestId = "6f1c2b6e-1b7a-4c5e-9d1a-2f3b4c5d6e7f";
    await service.changeStatus(
      pl,
      { participationId: id, track: "profiling", from: "not_started", to: "profiling_accepted" },
      { requestId },
    );
    const latest = await owner.query(
      "select request_id from audit_event where participation_id = $1 order by seq desc limit 1",
      [id],
    );
    expect(latest.rows[0].request_id).toBe(requestId);
  });

  it.each([
    ["an unassigned consultant", consultantFor(), "not_assigned"],
    ["back office taking a contact edge", backOffice, "role_not_allowed"],
    ["the system taking a user edge", system, "actor_not_allowed"],
    ["the regional operations manager", manager, "role_not_allowed"],
  ])("refuses %s (mayPerformTransition) and writes nothing", async (_label, actor, because) => {
    const { participationId } = await service.createParticipation(pl, { projectId: werkNord });
    await expect(
      service.changeStatus(actor, {
        participationId,
        track: "main",
        from: "imported",
        to: "contacted",
      }),
    ).rejects.toEqual(refused("forbidden", because));
    expect(await state(participationId)).toMatchObject({
      status: "imported",
      status_version: 0,
      events: 1,
    });
  });

  it("refuses a stale expected status", async () => {
    const id = await informed();
    await expect(
      service.changeStatus(pl, {
        participationId: id,
        track: "main",
        from: "contacted",
        to: "unreachable",
      }),
    ).rejects.toEqual(refused("stale", "stale_status"));
  });

  it("writes nothing when a guard fails (AC-19), and the Slice 1 facts fail closed (D4)", async () => {
    const id = await informed({ wave: true });
    const before = await state(id);
    await expect(
      service.changeStatus(backOffice, {
        participationId: id,
        track: "dsv",
        from: "not_offered",
        to: "dsv_offered",
      }),
    ).rejects.toEqual(refused("domain", "guard_failed", ["dsv_generated"]));
    expect(await state(id)).toEqual(before);
  });

  it("applies a change the guards allow with recorded facts", async () => {
    const id = await informed({ wave: true });
    const withDsv = createStatusService({ db, clock, facts: withFacts({ dsvGenerated: fact }) });
    await withDsv.changeStatus(backOffice, {
      participationId: id,
      track: "dsv",
      from: "not_offered",
      to: "dsv_offered",
    });
    expect(await state(id)).toMatchObject({ dsv_status: "dsv_offered" });
  });

  it("serialises two concurrent changes: one wins, the other gets stale_status (AC-19)", async () => {
    const id = await informed();
    const change = () =>
      service.changeStatus(pl, {
        participationId: id,
        track: "main",
        from: "informed",
        to: "withdrawn",
        endReason: "other",
        effectiveDate: "2091-02-01",
      });
    const results = await Promise.allSettled([change(), change()]);
    expect(results.map((r) => r.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: refused("stale", "stale_status"),
    });
    expect(await state(id)).toMatchObject({ status: "withdrawn", events: 4 });
  });

  it("fixes a TG entry's effective date to the TG start and refuses another one", async () => {
    const id = await informed({ wave: true });
    const facts = {
      dsvGenerated: fact,
      dsvScanReceived: fact,
      dsvFullyExecuted: fact,
      asuRegisteredWithProof: fact,
      profilingDone: fact,
    };
    const entering = createStatusService({ db, clock, facts: withFacts(facts) });
    await entering.changeStatus(backOffice, {
      participationId: id,
      track: "dsv",
      from: "not_offered",
      to: "dsv_offered",
    });
    await entering.changeStatus(backOffice, {
      participationId: id,
      track: "dsv",
      from: "dsv_offered",
      to: "dsv_signed",
    });
    clock.set(new Date("2091-03-02T09:00:00Z"));
    const entry = {
      participationId: id,
      track: "main",
      from: "informed",
      to: "active_in_tg",
      entryKind: "reconciliation",
    } as const;
    await expect(
      entering.changeStatus(pl, { ...entry, effectiveDate: "2091-03-02" }),
    ).rejects.toEqual(refused("domain", "effective_date_mismatch"));
    await entering.changeStatus(pl, entry);
    const { rows } = await owner.query(
      "select tg_entry_date::text from participation where id = $1",
      [id],
    );
    expect(rows[0].tg_entry_date).toBe(w1.defaultTgStart);
  });

  it("allows a reconciliation on the TG start day only after that day's lifecycle run is recorded (round 19)", async () => {
    const id = await informed({ wave: true });
    const facts = {
      dsvGenerated: fact,
      dsvScanReceived: fact,
      dsvFullyExecuted: fact,
      asuRegisteredWithProof: fact,
      profilingDone: fact,
    };
    const entering = createStatusService({ db, clock, facts: withFacts(facts) });
    for (const [from, to] of [
      ["not_offered", "dsv_offered"],
      ["dsv_offered", "dsv_signed"],
    ] as const) {
      await entering.changeStatus(backOffice, { participationId: id, track: "dsv", from, to });
    }
    clock.set(new Date("2091-03-01T09:00:00Z")); // W1's TG start, after the 04:15 run time
    const reconcile = () =>
      entering.changeStatus(pl, {
        participationId: id,
        track: "main",
        from: "informed",
        to: "active_in_tg",
        entryKind: "reconciliation",
      });
    // No row for today: the run isn't complete, whatever a caller believes.
    await expect(reconcile()).rejects.toEqual(refused("domain", "guard_failed", ["tg_start_date"]));
    await run("lifecycle.sweep", "2091-02-28", "2091-02-28T03:15:00Z");
    await run("lifecycle.other", "2091-03-01", "2091-03-01T03:15:00Z");
    await expect(reconcile()).rejects.toEqual(refused("domain", "guard_failed", ["tg_start_date"]));
    expect(await state(id)).toMatchObject({ status: "informed" });
    await run("lifecycle.sweep", "2091-03-01", "2091-03-01T03:15:00Z");
    await reconcile();
    expect(await state(id)).toMatchObject({ status: "active_in_tg" });
  });

  it("lets nobody into the TG with the Slice 1 facts (fail closed, D4)", async () => {
    const id = await informed({ wave: true });
    await expect(
      service.changeStatus(system, {
        participationId: id,
        track: "main",
        from: "informed",
        to: "active_in_tg",
        entryKind: "scheduled_entry",
        scheduledAt: new Date("2091-03-01T03:15:00Z"),
      }),
    ).rejects.toEqual(
      refused("domain", "guard_failed", [
        "dsv_fully_executed",
        "asu_registered_with_proof",
        "profiling_done_or_approved_exception",
        "tg_start_date",
      ]),
    );
  });

  it("maps a refusal of the status function to an integrity error, never a value", async () => {
    const id = await informed();
    await expect(
      service.changeStatus(pl, {
        participationId: id,
        track: "main",
        from: "informed",
        to: "withdrawn",
        endReason: "other",
        secondaryReasons: ["other"],
        effectiveDate: "2091-02-01",
      }),
    ).rejects.toEqual(refused("integrity", "invalid_argument"));
  });

  it("reports an unknown participation as not found", async () => {
    await expect(
      service.changeStatus(pl, {
        participationId: seedProjectIds.werkNord,
        track: "main",
        from: "imported",
        to: "contacted",
      }),
    ).rejects.toEqual(refused("not_found", "participation_not_found"));
  });
});

describe("creation and wave assignment", () => {
  it("lets only the PL create (the creation edge, Q60)", async () => {
    await expect(service.createParticipation(backOffice, { projectId: werkNord })).rejects.toEqual(
      refused("forbidden", "role_not_allowed"),
    );
    await expect(service.createParticipation(system, { projectId: werkNord })).rejects.toEqual(
      refused("forbidden", "actor_not_allowed"),
    );
    const fixed = "00000000-0000-4000-a000-0000000000f1";
    expect(await service.createParticipation(pl, { projectId: werkNord, id: fixed })).toEqual({
      participationId: fixed,
    });
  });

  it("assigns a wave by the domain's rules", async () => {
    const id = await informed();
    await service.assignEntryWave(pl, { participationId: id, waveId: w1.id });
    expect(await state(id)).toMatchObject({ entry_wave_id: w1.id });
    await expect(
      service.assignEntryWave(pl, { participationId: id, waveId: w1.id }),
    ).rejects.toEqual(refused("domain", "wave_unchanged"));
    await expect(
      service.assignEntryWave(pl, {
        participationId: id,
        waveId: "00000000-0000-4000-b000-0000000000ff",
      }),
    ).rejects.toEqual(refused("domain", "wave_of_other_project"));
    await expect(
      service.assignEntryWave(backOffice, { participationId: id, waveId: w1.id }),
    ).rejects.toEqual(refused("forbidden", "role_not_allowed"));
  });
});

describe("profiling exceptions", () => {
  const evidenceRecordId = "00000000-0000-4000-8000-0000000000e1";
  const withEvidence = createStatusService({ db, clock, facts: withFacts({}) });

  it("refuses every request with evidence_missing until Slice 4b validates evidence", async () => {
    const id = await informed({ wave: true });
    await expect(
      service.requestProfilingException(pl, {
        participationId: id,
        reason: "force_majeure",
        evidenceRecordId,
      }),
    ).rejects.toEqual(refused("domain", "evidence_missing"));
    expect(await state(id)).toMatchObject({ exception_status: null, status_version: 2 });
  });

  it("requests, decides by a regional operations manager and returns no fingerprint", async () => {
    const id = await informed({ wave: true });
    const result = await withEvidence.requestProfilingException(pl, {
      participationId: id,
      reason: "agentur_scheduling_unavailable",
      evidenceRecordId,
    });
    expect(Object.keys(result)).toEqual(["requestId"]);
    await expect(
      withEvidence.decideProfilingException(pl, { requestId: result.requestId, approve: true }),
    ).rejects.toEqual(refused("forbidden", "role_not_allowed"));
    await withEvidence.decideProfilingException(manager, {
      requestId: result.requestId,
      approve: true,
    });
    expect(await state(id)).toMatchObject({ exception_status: "approved" });
    await withEvidence.revokeProfilingException(pl, { requestId: result.requestId });
    expect(await state(id)).toMatchObject({ exception_status: "revoked" });
  });

  it("never lets the requester decide, even holding both roles (four eyes)", async () => {
    const id = await informed({ wave: true });
    const both = staffSubject(
      seedStaffUserIds.projectLead,
      { [werkNord]: ["project_lead"] },
      { regional_operations_manager: "all" },
    );
    const { requestId } = await withEvidence.requestProfilingException(both, {
      participationId: id,
      reason: "force_majeure",
      evidenceRecordId,
    });
    await expect(
      withEvidence.decideProfilingException(both, { requestId, approve: true }),
    ).rejects.toEqual(refused("forbidden", "four_eyes"));
  });

  it("supersedes a pending request in the transaction of the change that makes it stale", async () => {
    const id = await informed({ wave: true });
    await withEvidence.requestProfilingException(pl, {
      participationId: id,
      reason: "force_majeure",
      evidenceRecordId,
    });
    await service.changeStatus(consultantFor(id), {
      participationId: id,
      track: "profiling",
      from: "not_started",
      to: "profiling_declined",
    });
    expect(await state(id)).toMatchObject({ exception_status: "superseded" });
  });

  it("refuses an unknown request and one that is no longer current", async () => {
    await expect(
      service.decideProfilingException(manager, { requestId: evidenceRecordId, approve: true }),
    ).rejects.toEqual(refused("not_found", "request_not_found"));
    const id = await informed({ wave: true });
    const first = await withEvidence.requestProfilingException(pl, {
      participationId: id,
      reason: "force_majeure",
      evidenceRecordId,
    });
    await withEvidence.decideProfilingException(manager, {
      requestId: first.requestId,
      approve: false,
    });
    const changed = createStatusService({
      db,
      clock,
      facts: {
        ...withFacts({}),
        evidence: async (_tx, { evidenceRecordId: recordId }) => ({
          evidence: { ...fact, recordId, fingerprint: `sha256:v1:${"cd".repeat(32)}` },
        }),
      },
    });
    await changed.requestProfilingException(pl, {
      participationId: id,
      reason: "force_majeure",
      evidenceRecordId,
    });
    await expect(
      changed.decideProfilingException(manager, { requestId: first.requestId, approve: true }),
    ).rejects.toEqual(refused("stale", "request_not_current"));
  });
});

describe("end-reason correction", () => {
  it("corrects a system-derived reason through the PL (Q72)", async () => {
    const id = await informed();
    // Without a wave the cutoff is the project's final entry date (W2's, 2091-07-15; Q84).
    clock.set(new Date("2091-07-16T09:00:00Z"));
    await service.changeStatus(system, {
      participationId: id,
      track: "main",
      from: "informed",
      to: "withdrawn",
      endReason: "no_response",
      effectiveDate: "2091-07-16",
    });
    await expect(
      service.correctEndReason(consultantFor(id), {
        participationId: id,
        endReason: "placed_direct",
      }),
    ).rejects.toEqual(refused("forbidden", "role_not_allowed"));
    await service.correctEndReason(pl, { participationId: id, endReason: "placed_direct" });
    expect(await state(id)).toMatchObject({
      end_reason: "placed_direct",
      end_reason_secondary: "{no_response}",
    });
    await expect(
      service.correctEndReason(pl, { participationId: id, endReason: "placed_direct" }),
    ).rejects.toEqual(refused("domain", "reason_unchanged"));
  });

  it("refuses a correction without an end reason", async () => {
    const id = await informed();
    await expect(
      service.correctEndReason(pl, { participationId: id, endReason: "other" }),
    ).rejects.toEqual(refused("domain", "no_end_reason"));
  });
});

describe("effective dates (round 18)", () => {
  const facts = {
    dsvGenerated: fact,
    dsvScanReceived: fact,
    dsvFullyExecuted: fact,
    asuRegisteredWithProof: fact,
    profilingDone: fact,
    tl407Signed: fact,
  };
  const dated = createStatusService({ db, clock, facts: withFacts(facts) });
  const offered = async () => {
    const id = await informed({ wave: true });
    await dated.changeStatus(backOffice, {
      participationId: id,
      track: "dsv",
      from: "not_offered",
      to: "dsv_offered",
    });
    return id;
  };

  it("refuses a date on a transition where it means nothing", async () => {
    const id = await informed();
    await expect(
      service.changeStatus(pl, {
        participationId: id,
        track: "profiling",
        from: "not_started",
        to: "profiling_accepted",
        effectiveDate: "2091-02-01",
      }),
    ).rejects.toEqual(refused("domain", "effective_date_not_allowed"));
  });

  it("expires a DSV exactly on the offer deadline + 1, and not before", async () => {
    const id = await offered();
    const expire = (effectiveDate?: string) =>
      dated.changeStatus(system, {
        participationId: id,
        track: "dsv",
        from: "dsv_offered",
        to: "dsv_expired",
        ...(effectiveDate && { effectiveDate }),
      });
    clock.set(new Date("2091-02-16T09:00:00Z")); // W1's signing deadline is 2091-02-15
    await expect(expire()).rejects.toEqual(refused("domain", "effective_date_required"));
    await expect(expire("2091-02-17")).rejects.toEqual(
      refused("domain", "effective_date_mismatch"),
    );
    clock.set(new Date("2091-02-15T09:00:00Z"));
    await expect(expire("2091-02-16")).rejects.toEqual(
      refused("domain", "effective_date_in_future"),
    );
    clock.set(new Date("2091-02-16T09:00:00Z"));
    await expire("2091-02-16");
    expect(await state(id)).toMatchObject({ dsv_status: "dsv_expired" });
  });

  it("withdraws at the cutoff exactly on the applicable cutoff + 1, never in ta_only", async () => {
    const id = await informed({ wave: true });
    const withdraw = (effectiveDate: string) =>
      service.changeStatus(system, {
        participationId: id,
        track: "main",
        from: "informed",
        to: "withdrawn",
        endReason: "no_response",
        effectiveDate,
      });
    clock.set(new Date("2091-03-16T09:00:00Z")); // W1's latest entry date is 2091-03-15
    await expect(withdraw("2091-03-15")).rejects.toEqual(
      refused("domain", "effective_date_mismatch"),
    );
    await withdraw("2091-03-16");

    const { participationId: taOnly } = await service.createParticipation(pl, {
      projectId: verwaltung,
    });
    await expect(
      service.changeStatus(system, {
        participationId: taOnly,
        track: "main",
        from: "imported",
        to: "withdrawn",
        endReason: "no_response",
        effectiveDate: "2091-03-16",
      }),
    ).rejects.toEqual(refused("domain", "effective_date_mismatch"));
  });

  it("lets staff backdate a withdrawal or profiling_done, never future-date it", async () => {
    const id = await informed();
    const withdraw = (effectiveDate?: string) =>
      service.changeStatus(pl, {
        participationId: id,
        track: "main",
        from: "informed",
        to: "withdrawn",
        endReason: "other",
        ...(effectiveDate && { effectiveDate }),
      });
    await expect(withdraw()).rejects.toEqual(refused("domain", "effective_date_required"));
    await expect(withdraw("2091-02-02")).rejects.toEqual(
      refused("domain", "effective_date_in_future"),
    );
    await withdraw("2091-01-15");

    const profiled = await informed();
    const consultant = consultantFor(profiled);
    await dated.changeStatus(consultant, {
      participationId: profiled,
      track: "profiling",
      from: "not_started",
      to: "profiling_accepted",
    });
    await dated.changeStatus(consultant, {
      participationId: profiled,
      track: "profiling",
      from: "profiling_accepted",
      to: "profiling_in_progress",
    });
    const done = {
      participationId: profiled,
      track: "profiling",
      from: "profiling_in_progress",
      to: "profiling_done",
    } as const;
    await expect(
      dated.changeStatus(consultant, { ...done, effectiveDate: "2091-02-02" }),
    ).rejects.toEqual(refused("domain", "effective_date_in_future"));
    await dated.changeStatus(consultant, { ...done, effectiveDate: "2091-01-31" });
  });

  it("records an exit on or after the entry, never in the future", async () => {
    const id = await offered();
    await dated.changeStatus(backOffice, {
      participationId: id,
      track: "dsv",
      from: "dsv_offered",
      to: "dsv_signed",
    });
    clock.set(new Date("2091-03-02T09:00:00Z"));
    await dated.changeStatus(pl, {
      participationId: id,
      track: "main",
      from: "informed",
      to: "active_in_tg",
      entryKind: "reconciliation",
    });
    const exit = (effectiveDate: string) =>
      dated.changeStatus(consultantFor(id), {
        participationId: id,
        track: "main",
        from: "active_in_tg",
        to: "exited",
        endReason: "placed_permanent",
        effectiveDate,
      });
    clock.set(new Date("2091-06-30T09:00:00Z"));
    await expect(exit("2091-02-28")).rejects.toEqual(
      refused("domain", "effective_date_before_entry"),
    );
    await expect(exit("2091-07-01")).rejects.toEqual(refused("domain", "effective_date_in_future"));
    await exit("2091-03-01");
    expect(await state(id)).toMatchObject({ status: "exited" });
  });
});
