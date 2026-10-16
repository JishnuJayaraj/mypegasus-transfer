import type { TransitionContext } from "../transition";
import type { EntryWave } from "../waves";

/** Test fixtures (synthetic). Excluded from coverage and from the no-direct-time scan. */
export const wave: EntryWave = {
  id: "wave-1",
  code: "W1",
  signingDeadline: "2027-03-15",
  defaultTgStart: "2027-04-01",
  defaultTgEnd: "2028-03-31",
  latestEntryDate: "2027-04-30",
};

/** An `informed` participation of a `ta_tg` project, acted on by staff on 2027-03-01. */
export function context(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    projectType: "ta_tg",
    current: { status: "informed", profilingStatus: "not_started", dsvStatus: "not_offered" },
    actor: { type: "user", staffUserId: "staff-1" },
    today: "2027-03-01",
    wave,
    participation: { tgStart: null, offerDeadline: null },
    facts: {},
    ...overrides,
  };
}
