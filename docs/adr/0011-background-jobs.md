# ADR-0011: Background jobs

- Status: Accepted
- Date: 2026-10-15

## Context
Several rules are time-driven and exist well before Slice 5: the signing deadline
(`dsv_expired`), TG start (`active_in_tg`), the grace-period withdrawal, the ASU due date,
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
