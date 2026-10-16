import type { Database } from "@transfer/db";
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
 * Where the dated guard facts come from (plan 5.4). Slices 4b, 6 and 7 record the DSV, ASU,
 * TL 407 and evidence facts and replace this provider; the service stays as it is.
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
}

/**
 * Slice 1 fails closed (D4): no DSV, ASU, profiling, TL 407, cancellation or TA-completion fact
 * is recorded yet, so their guards fail, nobody enters the TG, and every exception request is
 * refused with `evidence_missing` (round 16). This is a temporary implementation state, not a
 * rule about whether employment legally exists. The one fact it gives is the participation's
 * own approved exception (decision date and recorded instant): the approval is our record, not
 * evidence.
 */
export const failClosedFacts: GuardFactsProvider = {
  facts: async (_tx, { currentRequest }) => {
    const approved = approvedExceptionFact(currentRequest);
    return approved ? { profilingExceptionApproved: approved } : {};
  },
  evidence: async () => undefined,
};
