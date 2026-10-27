# PR #91 — Slice 6, PR 6-3b review and the Q200 decisions

Reviewed 2026-10-27. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/91>.
Head: `1c1ce58`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

1. **P1 — Completion could survive without evidence supporting its date.** The facts reader
   accepted any remaining scan without checking its signature dates against `profilingDoneOn`.
   Reproduced: complete effective 17 October on scan A; accept scan B signed 22 October;
   quarantine A. The reader still reported completion on 17 October, which could wrongly satisfy
   the profiling requirement for a TG start between those dates. Derive completion only from
   usable scans signed by the recorded completion date; otherwise withhold the fact, preserving the
   historical status and date for a controlled resolution. Don't move the completion date
   automatically.
2. **P2 — New signed declarations stayed hidden behind the oldest scan.** The profiling projection
   selected the earliest-signature scan for both the guard's evidence and the signed declarations:
   older paper `full`, newer paper `none`, the API still returned `full` (the immutable records were
   stored correctly). Separate the earliest eligibility evidence from the current signed-declaration
   projection; show the latest applicable signed paper, or clearly labelled history, with its source
   document and date.

## Q200 decisions

- **1:** amend with the two fixes above. Completion dates and recording instants must come from
  supporting evidence.
- **2:** accept recording restored evidence from the lift instant; preserve past snapshots.
- **3:** accept the quarantine and lift permissions, rejected-scan immutability and the PL's
  deletion of unreviewed quarantined scans. The approved correction workflow remains required
  before live use.
- **4:** accept service-level guard enforcement. ADR-0002 explicitly places dated guards in
  TypeScript; that architecture, not seed convenience, is the justification. Keep the SQL scan lock
  and the date minimum; no further database guard redesign is requested.
- **5–9:** accept the Berlin-date comparisons, explicit completion dates, the closed-case
  restrictions, null for unmarked declarations, the tab placement, the `422` change and the staged
  invalidation support. Before 6-8 writes invalidation, it must also exclude that evidence from
  completeness and the ordinary opening.
