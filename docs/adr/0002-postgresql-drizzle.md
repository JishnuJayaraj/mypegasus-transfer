# ADR-0002: PostgreSQL + Drizzle, hybrid relational/jsonb model

- Status: Accepted
- Date: 2026-10-15

## Context
The data model is the core of the product and expensive to change later. Regional variation
needs flexible fields; reporting needs solid relational data.

## Decision
PostgreSQL 16 with Drizzle ORM and SQL migrations. Core entities and fields (person,
participation, status, dates, audit) are real columns. Config-driven fields live in `jsonb`
validated by the resolved Zod/JSON schema. Audit log is an append-only table.

## Consequences
+ Strong consistency, good reporting, one database to operate.
+ Pre-installed in cloud coding sessions (`service postgresql start`).
- jsonb fields need careful indexing if they become filter criteria; promote to columns when
  a field becomes universal.

## Amendments 2026-10-15

Decided (from the decisions log):
- **Legal and calendar dates are `date` columns** (signing deadline, TG start/end, exit, ASU
  due date, settlement dates). Event times are `timestamptz`.
- **Audit events** record the actor type (`user`, `participant`, `system`), `onBehalfOf`
  (assisted mode), from/to, reason, and are also written for guard overrides, break-glass
  access, document openings and confirmed plausibility warnings.
- **Special-category and highly confidential fields use field-level encryption** and are never
  part of list queries/payloads (data-protection.md).
- **Retention runs per data item/document** via `retentionClass` (ADR-0008). Audit entries of
  deleted subjects are pseudonymised.
- Locally Postgres 16, in production CloudNativePG on the cluster (ADR-0005). Keep the major
  versions aligned.

Accepted in the PR #1 review:
- **Status writes are enforced in the database.** Every change of the main status or a track
  (`status`, `profilingStatus`, `dsvStatus`) and its audit entry are written in **one
  transaction through a single function**. `UPDATE` on status columns is revoked from the app
  role. The audit table is **append-only by grants** (no `UPDATE`/`DELETE` for the app role;
  pseudonymisation runs under a separate role used only by the retention job).

- **Every table holding participant data has a `project_id` column from the start**, so
  row-level security per project can be added without migrating data. RLS itself is **not
  needed for the demo but required at the pre-pilot gate** (ADR-0005).
