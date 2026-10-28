import { sql, type Database } from "@transfer/db";
import { asuStatesOf } from "./asu";
import {
  approvedExceptionFact,
  type DatedFact,
  type EvidenceFact,
  type GuardFacts,
  type ProfilingException,
} from "@transfer/domain";

/** The status service's transaction; providers read in it, after the participation is locked. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The evidence record a profiling-exception request names (Q81, Q94), once it can be validated. */
export type RequestEvidence = { evidence: EvidenceFact; baConfirmation?: DatedFact };

/**
 * Where the dated guard facts come from (plan 5.4). Slices 6 and 7 record the TL 407, ASU, DSV
 * and evidence facts in `dbGuardFacts`; the service stays as it is.
 */
export interface GuardFactsProvider {
  facts(
    tx: Transaction,
    input: { participationId: string; currentRequest: ProfilingException | null },
  ): Promise<GuardFacts>;
  evidence(
    tx: Transaction,
    input: { participationId: string; evidenceRecordId: string },
  ): Promise<RequestEvidence | undefined>;
  /** The facts of many participations in one read (the work list), in the inputs' order. */
  many?(tx: Transaction, inputs: readonly FactsInput[]): Promise<GuardFacts[]>;
}

type FactsInput = Parameters<GuardFactsProvider["facts"]>[1];

/**
 * The facts not recorded yet fail closed (process-and-lifecycle.md, guards): no DSV, ASU,
 * cancellation or TA-completion fact, so their guards fail, nobody enters the TG, and every
 * exception request is refused with `evidence_missing`; `dbGuardFacts` adds the TL 407's and the
 * ASU record's. This
 * is a temporary implementation state, not a rule about whether employment legally exists. The
 * one fact it gives is the participation's own approved exception (decision date and recorded
 * instant): the approval is our record, not evidence.
 */
export const failClosedFacts: GuardFactsProvider = {
  facts: async (_tx, { currentRequest }) => {
    const approved = approvedExceptionFact(currentRequest);
    return approved ? { profilingExceptionApproved: approved } : {};
  },
  evidence: async () => undefined,
};

/** An instant as ISO 8601 UTC text, microseconds kept. */
const utcText = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** The TL 407 facts `tl407_facts` returns for each participation, by its id. */
async function tl407Facts(tx: Transaction, participationIds: readonly string[]) {
  const { rows } = await tx.execute<{
    participation_id: string;
    tl407_signed_on: string;
    tl407_recorded_at: string;
    profiling_done_on: string | null;
    profiling_done_recorded_at: string | null;
  }>(sql`select participation_id, tl407_signed_on::text,
      ${utcText("tl407_recorded_at")} as tl407_recorded_at, profiling_done_on::text,
      ${utcText("profiling_done_recorded_at")} as profiling_done_recorded_at
    from tl407_facts(${`{${participationIds.join(",")}}`}::uuid[])`);
  const byId = new Map<string, GuardFacts>();
  for (const row of rows) {
    byId.set(row.participation_id, {
      tl407Signed: { validOn: row.tl407_signed_on, recordedAt: new Date(row.tl407_recorded_at) },
      ...(row.profiling_done_on !== null && {
        profilingDone: {
          validOn: row.profiling_done_on,
          recordedAt: new Date(row.profiling_done_recorded_at!),
        },
      }),
    });
  }
  return byId;
}

/**
 * The facts recorded in the database (process-and-lifecycle.md, guards and the snapshot rule):
 * `tl407Signed` and `profilingDone` from `tl407_facts`, which counts only accepted TL 407 scans
 * that are neither quarantined nor invalidated, and `asuRegisteredWithProof` from the ASU record
 * (`asuRegisteredFact`: a usable proof, recorded when the complete registration-with-proof was),
 * each with the database instant its complete fact was recorded at. Everything else stays fail
 * closed until its slice records it (the DSV in Slice 7, the exception evidence in PR 6-7).
 */
export const dbGuardFacts: GuardFactsProvider = {
  facts: async (tx, input) => (await dbGuardFacts.many!(tx, [input]))[0]!,
  evidence: failClosedFacts.evidence,
  many: async (tx, inputs) => {
    const ids = inputs.map((input) => input.participationId);
    const recorded = await tl407Facts(tx, ids);
    const asu = await asuStatesOf(tx, ids);
    const all: GuardFacts[] = [];
    for (const input of inputs) {
      const registered = asu.get(input.participationId)?.fact;
      all.push({
        ...(await failClosedFacts.facts(tx, input)),
        ...recorded.get(input.participationId),
        ...(registered && { asuRegisteredWithProof: registered }),
      });
    }
    return all;
  },
};
