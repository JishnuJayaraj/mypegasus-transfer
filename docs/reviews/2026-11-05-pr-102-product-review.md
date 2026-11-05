# PR #102 — Slice 6, PR 6-7 review and the Q208 decisions

Reviewed 2026-11-05. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/102>.
Head: `7e6d517`. This records the product owner's decisions as given; the docs and fixes follow
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Q208 decisions

- Accept: the opaque, immutable evidence record id in place of an exposed fingerprint (1); the
  narrowly limited PL metadata (4); the regional queue scope (9); the recording roles (8); the
  minimal audit event (10); the synthetic seed dates (12).
- Accept the Agentur choices (6), **enforced server-side too**: an Agentur outside the
  participation's choices (the catalog's and the project's) is refused (`422 agentur_unknown`),
  not only absent from the dropdown.
- Amend (2), quarantine and restoration: an approved exception's fact is **withheld while its
  evidence is unusable** and restored no earlier than the quarantine's lift (valid and recorded
  from it); the approval's history and past snapshots stay.
- Amend (3), revocation: the dialog captures the request id and the status it was opened for; a
  replacement request or a newly decided status is never adopted silently (`409`).
- Amend (5), PL recovery: the PL's quarantine, its lift and the deletion before the review are
  authorised independently of a read right, with file access still restricted, and are offered
  on the tab "Profiling".

## Findings

- P2 (standards): existing seeded databases couldn't upgrade: 0085's foreign key failed on the
  requests recorded before evidence records existed (`23503`). An explicit, tested path; legacy
  references must not count as verified evidence.
- P2 (spec): quarantined evidence still supported an existing approval in the guard facts, and
  after the lift kept the original recording instant.
- P2 (spec): the PL's quarantine and deletion answered `404`: the document service required a read
  right before checking those separately granted operations.
- P2 (spec): a revocation dialog could revoke a different request after a refresh.
- CI: the Node 24 coverage run timed out in the existing self-service re-import test.
