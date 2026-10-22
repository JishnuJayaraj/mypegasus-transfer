# Slice 4b — Uploads and documents (F5)

Status: **proposed**, awaiting approval (no implementation before it).
Roadmap: uploads with storage and virus-scan adapters (mocks), a file-type allowlist, signed URLs,
document records with a retention class. Builds on the document-type catalog
(`packages/domain/src/documents/catalog.ts`, Q87 B), `decideAccess` for documents
(`packages/domain/src/access/decide.ts`), the completeness engine's document states
(`packages/domain/src/completeness/engine.ts`), the wizard and assisted mode of Slice 4a
(`@transfer/self-service-ui`, ADR-0007) and the rules in `data-protection.md` ("Uploads",
documents, access matrix), ADR-0002, ADR-0006, ADR-0008, ADR-0010 and ADR-0011.
The open questions this plan needs are Q142–Q149 in `docs/open-questions.md`, each with a proposed
answer marked `assumed`; the decisions below build on those answers.

## Decisions

- **D1. Scope: the participant's own document types** (Q142). This slice builds the document
  infrastructure for every type and wires three: `cv` (Lebenslauf, new), `participant_upload`
  (other uploads) and `qualification_certificate`. The signed scans (`tl407_signed_scan`,
  `kug200b_signed_scan`) and `asu_proof` come with Slice 6, `dsv_signed_scan` and
  `dsv_cancellation` with Slice 7, `profiling_exception_evidence` with Slice 6 (where
  `profiling_exception_request.evidence_record_id` becomes a document reference): their
  operations (received by, original location, submission, guards) belong to those slices. The
  upload routes refuse other types (`document_type_not_supported`).
- **D2. Catalog version 2** (Q142, Q145, Q146, Q148): adds `cv`; the three types get retention
  `personnel_file` (v1 had `participation_record`); every type gets `add`, `review` and `delete`
  rights per role (only the three types have any; the others stay `undecided`, Q65, until their
  slice) and `fileName` (whether the original file name is kept: the three types only).
- **D3. Upload transport: base64 in JSON** (ADR-0010, "uploads are JSON"). `POST` with
  `{ type, fileName, content }`; the file decoded at most **10 MB**, the body of the upload
  routes at most **14 MB** (every other route keeps 100 kB). Like the import, an API process
  handles at most 2 uploads at once with up to 4 waiting ≤ 20 s, else `503 upload_busy` with
  `Retry-After`. Not chosen: multipart (a second body parser and an exception to JSON-only and
  strict schemas) and a direct signed upload to the object store (CSP `connect-src` to the store's
  origin, a public store endpoint, the provider would see plaintext, and nothing is scanned before
  it is stored).
- **D4. File types by content** (Q143): PDF, JPEG and PNG, detected by their magic bytes; the
  client's MIME type and the extension are ignored. Empty files, other types (Office, HEIC,
  archives, SVG, HTML) are refused. 50 live documents per participation; 20 uploads per
  participation and hour.
- **D5. Scan before storing, in the request** (Q144): decode → detect type → `VirusScanner` →
  encrypt → store → record. An infected or unscannable file is never stored: `422` with the code
  (`file_infected`, `file_unscannable`) and the audit event `document_upload_rejected` (type and
  code). An unavailable scanner is `503 scan_unavailable` and nothing is stored. Not chosen: an
  asynchronous scan job (a pending state, a quarantine and purge of unscanned objects, polling in
  both apps, completeness over unscanned files); a stored file is always a clean one.
- **D6. Every file is encrypted by the API before storage** (CLAUDE.md rule 9; data-protection.md:
  signed documents encrypted): AES-256-GCM with a random 256-bit data key per document, wrapped
  (AES-256-GCM) under a key HKDF-derived (`document-encryption:v1`) from the new
  `DOCUMENT_ENCRYPTION_KEY`; a 64-bit `key_id` per row like field encryption. The additional data
  binds document id, participation id, type and format version, so an object copied to another
  row fails. Object layout `TPD1 | nonce | ciphertext | tag`, key `documents/<documentId>`: no
  name, project or person in a key. The store and its operator never see plaintext. A root of its
  own, not `FIELD_ENCRYPTION_KEY`: the object store and its backups are another trust domain than
  the database. Rotation re-wraps the data keys (a later migration). The runtime role never
  selects the wrapped key; only the opening path returns it.
