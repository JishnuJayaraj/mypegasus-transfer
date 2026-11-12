# Database: lifecycle

## Amendment 2026-10-16: status functions and the lifecycle tables (Slice 1, PR 1g-1)

Built in PR 1g-1:
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
  id and a versioned canonical fingerprint, which never leaves the row: not in audit details,
  logs or responses, round 17), whose status and decision progress on the row along an exact
  transition matrix enforced by a trigger;
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
