# Database: retention

## As built 2026-11-11: the retention role and the trigger path (Slice 7, PR 7-7a)

The separate role of the retention job (data-protection.md, retention as built; readings Q234):
- **`transfer_retention`** (LOGIN; `db:setup` creates it in dev and CI, on the cluster CloudNativePG
  with the same name; its credential `RETENTION_DATABASE_URL` from the secret store, held only by
  the job's process, never the API pod). CONNECT, USAGE on `public`, **no table privilege** and
  EXECUTE only on `retention_open_run`, `retention_close_run`, `retention_purge_credentials`,
  `retention_working_copies`, `retention_purge_working_copy`, `retention_known_objects` (SECURITY
  DEFINER, owner `transfer_owner`); each refuses unless `session_user` is `transfer_retention`
  (`retention_role_required`), and every one but the opening one unless its run is open in this
  transaction (`run_not_open`). `transfer_app` executes none of them, `transfer_retention` none of
  the ordinary functions (tested both ways in `retention.int.test.ts`).
- **`retention_run`** (`reference_data`, no subject): the run's day, dry or not, its transaction id
  and, once closed, its summary. No role but the owner reads it.
- **The trigger path:** `in_retention_run()` (internal) is true only for `session_user`
  `transfer_retention` with the transaction-local `transfer.retention_run` naming an open run whose
  `opened_txid` is this transaction's. Recreated with it, as their newest migrations wrote them:
  `refuse_config_change`, `keep_privacy_notice_immutable`, `keep_notice_acknowledgement_immutable`,
  `profiling_exception_evidence_record_immutable`, `ba_reporting_task_progresses`,
  `evidence_correction_append_only`, `profiling_exception_request_progresses`,
  `config_relaxation_request_progresses`. New: `audit_append_only` on `audit_event` and
  `staff_audit_event` (BEFORE UPDATE OR DELETE): the trail is append-only for every role, the
  owner included, outside a run. The setting alone, or the role alone, changes nothing (tested).
- **Retention's inputs:** `set_settlement_dates` (back office of the project, the exclusive project
  lock, against both dates read) and `set_funding_status` (back office through
  `document_staff_roles`, the participation locked, against the value and source read), granted to
  `transfer_app`. `update_project` is unchanged: the dates have their own function. New audit types
  `settlement_dates_set` (project-level) and `funding_status_set` (`case`): projection rows,
  `audit_event_lifecycle_has_participation` (the funding) and `record_audit_event`'s refused list,
  recreated from 0104. A document deletion may now be by `system` (the working copy's purge; the
  `document_deleted` check). 0107 is generated (the enum `funded110`, the columns, `retention_run`),
  0108 hand-written; the upgrade from 0106 is tested (`retention-migration.int.test.ts`).

## 7-7c as built: erasure

`transfer_retention` alone executes the erasure, project-lock and retention-read functions inside an
open retention run; helper functions remain private. Five foreign keys needed for cycles are
`DEFERRABLE INITIALLY IMMEDIATE`: ordinary transactions still check them immediately, and only the
erasure explicitly defers them. Migration from 0110 with existing audit events and privileges is
tested. Erasure uses exclusive project locks before participant rows and preserves active holds and
their FK parents (data-protection.md, stage-two erasure). The erasure function alone uses dynamic SQL to traverse its fixed table catalog and schema foreign keys: identifiers are quoted with `pg_catalog.format`, values are parameters, and tests check the inventory and deletion order.
