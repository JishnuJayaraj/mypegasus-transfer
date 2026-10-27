import { createHash } from "node:crypto";
import { ManualClock, scheduledAt } from "@transfer/adapters";
import {
  eq,
  inArray,
  participation,
  profilingExceptionRequest,
  seedProjectIds,
  seedStaffUserIds,
  seedWaves,
  type Database,
} from "@transfer/db";
import type { DatedFact, GuardFacts, IsoDate } from "@transfer/domain";
import { dbGuardFacts, type GuardFactsProvider, type RequestEvidence } from "./guard-facts";
import { createStatusService, type ServiceActor, type StatusService } from "./status-service";
import { staffSubject } from "./subjects";

/**
 * The participation seed (plan 5.10, AC-43; Q95, round 16): synthetic participations, no names,
 * created and moved only through the status service and its functions, so every seeded state has
 * its audit trail. Each staff step is taken by the seeded user the Q60 matrix allows; system
 * steps by `system` with job `seed`. Idempotent by fixed UUIDs: an existing participation is
 * skipped. The service runs with a manual clock on fictional dates in 2091–2092 and a seed facts
 * provider that supplies synthetic dated facts and evidence the guards need (no documents exist
 * before Slices 4b–7); everything else is the production path. The timeline lies far ahead so
 * that the instants the database records (an exception's approval) precede the scheduled runs
 * (round 18); the seed refuses to run once that no longer holds.
 */

const { werkNord, verwaltung } = seedProjectIds;
const [w1, w2] = seedWaves;
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

export const seedParticipationIds = {
  imported: id(1),
  contacted: id(2),
  unreachable: id(3),
  informedNotOffered: id(4),
  informedWithoutWave: id(5),
  offeredExceptionRequested: id(6),
  signedExceptionRejected: id(7),
  signedProfilingDeclined: id(8),
  declinedProfilingDone: id(9),
  expiredWithdrawn: id(10),
  enteredScheduled: id(11),
  enteredWithException: id(12),
  enteredProfilingDeclined: id(13),
  exited: id(14),
  withdrawnCorrected: id(15),
  taOnlyInformed: id(16),
  taOnlyCompleted: id(17),
  taOnlyWithdrawn: id(18),
} as const;
const p = seedParticipationIds;

const allIds = Object.values(p);
const pl = staffSubject(seedStaffUserIds.projectLead, {
  [werkNord]: ["project_lead"],
  [verwaltung]: ["project_lead"],
});
const consultant = staffSubject(
  seedStaffUserIds.consultant,
  { [werkNord]: ["consultant"], [verwaltung]: ["consultant"] },
  {},
  allIds,
);
const backOffice = staffSubject(seedStaffUserIds.backOffice, { [werkNord]: ["back_office"] });
// Projects get their region in Slice 3; until then the seeded reviewer has global scope.
const manager = staffSubject(
  seedStaffUserIds.regionalOperationsManager,
  {},
  { regional_operations_manager: "all" },
);
const system: ServiceActor = { kind: "system", job: "seed" };

const recorded = (validOn: IsoDate): DatedFact => ({
  validOn,
  recordedAt: new Date(`${validOn}T09:00:00Z`),
});
const before = recorded("2091-01-25");
const dsvDocuments = { dsvGenerated: before, dsvScanReceived: before };
const entryFacts = { ...dsvDocuments, dsvFullyExecuted: before, asuRegisteredWithProof: before };
/**
 * Valid before the TG start but recorded after its scheduled run: the late documentary evidence
 * that justifies a reconciliation instead of the scheduled entry (Q68, round 18).
 */
const lateAsu: DatedFact = {
  validOn: "2091-02-20",
  recordedAt: new Date("2091-03-01T12:00:00Z"),
};
const profiled = { tl407Signed: recorded("2091-02-01"), profilingDone: recorded("2091-02-01") };

/** Synthetic evidence: one record per participation, fingerprinted as Slice 4b will (round 17). */
function evidenceFor(participationId: string): RequestEvidence {
  const canonical = `profiling-exception-evidence:v1\n${participationId}\nseed-evidence-digest`;
  return {
    evidence: {
      ...before,
      recordId: participationId.replace("-a000-", "-8000-"),
      fingerprint: `sha256:v1:${createHash("sha256").update(canonical).digest("hex")}`,
    },
  };
}

