import { addDays, addMonths, compareIsoDates, laterIsoDate } from "../dates";
import type { IsoDate } from "../iso-date";
import type { KugOutcome } from "../lifecycle/enums";

/** Q17: profiling under an approved exception must be completed within one month of entry. */
export const profilingExceptionDeadlineMonths = 1;

/** The participation facts eligibility is derived from (plan 5.3; verify Q74, Q82). */
export type KugEligibilityInput = {
  tgEntryDate: IsoDate | null;
  exitDate: IsoDate | null;
  profilingDoneOn: IsoDate | null;
  /** A refusal (`→ profiling_declined`) before completion. */
  profilingDeclinedOn: IsoDate | null;
  /** The approval date of the profiling exception, if one was approved. */
  exceptionApprovedOn: IsoDate | null;
};

/** A recorded BA or legal determination; `reference` is an id, never free text. */
export type KugDetermination = {
  from: IsoDate;
  to: IsoDate | null;
  outcome: KugOutcome;
  reference: string;
};

export type KugPeriod = {
  from: IsoDate;
  to: IsoDate | null;
  outcome: KugOutcome;
  /** The determination that set this period's outcome. */
  determination?: string;
};

export type KugEligibility = {
  /** Employment in the beE, independent of the periods (Q74). */
  employment: { from: IsoDate; to: IsoDate | null } | null;
  periods: KugPeriod[];
};

const open = "9999-12-31";
const end = (to: IsoDate | null) => to ?? open;

/**
 * Transfer-KuG eligibility per period: `eligible`, `excluded` or `ba_review_required` (Q82).
 * Derived, never stored; anything but `eligible` is blocked from a Transfer-KuG export. The
 * application reports facts and decisions; it doesn't issue a benefit determination.
 */
export function transferKugEligibility(
  input: KugEligibilityInput,
  today: IsoDate,
  determinations: readonly KugDetermination[] = [],
): KugEligibility {
  const entry = input.tgEntryDate;
  if (!entry) return { employment: null, periods: [] };
  const exit = input.exitDate;
  const periods = computedPeriods(entry, input, today)
    .map((p) => (exit && end(p.to) > exit ? { ...p, to: exit } : p))
    .filter((p) => p.from <= end(p.to));
  return {
    employment: { from: entry, to: exit },
    periods: applyDeterminations(periods, determinations),
  };
}

function computedPeriods(entry: IsoDate, input: KugEligibilityInput, today: IsoDate): KugPeriod[] {
  const done = input.profilingDoneOn;
  if (done && done <= entry) return [{ from: entry, to: null, outcome: "eligible" }];
  const review: KugPeriod[] = [{ from: entry, to: null, outcome: "ba_review_required" }];
  // Entry needs profiling or an exception approved by then; anything else is for the BA (D10).
  const approved = input.exceptionApprovedOn;
  if (!approved || approved > entry) return review;

  const deadline = addMonths(entry, profilingExceptionDeadlineMonths);
  if (done) {
    if (done > deadline) return review; // a later completion doesn't clear the miss
    return [
      { from: entry, to: done, outcome: "excluded" },
      { from: addDays(done, 1), to: null, outcome: "eligible" },
    ];
  }
  const declined = input.profilingDeclinedOn;
  // A refusal is anchored at entry, not at the refusal date.
  if ((declined && declined <= deadline) || today <= deadline) {
    return [{ from: entry, to: null, outcome: "excluded" }];
  }
  return review;
}

/** Only a recorded determination may alter a period that needs BA review (Q82). */
function applyDeterminations(
  periods: KugPeriod[],
  determinations: readonly KugDetermination[],
): KugPeriod[] {
  const sorted = determinations.toSorted((a, b) => compareIsoDates(a.from, b.from));
  sorted.reduce<KugDetermination | null>((previous, d) => {
    if (previous && end(previous.to) >= d.from) throw new Error("Overlapping determinations");
    return d;
  }, null);

  return sorted.reduce(
    (current, d) =>
      current.flatMap((p) => (p.outcome === "ba_review_required" ? split(p, d) : [p])),
    periods,
  );
}

function split(p: KugPeriod, d: KugDetermination): KugPeriod[] {
  const pEnd = end(p.to);
  const dEnd = end(d.to);
  if (d.from > pEnd || dEnd < p.from) return [p];
  const middleEnd = dEnd < pEnd ? dEnd : pEnd;
  return [
    ...(p.from < d.from ? [{ ...p, to: addDays(d.from, -1) }] : []),
    {
      from: laterIsoDate(p.from, d.from),
      to: middleEnd === open ? null : middleEnd,
      outcome: d.outcome,
      determination: d.reference,
    },
    ...(dEnd < pEnd ? [{ ...p, from: addDays(dEnd, 1) }] : []),
  ];
}