- **D7. Opening is a logged action; the signed URL is the API's own** (Q147). `POST …/opening`
  checks access, audits `document_opened` and creates a `document_link` (32 random bytes, only
  their SHA-256 stored, bound to the session that asked, valid 60 s); it answers
  `{ url: "/api/v1/document-content/<token>", expiresAt }` (`no-store`). The browser navigates
  there; the `GET` needs the same live session, decrypts, checks the tag and answers the file as
  `attachment` (`Content-Type` the detected type, `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; sandbox`). Reusable
  within the 60 s (mobile viewers request twice); each opening is one audit event. No CSP change:
  same origin, a top-level download, no `blob:`.
- **D8. Who adds, reviews and deletes** (Q146, the Q65 document cells): the participant adds the
  three types in the portal; the assigned consultant and the PL add them in normal mode as
  themselves, and in assisted mode as actor + `onBehalfOf`; back office has no right on them
  (certificates not before Slice 8). The participant sees every document of these types in their
  participation, whoever added it. Review by the assigned consultant or the PL; deletion by the
  participant (own, not accepted) or the assigned consultant or PL (any, with a reason code).
- **D9. Review** (process-and-lifecycle.md, the engine's document states): a document is
  `uploaded` until reviewed once, `accepted` or `rejected` with a code (`unreadable`,
  `wrong_document`, `incomplete`); the review is final (a new upload replaces a wrong one).
  Completeness counts live documents only: `uploaded`, `accepted`, `rejected` as the engine
  defines them; deleted documents count nothing.
- **D10. Deletion and replacement** (Q146): nothing is replaced in place; a new upload is a new
  document. Deleting keeps the row as a tombstone (type, dates, who by kind, reason code; the file
  name erased) and purges the object through the job `documents.purge-object` (`{ documentId }`,
  queued in the deleting transaction; ADR-0011). Codes: `wrong_person`, `wrong_file`,
  `duplicate`, `participant_request`; a participant's own deletion has none. No deletion of
  another type before its slice; signed types never (retention job only).
- **D11. File names** (Q148): kept only for the three types, as confidential metadata (trimmed,
  no control characters, 1–200 characters, path parts dropped), shown to whoever reads the
  metadata, never in an audit entry, log, object key or error; the download's name otherwise is
  generated (`<type>-<date>.<ext>`).
- **D12. Adapters** (ADR-0006): `FileStorage` (`put`, `get`, `delete`; `delete` of a missing key
  succeeds) with `MemoryFileStorage` (tests) and `FilesystemFileStorage` (development and e2e,
  `STORAGE_DIR`, default `.data/documents`, git-ignored, outside the web root); `VirusScanner`
  (`scan(bytes)` → `clean` / `infected` / `unscannable`, throws `ScannerUnavailable`) with
  `MockVirusScanner` (the EICAR test string `infected`, a PDF with `/Encrypt` `unscannable`, else
  `clean`; switchable to unavailable in tests). Like the mail mocks, neither is wired with
  `NODE_ENV=production`: uploads and openings answer `503 storage_unavailable` there until an
  S3-compatible store and a ClamAV scanner exist with contract tests and their AVV (pre-pilot,
  Q149).
- **D13. The wizard gets a page "Unterlagen"** (`documents`, after "Weitere Angaben", before the
  overview; PRD F5): one section per type, the documents with their state, "Öffnen", "Löschen"
  where allowed, and an upload. It has no fields and no revision; it is complete when no document
  item of its types is missing (a template's `documentPresent` rule; none in the base defaults).
  The wizard's and the "Selbstauskunft" tab's missing items take the participation's document
  states (until now `documents: {}`).
- **D14. Staff tab "Unterlagen"** on the participation detail (normal mode): the documents of the
  types the viewer may read, upload, open, review and delete per capability. In assisted mode the
  wizard's "Unterlagen" page lists, adds (on behalf) and opens; review and deletion stay on the tab.
- **D15. Refusals:** a terminal participation takes no upload (`participation_closed`); staff
  deletions stay possible (a wrong-person upload). An unassigned consultant gets `404` as for the
  participation.
- **D16. Housekeeping:** `architecture/overview.md` dates `packages/forms` to Slice 4b; it is
  Slice 6 (roadmap).

## PRs

One planned PR = one branch, each based on `main` after its predecessor merged (none stacked).
Three PRs: the slice is about 3,400 lines excluding tests and generated code, and splits into
pure building blocks, the persistent path and the UI.

| PR | Scope | Est. lines |
|---|---|---|
| 4b-1 | Building blocks (D2, D4, D6, D11, D12, D16): catalog v2, document permissions and the generated matrix, file detection and limits, file-name rules, `FileStorage` and `VirusScanner` with their mocks, the document cipher, env | ~800 |
| 4b-2 | Documents in the database and API (D1, D3, D5, D7–D10, D15): tables, functions, grants, audit events, portal/staff/assisted/content routes, the upload gate, the purge job, completeness facts (D13 data) | ~1,400 |
| 4b-3 | The UI (D13, D14): the documents page in `@transfer/self-service-ui`, the portal wizard page, the staff tab, the assisted page, de/en; the slice e2e; archive the plan | ~1,200 |

## Design

### Data model

New tables (data catalog; every table with participant data has `project_id`; periods stay
`unset` until Slice 7):

| Table | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|
| `document` | id, project, participation (composite FK), `type` (enum), `catalog_version`, `retention_class` (the type's, held by a CHECK against `document_type_policy`), `media_type` (`application/pdf`, `image/jpeg`, `image/png`), `size_bytes` (1 B–10 MB), `content_sha256` (integrity, the exception evidence fingerprint later; never served), `file_name` (null unless the type keeps one), `key_id`, `wrapped_key`, added by (`participant` / staff id, `on_behalf_of`), `added_at`; `review_state` (`unreviewed`, `accepted`, `rejected`), `review_reason`, reviewer, time; `deleted_at`, deleted by, `delete_reason`, `purged_at` | confidential (metadata; the file's class is its type's) / the type's category | per row: the type's (`by_document_type` in the data catalog; a test maps every catalog type to a class) |
| `document_link` | the token's SHA-256, document, project, participation, session kind (`staff`, `participant`) and hash, `expires_at`, `created_at` | internal / `case_internal` | `access_credential` (Q122: 30 days after expiry) |
| `document_type_policy` | per type and catalog version: retention class, `file_name`, who may add (participant, project roles), review, delete, open; a drift test holds it equal to the domain catalog | no personal data | `reference_data` |

Domain (4b-1): `DocumentType` adds `cv`; `DocumentReviewReason`, `DocumentDeleteReason`,
`DocumentMediaType`; `documentState(row)` maps a live row to the engine's `DocumentState`;
`detectFileType(bytes)`, `documentFileName(name)`, `documentLimits` (10 MB, 50 live, 20 per hour).
Permissions: `mayAddDocument`, `mayReviewDocument`, `mayDeleteDocument(subject, type, target,
mode, { addedByParticipant, accepted })` beside `decideAccess` (which keeps `open_document` and
`read`; its `write` stays `via_domain_operation`). The generated access matrix adds a table
"Document operations" (type × role × add/review/delete).

### Functions and grants (hand-written, SECURITY DEFINER, audit in the same transaction)

- `add_document(context, participation, document id, type, media type, size, sha256, file name,
  key id, wrapped key, token hash)`: the participant through their live `active` session, staff
  in normal mode by the type's `add` roles, staff in assisted mode through `lock_assisted_mode`;
  under the participation lock refuses `participation_closed`, `document_type_not_supported`,
  `actor_not_allowed`, `document_limit`, `upload_rate_limited`. Audits `document_added` (id, type,
  source `portal` / `staff` / `assisted`).
- `record_document_upload_rejected(context, participation, type, code, token hash)`: the audit
  event only, the same actor checks.
- `open_document(context, document, session kind, session hash, link hash)` → `expires_at`: the
  open right again (participant own; staff by the policy's roles, the consultant while assigned),
  a live document; inserts the link and audits `document_opened` (exists).
- `document_link_content(link hash, session kind, session hash)` → participation, type, media
  type, file name, key id, wrapped key: only for a live link of that live session and a live
  document; not audited again (the opening was).
- `review_document(context, document, decision, reason)` (`document_reviewed`),
  `delete_document(context, document, reason, token hash)` (`document_deleted`; queues the purge
  in the caller's transaction through the API), `record_document_purged(document)` (system,
  idempotent).
- Audit events (reserved: `record_audit_event` refuses them): `document_added`,
  `document_reviewed`, `document_deleted` in the `case` stream; `document_upload_rejected` in
  `security` with `document_opened`. Ids and codes only; never a file name or content.
- Grants: `transfer_app` selects `document` except `wrapped_key` and `content_sha256` (column
  grants), selects `document_type_policy`, has no privilege on `document_link`, writes none.

### Upload path (4b-2)

`POST` → body limit 14 MB → strict schema (`content` base64, `fileName`, `type`) → session and
visibility (404) → operation permission (403) → the upload gate → decode (`422 file_too_large`,
`file_empty`) → `detectFileType` (`422 file_type_not_allowed`) → scan (`422 file_infected` /
`file_unscannable` + `record_document_upload_rejected`; `503 scan_unavailable`) → encrypt → `put`
(`503 storage_unavailable`) → `add_document` in one transaction (on a refusal the object is
deleted at once; an object left by a crash between `put` and commit is the Slice 7 retention
job's, which reconciles objects without a row). Logs carry the request id, participation id,
type, size bucket and outcome; never a name, content or hash.

### API (`/api/v1`, OpenAPI, RFC 9457)

| Route | Does |
|---|---|
| `GET /portal/documents` | own documents of the three types (metadata, capabilities), the types the participant may add, the limits |
| `POST /portal/documents` | upload (`201` `Document`) |
| `POST /portal/documents/{documentId}/opening` | `201` `{ url, expiresAt }` |
| `DELETE /portal/documents/{documentId}` | own, not accepted (`204`) |
| `GET /participations/{id}/documents` | the types the viewer may read, with capabilities and `addableTypes` |
| `POST /participations/{id}/documents` | staff upload in normal mode |
| `POST /participations/{id}/documents/{documentId}/opening` | as above, staff session |
| `POST /participations/{id}/documents/{documentId}/review` | `{ decision, reasonCode? }` |
| `DELETE /participations/{id}/documents/{documentId}?reasonCode=` | staff deletion (strict query) |
| `GET`/`POST /participations/{id}/assisted/documents?assistedModeId=`, `POST …/assisted/documents/{documentId}/opening?assistedModeId=` | the page in assisted mode |
| `GET /document-content/{token}` | the file (D7) |

`Document`: `{ id, type, mediaType, sizeBytes, fileName | null, addedAt, addedBy: participant |
staff, onBehalf, review: { state, reasonCode, reviewedAt }, capabilities: { open, review, delete
} }`. Nested ids of another participation are `404`. New codes: `document_type_not_supported`,
`file_too_large`, `file_empty`, `file_type_not_allowed`, `file_infected`, `file_unscannable`,
`document_limit`, `document_reviewed` (a second review), `document_accepted` (a participant
deleting an accepted one); `429 rate_limited` for `upload_rate_limited`; `503 upload_busy`,
`scan_unavailable`, `storage_unavailable`; a dead link or another session is `404`.

### Jobs (4b-2)

`documents.purge-object` (`exclusive`, `singletonKey` the document id, retries with backoff): reads
nothing but the id, deletes `documents/<id>` and records `purged_at`. Without pg-boss
(`JOBS_ENABLED=false`: tests, e2e) the API runs the same handler after the response
(`detached.ts`). Logs: job, id, document id, outcome.

### Portal and shared UI (4b-3)

`@transfer/self-service-ui` gets `DocumentsPage` and a `DocumentSource` (`list`, `upload`, `open`,
`remove?`), with a portal source and an assisted one. The file is read with `FileReader` into
base64 in memory (no preview, nothing in browser storage); the input accepts
`.pdf,.jpg,.jpeg,.png`; the size is checked before sending. "Öffnen" posts the opening and then
assigns `location` to the URL. Errors per code ("Datei zu groß (höchstens 10 MB)", "Nur PDF, JPG
oder PNG", "Die Datei wurde nicht angenommen, weil sie Schadsoftware enthalten könnte"). Copy asks
for no health documents (no diagnoses or medical certificates here). Mobile-first, logical CSS
properties, de/en.

### Web UI (4b-3)

Tab "Unterlagen": a table (Art, Datei, Größe, hinzugefügt am / von Teilnehmer·in oder Team,
Status) with "Öffnen", "Annehmen", "Ablehnen" (reason), "Löschen" (reason, confirmation) per
capability, and "Unterlagen hinzufügen" (type, file). German only.

## User flows

1. **Participant:** "Meine Angaben" → "Unterlagen" → uploads a Lebenslauf (PDF) → listed as
   "hochgeladen" → "Öffnen" downloads it → a second file with the EICAR string is refused with the
   message; nothing is stored.
2. **Consultant:** detail → "Unterlagen" → opens the CV (logged) → rejects a blurred certificate
   as `unreadable` → the participant sees "abgelehnt: nicht lesbar", deletes it and uploads again.
3. **PL, normal mode:** uploads a certificate the participant handed over on paper; deletes a
   document uploaded for the wrong person (`wrong_person`): the file is purged, the tombstone and
   the audit trail remain.
4. **Assisted (consultant, phone):** in the wizard's "Unterlagen" page uploads on behalf;
   recorded as actor + `onBehalfOf`.

## Acceptance criteria

**4b-1**
- Catalog v2: `cv` exists; the three types have `personnel_file`, file names and add, review and
  delete rights per D8; the other types' operations are `undecided` (Q65) in the generated matrix.
- Domain tests (100 % coverage) for every document operation cell, `detectFileType` (PDF, JPEG,
  PNG accepted; SVG, HTML, ZIP, Office, HEIC and a PDF extension on a PNG refused or detected by
  content), the file-name rules and the limits.
- Adapter tests: memory and filesystem storage share one contract test; the mock scanner's three
  verdicts and its unavailable mode.
- The cipher round-trips; a changed byte, another document id, participation or type, or another
  key fails (`key_unknown` for another key id); no plaintext in the object.
- The API refuses to start outside development without `DOCUMENT_ENCRYPTION_KEY`.

**4b-2**
- Integration: an upload stores one encrypted object and one row, audited `document_added`; the
  runtime role can't select `wrapped_key` or `content_sha256` or touch `document_link`; every
  function refusal of D1, D4, D8, D15 per actor (participant, PL, assigned and unassigned
  consultant, back office, assisted mode, an `activating` session).
- An infected or unscannable file leaves no object and no row, only `document_upload_rejected`;
  an unavailable scanner or store leaves nothing; with `NODE_ENV=production` uploads are `503`.
- Opening audits `document_opened` and returns a link that works for 60 s and only with the same
  live session; the download carries the D7 headers and the exact bytes.
- Review and deletion per role; a deleted document's object is gone, its row a tombstone without
  file name; completeness counts live documents only (a template rule `documentPresent cv`
  missing → satisfied → `not_accepted` after a rejection).
- Body limits: 14 MB on the upload routes only; the gate answers `503 upload_busy`.
- Log capture: no file name, content, hash, token or key in logs, errors or audit details.

**4b-3**
- Component tests: the documents page (list, upload with its busy state, the error codes, open,
  delete confirmation), the staff tab (capabilities decide every button), de/en.
- e2e (no code submission: `loggedInAsOwner`, participants.ts; the suite fails on any CSP
  violation): the participant uploads a synthetic CV PDF in the wizard and downloads it; an EICAR
  file is refused; the assigned consultant rejects a synthetic certificate as unreadable on the
  tab; the participant sees it rejected and deletes it. Fixtures: synthetic files in
  `fixtures/documents/`; the EICAR string assembled at runtime, never committed.

## Docs updated by the PRs

- 4b-1: `data-protection.md` (document table: `cv`, retention, who adds/reviews/deletes, file
  names, encryption of files), ADR-0006 (storage and scanner as built, production wiring, file
  encryption), the generated access matrix, `architecture/overview.md` (adapters; D16),
  `.env.example` (`DOCUMENT_ENCRYPTION_KEY`, `STORAGE_ADAPTER`, `STORAGE_DIR`,
  `VIRUS_SCAN_ADAPTER`), `.gitignore`.
- 4b-2: ADR-0002 (tables, functions, grants), ADR-0010 (upload transport, limits, routes, codes,
  the content route), ADR-0011 (the purge job), ADR-0005 (memory per pod; pre-pilot: S3 and
  ClamAV adapters, bucket without public access and with versions kept ≤ 30 days, Q149),
  `data-protection.md` (retention table rows, "Uploads" as built), `process-and-lifecycle.md`
  (document review).
- 4b-3: `data-protection.md` (portal and staff views), `regional-variation.md` (the wizard page
  and document rules), ADR-0007 (documents in assisted mode), `roadmap.md` (4b done); this plan
  moves to `plans/archive/`.
