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

## Amendment 2026-10-16: status functions and the lifecycle tables (Slice 1, PR 1g-1)

Decided in the Slice 1 plan (D2, sections 5.4 and 5.10) and built in PR 1g-1:
- **Only `SECURITY DEFINER` functions write statuses and audit events.** Nine functions
  (`lock_participation`, `create_participation`, `change_participation_status`,
  `assign_entry_wave`, `request_profiling_exception`, `decide_profiling_exception`,
  `revoke_profiling_exception`, `correct_end_reason`, `record_audit_event`), in a hand-written
  migration owned by `transfer_owner`: fixed `search_path` (`pg_catalog, public, pg_temp`),
  schema-qualified names, no dynamic SQL, `EXECUTE` revoked from `PUBLIC` (also by default in
  `public`) and granted to `transfer_app` only. Each writes its change and its audit event in
  the caller's transaction; errors are `P0001` with a stable code, never a value. Grants,
  atomicity and drift are integration-tested.
- **Profiling-exception requests are first-class rows** (`profiling_exception_request`, round 16,
  Q94): one immutable row per request (reason and evidence identity, by an opaque evidence-record
  id and a canonical fingerprint), whose status and decision progress on the row under a trigger;
  the participation references its current request. Never overwritten by the next request.
- **Grants:** `transfer_app` may `SELECT` `participation`, `profiling_exception_request` and
  `project_entry_wave` and has no
  privilege on `audit_event` or `lifecycle_edge` in Slice 1. Without `UPDATE` it can't
  `SELECT … FOR UPDATE`, so the status service locks through `lock_participation`.
- **`lifecycle_edge`** holds the domain's edge list as reference data for the functions; a
  drift test keeps it, the Postgres enums and the end-reason phases equal to the domain. Guards
  with dated facts stay in TypeScript; the functions check the edge list, the invariants and
  the four-eyes rule.
- **`audit_event` has no FK to `participation`** (`participation_id` stays when retention
  deletes the participation and pseudonymises the trail), a strict `seq` identity, database
  time in `occurred_at`, and **no free text** before encrypted storage exists (Q66): `CHECK`s
  hold every text column and every string in `details` to an id or code pattern and refuse
  inconsistent actors. Its shape per event type is the Zod model in
  `packages/domain/src/audit`.
- **Entry waves** (`project_entry_wave`, Q79) carry the contractual dates; the Slice 0 project
  dates were copied into one wave `W1` per `ta_tg` project. A participation's wave is of its own
  project (composite FK).
