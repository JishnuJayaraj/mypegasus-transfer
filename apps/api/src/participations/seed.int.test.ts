import { createDb, seedProjectIds, seedWaves } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  DsvStatus,
  LifecycleFlag,
  MainStatus,
  ProfilingExceptionStatus,
  ProfilingStatus,
  lifecycleFlags,
  projectFlags,
  type EntryWave,
  type ParticipationSnapshot,
} from "@transfer/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedActivations, seedTemplatePins } from "../projects/seed";
import { loadRelease } from "../projects/template-pins";
import { failClosedFacts } from "./guard-facts";
import { seedFacts, seedParticipationIds, seedParticipations, seedTgStartRun } from "./seed";

// AC-43: seeded participations exist only through the service and its functions, each with its
// audit trail; synthetic only (fixed UUIDs, no names).
const db = createDb(testDatabaseUrls().app);
const owner = createDb(testDatabaseUrls().owner).$client;
const ids = Object.values(seedParticipationIds);

let firstRun = 0;
let secondRun = 0;
beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  // As `pnpm db:seed` does: pins and activations through their services first (plan 5.5).
  const release = loadRelease(undefined);
  await seedTemplatePins(db, release);
  await seedActivations(db, release);
  firstRun = await seedParticipations(db);
  secondRun = await seedParticipations(db);
});
afterAll(() => Promise.all([db.$client.end(), owner.end()]));

type Row = {
  id: string;
  project_id: string;
  status: string;
  profiling_status: string;
  dsv_status: string;
  exception_status: string | null;
  end_reason: string | null;
  end_reason_secondary: string;
  entry_wave_id: string | null;
  tg_start: string | null;
  tg_end: string | null;
  offer_deadline: string | null;
  tg_entry_date: string | null;
};

async function rows(): Promise<Row[]> {
  const result = await owner.query(
    `select p.id, p.project_id, p.status, p.profiling_status, p.dsv_status, r.status as exception_status,
       p.end_reason, p.end_reason_secondary::text, p.entry_wave_id, p.tg_start::text,
       p.tg_end::text, p.offer_deadline::text, p.tg_entry_date::text
     from participation p left join profiling_exception_request r on r.id = p.profiling_exception_request_id
     order by p.id`,
  );
  return result.rows;
}

describe("the participation seed (AC-43)", () => {
  it("creates every scenario once and is idempotent", async () => {
    expect([firstRun, secondRun]).toEqual([ids.length, 0]);
    expect((await rows()).map((r) => r.id)).toEqual(ids.toSorted());
  });

  it("covers every main status reachable before Slice 4c, each track status and exception state", async () => {
    const seeded = await rows();
    const statuses = (key: keyof Row) => new Set(seeded.map((r) => r[key] ?? "none"));
    // self_registered and rejected come with the anonymous QR flow (Slice 4c).
    expect(statuses("status")).toEqual(
      new Set(MainStatus.options.filter((s) => s !== "self_registered" && s !== "rejected")),
    );
    expect(statuses("profiling_status")).toEqual(new Set(ProfilingStatus.options));
    expect(statuses("dsv_status")).toEqual(new Set(DsvStatus.options));
    expect(statuses("exception_status")).toEqual(new Set(ProfilingExceptionStatus.options));
    expect(seeded.filter((r) => r.project_id === seedProjectIds.verwaltung)).toHaveLength(3);
  });

  it("gives every participation an audit trail that replays to its stored statuses", async () => {
    const { rows: events } = await owner.query(
      `select participation_id, event_type, field, from_value, to_value, actor_type, system_job
       from audit_event where participation_id is not null order by seq`,
    );
    for (const row of await rows()) {
      const trail = events.filter((e) => e.participation_id === row.id);
      expect(trail[0]).toMatchObject({ event_type: "participation_created", to_value: "imported" });
      const replayed: Record<string, string> = {
        status: "imported",
        profiling_status: "not_started",
        dsv_status: "not_offered",
      };
      for (const event of trail.filter((e) => e.event_type === "status_changed")) {
        expect(event.from_value).toBe(replayed[event.field]);
        replayed[event.field] = event.to_value;
      }
      expect(replayed).toEqual({
        status: row.status,
        profiling_status: row.profiling_status,
        dsv_status: row.dsv_status,
      });
      // System steps are the seed's, never a bypass of a user edge (Q95).
      for (const event of trail.filter((e) => e.actor_type === "system")) {
        expect(["seed", "lifecycle.supersede-stale-exception"]).toContain(event.system_job);
      }
    }
  });

  it("produces every lifecycle flag on the scenario's dates, and the project flag", async () => {
    const waves: EntryWave[] = seedWaves.map(({ projectId: _projectId, name: _name, ...w }) => w);
    const werkNord = { type: "ta_tg" as const, waves };
    const flags = new Set<string>();
    for (const row of (await rows()).filter((r) => r.project_id === seedProjectIds.werkNord)) {
      const { rows: requests } = await owner.query(
        `select r.status, r.reason_code as reason, r.evidence_record_id as "evidenceRecordId",
           r.evidence_fingerprint as "evidenceFingerprint", r.requested_by as "requestedBy",
           r.decided_by as "decidedBy", r.decided_on::text as "decidedOn", r.decided_at as "decidedAt",
           r.superseded_reason as "supersededBecause"
         from profiling_exception_request r join participation p on p.profiling_exception_request_id = r.id
         where p.id = $1`,
        [row.id],
      );
      const snapshot: ParticipationSnapshot = {
        current: {
          status: row.status as MainStatus,
          profilingStatus: row.profiling_status as ProfilingStatus,
          dsvStatus: row.dsv_status as DsvStatus,
        },
        wave: waves.find((w) => w.id === row.entry_wave_id) ?? null,
        participation: {
          tgStart: row.tg_start,
          tgEnd: row.tg_end,
          offerDeadline: row.offer_deadline,
          tgEntryDate: row.tg_entry_date,
        },
        facts: await failClosedFacts.facts(null as never, {
          participationId: row.id,
          currentRequest: requests[0] ?? null,
        }),
      };
      for (const today of ["2091-04-02", "2091-07-05", "2091-07-14", "2091-07-16"]) {
        for (const flag of lifecycleFlags(snapshot, werkNord, today)) flags.add(flag);
      }
    }
    expect(flags).toEqual(new Set(LifecycleFlag.options));
    expect(projectFlags(werkNord)).toEqual([]);
    expect(projectFlags({ type: "ta_tg", waves: [] })).toEqual(["latest_entry_date_missing"]);
  });

  it("reconciles an entry only after an approval before the run and late evidence (round 18)", async () => {
    const { rows: reconciled } = await owner.query(
      `select e.participation_id, e.effective_date::text as tg_start, r.decided_at
       from audit_event e
       join participation p on p.id = e.participation_id
       left join profiling_exception_request r on r.id = p.profiling_exception_request_id
       where e.event_type = 'status_changed' and e.details->>'entryKind' = 'reconciliation'`,
    );
    expect(reconciled.map((r) => r.participation_id).toSorted()).toEqual(
      [
        seedParticipationIds.enteredWithException,
        seedParticipationIds.enteredProfilingDeclined,
      ].toSorted(),
    );
    for (const { participation_id: id, tg_start: tgStart, decided_at: decidedAt } of reconciled) {
      expect(decidedAt.getTime()).toBeLessThanOrEqual(seedTgStartRun.getTime());
      const late = Object.values(seedFacts[id] ?? {}).filter(
        (fact) => fact.validOn <= tgStart && fact.recordedAt > seedTgStartRun,
      );
      expect(late.length).toBeGreaterThan(0);
    }
  });
});
