# PR #95 — Slice 6, PR 6-4a review and the Q201 decisions

Reviewed 2026-10-28. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/95>.
Head: `0717afc`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

### Standards

- **P2 — Back office received unauthorized proof metadata.** The tab returned the BA
  confirmations' IDs, upload and review dates and quarantine metadata to back office, which has no
  document-read permission on `asu_proof` (reproduced with an accepted, unlinked proof). Omit the
  unauthorized document properties while retaining the permitted ASU case summary; false action
  capabilities do not hide the surrounding data.

### Spec

1. **P2 — Refreshes attached new concurrency tokens to old drafts.** The knowledge-date editor
   sent the latest query's date as `previous` while keeping older editor text; the route editor
   similarly adopted a newer version (both reproduced). Keep each draft paired with its original
   baseline; refresh clean editors and surface conflicts for dirty ones.
2. **P2 — Registration could freeze an unseen route change.** The database function read the
   current route without comparing what the recorder reviewed: opening on `online_self`, changing
   it elsewhere to `in_person`, then submitting succeeded and permanently recorded `in_person`.
   Require the reviewed route version and compare it atomically.
3. **P2 — ASU quarantine and its lift could not be used through the UI.** The proof section
   ignored those capabilities and "Unterlagen" offers no substitute. Add capability-driven
   quarantine and lift controls so staff can suspend a suspect proof at once.

## Q201 decisions

- **1–3:** accept the two tables, the separation of registration and proof and the
  consultant-only proof linking. Add the route freshness protection above.
- **4:** allow the PL to quarantine at once, without granting opening, review or linking rights.
  Permanent correction can remain in 6-8. Keep the normal-mode operations and the deletion before
  review. Reusing `signed` for immutability is acceptable here, provided it introduces no
  wet-signature requirement for a BA confirmation.
- **5:** accept the write-only storage and the provisional input bounds. The number alone is not
  proof; retain the PL's verification source.
- **6:** accept the optional knowledge-date import and the PL's correction, after fixing the
  editor concurrency.
- **7–8:** accept the orientation behaviour, the deferred filters and counts, the tab scope and
  hiding ordinary uploads once a proof is linked. Back office receives only its authorized case
  summary.

The deadline's two-branch shape matches §38(1) SGB III. Keep Q1's verification gate for the
calendar and holiday details and the no-automatic-reminder rule.