export const seedFacts: Readonly<Record<string, GuardFacts>> = {
  [p.offeredExceptionRequested]: dsvDocuments,
  [p.signedExceptionRejected]: dsvDocuments,
  [p.signedProfilingDeclined]: dsvDocuments,
  [p.declinedProfilingDone]: { ...dsvDocuments, ...profiled },
  [p.expiredWithdrawn]: dsvDocuments,
  [p.enteredScheduled]: { ...entryFacts, ...profiled },
  [p.enteredWithException]: { ...entryFacts, asuRegisteredWithProof: lateAsu },
  [p.enteredProfilingDeclined]: { ...entryFacts, asuRegisteredWithProof: lateAsu },
  [p.exited]: { ...entryFacts, ...profiled },
  [p.withdrawnCorrected]: dsvDocuments,
  [p.taOnlyCompleted]: { taMeasuresComplete: before },
};

/** The production provider plus the seed's synthetic facts and evidence. */
const seedFactsProvider: GuardFactsProvider = {
  facts: async (tx, input) => ({
    ...(await dbGuardFacts.facts(tx, input)),
    ...seedFacts[input.participationId],
  }),
  evidence: async (_tx, { participationId }) => evidenceFor(participationId),
};

type Step = {
  on: IsoDate;
  at?: string;
  run: (s: StatusService, db: Database) => Promise<unknown>;
};
type Scenario = { id: string; steps: Step[] };

const D1 = "2091-02-01"; // contact, info event, offers, profiling, exception decisions
const D2 = "2091-02-16"; // the day after W1's signing deadline
const TG = "2091-03-01"; // W1's TG start, scheduled run at 04:15 Berlin
/** The scheduled run of W1's TG start (`JOBS_LIFECYCLE_TIME` default). */
export const seedTgStartRun = scheduledAt(TG, "04:15");
const D4 = "2091-03-02"; // reconciliations after the TG start
const CUTOFF = "2091-03-16"; // the day after W1's latest entry date
const EXIT = "2091-07-01";

// Step builders. `on` is the Berlin day the step happens; the clock stands at 10:00 Berlin.
const create = (
  participationId: string,
  projectId: string = werkNord,
  entryWaveId?: string,
): Step => ({
  on: D1,
  run: (s) =>
    s.createParticipation(pl, {
      projectId,
      id: participationId,
      ...(entryWaveId && { entryWaveId }),
    }),
});
const move = (
  actor: ServiceActor,
  participationId: string,
  track: "main" | "profiling" | "dsv",
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
  on: IsoDate = D1,
): Step => ({
  on,
  run: (s) =>
    s.changeStatus(actor, { participationId, track, from, to, ...extra } as Parameters<
      StatusService["changeStatus"]
    >[1]),
});
const informed = (participationId: string): Step[] => [
  move(consultant, participationId, "main", "imported", "contacted"),
  move(consultant, participationId, "main", "contacted", "informed"),
];
const offer = (participationId: string) =>
  move(backOffice, participationId, "dsv", "not_offered", "dsv_offered");
const sign = (participationId: string) =>
  move(backOffice, participationId, "dsv", "dsv_offered", "dsv_signed");
const profiling = (participationId: string, ...path: string[]): Step[] =>
  path.slice(1).map((to, i) => move(consultant, participationId, "profiling", path[i]!, to));
const doneOn = { effectiveDate: D1 };

/** Requests an exception (PL) and lets the regional operations manager decide it. */
function exception(participationId: string, decision?: boolean, revoke = false): Step {
  return {
    on: D1,
    run: async (s) => {
      const { requestId } = await s.requestProfilingException(pl, {
        participationId,
        reason: "agentur_scheduling_unavailable",
        evidenceRecordId: evidenceFor(participationId).evidence.recordId,
      });
      if (decision !== undefined) {
        await s.decideProfilingException(manager, { requestId, approve: decision });
      }
      if (revoke) await s.revokeProfilingException(pl, { requestId });
    },
  };
}

const scheduledEntry = (participationId: string): Step => ({
  on: TG,
  at: "04:20",
  run: (s) =>
    s.changeStatus(system, {
      participationId,
      track: "main",
      from: "informed",
      to: "active_in_tg",
      entryKind: "scheduled_entry",
      scheduledAt: seedTgStartRun,
    }),
});
/**
 * A reconciliation under an approved exception (round 18): only when the exception was approved
 * before the scheduled run (an approval after it can't authorise the entry retroactively) and a
 * documentary fact valid at the TG start was recorded after the run. Checked before the step.
 */
