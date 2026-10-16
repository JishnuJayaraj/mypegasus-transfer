# ADR-0011: Background jobs

- Status: Accepted
- Date: 2026-10-15

## Context
Several rules are time-driven and exist well before Slice 5: the signing deadline
(`dsv_expired`), TG start (`active_in_tg`), the admission-cutoff withdrawal, the ASU due date,
profiling-exception deadlines, reminders and the retention job (ADR-0008).

## Decision
- **pg-boss** on the existing PostgreSQL. Decided now, not in Slice 5. No extra infrastructure.
- Every job is **idempotent** (safe to run twice) and runs with the **`system` actor**, so its
  status changes are audited like any other.
- Jobs get the current time from an **injected `Clock`** (ADR-0006), never from `Date.now()`,
  so deadline logic is testable.
- **Job payloads carry only IDs**, never personal data. The job loads what it needs.
- Recurring jobs (nightly lifecycle and retention runs, reminders) are scheduled by pg-boss.
  Failed jobs retry with backoff and show up in monitoring.

## Consequences
+ Time-driven lifecycle rules can be built and tested in Slice 1 / Slice 2 already.
- Job state lives in the same database. Job tables are excluded from participant-data
  retention but cleaned up by pg-boss's own archive settings.

## Note 2026-10-16: spike S2 (pg-boss, Slice 1 plan section 3)

**Passed; no fallback, no `transfer_jobs` role.** `pg-boss@12.38.0` (schema version 46) with
`@opentelemetry/api@1.9.1`, against PostgreSQL 16 in a cloud session:

| Check | Result |
|---|---|
| (a) schema installed as `transfer_owner` | OK: `start()` as the owner creates the `pgboss` schema (11 tables, 2 partitioned tables, 6 functions, none `SECURITY DEFINER`); the queues are created there too. |
| (b) runtime as `transfer_app` | OK with `migrate: false`, `createSchema: false` and only these grants: `USAGE` on the schema, `SELECT, INSERT, UPDATE, DELETE` on all its tables, `USAGE, SELECT` on its sequences, `EXECUTE` on its functions. `start()`, `send`, `work`, `schedule`, `supervise()` and creating a further (non-partitioned) queue ran without an error. |
| (c) cron with `tz: "Europe/Berlin"` | OK: registers with the time zone and fires. pg-boss's preview of `15 4 * * *` gives 02:15 UTC before and 03:15 UTC after 2026-10-25, and 03:15 / 02:15 UTC around 2027-03-28: the same instants as our `scheduledAt` (`@transfer/adapters`). |
| (d) Node 22.22 and 24 | OK on 22.22.0 and 24.22.0 (cron fired on both). CI tests both. |
| (e) `--frozen-lockfile` | OK: one copy each of `pg-boss` and `@opentelemetry/api`, no peer warning. |
| (f) `pnpm deploy --legacy --prod` | OK: both land in the API's production `node_modules` and import on Node 24 with `NODE_ENV=production`. The image build and smoke test run in CI (no Docker daemon in cloud sessions); the API doesn't load pg-boss before PR 1h. |

For PR 1h:
- The grants are on existing objects only, so `db:migrate` re-applies them after every pg-boss
  migration (planned).
