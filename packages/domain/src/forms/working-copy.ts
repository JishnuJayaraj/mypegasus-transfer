// When a generated form's file may go (data-protection.md, generated forms; ADR-0008; Q179): the
// unsigned working copy, never the signed scan or the provenance, which stay as the tombstone.
// The periods are proposals awaiting the DPO: the class `form_working_copy` stays `unset`, so no
// job deletes anything before Slice 7's retention job encodes them.

export type WorkingCopyTrigger =
  /** A newer generation of the same form and participation. */
  | "superseded"
  /** Its signed scan was accepted. */
  | "scan_accepted"
  /** A sole unsigned form nobody followed up. */
  | "abandoned"
  /** The participation reached a terminal status. */
  | "participation_closed";

/** The proposed days after each trigger (Q179). */
export const workingCopyDays: Readonly<Record<WorkingCopyTrigger, number>> = {
  superseded: 30,
  scan_accepted: 30,
  abandoned: 90,
  participation_closed: 30,
};

export type WorkingCopyFacts = {
  generatedAt: Date;
  /** When the next generation of the form was recorded, if any. */
  supersededAt: Date | null;
  /** When a signed scan printed from it was accepted, if any. */
  scanAcceptedAt: Date | null;
  /** When the participation became terminal, if it is. */
  closedAt: Date | null;
  legalHold: boolean;
};

export type WorkingCopyExpiry =
  | { kind: "held" }
  | { kind: "due"; trigger: WorkingCopyTrigger; from: Date; afterDays: number };

const day = 24 * 60 * 60 * 1000;

/**
 * The earliest deletion a working copy's facts give (data-protection.md, generated forms): 30
 * days after supersession, an accepted scan or the terminal status, 90 days after an abandoned
 * generation; a legal hold suspends each. Every working copy has one, so none stays forever.
 */
export function workingCopyExpiry(facts: WorkingCopyFacts): WorkingCopyExpiry {
  if (facts.legalHold) return { kind: "held" };
  const candidates: [WorkingCopyTrigger, Date | null][] = [
    ["superseded", facts.supersededAt],
    ["scan_accepted", facts.scanAcceptedAt],
    ["participation_closed", facts.closedAt],
    ["abandoned", facts.generatedAt],
  ];
  let best: { trigger: WorkingCopyTrigger; from: Date; afterDays: number } | null = null;
  for (const [trigger, from] of candidates) {
    if (from === null) continue;
    const afterDays = workingCopyDays[trigger];
    const due = from.getTime() + afterDays * day;
    if (best === null || due < best.from.getTime() + best.afterDays * day) {
      best = { trigger, from, afterDays };
    }
  }
  return { kind: "due", ...best! };
}
