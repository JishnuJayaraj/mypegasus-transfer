# Decisions — 2026-10-16, round 21 (Slice 1, PR 1h-2 review)

The product owner's answers to Q97 and to the twelve readings taken in PR 1h-2 (#23). Where they
differ from earlier rounds, round 21 wins.

## Q97 — TG entry and the DSV track (confirmed)

TG entry requires both:
- `dsvStatus === "dsv_signed"`; and
- the dated `dsvFullyExecuted` fact passing the existing validity and recording rules.

The status is never repaired or overridden automatically. Inconsistent data stays `informed`; the
planner must not propose an entry the database would reject. Domain, planner and job tests.

## The twelve readings

1. **Database-time due check — confirmed, applied to project jobs too.** A directly queued
   project job independently verifies that `scheduledAt(runDate)` has passed by database time
   before planning or writing.
2. **Only the endpoint run date gets `job_run` — confirmed.**
3. **Every project gets a job — confirmed.**
4. **Planning and application order — confirmed with payload hardening.** The worker must not
   trust caller-supplied `scheduledAt` values or a window with missing days. Preferred: a payload
   of `projectId`, `firstDay` and `runDate`, from which the job derives the contiguous days and
   the canonical scheduled instants using `JOBS_LIFECYCLE_TIME` (alternatively, validate every
   day and instant exactly before planning).
5. **Refusals — corrected.** Only a `StatusServiceError` is a lifecycle refusal: `stale` is
   counted; other `StatusServiceError`s are counted as refused; unknown database, infrastructure
   and programming errors propagate as unexpected and are not converted to `changes_refused`.
6. **Project job limited to its run date — confirmed.**
7. **Polling and wait policy — confirmed.**
8. **Inline CLI execution — confirmed.**
9. **Failed-job sanitization — confirmed after fixing the stack sanitization.** `errorForLog`
   leaked the continuation lines of multiline error messages: keep only actual stack-frame lines
   rather than merely removing the first line; add a multiline sensitive-message test.
10. **Log fields and counts — confirmed.**
11. **Fail-closed production facts — confirmed.**
12. **Past-dated job fixtures — confirmed.**

Also: remove the trailing blank line `git diff --check` reports in ADR-0011.

## Applied in PR 1h-2

See the plan, section 5.9, "Readings taken in PR 1h (1h-2)", and the guard table in 5.3.
