# Database: BA reporting

## Amendment 2026-11-04: the TL 407's submission and the regional view (Slice 6, PR 6-5b)

Migrations `0081_tl407_submissions.sql` (generated) and `0082_tl407_submission_functions.sql`
(hand-written, the 0078 hardening); process-and-lifecycle.md (TL 407 submission) and
data-protection.md (the regional view) hold the rules, Q206 the readings.
- **Table:** `agentur_submission` gains, for a TL 407, `original_required` (the resolved setting
  when it was submitted; exactly for `tl407`), "Original versandt am" (`original_sent_on/
  recorded_by/recorded_at`, whole, only where required and not `paper_original`, not before the
  submission) and the Agentur's rejection (`rejected_on`, `rejection_reason`
  `agentur_rejection_reason`, `rejection_recorded_by/at`, whole, `tl407` only, not before the
  submission). A partial unique index keeps one standing (unrejected) TL 407 submission per
  participation (`agentur_submission_tl407_live_unique`). `original_retained_from` (a self-link,
  `agentur_submission_original_retained_from_fk`) records an earlier dispatch the Agentur still
  holds; such an original keeps the earlier date, so only it may precede the submission.
  `transfer_app` still writes none.
- **What the API resolves:** the placement Agentur's channel, `originalRequired` and the TL 407
  versions it rejects as outdated (only where `rejectsOutdatedFormVersions` is `true`), after
  taking `lock_project_setup`, which every configuration write and `set_placement_agentur` take;
  it passes them with the Agentur key, and `submit_tl407` compares the key with the participation's
  under the lock (`settings_changed`). Null settings are the `agentur_submission` blocker.
- **The lock order:** `submit_tl407`: the project's lock exclusive (the API), then shared through
  `lock_participation` → the scan `FOR SHARE` → the participation's submissions `FOR UPDATE` in id
  order → the new row. `record_original_sent`, `record_agentur_rejection`: shared, through
  `lock_agentur_submission` → the participation → the submission `FOR UPDATE`.
- **Functions:** `submit_tl407` (the PL, as themselves: `actor_not_allowed`; `document_not_found`,
  `participation_closed`, `placement_agentur_missing`, `settings_changed`,
  `submission_settings_missing`, `scan_unusable` (deleted, unreviewed, rejected, quarantined,
  invalidated or without a version), `already_submitted`, `form_version_outdated`,
  `submitted_on_in_future`, `submitted_before_signature`, `submitted_before_rejection`; audited
  `agentur_submission_recorded`). `record_original_sent` (`submission_not_found`,
  `original_not_required`, `original_recorded`, `date_in_future`, `date_before_submission`;
  `agentur_submission_original_sent`). `record_original_retained` (Q206 (4); the same refusals as
  the original's, then `retained_original_not_found` for an attempt not of the participation and
  `original_not_retainable` unless it is an earlier, rejected TL 407 attempt of the same scan and
  Agentur with its original dispatched; `agentur_submission_original_retained`).
  `record_agentur_rejection` (`rejection_not_applicable` for a
  batch's Kug 200b, Q204; `already_rejected`, the two dates; `agentur_submission_rejected`); neither
  touches the scan or a status. `profiling_declined_dates(uuid[])` reads the effective date of each
  participation's latest change to `profiling_declined` for the regional view (dates only;
  `transfer_app` selects no `audit_event`). `record_audit_event` refuses the three new types; all are
  participation events (`audit_event_lifecycle_has_participation`).

## Amendment 2026-11-05: closing a BA reporting task (Slice 6, PR 6-6)

Migrations `0083_ba_report_outcome.sql` (generated) and `0084_ba_report_functions.sql`
(hand-written, the 0082 hardening); process-and-lifecycle.md (BA reporting) holds the rule, Q207
the readings.

- **Table:** `ba_reporting_task` adds `not_required_reason` (`ba_report_not_required_reason`),
  `decided_by` (a staff user) and `decided_at`. Its `status` stays the outcome (`reported`,
  `not_required`) and `reported_on` the sent date; `channel` and `reference` stay unwritten.
  `ba_reporting_task_outcome_fields` replaces `ba_reporting_task_reported_fields`: a reported task
  has its date, a not-required one its reason, a closed one who and when, a pending one none of
  them. The trigger `ba_reporting_task_progresses` still refuses a delete, any change to a closed
  task and any other column change; `transfer_app` writes nothing directly.
- **Function:** `record_ba_report(p_context, p_task_id, p_outcome ba_reporting_status,
  p_reported_on, p_reason)`: a staff user as themselves (`actor_not_allowed` on someone's
  behalf), the PL or back office of the project (`actor_not_allowed` otherwise, a consultant too),
  `task_not_found`, `already_recorded` once closed, `date_in_future` (Berlin today),
  `date_before_task` (before the task's Berlin creation day), `invalid_argument` for a shape that
  doesn't fit the outcome. Lock order: `lock_participation` (shared project lock, the
  participation row) → the task `FOR UPDATE`; no setting is read. Audited `ba_report_recorded`
  (`taskId`, `kind`, `outcome`, `reportedOn` or `reason`), a participation event
  (`audit_event_lifecycle_has_participation`) in the `dsv` stream; `record_audit_event` refuses
  it. A closed participation's task is closed too (an early exit's is created at the exit).
