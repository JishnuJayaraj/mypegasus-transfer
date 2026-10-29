# PR #98 — Slice 6, PR 6-5a-1 review and the Q203 decisions

Reviewed 2026-10-29. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/98>.
Head: `350c768`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

### Spec

1. **P2 — Closing a participant could break the whole tab "Agentur".** Closing the last
   participant of an Agentur before any batch left their accepted scan, but no settings were read
   for that Agentur, and the tab answered 500. Exclude closed participants before that lookup.
2. **P2 — A quarantined submitted paper still supplied the ASU guard fact.** Submission, then a
   wrong-person quarantine, left `asuRegisteredWithProof` in place. Keep the historical
   registration, but withhold its future guard fact while its only supporting evidence is
   unusable. A lift restores availability from the lift instant; no lifecycle status reverses
   automatically.

## Q203 decisions

- Amend "any route": an explicitly selected route is required before batching. An unset route
  could be submitted without a registration, and selecting `kug_200b` afterwards blocked both a
  direct registration and a new batch (reproduced). Block unresolved routes and explain the next
  action.
- Amend "never resubmit": preventing duplicate initial submissions is accepted for this scope. A
  controlled retransmission path for rejected, returned or unreceived packets is tracked before the
  pilot; they are not permanently impossible.
- Accept the Agentur-scoped alternative, the automatic selection of the first 200, the conditional
  rejection of outdated versions, the PL's confirmation after the end and the confirmation work
  item arriving in 6-5b.
- Accept settings checked at the link's issuance for this internal CSV only, with fresh
  authorization and member checks at the download. The official artifacts of 6-5a-2 need the full
  relevant recheck.
- The registration's retention after a quarantine is accepted with the guard-fact correction
  above.
