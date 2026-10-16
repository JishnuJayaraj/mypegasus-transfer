# Decisions — 2026-10-16, round 19 (Slice 1, PR 1h-1 review)

The product owner's answers to the twelve readings taken in PR 1h-1 (#21), plus one correction to
the PR. Where they differ from earlier rounds, round 19 wins.

1. **The 1h split — confirmed.**
2. **Schema installation from pg-boss's exported SQL — confirmed.** Refusing downgrades and running
   the concurrent index builds outside the migration transaction are correct.
3. **pg-boss grants — confirmed.**
4. **Queue policy — corrected.**
   - `lifecycle.sweep`: **`singleton`**;
   - `lifecycle.evaluate-project`: **`exclusive`**, keyed by `<projectId>:<runDate>`.

   pg-boss documents that a missed occurrence can arrive beside the currently due occurrence. An
   exclusive sweep queue collapses those two jobs: around 04:15 an early missed-run handler could
   do nothing while the actual 04:15 occurrence is discarded, delaying lifecycle processing until
   the following day. A singleton sweep queue keeps both jobs while allowing only one active
   sweep; `job_run` makes the second execution idempotent. An integration test proves that a
   second sweep stays queued while one is active, that a duplicate project/day job is refused,
   and that different project/day keys stay queueable.
5. **`missed: "once"` — confirmed** with the corrected sweep policy. Before today's scheduled time
   the missed job may do nothing; the current occurrence must stay queued and run at 04:15.
6. **Start before listening — confirmed.**
7. **Sanitized pg-boss event logging — confirmed.**
8. **`job_run` — corrected.** Keeping it indefinitely as non-personal reference data is approved,
   but its invariants were incomplete:
   - add `completed_at >= scheduled_at`;
   - give `transfer_app` column-level `INSERT` only on `job_name`, `run_date` and `scheduled_at`;
   - don't grant inserting `completed_at`, so database time is authoritative.

   Tests prove that an explicit `completed_at` is refused and that a completion before the
   scheduled run can't be stored.
9. **Clock validation order — confirmed.**
10. **Playwright with jobs disabled — confirmed.**
11. **Cron before 1h-2 — confirmed temporarily**, with a documentation correction: with a singleton
    sweep queue more than one job may wait, bounded by pg-boss's retention. Once 1h-2 runs, the
    first useful sweep catches up and later queued sweeps are idempotent no-ops.
12. **Same-day reconciliation — corrected.** The status service, not the route, derives
    `scheduledRunCompleted` from `job_run`, inside the participation's transaction after the
    lock. `scheduledRunCompleted` is removed from the caller-controlled `StatusChange`. For a
    reconciliation on `tgStart === today` the service checks for the authoritative
    `lifecycle.sweep` row of today; no row means the run is not complete.

## Additional correction to PR 1h-1

The shutdown called `server.close()` without awaiting active HTTP requests and then closed the
database pool. Before merge: make the shutdown single-flight; stop accepting requests; await both
HTTP draining and pg-boss's graceful stop; only then close the pool; sanitize and report shutdown
failures.

## Applied in PR 1h-1

See the plan, section 5.9, "Readings taken in PR 1h (1h-1)". One consequence of 8 is a new open
question, Q96.
