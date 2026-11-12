# Database: profiling

## Amendment 2026-10-26: the profiling record (Slice 6, PR 6-2)

Migrations `0067_profiling_record.sql` (generated) and `0068_profiling_record_functions.sql`
(hand-written, the 0066 hardening); data-protection.md and process-and-lifecycle.md ("The
profiling record") hold the rules.
- **Tables:** `participant_profiling` (one row per participation: the pending Jobbörse choice,
  enum `jobboerse_choice`, and BA contact declaration, who recorded them and when, the `revision`
  of sessions and declarations), `profiling_session` (date, `time_from` < `time_to` as `hh:mm`,
  who recorded it and when), `participant_profiling_assessment` (one ciphertext per section C line
  and per p. 7 text with presence flags, key id, its own `revision`),
  `participant_profiling_health_assessment` (the health line's rating only) and
  `participant_residence_social_data.unemployment_period` with its own `unemployment_revision`.
  Each has `project_id` and a composite FK to the participation. `transfer_app` selects the record
  and the sessions, of the encrypted tables only keys, presence flags, key ids, revisions and
  times; it writes none of them.
- **The lock order** (the tables above, extended):

  | Operation | Project lock | Then |
  |---|---|---|
  | `write_profiling_sessions`, `write_profiling_declarations` | shared (`lock_participation`) | the participation → `participant_profiling` `FOR UPDATE` → its sessions `FOR UPDATE` (id order) |
  | `write_profiling_assessment` | shared | the participation → the assessment row → the health row (`FOR UPDATE`) |
  | `write_unemployment_period` | shared | the participation → the residence row `FOR UPDATE` |

- **Functions** (`SECURITY DEFINER`, granted): the four writes take the context of the assigned
  consultant acting for themselves (internal `lock_profiler`: `actor_not_allowed` otherwise, also
  for an `onBehalfOf`; `participation_closed` for a terminal participation).
  `write_profiling_sessions(participation, context, sessions, revision)`: the whole list, an
  existing session by id (`session_not_found`), `session_times_reversed`, `session_in_future`
  (Berlin date, `berlin_today`), `sessions_overlap`, `stale_revision`; audited
  `profiling_session_changed` per session. `write_profiling_declarations(participation, context,
  choice, contact, revision)`: audited `profiling_declarations_recorded` with the changed keys.
  `write_profiling_assessment(participation, context, values, revision, key, key id)`: the whole
  assessment (`profiling_assessment_valid`), any key on the health line but its rating
  `health_detail_not_recorded`; one `sensitive_write` per changed field.
  `read_profiling_assessment(participation, context, key, key id)`: the assigned consultant only,
  one `sensitive_read` per field. Gesamteinschätzung and weiteres Vorgehen are multiline
  (`profiling_multiline_valid`: line breaks kept, any other control character refused, the API
  normalises CRLF first); every other text is single-line (`profiling_text_valid`).
  `write_unemployment_period(participation, context, period, revision, key, key id)` returns the
  new `unemployment_revision`: a stale revision is `stale_revision` under the row lock, clearing
  (`period` null) included; one `sensitive_write` when the value changed.
  `read_unemployment_period(participation, context, key, key id)` returns `{ revision, period }`
  from one row read with one `sensitive_read`, for the assigned consultant and back office in
  normal mode (internal `unemployment_reader`); a participant's or an assisted-mode read is
  `actor_not_allowed`. `read_sensitive_fields` doesn't serve `unemploymentPeriod`
  (`invalid_argument`). Encryption, envelope and key id as in the field-encryption amendment.
  `record_audit_event` refuses the two new types. The profiling track's route uses the existing
  `change_participation_status`.

## Amendment 2026-11-05: profiling exception evidence (Slice 6, PR 6-7)

Migrations `0085_exception_evidence.sql` (generated) and `0086_exception_evidence_functions.sql`
(hand-written, the 0084 hardening); process-and-lifecycle.md (profiling exceptions) and
data-protection.md (exception evidence) hold the rules, Q208 the readings.

- **Upgrade of an existing database** (the review of PR #102): 0085 creates the table; 0086 first
  gives every request recorded before it a `legacy_unverified` record (its id, participation and
  fingerprint, the requester and request date; no source), stops with `legacy_evidence_conflict`
  if one id is named by requests of two participations (the transaction leaves the database
  unchanged), and only then adds the request's FK. `exception_evidence_usable` is false for a
  legacy record, so it supports no request, approval or fact. Tested from a database at 0084
  (`exception-evidence-migration.int.test.ts`).
- **Table:** `profiling_exception_evidence_record` (`exception_evidence_kind`: `documents`,
  `ba_confirmation` or `legacy_unverified`; `document_ids uuid[]` or `agentur_key`, `reference`, `confirmed_on`; the
  `fingerprint`; `created_by`, `created_on`, `created_at`), composite FK to the participation, a
  CHECK for one complete source, the fingerprint's format; immutable by trigger for every role
  (`record_immutable`); `transfer_app` selects it. `profiling_exception_request` gains the
  composite FK `(evidence_record_id, participation_id)` to it.
- **Document catalog version 7:** `profiling_exception_evidence` becomes `signed`; add and
  quarantine `{consultant, project_lead}`, review `{consultant}`, delete `{project_lead}`; its
  `open_roles` stay `{consultant}`. `review_document` needs no change for it (no scan origin, no
  paper arguments).
- **Helpers:** `normalise_ba_reference` (NFC, spaces, trim, ICU `lower`, NFC; null for a control
  character or nothing), `exception_evidence_fingerprint` (round 17's payload), both internal;
  `exception_evidence_usable(record)` (SECURITY DEFINER, for transfer_app: a BA confirmation, or
  documents all live, accepted, not quarantined or invalidated).
- **Functions:** `create_exception_evidence_record(p_context, p_participation_id, p_kind,
  p_document_ids, p_agentur_key, p_reference, p_confirmed_on)`: the PL as themselves, `informed`
  (`not_informed`), `document_not_found`, `evidence_missing`, `reference_invalid`,
  `confirmation_in_future`, `invalid_argument`; `lock_participation`, then the documents `FOR
  SHARE` in id order; audited `exception_evidence_recorded` (a participation event,
  `profiling` stream; `record_audit_event` refuses it). `request_profiling_exception` loses
  `p_evidence_fingerprint` (DROP with the old signature, CREATE, the grants again): it reads the
  record of this participation under the lock, its documents `FOR SHARE`, and refuses
  `evidence_missing`, `evidence_unchanged` and `ba_confirmation_missing`.
  `decide_profiling_exception` gains `p_evidence_record_id` (DROP, CREATE, the grants): the
  project's exclusive advisory lock first (D31), then `lock_current_request`; `source_changed`
  for another record, `evidence_missing` for an approval on unusable evidence.
- **Status service:** `createExceptionEvidence`; the decision takes `lock_project_setup` before it
  loads the request and compares the record shown; the revocation compares the status shown. The
  evidence functions' state refusals map to `domain`, `document_not_found` to `not_found`,
  `source_changed` to `stale`. `dbGuardFacts.evidence` reads the record; `dbGuardFacts` withholds
  `profilingExceptionApproved` while the approved request's evidence doesn't count and dates it
  from a later quarantine lift.
