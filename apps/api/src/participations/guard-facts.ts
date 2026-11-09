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
 * The evidence record a request names (data-protection.md, exception evidence; Q94, Q194): of
 * this participation and still usable (`exception_evidence_usable`), valid from the BA's
 * confirmation date or, for documents, the day it was recorded; a BA confirmation also gives
 * the `ba_confirmed_other` fact. Undefined otherwise (`evidence_missing`). Read after the
 * participation is locked; the request function reads it again.
 */
async function recordedEvidence(
  tx: Transaction,
  { participationId, evidenceRecordId }: { participationId: string; evidenceRecordId: string },
): Promise<RequestEvidence | undefined> {
  const { rows } = await tx.execute<{
    kind: "documents" | "ba_confirmation";
    fingerprint: string;
    valid_on: string;
    recorded_at: string;
    usable: boolean;
  }>(sql`select kind, fingerprint, coalesce(confirmed_on, created_on)::text as valid_on,
      ${utcText("created_at")} as recorded_at, exception_evidence_usable(id) as usable
    from profiling_exception_evidence_record
    where id = ${evidenceRecordId}::uuid and participation_id = ${participationId}::uuid`);
  const row = rows[0];
  if (!row?.usable) return undefined;
  const fact = { validOn: row.valid_on, recordedAt: new Date(row.recorded_at) };
  return {
    evidence: { ...fact, recordId: evidenceRecordId, fingerprint: row.fingerprint },
    ...(row.kind === "ba_confirmation" && { baConfirmation: fact }),
  };
}

/**
 * The approvals' evidence as it stands now (process-and-lifecycle.md, profiling exceptions; the
 * review of PR #102): per evidence record whether it still counts and the latest quarantine lift
 * of its documents. Read once for all approved requests.
 */
async function approvalEvidence(tx: Transaction, recordIds: readonly string[]) {
  const byId = new Map<
    string,
    { usable: boolean; liftedAt: string | null; liftedOn: string | null }
  >();
  if (recordIds.length === 0) return byId;
  const { rows } = await tx.execute<{
    id: string;
    usable: boolean;
    lifted_at: string | null;
    lifted_on: string | null;
  }>(sql`select e.id, exception_evidence_usable(e.id) as usable,
      ${utcText("l.lifted")} as lifted_at,
      (l.lifted at time zone 'Europe/Berlin')::date::text as lifted_on
    from profiling_exception_evidence_record e
    left join lateral (select max(d.quarantine_lifted_at) as lifted from document d
      where d.id = any(e.document_ids)) l on true
    where e.id = any(${`{${recordIds.join(",")}}`}::uuid[])`);
  for (const row of rows) {
    byId.set(row.id, { usable: row.usable, liftedAt: row.lifted_at, liftedOn: row.lifted_on });
  }
  return byId;
}

/**
 * The approved exception as a fact (the review of PR #102): withheld while its evidence doesn't
 * count (a document quarantined, invalidated or deleted, or a record from before the evidence
 * existed), and after a quarantine's lift valid and recorded no earlier than the lift. The request,
 * its decision and the history stay as they are; nothing here changes a past snapshot.
 */
function approvalFact(
  approved: DatedFact | undefined,
  evidence: { usable: boolean; liftedAt: string | null; liftedOn: string | null } | undefined,
): DatedFact | undefined {
  if (!approved || !evidence?.usable) return undefined;
  const liftedAt = evidence.liftedAt === null ? null : new Date(evidence.liftedAt);
  if (liftedAt === null || liftedAt.getTime() <= approved.recordedAt.getTime()) return approved;
  return {
    validOn: evidence.liftedOn! > approved.validOn ? evidence.liftedOn! : approved.validOn,
    recordedAt: liftedAt,
  };
}

/**
 * The facts recorded in the database (process-and-lifecycle.md, guards and the snapshot rule):
 * `tl407Signed` and `profilingDone` from `tl407_facts`, which counts only accepted TL 407 scans
 * that are neither quarantined nor invalidated, and `asuRegisteredWithProof` from the ASU record
 * (`asuRegisteredSince`: a usable proof, recorded when the complete registration-with-proof was),
 * each with the database instant its complete fact was recorded at, a request's evidence record,
 * and the approved exception while its evidence counts (`approvalFact`). The DSV's signature and complete packet come from `dsv_facts`; the cancellation stays fail closed until it is recorded.
 */
export const dbGuardFacts: GuardFactsProvider = {
  facts: async (tx, input) => (await dbGuardFacts.many!(tx, [input]))[0]!,
  evidence: recordedEvidence,
  many: async (tx, inputs) => {
    const ids = inputs.map((input) => input.participationId);
    const recorded = await tl407Facts(tx, ids);
    const asu = await asuStatesOf(tx, ids);
    const { rows: dsv } = await tx.execute<{
      participation_id: string;
      signed_on: string;
      recorded_at: string;
    }>(sql`select distinct on (participation_id) participation_id, signed_on::text,
      ${utcText("recorded_at")} as recorded_at from dsv_facts(${`{${ids.join(",")}}`}::uuid[]) order by participation_id, recorded_at, document_id`);
    const dsvById = new Map(
      dsv.map((row) => [
        row.participation_id,
        { validOn: row.signed_on, recordedAt: new Date(row.recorded_at) },
      ]),
    );
    // The complete packet (D7): `executed_on` is set only for a counting scan of the signed offer
    // showing all three signatures; valid on the latest date, recorded when that scan counted.
    const { rows: packets } = await tx.execute<{
      participation_id: string;
      executed_on: string;
      recorded_at: string;
    }>(sql`select distinct on (participation_id) participation_id, executed_on::text,
      ${utcText("recorded_at")} as recorded_at from dsv_facts(${`{${ids.join(",")}}`}::uuid[])
      where executed_on is not null order by participation_id, recorded_at, document_id`);
    const packetById = new Map(
      packets.map((row) => [
        row.participation_id,
        { validOn: row.executed_on, recordedAt: new Date(row.recorded_at) },
      ]),
    );
    const evidence = await approvalEvidence(
      tx,
      inputs
        .filter((input) => input.currentRequest?.status === "approved")
        .map((input) => input.currentRequest!.evidenceRecordId),
    );
    const all: GuardFacts[] = [];
    for (const input of inputs) {
      const registered = asu.get(input.participationId)?.fact;
      const approved = approvalFact(
        approvedExceptionFact(input.currentRequest),
        input.currentRequest ? evidence.get(input.currentRequest.evidenceRecordId) : undefined,
      );
      all.push({
        ...(approved && { profilingExceptionApproved: approved }),
        ...recorded.get(input.participationId),
        ...(dsvById.has(input.participationId) && {
          dsvScanReceived: dsvById.get(input.participationId)!,
        }),
        ...(packetById.has(input.participationId) && {
          dsvFullyExecuted: packetById.get(input.participationId)!,
        }),
        ...(registered && { asuRegisteredWithProof: registered }),
      });
    }
    return all;
  },
};