async function assertReconciliationJustified(db: Database, participationId: string) {
  const [row] = await db
    .select({ decidedAt: profilingExceptionRequest.decidedAt })
    .from(participation)
    .innerJoin(
      profilingExceptionRequest,
      eq(profilingExceptionRequest.id, participation.profilingExceptionRequestId),
    )
    .where(eq(participation.id, participationId));
  // Fails closed on a missing or unparsable instant too.
  if (!row?.decidedAt || !(new Date(row.decidedAt).getTime() <= seedTgStartRun.getTime())) {
    throw new Error("Seed: the exception was not approved before the scheduled run");
  }
  const late = Object.values(seedFacts[participationId] ?? {}).some(
    (fact) => fact.validOn <= TG && fact.recordedAt > seedTgStartRun,
  );
  if (!late) throw new Error("Seed: no fact was recorded after the scheduled run");
}

const reconciledEntry = (participationId: string): Step => ({
  on: D4,
  run: async (s, db) => {
    await assertReconciliationJustified(db, participationId);
    return s.changeStatus(pl, {
      participationId,
      track: "main",
      from: "informed",
      to: "active_in_tg",
      entryKind: "reconciliation",
    });
  },
});

const scenarios: Scenario[] = [
  { id: p.imported, steps: [create(p.imported)] },
  {
    id: p.contacted,
    steps: [
      create(p.contacted, werkNord, w2.id),
      move(consultant, p.contacted, "main", "imported", "contacted"),
    ],
  },
  {
    id: p.unreachable,
    steps: [
      create(p.unreachable, werkNord, w2.id),
      move(consultant, p.unreachable, "main", "imported", "contacted"),
      move(consultant, p.unreachable, "main", "contacted", "unreachable"),
    ],
  },
  {
    id: p.informedNotOffered,
    steps: [create(p.informedNotOffered, werkNord, w2.id), ...informed(p.informedNotOffered)],
  },
  {
    id: p.informedWithoutWave,
    steps: [create(p.informedWithoutWave), ...informed(p.informedWithoutWave)],
  },
  {
    id: p.offeredExceptionRequested,
    steps: [
      create(p.offeredExceptionRequested, werkNord, w2.id),
      ...informed(p.offeredExceptionRequested),
      offer(p.offeredExceptionRequested),
      ...profiling(p.offeredExceptionRequested, "not_started", "profiling_accepted"),
      exception(p.offeredExceptionRequested),
    ],
  },
  {
    id: p.signedExceptionRejected,
    steps: [
      create(p.signedExceptionRejected, werkNord, w2.id),
      ...informed(p.signedExceptionRejected),
      offer(p.signedExceptionRejected),
      sign(p.signedExceptionRejected),
      ...profiling(
        p.signedExceptionRejected,
        "not_started",
        "profiling_accepted",
        "profiling_in_progress",
      ),
      exception(p.signedExceptionRejected, false),
    ],
  },
  {
    id: p.signedProfilingDeclined,
    steps: [
      create(p.signedProfilingDeclined, werkNord, w2.id),
      ...informed(p.signedProfilingDeclined),
      offer(p.signedProfilingDeclined),
      sign(p.signedProfilingDeclined),
      exception(p.signedProfilingDeclined),
      // Declining profiling supersedes the pending request (round 10).
      ...profiling(p.signedProfilingDeclined, "not_started", "profiling_declined"),
    ],
  },
  {
    id: p.declinedProfilingDone,
    steps: [
      create(p.declinedProfilingDone, werkNord, w2.id),
      ...informed(p.declinedProfilingDone),
      offer(p.declinedProfilingDone),
      move(backOffice, p.declinedProfilingDone, "dsv", "dsv_offered", "dsv_declined"),
      exception(p.declinedProfilingDone, true, true),
      ...profiling(
        p.declinedProfilingDone,
        "not_started",
        "profiling_accepted",
        "profiling_in_progress",
      ),
      move(
        consultant,
        p.declinedProfilingDone,
        "profiling",
        "profiling_in_progress",
        "profiling_done",
        doneOn,
      ),
    ],
  },
  {
    id: p.expiredWithdrawn,
    steps: [
      create(p.expiredWithdrawn, werkNord, w1.id),
      ...informed(p.expiredWithdrawn),
      offer(p.expiredWithdrawn),
      move(
        system,
        p.expiredWithdrawn,
        "dsv",
        "dsv_offered",
        "dsv_expired",
        { effectiveDate: D2 },
        D2,
      ),
      move(
        system,
        p.expiredWithdrawn,
        "main",
        "informed",
        "withdrawn",
        { endReason: "no_response", effectiveDate: CUTOFF },
        CUTOFF,
      ),
    ],
  },
  ...[p.enteredScheduled, p.exited].map((pid) => ({
    id: pid,
    steps: [
      create(pid, werkNord, w1.id),
      ...informed(pid),
      offer(pid),
      sign(pid),
      ...profiling(pid, "not_started", "profiling_accepted", "profiling_in_progress"),
      move(consultant, pid, "profiling", "profiling_in_progress", "profiling_done", doneOn),
      scheduledEntry(pid),
      ...(pid === p.exited
        ? [
            move(
              consultant,
              pid,
              "main",
              "active_in_tg",
              "exited",
              { endReason: "placed_permanent", effectiveDate: "2091-06-30" },
              EXIT,
            ),
          ]
        : []),
    ],
  })),
  ...[p.enteredWithException, p.enteredProfilingDeclined].map((pid) => ({
    id: pid,
    steps: [
      create(pid, werkNord, w1.id),
      ...informed(pid),
      offer(pid),
      sign(pid),
      exception(pid, true),
      reconciledEntry(pid),
      // After entry under the approved exception, profiling moves on or is declined (Q74).
      ...(pid === p.enteredWithException
        ? profiling(pid, "not_started", "profiling_accepted", "profiling_in_progress")
        : profiling(pid, "not_started", "profiling_declined")
      ).map((step) => ({ ...step, on: D4 })),
    ],
  })),
  {
    id: p.withdrawnCorrected,
    steps: [
      create(p.withdrawnCorrected, werkNord, w1.id),
      ...informed(p.withdrawnCorrected),
      offer(p.withdrawnCorrected),
      move(backOffice, p.withdrawnCorrected, "dsv", "dsv_offered", "dsv_declined"),
      move(
        system,
        p.withdrawnCorrected,
        "main",
        "informed",
        "withdrawn",
        { endReason: "declined_dsv", effectiveDate: CUTOFF },
        CUTOFF,
      ),
      {
        on: CUTOFF,
        run: (s) =>
          s.correctEndReason(pl, {
            participationId: p.withdrawnCorrected,
            endReason: "placed_direct",
          }),
      },
    ],
  },
  {
    id: p.taOnlyInformed,
    steps: [
      create(p.taOnlyInformed, verwaltung),
      ...informed(p.taOnlyInformed),
      ...profiling(p.taOnlyInformed, "not_started", "profiling_accepted"),
    ],
  },
  {
    id: p.taOnlyCompleted,
    steps: [
      create(p.taOnlyCompleted, verwaltung),
      ...informed(p.taOnlyCompleted),
      move(pl, p.taOnlyCompleted, "main", "informed", "ta_completed", { confirmed: true }),
    ],
  },
  {
    id: p.taOnlyWithdrawn,
    steps: [
      create(p.taOnlyWithdrawn, verwaltung),
      move(consultant, p.taOnlyWithdrawn, "main", "imported", "contacted"),
      move(pl, p.taOnlyWithdrawn, "main", "contacted", "withdrawn", {
        endReason: "other_measure",
        effectiveDate: D1,
      }),
    ],
  },
];

/** Berlin 10:00 (or `at`) on `day`, in winter or summer time. */
const atBerlin = (day: IsoDate, at = "10:00") => scheduledAt(day, at);

/**
 * Seeds the participations missing so far, each through its own sequence of service calls.
 * Needs the base seed (staff users, projects, waves). Returns how many it created.
 */
export async function seedParticipations(db: Database): Promise<number> {
  const existing = new Set(
    (
      await db
        .select({ id: participation.id })
        .from(participation)
        .where(inArray(participation.id, allIds))
    ).map((row) => row.id),
  );
  const clock = new ManualClock(atBerlin(D1));
  const service = createStatusService({ db, clock, facts: seedFactsProvider });
  let created = 0;
  for (const scenario of scenarios.filter((s) => !existing.has(s.id))) {
    for (const step of scenario.steps) {
      clock.set(atBerlin(step.on, step.at));
      await step.run(service, db);
    }
    created += 1;
  }
  return created;
}