- Keep **`persistQueueStats` off** (default): it creates a partition per day, which is DDL the
  runtime role can't do. Run the app instance with **`reindex: false`**: `REINDEX` needs the
  owner (pg-boss skips indexes it doesn't own anyway).
- **`singletonKey` deduplicates only on queues with policy `stately` or `exclusive`**; on
  `standard` and `singleton` two sends with the same key both succeed. Create
  `lifecycle.evaluate-project` with one of those, and keep idempotency in the planner and the
  compare-and-set (plan 5.9).

## Amendment 2026-10-16: setup, runtime role and schedule (Slice 1, PR 1h-1)

Decided in the Slice 1 plan (D7, section 5.9) and built in PR 1h-1; the sweep, the catch-up
window and the per-project job follow in PR 1h-2.
- **Schema install:** `db:migrate` (and `node dist/migrate.js` in the image) installs pg-boss's
  `pgboss` schema after the app migrations, as `transfer_owner`, from pg-boss's exported SQL
  plans: the construction plan on a fresh database, the migration plan from the installed
  version on an upgrade (its `CREATE INDEX CONCURRENTLY` builds run one by one after its
  transaction, since the app instance never runs pg-boss's own background migrations). A schema
  newer than the pinned pg-boss is refused. The target version comes from the pinned package
  (`pg-boss@12.38.0`: 46).
- **Runtime role:** every migration run re-applies `transfer_app`'s grants on the existing
  objects: `USAGE` on the schema, `SELECT, INSERT, UPDATE, DELETE` on its tables, `USAGE, SELECT`
  on its sequences, `EXECUTE` on its functions; no `CREATE`, no DDL. The API starts pg-boss as
  `transfer_app` with migration off, `persistQueueStats` off and `reindex: false`; a missing or
  outdated schema fails the API's start.
- **In-process:** pg-boss runs in the API process (D7) when `JOBS_ENABLED=true` (the default),
  started before the server listens. `SIGTERM`/`SIGINT` start a single-flight shutdown: the
  server stops accepting, HTTP draining and pg-boss's graceful stop are both awaited, then the
  pool is closed; failures are logged without their message and give a non-zero exit code. Tests and the
  Playwright server run with `false`; tests start it explicitly.
- **Queues** (round 19): `lifecycle.sweep` is **`singleton`** (one active sweep, the others kept
  queued: a missed occurrence can arrive beside the due one and must not displace it; `job_run`
  makes a second sweep of a completed day a no-op); `lifecycle.evaluate-project` is
  **`exclusive`** per `singletonKey` `<projectId>:<runDate>`. Both retry with backoff; their
  options are kept current on every start and a queue with another policy fails it.
- **Time zone:** the nightly sweep is a pg-boss cron at `JOBS_LIFECYCLE_TIME` (Berlin local time,
  default `04:15`, 02:00–02:59 refused) with `tz: "Europe/Berlin"`, whose instants equal the
  `Clock` adapter's `scheduledAt`, DST days included. An occurrence missed while the API was down
  is sent once at the next start (`missed: "once"`).
- **`job_run`** (`job_name`, `run_date`, `scheduled_at`, `completed_at`): one row per job and Berlin
  run day, inserted once when the day's run has completed and never changed. `transfer_app` may
  `SELECT` it and `INSERT` only `job_name`, `run_date` and `scheduled_at`, so `completed_at` is
  always database time; `CHECK`s keep the scheduled time on the run date in Berlin and the
  completion not before it (round 19). Reference data (retention class `reference_data`). The
  sweep reads it for its catch-up window (PR 1h-2); the status service reads today's row before a
  same-day reconciliation.
- **Database time is authoritative** in every environment (Q96, round 20): a lifecycle run whose
  scheduled time hasn't passed by database time stops before any change (`run_not_due`); there is
  no database clock for development.
- Events are logged without their data and errors without their message (CLAUDE.md rule 9).

## Amendment 2026-10-16: the nightly lifecycle sweep (Slice 1, PR 1h-2)

Built in PR 1h-2 (plan 5.9; rounds 9, 18–20):
- **`lifecycle.sweep`**: the run date is the `Clock`'s Berlin today. The run is due only once its
  scheduled time has passed **by database time** (Q96); otherwise it stops before any change
  (`not_due`). A due run evaluates the **catch-up window**, every day after the last completed
  run in `job_run` up to today (the first run: today); a completed day is never evaluated
  again (`already_completed`). It dispatches one `lifecycle.evaluate-project` job per project
  with the window's bounds only (`{ projectId, firstDay, runDate }`, `singletonKey`
  `<projectId>:<runDate>`; a taken key waits for the existing job), waits for all of them and
  only then inserts today's `job_run` row. A failed or cancelled project job fails the sweep: no row, so the next sweep covers the
  gap.
- **`lifecycle.evaluate-project`** trusts its payload for nothing but the bounds (round 21): it
  runs only on its run date, only once that day's scheduled time has passed by database time,
  and only for the window starting the day after the last completed run; it derives the days and
  their scheduled instants from `JOBS_LIFECYCLE_TIME` itself. It plans each open participation
  with `planSystemTransitions` (the snapshot of each day's scheduled run, round 9) and applies each
  change through the status service as `system` with the job id; the service locks, re-checks the
  guards and validates the effective dates (round 18). Of the service's refusals, a lost race is
  counted and any other fails the job after the other participations were applied; any other
  error propagates at once.
- **Payloads** are strict Zod schemas of IDs and dates; a failed job stores only a `JobError`
  with its code. **Logs** carry the job name, job id, project id, outcome and counts; an error's
  stack keeps only its frames, never a line of its message.
- **`pnpm jobs:lifecycle [--today YYYY-MM-DD]`** runs the sweep once with the projects evaluated
  in its own process (never through the queue, so a running API's workers don't take a `--today`
  run); `--today` uses a `ManualClock` at that day's run time; a run not due exits non-zero with
  `run_not_due`; refused with `NODE_ENV=production`.
- The API's workers use the Slice 1 facts provider, which fails closed (D4): DSV expiry and cutoff
  withdrawals run, nobody enters the TG.
