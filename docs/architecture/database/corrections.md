# Database: corrections

## Amendment 2026-11-05: evidence corrections (Slice 6, PR 6-8)

Migrations `0087_evidence_corrections.sql` (generated, one hand edit: the document FK `NOT
VALID`) and `0088_evidence_correction_functions.sql` (hand-written, the 0086 hardening);
data-protection.md (evidence corrections) holds the rules, Q209 the readings.

- **Table:** `evidence_correction` (`correction_target_kind`: `document`, `asu_registration`,
  `ba_reporting_task`; `correction_action`: `invalidate`, `supersede`; one of `document_id`,
  `asu_registration_id`, `ba_reporting_task_id` by kind; `wrong_person` for a document,
  `corrected_registered_on` for an ASU supersession; `correction_reason`; `source` (1–200
  characters, trimmed, no control character); `retention_class` per row, the target's (a
  document's type class, else `participation_record`); `correction_status`: `requested`,
  `approved`, `rejected`; requested by/at, decided by/at, never the same person), composite FK to
  the participation, CHECKs for the shape, one pending request per target (a partial unique index
  on the target), append-only by trigger for every role (`correction_immutable`: only a pending
  request's decision is written, once). `transfer_app` selects it.
- **Links:** `document.invalidated_by_correction` gets its FK, `NOT VALID` so a value written
  before corrections existed (only tests did) stays invalidated and counts nothing, while every new
  value must name a correction (tested from a database at 0086,
  `evidence-corrections-migration.int.test.ts`). `asu_registration` gains `superseded_by` and
  `invalidated_by` (the approved correction) and `correction_id` (on the superseding row); its
  UNIQUEs on the participation and the proof document become partial unique indexes over the
  **current** registration (`superseded_by` and `invalidated_by` null), and a CHECK allows one of
  the two. `ba_reporting_task` gains `superseded_by` (the replacement task), `replaces_task_id`
  (UNIQUE) and `correction_id`; its forward-only trigger also lets a closed task gain
  `superseded_by` once, its outcome unchanged.
- **The current registration:** `set_asu_route`, `record_asu_registration`, `link_asu_proof`,
  `record_asu_confirmation` and `kug200b_member_problem` (redefined, bodies otherwise as before)
  read only the current registration; a write on a superseded or invalidated one is
  `asu_registration_corrected`. The API's `asuStatesOf` and the batch candidates read the same.
- **Invalidated documents:** `open_document` refuses one (`document_invalidated`),
  `document_link_content` answers nothing for an earlier link, `quarantine_document` refuses it,
  `lift_document_quarantine` refuses it and refuses while a correction of it is pending
  (`correction_pending`). Every facts reader already skipped it.
- **Functions:** `request_evidence_correction(p_context, p_participation_id, p_target_kind,
  p_action, p_target_id, p_wrong_person, p_corrected_registered_on, p_reason, p_source)`: as
  themselves, the correction-authority table's roles (`actor_not_allowed`), `target_not_found`,
  `target_corrected`, `correction_pending`, `document_not_accepted`, `task_pending`,
  `asu_route_kug200b`, `registered_on_in_future`, `correction_unchanged`, `source_invalid`,
  `invalid_argument`; `lock_participation`, then the target `FOR UPDATE`, then the insert.
  `decide_evidence_correction(p_context, p_correction_id, p_approve)` → the document to purge or
  null: the project's **exclusive** advisory lock first (D31), the participation row, the target,
  then the correction `FOR UPDATE`; a supersession carries the PL's attestation, not a BA
  confirmation (the consultant links it again); the regional operations manager of the project's region
  (`actor_not_allowed`), never the requester (`same_person_approval`), `correction_not_pending`,
  `target_corrected`. Both audited (`evidence_correction_requested`, `evidence_correction_decided`:
  participation events, `case` stream, codes only; `record_audit_event` refuses them). Helpers
  `normalise_correction_source` and the trigger function stay internal.
- **The reporting obligation's day** (the review of PR #103): `ba_reporting_obligation_day(task)`
  (internal) follows `replaces_task_id` to the chain's first task and gives its Berlin creation
  day; `record_ba_report` (redefined, same signature) checks `date_before_task` against it, so a
  replacement keeps its own `created_at` and still records a report sent before the correction.
- **Lock order** (unchanged from D31 for every Slice 6 function): the project's advisory lock
  first, shared through `lock_participation` for one participation, exclusive for a batch, a bulk
  generation and a correction's or exception's decision; then the participation rows (UUID order)
  → document rows (id order) → the profiling rows → `asu_registration` → the batch row →
  `agentur_submission` rows (id order) → consent rows → the sensitive rows → the BA reporting task
  → the correction or request row. Never a batch before a participation.

## Amendment 2026-11-10: date corrections (Slice 7, PR 7-8)

Migrations `0105_date_corrections.sql` (generated) and `0106_date_correction_functions.sql`
(hand-written, the 0088 hardening); data-protection.md (evidence corrections: date corrections)
holds the rules, Q232 the readings.

- **Table:** `correction_target_kind` gains `field` and `dsv_signature`; `evidence_correction` gains
  `field_key` (CHECK: `profilingDoneOn` or `withdrawnOn`), `dsv_offer_id` (FK), `signature_paper`
  (`dsv_signed_scan` or `dsv_cancellation`, text: an enum cast isn't immutable in the index),
  `signature_kind`, `corrected_on` and `original_on`; the target CHECK takes one of five targets by
  kind (compared as text, the values are new in the run), the action CHECK makes both new kinds
  `supersede`, and the pending index covers the field (participation and key) and the signature
  (offer, paper and kind). The append-only trigger function covers the new columns.
- **Signature rows:** `dsv_scan_signature` gains `superseded_by` and `correction_id` (FKs to the
  correction); `dsv_signature_once` becomes a partial unique index over the current rows. Upgrade
  tested from a database at 0104 with an existing correction and signature row
  (`date-corrections-migration.int.test.ts`): both keep their targets and facts.
- **Recreated functions and their diffs:** `request_evidence_correction` (DROP/CREATE: four
  parameters `p_field_key`, `p_corrected_on`, `p_signature_paper`, `p_signature_kind` with defaults;
  the two shapes, the offer locked after its paper's documents, the rules through
  `field_correction_problem` / `signature_correction_problem`, the original stored, `fieldKey` /
  `paper` / `signatureKind` in the audit details; and `dsv_form` now refused like the other working
  copies, as the authority table says), `decide_evidence_correction` (DROP/CREATE, same signature
  re-created for its body: the two approvals, the rules re-checked against the original,
  `target_corrected` when it moved; the field written with no other column, or the signature rows
  superseded and replaced and `dsv_contract`'s retained dates followed), `tl407_facts` (the
  completion's recording instant also not before the latest approved `profilingDoneOn`
  correction), `dsv_facts` and `dsv_cancellation_facts` (current signature rows only; the packet's
  participant date compared among the contract's own scans), `assert_dsv_participant_date` (current
  rows, the contract's scans only). Grants again for the two writes. New: `field_status_change`
  (SECURITY DEFINER, granted: the actor type and instant of the change that recorded the field, so
  the views needn't read `audit_event`), and the internal helpers `field_correction_problem` and
  `signature_correction_problem`. `record_audit_event` is unchanged: no new event type (the two
  correction events gain detail keys, their projection rows updated).
- **Grants:** `transfer_app` writes neither participation column, the signature rows nor the
  corrections directly (tested); the decision is the one write of `profiling_done_on` and
  `withdrawn_on` besides the status function.
