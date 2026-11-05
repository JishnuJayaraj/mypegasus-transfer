# PR #103 — Slice 6, PR 6-8 review and the Q209 decisions

Reviewed 2026-11-05. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/103>.
Head: `31887ab`. This records the product owner's decisions as given; the fixes and docs follow
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

1. **P2 — Replacement BA tasks rejected truthful historical dates.** The original task was created
   three days ago, the report sent yesterday, the correction approved today: recording
   yesterday's actual sent date on the replacement returned `422 date_before_task`. Fix: inherit
   the original reporting obligation's date boundary while keeping the replacement's actual
   creation timestamp, through repeated corrections too.
2. **P2 — "Nachweis ungültig" disappeared before recovery was complete.** Three reproduced cases
   cleared the warning although guard facts were missing: a new ASU registration without proof;
   an accepted replacement proof that stays unlinked; a TL 407 signed after the retained
   `profilingDoneOn`. Fix: clear the warning only when replacement evidence actually supports
   the relevant fact, its linkage and its effective date; otherwise keep it unresolved, without
   changing historical statuses or inventing dates.
3. **P3 (nonblocking) — The Kug 200b correction dialog offered date supersession**, which SQL then
   rejects. Show only the permitted invalidation.

## Q209 decisions

- Accept the linked replacement tasks, the restricted approver visibility, the explicit
  wrong-person handling, closed-case corrections, target-specific retention and the preservation
  of legacy invalidations.
- Accept date-only ASU supersession where its proof supports the corrected date.
- Amend (7), the recovery rule, as in finding 2.
- Batch-date corrections remain with Q204.
