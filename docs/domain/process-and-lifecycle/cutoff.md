# Process & lifecycle: cutoff

### System withdrawal at the final admission cutoff *(Q50, Q53, Q70; timing provisional, Q77)*

At the cutoff (the Berlin day after the wave's `latestEntryDate`), a nightly job with the
`system` actor moves participations to `withdrawn` when they can no longer reach the TG,
evaluated against **the participation's entry wave**. Without a `latestEntryDate`, the cases are
flagged and nothing moves or is deleted automatically (Q70, Q77).

**Participations without a wave** (Q84): the cutoff is the project's **final entry date** (the
latest `latestEntryDate` across all waves); on the next Berlin day `imported` → `never_contacted`,
`contacted` → `not_informed`, `unreachable` → `no_response`, with the same project-level warning
and reminder. Once a participation is assigned to a wave, that wave's cutoff applies. An
`informed` participation without a wave/DSV offer stays a flagged exception and is not withdrawn
automatically.

- **Warning** (Q78): from 14 calendar days before the cutoff, persistent until resolved, plus a
  final reminder 3 days before; a wave activated fewer than 14 days before is warned
  immediately. The warning is informational: at the cutoff the withdrawal runs.
- The withdrawal date `withdrawnOn` starts the non-signer deletion clock (Q77; period
  `assumed`).

| Precedence | Situation | Withdrawal reason |
|---|---|---|
| 1 | `dsvStatus = dsv_declined` | `declined_dsv` — the decision against the TG itself |
| 2 | `profilingStatus = profiling_declined` (and DSV not signed) | `declined_profiling` (no Transfer-KuG at all, reported separately) |
| 3 | `dsvStatus = dsv_expired`, or main status `unreachable` | `no_response` |
| — | main status `imported` | `never_contacted` |
| — | main status `contacted` | `not_informed` |

- Explicit decisions rank above silence (Q56). The highest-ranking reason is stored as the
  **primary reason**. All other applicable reasons are stored as a **secondary list**, so
  nothing is lost in the audit log.
- A reason chosen **manually by the PL** (e.g. `placed_direct`, `retirement`) always overrides
  the derived one. After a system withdrawal, the PL corrects the primary reason through a
  dedicated, audited **correction** that doesn't reopen the terminal status; the system-derived
  reason moves to the secondary list (Q72). An erroneous reason a PL chose earlier stays only in
  the audit history, unless the PL confirms it also applies; correcting to the same reason is
  refused (round 10).
- **Conflict:** `dsvStatus = dsv_signed` **and** `profilingStatus = profiling_declined`. The
  person can't enter the beE, but the DSV is signed. The system **does not resolve this
  automatically**. It flags the conflict to the PL for manual clarification.
- Participations in `informed` whose DSV was never offered (`not_offered`) at the cutoff are
  flagged to the PL, not withdrawn automatically.
- `declined_profiling`, `declined_dsv`, `no_response`, `never_contacted` and `not_informed`
  exist only as reasons, never as states.
