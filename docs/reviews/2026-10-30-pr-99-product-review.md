# PR #99 — Slice 6, PR 6-5a-2 review and the Q205 decisions

Reviewed 2026-10-30. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/99>.
Head: `e8e141e`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

### Spec

1. **P2 — Saving the header can overwrite another PL's changes.** Reproduced: PL A edits only the
   T-Kug-Nummer; a background refresh receives PL B's changed Betriebsnummer; PL A saves, and the
   request also sends the old, untouched Betriebsnummer, overwriting B's change. Preserve the
   draft's original baseline and dirty fields; never submit an untouched field merely because
   refreshed server data differs.

## Q205 decisions

- Amend (4): "ist beigefügt" must describe the actual packet. Reproduced: a batch containing scan
  A, followed by a withdrawal and a renewed declaration B; the cover said the current declaration
  was attached, but the scans PDF contained only A. Either include the supporting paper or leave
  the attachment undecided with an actionable checklist entry; apply this to both list formats.
- Accept the blank last-activity fields, the common info-event date, the effective TG period, the
  whole-field handwriting fallback, the prefix-free T-Kug-Nummer and the logged RV reads.
- Accept rows numbered 1–6 per copy. Adding batch/copy identification is a useful nonblocking
  follow-up.
- Accept the 6 pt floor for implementation: the owner inspected the representative filled official
  PDF and rendered the alternative list through CI's exact Gotenberg image; the tested names
  remained readable.
