# Database: messages

## Amendment 2026-10-22: reminders and consent v2 (Slice 5, PR 5-2)

Migrations `0055_reminders.sql` (generated) and `0056_reminder_functions.sql` (hand-written, the
0054 hardening); data-protection.md ("Reminders", "Consent v2") holds the rules.
- **`participant_reminder`** (internal, `case_internal`, `personnel_file`; the field
  `reminderLog`): id, project and participation (a composite FK), batch, kind, text version,
  language, the channel's id (FK) and kind, the consent id it was queued under (FK), the
  requester's staff id, `requested_at`, `requested_on` (the Berlin date of the window), status, a
  closed cancel reason, `claimed_at`, `outcome_at`; `CHECK`s tie the cancel reason to `cancelled`
  and the outcome time to a final status. Never an address, a text, a provider answer or an
  error. `transfer_app` selects it and writes none.
- **`request_reminders(context, project, participation ids, kind, message version, batch)`**: the
  exclusive project lock; refuses `invalid_argument` (1–500 distinct ids, the version
  `portal-reminder:v1`), `actor_not_allowed` (assisted mode, any role but the PL or the assigned
  consultant), `participation_not_found` (another project's id; for a consultant one not assigned
  to them), `project_not_active`. Per row under the participation lock: `participation_closed`,
  `no_channel`, `consent_required`, `reminded_recently` (a row with `requested_on` within 3 days of
  the database's Berlin date); otherwise the channel is picked (`kind = 'email' desc, verified_at
  desc, id`), the row written `queued` and `reminder_queued` audited. Returns per participation
  the reminder id and channel kind, or the skip code.
- **`claim_reminder_dispatch(reminder, has actions, job id)`**: under `lock_participation`, the
  reminder `FOR UPDATE` and its queued channel and consent `FOR SHARE`, rechecks the status, the
  channel (live, still on that consent), the consent (live, `portal_contact`, exactly v2), the
  requester (`document_staff_roles`) and the job's verdict on the actions; `dispatching`, or
  cancelled with the reason; from `dispatching` (a retry) a failed check settles
  `delivery_unknown` (`settled`). `record_reminder_outcome(reminder, outcome, cancel reason, job
  id)`: once per reminder (the same outcome again is a no-op, another `reminder_settled`). Both
  audit `reminder_delivery` as the system (`reminders.send`).
- **Consent v2:** `consent_end_reason` adds `superseded`. `upgrade_channel_consent(session,
  channel, consent id, version, language)` locks the participation (with the session), the channel
  and its consent; ends v1 `superseded`, inserts the participant's v2 consent, repoints
  `participant_channel.consent_id` and audits `consent_ended` and `consent_given`, or returns
  `already_current`. `complete_activation` and `add_participant_channel` are replaced to accept
  `portal-contact-consent:v2` only. No migration changes an existing consent's version (a test
  reads the migrations).
- `reminder_queued` and `reminder_delivery` are reserved (`record_audit_event` refuses them) and
  need their participation (the `CHECK` compares the type as text, as 0054 does). Grants:
  `EXECUTE` on the four functions; the helpers (`reminder_requester_allowed`,
  `reminder_job_context`, `settle_reminder`) have none.
