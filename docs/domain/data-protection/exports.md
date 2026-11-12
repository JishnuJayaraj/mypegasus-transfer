# Data protection: exports

### Exports *(accepted, Q159; as built in Slice 6, PRs 6-4b, 6-5a-1 and 6-5a-2)*

- **An export is issued by a logged request** (`POST /exports/{kind}`; `create_export_link`):
  staff as themselves through a live session (in assisted mode `403`); the kind `kug200b_print`
  covers 1–100 live, unquarantined generated Kug 200b forms of one project, each the requester's
  to open now (the type's open roles, a consultant only while assigned). **Visibility comes
  first:** a form that doesn't exist, is deleted, is of another type or isn't the requester's to
  open is `404` whatever its state (`export_document_visible`); only for forms they see do forms
  of more than one project, quarantine and invalidation answer `422`. It stores a link: the SHA-256 of 32 random
  bytes (never the token), the kind, the document ids fixed at the request, the staff user and the
  session's hash, valid 60 seconds (`export_link`, `internal`, class `access_credential`; the
  runtime role has no privilege on it). Audited `export_created` (the kind and count; security,
  project-level, never in a history and never the ids).
- **The download re-authorizes** (`GET /export-content/{token}`; `export_link_content`): only the
  user and session that asked, within the 60 seconds (else `404`); every document again: still
  live, not quarantined or invalidated, still the user's to open (else `422 export_stale`, nothing
  served). The output is rendered at that moment from the immutable generated forms (one merged
  PDF, `attachment`, `no-store`, `nosniff`, and the download policy `default-src 'none'; sandbox`
  as a document's download), streamed and stored nowhere. Every download is audited
  `export_downloaded` (kind and count).
- **A batch's work list** (`kug200b_batch_index`, Slice 6, PR 6-5a-1): `POST /exports/kug200b_batch_index`
  with `{ batchId }` (`create_kug200b_batch_export_link`): an open batch the requester leads as the
  project's PL (anyone else `404` whatever its state), rechecked under the project's exclusive lock
  (`422 batch_stale` with its rows); the link stores the batch, no document ids. The download
  (`kug200b_batch_export_content`) re-authorizes the PL, the open batch and every member, reads the
  names in the same locked call and streams a CSV (`;`, BOM, the formula guard) with the download
  policy; nothing is stored. Last name, first name and form version only: the PL's working list,
  never sent to the Agentur. The settings are checked at the issuance only, accepted for this
  internal list (Q203 (6)); the official artifacts take the full recheck at the download.
- **A batch's official artifacts** (Slice 6, PR 6-5a-2; Q203 (6), Q205): `kug200b_batch_artifact`
  (the Kug 200a, or the alternative list the Agentur accepted) and `kug200b_batch_scans` (the
  members' accepted scans, only on the channels `scan_email` and `upload`, else
  `422 export_not_applicable`), issued like the work list. **The download rechecks everything, the
  settings included**, in two steps, each under the project's exclusive lock (which every writer
  of what they print takes or conflicts with: configuration and project writes and attendance
  through `lock_project_setup`, every participation write, the participant's own and document
  reviews and quarantines through `lock_participation`): the API resolves the Agentur's channel,
  artifact and outdated versions under the lock, `read_kug200b_batch_export` rechecks the PL, the
  open batch, the settings and every member (`422 export_stale`) and reads what is printed and its
  fingerprint; the API renders; `record_kug200b_batch_export` rechecks again and compares the
  fingerprint of everything printed (the project's customer and header fields, the
  organisation's, the names, addresses, RV-Nummern as their ciphertexts' digests, TG dates,
  where declaration 17 in force is, info-event attendance; for the scans each scan and its content digest)
  before it writes `export_downloaded` (`409 source_changed` otherwise, nothing served). A
  quarantined, invalidated or deleted scan makes the batch stale, so it never goes into a scans
  PDF. Streamed with the download policy, stored nowhere.
- **The Kug 200a's values** (ba-forms.md, the Kug 200a as built): name, address, the effective
  TG dates, where declaration 17 in force is and info-event attendance as the PL reads them for the batch;
  the **RV-Nummer** (highly confidential) only through `read_kug200b_batch_export`, a read bound to
  this purpose, decrypted per member at each download and each read audited `sensitive_read` (key
  `pensionInsuranceNumber`), the values going only into the file. The tab's handwriting checklist
  uses the RV-Nummer's presence only (`kug200b_batch_print_sources`, nothing decrypted or
  audited) and carries codes, keys and members, never a value. The header's project fields (the
  T-Kug-Nummer, the employer's Betriebsnummer and Branche/WK) are project data (`project`,
  `internal`, `project_master`), no personal data, set by the PL and audited by field name in
  `project_changed`.
- **Batches and submissions** (process-and-lifecycle.md, Kug 200b batches): `kug200b_batch`
  (project data: Agentur, channel, artifact, status, dates, counts, staff ids; `internal`,
  `project_master`), `kug200b_batch_member` and `agentur_submission` (`internal`, `case_internal`
  as `agenturSubmissions`; `participation_record`, the proof of submission). The runtime role
  selects them and writes none; the functions write them under the project's exclusive lock. The
  member's history shows its submission (form, version, channel, date, batch) in the `profiling`
  stream and the Agentur's confirmation in `case`; the batch's own events are project-level.
- **The TL 407's submissions** (process-and-lifecycle.md, TL 407 submission; Slice 6, PR 6-5b):
  `agentur_submission` rows of the TL 407 also keep whether the original was required, "Original
  versandt am" (or, after a resubmission, the link to the earlier dispatch the Agentur still
  holds, Q206 (4)) and the Agentur's rejection (date, reason), each with who recorded it when; the
  same classification and `participation_record` (no new personal data beyond dates and codes).
  The PL records them (`submit_tl407`, `record_original_sent`, `record_agentur_rejection`, under
  the participation's lock); the PL and the assigned consultant read them on "Profiling"; the
  `profiling` stream shows `agentur_submission_original_sent` (date) and
  `agentur_submission_rejected` (date, reason) and `agentur_submission_original_retained` (date).
- Logs carry ids, codes and counts, never a token, a value or a file's content. The bound: a print
  file ≤ 100 forms; a batch ≤ 200 members.

## Customer reporting *(assumed, Q5, Q13, Q47)*

- **No person-level data to the customer, except a fixed whitelist**: name, Personalnummer,
  DSV signed (yes/no + date), beE entry date, beE exit date. The customer needs these to end
  the old employment relationships and calculate per-head costs and Remanenzkosten. The
  whitelist is enforced in the API/report layer (`customerVisible`), not in the UI.
- Everything else is **aggregated with n < 5 suppressed** ("< 5"), plus **secondary
  suppression** so totals can't be used to back-calculate. The threshold is a global setting
  (default 5), implemented in the reporting layer.
- MVP: the PL generates a **monthly report** (PDF + CSV) and sends it to the customer. A
  customer portal is deferred to v2.
- Withdrawal after `dsv_signed` sets a **customer notification flag** (Q46).
