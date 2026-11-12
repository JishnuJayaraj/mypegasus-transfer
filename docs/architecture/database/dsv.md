# Database: DSV

## Amendment 2026-11-06: the DSV's generation (Slice 7, PR 7-1)

- **`document_type` recreated** with `dsv_form` (as 0069 and 0075 did: catalog version 8's policy
  rows use it in the same migration run): the constraints comparing it with a literal and the six
  functions naming it are dropped by 0089 and created again unchanged by 0090.
- **`record_form_generation`** (DROP/CREATE) takes the DSV: `p_offer_deadline`, `p_deadline_kind`
  (`dsv_deadline_kind`) and the checklist; the PL or back office as themselves; the state, the
  pinned template, the deadline (`offer_deadline_invalid`, the wave's as it is now) and the printed
  sources (`form_person` and `dsv_source_token`) checked under the participation lock; audited
  `dsv_form_generated`. `form_generation` gains `offer_deadline` and `deadline_kind`
  (`form_generation_dsv`), its version check allows `v<n>` for `dsv`.
- **`dsv_source_token(participation, organisation sha256)`** (internal, no grant) builds the
  domain's `dsvSourceCanonical` and hashes it (a test holds them equal);
  **`dsv_generation_current(generation, organisation sha256)`** (granted) says whether a paper can
  still be handed out (D3).
- **`update_project`** (DROP/CREATE) takes `p_dsv_template_version` alone: the project's PL, a
  `ta_tg` project, no DSV generated yet (`template_pinned`); audited `dsv_template_pinned`
  (project-level), under the exclusive project lock a generation's shared lock waits for.
- **`record_audit_event`** refuses `dsv_form_generated` and `dsv_template_pinned`.

#### DSV scan evidence (7-2b)

Migrations 0093–0094 add nullable receipt/offer metadata to existing documents and the
`dsv_scan_signature` table without changing existing rows. Catalog 9 enables DSV scan operations.
`add_document` and `review_document` are dropped/recreated with optional DSV arguments and their
grants restored; existing calls retain their behavior. Only these functions write scan metadata
and confirmed signatures. Review and signing share the participation lock with offer changes,
quarantine, lift and deletion. `sign_dsv` checks the exact scan and status version;
`apply_status_change` also checks counting evidence, so the ordinary status function cannot
bypass the documentary guard. `dsv_facts` returns actual signature dates and advances recording
instants on lift. The history function routes DSV document events to the DSV stream while
preserving other document projections.

#### DSV packet and original (7-3)

Migrations 0095–0096 add `dsv_contract` (select-only for `transfer_app`) and drop and recreate
`dsv_facts` (it returns the customer and Transfergesellschaft dates and `executed_on`, the latest
of the three for a scan of the signed offer that shows all three), with its grants restored.
`apply_status_change`, `add_document` and `review_document` are replaced with the same signatures
(the diffs against 0094: the entry check and the contract sync; the signed offer takes scans and
the participant date is compared; a rejection is allowed after the offer ended). `sync_dsv_contract`,
`assert_dsv_participant_date` and `dsv_role_kind` are internal helpers without grants;
`record_dsv_original` is granted. `record_audit_event` refuses `dsv_original_recorded`. The lock
order is participation → documents → `dsv_offer` → `dsv_contract`. The migration backfills a
contract for every offer already signed (no packet is invented).

#### The entry clarification and the bulk generation (7-4)

Migrations 0097–0098 add `entry_clarification` (select-only for `transfer_app`; one row per
participation and planned start; each step needs the one before, by check constraints) and three
functions: `record_entry_clarification` and `escalate_entry_clarification` under the shared project
lock (`lock_participation`, the PL by `document_staff_roles`), and `record_clarification_instruction`
under the exclusive one (the region's `regional_operations_manager`, never the person who
escalated). `entry_clarification_opened_on` is an internal helper without a grant.
`record_form_generation` is dropped and created again with `p_batch_size` (1 to 100, DSV only): a
batch takes the project's exclusive lock before any participation row, its calls run in participation
id order in one transaction, and the audit event carries `batchSize` (the diff against 0090 is that
parameter, its check, the lock and the detail). `record_audit_event` refuses the three new events
(its diff against 0096 is the list), and `audit_event_lifecycle_has_participation` and
`audit_event_projection` know them. The lock order ends participation rows → documents → `dsv_offer` →
`dsv_contract` → `entry_clarification`.

Migrations 0099–0100 add the clarification's rounds: `entry_clarification` gains `stage` and `revision`
(its check constraints now state what each stage holds, and a unique index allows one unresolved case
per participation), `entry_clarification_step` keeps every step (select-only for `transfer_app`), and
the rows of 0098 are backfilled as the first steps of their history. `record_entry_clarification`,
`escalate_entry_clarification` and `record_clarification_instruction` are dropped and created again
with `p_expected_revision` (compared under the lock, `stale_clarification`), they act on the
participation's unresolved case whatever its planned start became, and the manager's two answers
(`record_clarification_instruction`, `request_entry_clarification_reply`) share the internal
`answer_entry_clarification` under the exclusive project lock. `record_audit_event` refuses
`entry_clarification_requested` (its diff against 0098 is the list).


#### The DSV cancellation, the withdrawal and the customer notice (7-5)

Migration 0101 adds `dsv_customer_notice` (one row per participation; composite FK to the
participation) and the audit type `dsv_customer_notified`; 0102 is hand-written. The document type
policy gains catalog version 10 (the cancellation takes the DSV scan's add, review, delete and
quarantine roles; `current_document_policy` reads the latest version and is unchanged).
`dsv_cancellation_facts(uuid[])` is a new `SECURITY DEFINER` reader beside `dsv_facts`, whose rows
stay as they were. `record_customer_notice` (the PL by `document_staff_roles`, under
`lock_participation`) writes the notice and its event; `transfer_app` selects the table and writes
none. Recreated with `CREATE OR REPLACE` (same signatures): `add_document` (diff against 0096: the
`p_dsv` metadata is taken for `dsv_cancellation` too, against the signed offer and only while the
participation is `informed` on a signed DSV, `cancellation_not_open`; the participant-date comparison
stays the DSV scan's), `review_document` (diff against 0096: the cancellation's acceptance needs the
three signatures, `cancellation_signatures_missing`, takes no `termsConfirmed`, writes its
`dsv_scan_signature` rows; `signatureKinds` in the audit for both types), `apply_status_change`
(diff against 0096: `→ withdrawn` of a signed DSV needs a user, the effective TG start not passed,
a counting cancellation valid today and an effective date not before it; the cancellation's
document row is held `FOR SHARE`), `record_audit_event` (diff against 0100: the list) and
`audit_history` (diff against 0094: the cancellation's document events in the `dsv` stream).
`audit_event_lifecycle_has_participation` and `audit_event_projection` know the new event. The lock
order is unchanged: participation → documents (the cancellation) → `dsv_offer` → `dsv_contract`.
