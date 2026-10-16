# Decisions — 2026-10-16, round 20 (Slice 1, PR 1h-1: Q96)

The product owner's answer to Q96, raised while applying [round 19](2026-10-16-answers-round-19.md)
in PR 1h-1 (#21). Where it differs from earlier rounds, round 20 wins.

## Q96 — Lifecycle runs ahead of database time (confirmed)

No dev-only database clock, and no lifecycle run intentionally applied in the future without
recording `job_run`. **Database time stays authoritative in every environment.**

For PR 1h-2:
- Before dispatching project jobs, the sweep verifies **against database time** that the requested
  run's `scheduledAt` has passed.
- A future `--today`, or a fixed `Clock` ahead of database time, **stops before any lifecycle
  change**. No `job_run` row is written.
- `pnpm jobs:lifecycle` exits non-zero with a stable code: **`run_not_due`**.
- A normal missed sweep arriving before today's scheduled time may stay a no-op; the singleton
  queue keeps the due occurrence.
- Past run dates stay supported for catch-up and tests.
- Ordinary crashes may still leave partial, idempotent changes without a completion row; that is
  recovery behaviour, not a simulation mechanism.

The 2091 seed stays suitable for UI and domain demonstrations. A persisted lifecycle-job
demonstration uses a separate past-dated fixture, or a future non-writing `--dry-run`. The planned
example that runs the persistent scheduler against the 2091 timeline is removed.

## Applied in PR 1h-1

Q96 is `confirmed` in `open-questions.md`; the plan (sections 1 and 5.9, the readings, AC-38) and
ADR-0011 carry the rule. The behaviour itself is built in PR 1h-2.
