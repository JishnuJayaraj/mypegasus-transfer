# PR #101 — Slice 6, PR 6-6 review and the Q207 decisions

Reviewed 2026-11-05. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/101>.
Head: `a48f717`. This records the product owner's decisions as given; the docs follow in the same
PR. This does not constitute external DPO, legal, works-council or Agentur confirmation.

## Q207 decisions

- Accept (1)–(4): reuse the existing columns (`status` is the outcome, `reported_on` the sent
  date); the task's Berlin creation day is the date boundary; a closed participation's tasks stay
  closable and on the work list; pending reports are grouped under "Agentur".
- Accept (5): `channel` and `reference` stay unset. "Gemeldet am" records staff's confirmation
  that the report was sent; it does not establish delivery or the Agentur's acceptance.
- Accept (6) for this PR, with a firm requirement for 6-8: a correction must invalidate an older
  open confirmation dialog. Reopening the same task requires a revision check (a stale outcome is
  refused); creating a linked replacement task also works. 6-8 includes that regression.
- Accept (7)–(8): `created_in_error` closes an erroneous pending task; a recorded outcome changes
  only through an approved correction. Only the PL or back office act, as themselves.
