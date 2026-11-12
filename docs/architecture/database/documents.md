# Database: documents

## Amendment 2026-10-22: documents (Slice 4b, PR 4b-2)

Migrations `0053_documents.sql` (generated) and `0054_document_functions.sql` (hand-written, the
0052 hardening); data-protection.md ("Uploads", documents) holds the rules.
- **`document_type_policy`** (reference data, written only by migrations): per document type and
  catalog version the retention class, whether the file name is kept, signed, and the roles that
  add, review, delete and open (`participant` and project roles; empty while the type's operations
  are undecided, Q65). A drift test holds it equal to the domain's `documentTypeCatalog`; a new
  catalog version is a migration adding its rows. Opening in assisted mode or through break-glass
  (the PL's `assisted_or_break_glass` and `metadata_break_glass_open` rights) comes with the types'
  slices.
- **`document`**: one row per stored file, never its content: type, catalog version and retention
  class (a composite FK to the policy, so a row has its type's class: retention per row,
  ADR-0008, `by_document_type` in the data catalog), media type, size (1 B–10 MB), the content's
  SHA-256, the kept file name, the key id and the wrapped data key, who added it (actor kind, staff
  id, on behalf), the review (state, reason, reviewer, time) and a deletion's tombstone (who by
  kind, reason; the file name erased by a `CHECK`) and `purged_at`. `transfer_app` selects every
  column but `wrapped_key` and `content_sha256` (column grants) and writes none.
- **`document_link`**: an opening's link: the SHA-256 of 32 random bytes, the document, the
  session's kind and hash, `expires_at` (60 s). `transfer_app` has no privilege on it.
- **Functions** (granted): `add_document` (the upload, after the API scanned, encrypted and
  stored the object; refuses `participation_closed`, `document_type_not_supported`,
  `actor_not_allowed`, `document_limit`, `upload_rate_limited`; audited `document_added` with the
  source `portal` / `staff` / `assisted`), `record_document_upload_rejected` (the audit event only,
  the same actor checks), `open_document` (the open right again, a live session of the caller,
  inserts the link, audited `document_opened`), `document_link_content` (the only path that returns
  the wrapped key: a live link of that live session and a live document; not audited again),
  `review_document` (normal mode, once: `document_reviewed`), `delete_document` (staff with a
  reason in normal mode, the participant their own while not accepted: `document_accepted`; signed
  types `document_immutable`) and `record_document_purged` (the purge job; idempotent, refuses a
  live document). The actor is found by the internal `lock_document_actor`: the participation
  locked first, the participant through their live active session, staff in assisted mode through
  `lock_assisted_mode`, staff in normal mode by their project roles (`document_staff_roles`, the
  consultant while assigned). The five document event types and `document_opened` are reserved
  (`record_audit_event` refuses them); their details carry ids and codes, never a file name, the
  content or its hash.
