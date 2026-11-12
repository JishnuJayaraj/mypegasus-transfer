# Database: TG entry

#### The reconciliation and its review (7-6)

Migration 0103 adds `tg_entry_reconciliation` (one per participation; composite FK to the
participation; the stage and revision) and `tg_entry_reconciliation_step` (one per review step, its
code and source checked per kind), and the audit types `tg_entry_reconciled`,
`reconciliation_reviewed`, `reconciliation_replied`; 0104 is hand-written. New `SECURITY DEFINER`
functions: `reconcile_tg_entry` (the PL by `document_staff_roles`, under `lock_participation`; the
packet's document row `FOR SHARE`; the row, then the status change, then the row's `status_event_id`
and its event), `review_reconciliation` (the region's manager by `staff_org_role`, under the
project's exclusive lock, then the participation and the row `FOR UPDATE`; `four_eyes`,
`stale_reconciliation`, `not_awaiting`, `outcome_not_allowed`) and
`reply_reconciliation_clarification` (a PL of the project, under `lock_participation`). Recreated
with `CREATE OR REPLACE` (same signatures): `apply_status_change` (diff against 0102: an entry of
kind `reconciliation` needs a row of the participation without a status event for the same effective
date, else `reconciliation_missing`) and `record_audit_event` (diff against 0102: the list).
`audit_event_lifecycle_has_participation` and `audit_event_projection` know the new events.
`transfer_app` selects both tables and writes neither. Lock order: participation → documents (the
packet) → `tg_entry_reconciliation` (the project's lock first, exclusive for the review). The day
of a reconciliation is the status service's (the injected clock and the day's `job_run`), as every
guard's day is; the database checks the packet's validity, not the clock.
