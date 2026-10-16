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
