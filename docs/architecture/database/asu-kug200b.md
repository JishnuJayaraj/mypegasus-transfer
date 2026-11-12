# Database: ASU and Kug 200b

## Amendment 2026-10-28: the ASU record (Slice 6, PR 6-4a)

Migrations `0073_asu_record.sql` (generated) and `0074_asu_record_functions.sql` (hand-written,
the 0072 hardening); process-and-lifecycle.md (Arbeitsuchendmeldung, dates) and data-protection.md
("The ASU record") hold the rules, Q201 the accepted readings (the owner's review of PR #95).
- **Columns and tables:** `asu_record` (one row per participation: `channel` `asu_channel`,
  `version` ≥ 1, who set it and when) and `asu_registration` (`project_id`, the participation,
  unique per participation until corrections exist; `channel`, `registered_on`, who recorded it
  and when; the proof once linked: `proof_kind` `asu_proof_kind`, `proof_document_id` (unique),
  `attestation_source` `asu_attestation_source`, `proof_linked_by`, `proof_linked_at`, all or none
  and each kind with exactly its own columns: `asu_registration_proof_whole`,
  `asu_registration_proof_kind`); `participant_identifier_data` adds the BA-Kundennummer's
  ciphertext and presence (the presence `CHECK` of every encrypted field); `participant_details`
  adds `knowledge_date`; `document_type_policy` adds `quarantine_roles` (filled from
  `review_roles` for the earlier versions); the enum `import_target` adds `knowledgeDate`.
  `transfer_app` selects both ASU tables and the number's presence, never its
  ciphertext, and writes none. `field_access_category` gains `asuChannel` and `asuRegistration`.
- **Changed signature:** `write_participant_data` gains `p_knowledge_date` (not after the Berlin
  date, `knowledge_date_in_future`; a null keeps the stored value): dropped by its old signature,
  created again and granted again. The audit types 0073 added are compared as text in 0074.
- **The lock order** (the shared project lock through `lock_participation` first):

  | Operation | Then |
  |---|---|
  | `set_asu_route` | the participation → `asu_record` `FOR UPDATE` |
  | `record_asu_registration` | the participation → `asu_record` `FOR SHARE` → the new `asu_registration` → `participant_identifier_data` `FOR UPDATE` (the attestation) |
  | `link_asu_proof` | the participation → the proving document `FOR SHARE` → `asu_registration` `FOR UPDATE` |
  | `set_knowledge_date` | the participation → `participant_details` `FOR UPDATE` |

- **Functions:** `lock_asu_actor` (internal): a staff user as themselves (`actor_not_allowed` in
  assisted mode or without one of the operation's roles; a consultant only while assigned), a
  `ta_tg` project (`asu_not_applicable`), an open participation (`participation_closed`).
  `set_asu_route` (the PL, the assigned consultant; `stale_revision` against the version;
  `asu_registered` once a registration exists; an unchanged route writes nothing; audited
  `asu_route_set`). `record_asu_registration` (the PL or the assigned consultant, the attestation
  the PL only): a route (`asu_route_unset`) of the version the recorder reviewed (`p_route_version`,
  `stale_revision`; read under the `FOR SHARE` lock, so a route changed meanwhile is never frozen
  unseen), not `kug_200b` (`asu_route_kug200b`), one per
  participation (`asu_registered`), a date not after the Berlin date (`registered_on_in_future`);
  with the attestation the number upper case, 4–20 letters and digits (`invalid_argument`, never
  the value), sealed with the key passed per call under the row's key (`key_unknown`), audited
  `sensitive_write` (`baCustomerNumber`); audited `asu_registration_recorded` without the number.
  `link_asu_proof` (the assigned consultant): an accepted, live `asu_proof` of the participation
  (`document_not_found`, `document_not_accepted`, `document_quarantined`,
  `document_invalidated`), a registration of it without a proof (`asu_registration_not_found`,
  `asu_proof_present`); audited `asu_proof_linked`. `set_knowledge_date` (the PL;
  `stale_value` against the date read, `knowledge_date_in_future`; an unchanged date writes
  nothing; audited `knowledge_date_set` with the kind of change). `record_audit_event` refuses the
  four new types. The fact `asuRegisteredWithProof` is the domain's `asuRegisteredSince` of the
  registration and its proving document as `dbGuardFacts` reads them in the caller's transaction,
  after the participation's lock (no reader function: the runtime role selects both).
- **Catalog version 5:** the ASU proof as `signed` evidence (immutability only, no wet signature)
  with its operations (add: the consultant and the PL; review: the consultant; delete: the PL,
  before its review; quarantine: the consultant and the PL). `quarantine_document` and
  `lift_document_quarantine` check the policy's `quarantine_roles` instead of its `review_roles`
  (replaced by `CREATE OR REPLACE`, signatures unchanged); the other document functions apply the
  policy unchanged.

## Amendment 2026-10-28: the Kug 200b and exports (Slice 6, PR 6-4b)

Migrations `0075_kug200b.sql` (generated, hand-edited) and `0076_kug200b_functions.sql`
(hand-written, the 0074 hardening); process-and-lifecycle.md (the Kug 200b offer) and
data-protection.md (generated forms, the signed Kug 200b, declaration 17, exports) hold the rules,
Q202 the readings.
- **The recreated type:** 0076 inserts the catalog's version 6 rows with `kug200b_form` in the same
  migration run, where a value from `ADD VALUE` would be an unsafe use, so 0075 recreates
  `document_type` as 0069 did: the policy FK and `document_scan` dropped, both columns to `text`,
  the five functions naming the type in their signature dropped (`current_document_policy`,
  `add_document`, `record_document_upload_rejected`, `document_link_content`, `scan_form`), the
  type recreated, the columns and the FK restored; 0076 creates the five again unchanged but for
  `scan_form`, which names the Kug 200b too. The audit types 0075 added are compared as text in
  0076.
- **Columns and tables:** `form_generation.checklist` (`jsonb`, `[{code, key}]`, exactly for the
  Kug 200b, which has no declaration snapshot, confirmed warning or Anlage:
  `form_generation_kug200b`); `consent_record.given_on` (exactly for `paper_form`) and
  `document_id` (the scan, `paper_form` only): `consent_record_paper`; `document_scan` covers
  `scanForms`' types and `document_scan_review` the Kug 200b's one date and three confirmations
  (`countersigned_on` only for the TL 407); `signed_declaration_value` takes
  `kug200bJobSeeking` and `kug200bProfileAccess` as `yes`; `kug200b_decline` (one per
  participation: the date, who and when), `kug200b_withdrawal` (the consent record it ended,
  unique; the date received, who and when; "BA informiert am" with who and when, all or none, not
  before the receipt) and `export_link` (the token's hash, the project, `export_kind`, 1–100
  document ids, the staff user, the session's hash, expiry). `transfer_app` selects the two offer
  tables, has **no privilege on `export_link`**, and writes none. `field_access_category` gains
  `kug200bOffer`.
- **Changed signature:** `record_form_generation` gains `p_checklist` and `p_employer_sha256`
  (dropped by its old signature, created again, granted again): for `kug200b` the actor is
  `lock_kug200b_actor`'s (the PL or the assigned consultant, `ta_tg`, open), `p_declarations` null,
  no confirmation, no Anlage, a valid checklist and the employer printed (the SHA-256 of the
  project's customer name); it compares the profile's revision, `form_person` and the customer name
  (`source_changed`; `update_project` writes it under the exclusive project lock, so the shared
  lock makes the comparison atomic); the TL 407 takes neither and is otherwise unchanged.
- **The lock order** (the project's advisory lock first: shared through `lock_participation`,
  exclusive for a bulk generation):

  | Operation | Then |
  |---|---|
  | `record_form_generation`, `read_kug200b_values` | the participation → the new document and generation |
  | `lock_bulk_form_generation`, then `record_form_generation` per member in the same transaction | the project's exclusive lock → the participations in UUID order (`FOR UPDATE`) → each new document and generation |
  | `review_document` (Kug 200b) | the participation → the documents in id order (the generation `FOR SHARE`, the scan `FOR UPDATE`) → `consent_record` of the purpose in force (id order, `FOR UPDATE`, only when the new paper is in force) → the new consent record |
  | `decline_kug200b_offer` | the participation → `asu_record` `FOR SHARE` → the new `kug200b_decline` |
  | `record_declaration_withdrawal` | the participation → the consent record `FOR UPDATE` → the new `kug200b_withdrawal` |
  | `record_withdrawal_ba_notice` | the participation → `kug200b_withdrawal` `FOR UPDATE` |
  | `create_export_link`, `export_link_content` | no lock: they read the documents and memberships and write the link or the audit event |

- **Functions:** `lock_kug200b_actor` (internal; `p_open` false lets a withdrawal and its BA
  notice be recorded after the end). `lock_bulk_form_generation` (the PL as themselves, `ta_tg`,
  1–100 distinct participations of the project, `participation_not_found`). `read_kug200b_values`
  (the three printed sensitive answers, each key audited `sensitive_read`, the key per call).
  `review_document` (replaced, signature unchanged): the Kug 200b's acceptance with `p_signed_on`
  and the three confirmations, no `p_countersigned_on` or declarations (`invalid_argument`),
  `signature_in_future`, `signature_before_generation`; the signed declarations, the consent record
  by the dates, never the order of acceptance (in force only if its date is after every withdrawal
  received and not before a record in force whose paper is usable, the earlier ones then ended
  `superseded`; otherwise written ended `superseded` at once, as history), audited
  `signed_declaration_recorded`, `consent_given`, `consent_ended`. `decline_kug200b_offer` (`kug200b_signed`, `asu_route_kug200b`,
  `kug200b_declined`, `declined_on_in_future`). `record_declaration_withdrawal`
  (`consent_not_found`, `consent_ended`, `received_on_in_future`, `received_before_consent`).
  `record_withdrawal_ba_notice` (`withdrawal_not_found`, `ba_notice_recorded`,
  `notified_on_in_future`, `notified_before_receipt`). `create_export_link` (`session_invalid`,
  `actor_not_allowed` in assisted mode; then visibility before any state: `document_not_found`
  for a form that isn't live, a Kug 200b or the user's to open (`export_document_visible`), then
  `invalid_argument` for more than one project, `document_quarantined`, `document_invalidated`;
  audited `export_created`, project-level) and `export_link_content`
  (`export_link_invalid`, `export_stale` through `export_document_allowed`, which is visible and
  neither quarantined nor invalidated; audited `export_downloaded`; `VOLATILE`, since it
  writes the event). `record_audit_event` refuses the four new types and `export_created`; the
  constraint `audit_event_export_of_project` keeps both export events project-level.
- **Catalog version 6:** the signed Kug 200b with the signed TL 407's operations (add and review:
  the consultant and the PL; delete: the PL, before its review; quarantine: both) and the
  generated `kug200b_form` (the signed type's open roles, `form_working_copy`, `generated`).

## Amendment 2026-10-29: Kug 200b batches (Slice 6, PR 6-5a-1)

Migrations `0077_kug200b_batches.sql` (generated) and `0078_kug200b_batch_functions.sql`
(hand-written, the 0076 hardening); process-and-lifecycle.md (Kug 200b batches) and
data-protection.md (exports, batches and submissions) hold the rules, Q203 the readings.
- **Tables:** `kug200b_batch` (Agentur key, `kug200b_batch_channel`, `kug200b_batch_artifact`,
  `kug200b_batch_status`, 1–200 members, created, submitted and discarded with who and when;
  `kug200b_batch_status` keeps them whole; the sent date not before the Berlin day it was built),
  `kug200b_batch_member` (batch, participation, scan, version, the route and placement Agentur as
  read; `active` until a discard, one live membership per participation by a partial unique
  index), `agentur_submission` (one row per attempt: participation, scan, `form_code`, version,
  Agentur, `agentur_submission_channel`, batch for a Kug 200b, sent date, who and when; one per
  batch member). `asu_registration` gains `agentur_submission_id` (exactly for the proof
  `kug200b_submission`) and the confirmation (`confirmed_on/by/at`, whole, `kug_200b` only, not
  before the registration). `export_link` gains `batch_id`: a batch kind stores the batch and no
  document ids (`export_link_batch`, `export_link_documents`). `transfer_app` selects the three
  tables and writes none. `field_access_category` gains `agenturSubmissions`.
- **What the API resolves:** the batch channel, the artifact and the outdated versions come from
  the configuration layers, which only the API reads. It takes `lock_project_setup` (the project's
  exclusive lock, which every configuration write takes), resolves them, and passes them to the
  function, which takes the lock again (re-entrant) and compares them with the batch
  (`settings_changed`).
- **The lock order** (the project's advisory lock exclusive, taken first):

  | Operation | Then |
  |---|---|
  | `create_kug200b_batch` | the participations in UUID order (`FOR UPDATE`) → their scans in id order (`FOR SHARE`) → the new batch and members |
  | `submit_kug200b_batch`, `create_kug200b_batch_export_link` (through `kug200b_batch_recheck`) | the members' participations in UUID order → their scans in id order → the batch `FOR UPDATE` → the new submissions → the new ASU registrations (or the link) |
  | `discard_kug200b_batch` | the batch `FOR UPDATE` → its members |
  | `kug200b_batch_export_content` | reads the batch, members, participations and identities |
  | `record_asu_confirmation` | shared, through `lock_participation`: the participation → `asu_registration` `FOR UPDATE` |

- **Functions:** visibility before permission before state (`lock_kug200b_batch_project`, after
  the lock: a non-member `project_not_found`, a batch the user doesn't lead `batch_not_found`;
  then `actor_not_allowed`, `asu_not_applicable`). `create_kug200b_batch` (`batch_settings_missing`
  without a channel, `document_not_found` for a scan of another project, `invalid_argument` for two
  scans of one participation, `batch_stale` with the rows in the refusal's `DETAIL`; audited
  `kug200b_batch_created`). `discard_kug200b_batch` (`batch_not_open`; `kug200b_batch_discarded`).
  `submit_kug200b_batch` (`batch_not_open`, `submitted_on_in_future`, `submitted_before_batch`,
  `batch_stale`; per member `agentur_submission_recorded` and, on `kug_200b`,
  `asu_registration_recorded`; `kug200b_batch_submitted`; returns the counts).
  `record_asu_confirmation` (`asu_registration_not_found`, `asu_not_kug200b`, `asu_confirmed`,
  `confirmed_on_in_future`, `confirmed_before_submission`; `asu_confirmation_recorded`).
  `create_kug200b_batch_export_link` (`session_invalid`, `batch_not_found`, `actor_not_allowed`,
  `batch_not_open`, `batch_stale`; `export_created`), `export_link_kind` (a live link's kind, not
  audited) and `kug200b_batch_export_content` (`export_link_invalid`, `export_stale`;
  `export_downloaded`). `export_link_content` is replaced (signature unchanged) to serve the print
  kind only, through the shared helper `live_export_link`. `kug200b_member_problem` and
  `kug200b_batch_recheck` mirror the domain's `batchEligibility` and `batchRecheck`.
  `record_audit_event` refuses the five new types; `audit_event_batch_of_project` keeps the batch's
  events project-level.
- **From the review of PR #98:** `kug200b_member_problem` refuses a participation without a route
  (`asu_route_unset`, Q203); `set_asu_route` is replaced (signature unchanged) to refuse
  `kug_200b` once a Kug 200b was submitted (`asu_kug200b_submitted`). The ASU fact's reader
  (`asuStatesOf`) takes a batch registration's submitted scan as its supporting document
  (`agentur_submission.document_id`), so a quarantined, invalidated or deleted scan withholds
  the fact and a lift dates it.

## Amendment 2026-10-29: a batch's official artifacts (Slice 6, PR 6-5a-2)

Migrations `0079_kug200a_header.sql` (generated) and `0080_kug200a_functions.sql` (hand-written,
the 0076 hardening); ba-forms.md (the Kug 200a as built) and data-protection.md (exports) hold the
rules, Q205 the readings.
- **Tables:** `project` gains `t_kug_number`, `employer_betriebsnummer` and
  `employer_economic_class` (each nullable, with its `CHECK`: the T-Kug-Nummer without `TK-`,
  eight digits, 1–100 trimmed characters). `export_kind` gains `kug200b_batch_artifact` and
  `kug200b_batch_scans`, both batch kinds of `export_link`.
- **`update_project`** gains `p_kug200a jsonb` (DROP of the old signature, CREATE, the grants
  again): an object whose keys present are set or cleared (null); any other shape is
  `invalid_argument`; audited by field name in `project_changed`.
- **`create_kug200b_batch_export_link`** and **`kug200b_batch_export_content`** are replaced
  (signatures unchanged): the link takes the three batch kinds, the scans only on `scan_email` or
  `upload` (`export_not_applicable`); the index content serves an index link only.
- **The official download, in two steps** (Q203 (6)), each under the project's exclusive lock that
  the API takes first (`lock_project_setup`) before resolving the Agentur's settings:
  `read_kug200b_batch_export` (through `lock_kug200b_official_export`: the live link of an official
  kind, else `export_link_invalid`; the PL and the open batch, else `export_stale`; the recheck
  `kug200b_batch_recheck` with the settings passed in, `export_stale` with the rows in `DETAIL`)
  returns the sources (`kug200b_batch_export_sources`), the fingerprint
  (`kug200b_batch_export_fingerprint`: SHA-256 over the kind, the batch's channel and artifact,
  the organisation's digest and the sources, the RV-Nummer as its ciphertext's digest) and, for the
  Kug 200a, each RV-Nummer decrypted with the field key (`key_unknown` for another key id), each
  read audited `sensitive_read`; for the scans each scan's key material. `record_kug200b_batch_export`
  rechecks again, recomputes the fingerprint (`source_changed`) and writes `export_downloaded`.
  `export_link_batch` names a live official link's batch (not audited), so the API knows which
  project to lock; `kug200b_batch_print_sources` gives the PL the sources for the tab's checklist
  (the RV-Nummer's digest only, nothing decrypted, not audited; `batch_not_found` for anyone else).
- **Which writer takes which lock:** everything the artifact prints is written under the
  project's lock: configuration and project fields (`update_project`, the Agentur-scoped setting)
  and attendance and appointments through `lock_project_setup` (exclusive), every participation
  write (identity, address, the RV-Nummer, the route, document reviews and quarantines,
  declaration 17's records) through `lock_participation` (shared). Under the exclusive lock the
  read and the record therefore each see one consistent state; the fingerprint catches what
  changed between them. Enum values in the SQL function `kug200b_batch_export_sources` are
  compared as text (a SQL function's body is checked when it is created, in the same migration run
  that may add them).
