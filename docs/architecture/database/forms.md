# Database: forms

## Amendment 2026-10-26: generated forms (Slice 6, PR 6-3a)

Migrations `0069_generated_forms.sql` (generated, hand-edited) and
`0070_generated_form_functions.sql` (hand-written, the 0068 hardening); data-protection.md
("Generated forms and the readiness projection") holds the rules.
- **A new value of an existing enum used in the same run:** 0070 inserts the catalog's version 3
  policy rows with `tl407_form`, which a value from `ALTER TYPE … ADD VALUE` in the same migration
  transaction can't be (an unsafe use). 0069 therefore recreates `document_type`, as 0041 did for
  `edge_kind`: the policy FK dropped, `document.type` and `document_type_policy.type` to text, the
  four functions that name the type in their signature dropped (`current_document_policy`,
  `add_document`, `record_document_upload_rejected`, `document_link_content`), the type dropped
  and created with the new value, the columns and the FK back; 0070 creates the four functions
  again with their grants, `add_document` with upload limits that count uploads only (documents of
  a `generated` policy don't count against the 50 live or 20 an hour). The next added document
  type takes the same path.
- **Tables:** `form_generation` (one row per generated document: `document_id` unique, the enum
  `form_code`, `form_version` as `MM-JJJJ`, the four source revisions ≥ 0, the readiness's
  `source_token` and the `organisation_sha256` (SHA-256 hex each), the printed `jobboerse_choice`
  and `ba_contact_consent`, `confirmed_warnings` within the known codes, the
  Anlage, who generated it and when; `project_id` and the composite FK to the participation);
  `document_type_policy.generated` (default false; true for `tl407_form`). `transfer_app` selects
  `form_generation` and writes neither; the document's ciphertext and wrapped key stay out of its
  reach as before.
- **The lock order:**

  | Operation | Project lock | Then |
  |---|---|---|
  | `record_form_generation` | shared (`lock_participation` through `lock_profiler`) | the participation → the new document → its generation; the source rows whose revisions it compares are written only under the same participation lock |

- **Functions:** `record_form_generation(context, participation, generation id, document id,
  form code, version, sources, person, source token, organisation hash, declarations, confirmed
  warnings, anlage, size, hash, key id, wrapped key)`: the assigned consultant as themselves while
  open (`lock_profiler`); only the TL 407 so far (`form_not_supported`); `invalid_argument` for a
  malformed version, provenance (`form_sources_valid`), person (`form_person_valid`), token or hash,
  declaration snapshot (`form_declarations_valid`) or an unknown or repeated warning code;
  `source_changed` when a revision moved, the person printed differs from the stored one (internal
  `form_person`: names and birth date, the contact details, the effective contractual TG dates;
  they have no revision of their own) or the printed declarations aren't the pending ones; inserts the document (type `tl407_form`, the current policy) and its
  generation; audits `form_generated` and one `warning_confirmed` per confirmed code (the code as
  its reason code). `delete_document` answers `document_immutable` for a generated type as for a
  signed one; `add_document` refuses it (`document_type_not_supported`, no add role) and
  `review_document` (`actor_not_allowed`). `record_audit_event` refuses `form_generated`.
