# PR #97 — Slice 6, PR 6-4b review and the Q202 decisions

Reviewed 2026-10-29. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/97>.
Head: `56c70b3`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

### Standards

1. **P2 — Export errors revealed invisible document state.** After a consultant's assignment was
   removed, requesting a form's export answered 403; quarantining that form changed the answer to
   422. Both must be 404 for an invisible case: check visibility before exposing permissions or
   state.
2. **P2 — `/export-content/` got the SPA's CSP** instead of `default-src 'none'; sandbox`. Extend
   the existing download-header policy to exports.

### Spec

1. **P2 — Older paper could undo a recorded withdrawal.** Accepting a Monday paper, recording a
   withdrawal received on Wednesday and accepting another scan of Monday's paper made the
   declaration current again. The order of acceptance must not override the chronology of
   signatures and withdrawals. Preserve older evidence historically; a renewed current state needs
   later supporting paper.
2. **P2 — Quarantining an accepted wrong-person scan** removed the signed outcome, but
   `profileAccess` stayed current. Exclude unusable supporting documents from that projection,
   keeping the history and actual withdrawal follow-ups.
3. **P2 — Changing the project's customer between the render and the record** still answered 201
   with the old employer printed. Include the printed value in the atomic source comparison; the
   answer is `409 source_changed`.

## Q202 decisions

- Accept the purpose-bound PL read (1), the checklist without a separate readiness step (2), the
  separate offer tables (6), the withdrawal and BA notice after the end (5), session-bound exports
  (7) and back office's summaries (8).
- Accept the proposed decline workflow (3), on a route other than `kug_200b`.
- Amend declaration 17's supersession (4) as Spec finding 1 requires.
- Q185's legal and DPO verification stays open.
