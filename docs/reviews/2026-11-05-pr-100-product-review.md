# PR #100 — Slice 6, PR 6-5b review and the Q206 decisions

Reviewed 2026-11-05. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/100>.
Head: `d0ead13`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

### Spec

1. **P2 — A changed destination can be recorded without the PL reviewing it.** Reproduced: the PL
   views Agentur Ost; the placement changes to West with identical channel and original settings;
   the stale request succeeds with 201 and records West. Send the reviewed Agentur key or a source
   token, compare it under the existing project lock, and return `409 source_changed` before
   writing.

## Q206 decisions

- Amend (4), original reuse: after rejection and resubmission of the same paper, allow the PL to
  confirm that the same Agentur still holds the previously dispatched original. Link that earlier
  dispatch and preserve its actual date. Previously the new attempt demanded another original and
  rejected the earlier date. Don't assume the original was retained automatically.
- Amend (8), escalation age: keep TG start + 14 as the trigger, with immediate re-escalation after
  a late rejection. Display the age of the current unresolved episode. A rejection received today
  should say "seit heute", rather than imply continuous escalation while a submission stood.
- Accept closed-case behavior: no ordinary new submission after closure; historical follow-ups
  remain recordable.
- Accept the exception deadline: no submission deadline until profiling is done, then that
  completion day. The exception's compliance deadline and independent submission escalation still
  apply.
- Accept the remaining scan/date rules, regional access, partial lead-time display and
  registry-check notice, with the destination fix above.

## As fixed in this PR

- The submission names the Agentur the PL reviewed (`agenturKey`); the route compares it with the
  placement under `lock_project_setup` and answers `409 source_changed` before writing.
- `record_original_retained` / `POST /agentur-submissions/{id}/original-retained`: links an
  earlier, rejected attempt of the same scan and Agentur whose original was dispatched, keeping its
  date; offered on the tab ("Original liegt der Agentur vor"), never assumed.
- An escalated TL 407 is dated by its current episode: TG start + 14, or a later rejection that
  reopened it.
