# Database: evidence

## Amendment 2026-10-27: signed scans, quarantine and the TL 407 facts (Slice 6, PR 6-3b)

Migrations `0071_signed_scans.sql` (generated, hand-edited: the `UNIQUE` the scan's composite FK
references moved before the FK) and `0072_signed_scan_functions.sql` (hand-written, the 0070
hardening); data-protection.md ("Signed scans, signed declarations and quarantine") holds the
rules.
- **Columns and tables:** `document` adds the scan's `scan_origin` (`generated`,
  `external_paper`), `generation_document_id` (a composite FK with `participation_id` and
  `form_code` to `form_generation`, whose `(document_id, participation_id, form_code)` is unique:
  a generation of the same participation and form), `form_code` / `form_version` (a generated
  scan's from its generation at the add, external paper's at the acceptance), `signed_on` /
  `countersigned_on` (the participant's and the profiler's actual signature dates) and
  `review_confirmations`, set exactly for an accepted scan (`document_scan_review`), the quarantine
  (`quarantine_reason`, `quarantined_by`, `quarantined_at`, all or none; the last
  `quarantine_lifted_at`) and `invalidated_by_correction` (set by the corrections of a later PR).
  `signed_declaration` holds one row per declaration of an accepted signed form (`project_id`, the
  scan, form code and version, `declaration`, `value` as marked or null, the later signature
  date, who recorded it and when; unique per scan and declaration). `transfer_app` selects the new
  `document` columns and `signed_declaration`, and writes neither.
- **Changed signatures:** `add_document` gains `p_scan_origin` and `p_generation_document_id`,
  `review_document` gains `p_signed_on`, `p_countersigned_on`, `p_confirmations`,
  `p_form_version` and `p_declarations` (all defaulted): both are dropped by their old signature,
  created again and granted again. The audit types 0071 added are compared as text in 0072.
- **The lock order:**

  | Operation | Project lock | Then |
  |---|---|---|
  | `add_document` of a generated scan | shared (`lock_document_actor`) | the participation → the generation's document `FOR SHARE` → the new document |
  | `review_document`, `quarantine_document`, `lift_document_quarantine`, `delete_document` | shared | the participation → its documents in id order (`FOR SHARE` the generation a scan names, `FOR UPDATE` the one changed) |
  | `profiling_done` (`apply_status_change`) | shared (held) | the participation (held) → the accepted TL 407 scan `FOR SHARE` |

- **Functions:** `add_document` takes a scan type's origin (`invalid_argument` without, or with
  one for another type), refuses a signed type on someone's behalf (`actor_not_allowed`) and a
  generation of another participation or form (`generation_not_found`). `review_document`: a
  quarantined document `document_quarantined`, a scan after the end `participation_closed`; a
  scan's acceptance needs both dates (none after the Berlin date, `signature_in_future`; for a
  generated scan none before its generation's Berlin date, `signature_before_generation`), both
  confirmations, external paper's version and the declarations (`as_printed` copies the
  generation's snapshot, a generated scan only; `as_marked` takes the values); it writes the
  `signed_declaration` rows and audits `signed_declaration_recorded`; `document_reviewed` names a
  scan's origin and accepted version. `delete_document`: a signed type by its delete roles before
  its review only, as `wrong_person` or `wrong_file` (`delete_reason_not_allowed`), else
  `document_immutable`. `quarantine_document` (the review roles, normal mode, once:
  `document_quarantined`) and `lift_document_quarantine` (whoever quarantined it or the PL;
  `document_not_quarantined`), each audited. `open_document` and `document_link_content` refuse a
  quarantined document. `tl407_facts(uuid[])` (SECURITY DEFINER, read-only, one row per
  participation with a fact, so the work list reads all at once) returns the dated `tl407Signed`
  and `profilingDone` from the accepted, live, unquarantined, uninvalidated scans (internally
  `tl407_evidence` for one participation), `profilingDone` only while such a scan signed by
  `profiling_done_on` supports it; `apply_status_change` holds that scan for `profiling_done` and
  refuses a date before its later signature date (`effective_date_before_signature`); the guard
  itself stays the status service's, since dated guards are checked in TypeScript by this ADR's
  architecture (Q200). `record_audit_event` refuses the three new types.
- **Catalog version 4:** the signed TL 407's add and review roles (the consultant and the PL) and
  delete role (the PL); documents of earlier versions keep their rows.
