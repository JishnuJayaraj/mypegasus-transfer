# Data protection: documents

**Documents** *(assumed, Q87 B, Q142–Q148)*: a versioned document-type catalog
(`packages/domain/src/documents/catalog.ts`, version 2) gives each type its category, class,
retention class, the roles that may use it, participant visibility, whether the original file
name is kept, and who may add, review and delete it. Reading a document gives its metadata; the
file only through an explicit, logged opening (`document_opened`). Existing documents never
change: signed ones are immutable, and adding a document or a new version is a document
operation. Signed documents aren't in the MVP portal (Q67).

| Document type | Who may open it | Retention class |
|---|---|---|
| Signed TL 407, Kug 200b | assigned profiler, PL | `evidence_set` |
| Signed DSV, DSV cancellation | PL, back office | `personnel_file` |
| ASU proof (operations from catalog version 5; the ASU record below) | assigned profiler; PL metadata, the file only through break-glass | `participation_record` |
| Profiling-exception evidence | assigned profiler; PL only in assisted mode or through break-glass; regional operations manager "evidence present" (metadata) only | `participation_record` |
| CV (`cv`, Lebenslauf; catalog version 2, Q142), other uploads, qualification certificates | the participant (own), assigned consultant, PL; back office for certificates only when funding or settlement needs it (not before Slice 8) | `personnel_file` (Q145; version 1 had `participation_record`: they aren't BA evidence; a funded qualification's certificate may need a longer class, Slice 8) |

**Document operations** *(assumed, Q146; the Q65 document cells)*: `mayAddDocument`,
`mayReviewDocument` and `mayDeleteDocument` (`packages/domain/src/access/document-operations.ts`)
beside `decideAccess`, whose `write` on a document stays `via_domain_operation`; the generated
access matrix has the table "Document operations".
- For the CV, other uploads and qualification certificates: the participant adds in the portal;
  the assigned consultant and the PL add in normal mode as themselves and in assisted mode as
  actor + `onBehalfOf`; back office none. The participant sees every document of these types in
  their participation, whoever added it.
- Review (accept, or reject with `unreadable`, `wrong_document`, `incomplete`) by the assigned
  consultant or the PL in normal mode, once and final. Deletion by the participant (what they
  added, while not accepted, no reason) or the assigned consultant or the PL (any, in normal
  mode, with `wrong_person`, `wrong_file`, `duplicate` or `participant_request`). No replacement
  in place: a new upload is a new document. Break-glass never adds, reviews or deletes.
- Signed documents are never deleted (`immutable`; the retention job only). The other types'
  operations stay `undecided` (Q65) until their slice: the signed TL 407 (version 4) and the ASU
  proof (version 5) and the exception evidence (version 7, PR 6-7; "Exception evidence") have
  theirs, the Kug 200b scan its own (version 6); the DSV scan follows in version 9 and the DSV
  cancellation in version 10 (PR 7-5), the last: from version 10 no document type's operations are
  undecided.

**File names** *(assumed, Q148)*: kept only for the CV, other uploads and certificates, as
confidential metadata: NFC, path parts and control characters (including bidirectional
controls) dropped, trimmed, 1–200 characters (`documentFileName`). Shown to whoever reads the
document's metadata, never in an audit entry, log, object key or error; the download of another
type is named `<type>-<date>.<ext>`.

**Document files** *(assumed, Q143, Q149)*: PDF, JPEG or PNG, told apart by their magic bytes
(`detectFileType`), never by the extension or the client's MIME type; at most 10 MB, 50 live
documents and 20 uploads an hour per participation (`documentLimits`). Every file is encrypted by
the API before it reaches the store (`apps/api/src/document-encryption.ts`): AES-256-GCM under a
random 256-bit data key per document, wrapped (AES-256-GCM) under a key derived (HKDF,
`document-encryption:v1`) from `DOCUMENT_ENCRYPTION_KEY`, a root of its own (the store and its
backups are another trust domain than the database); a 64-bit key id per row; the additional
data binds the format version, document id, participation id and type, so an object copied to
another row fails. The object is `TPD1 | nonce | ciphertext | tag` under the key
`documents/<documentId>`: no name, project or person in a key. The store and its operator never
see plaintext.

**Uploads as built** *(assumed, Q143–Q149; Slice 4b, PR 4b-2)*: the upload routes take the three
types of Q142 only (`document_type_not_supported` otherwise). The API checks the permission, then
the upload gate, decodes, detects the type, **scans before anything is stored** (`VirusScanner`;
an infected or unscannable file is refused with `file_infected` / `file_unscannable` and only the
audit event `document_upload_rejected`, type and code, is written: no object, no row, no
quarantine; an unreachable scanner is a `503` and nothing is stored), encrypts, stores the object
and records the row (`add_document`, audited `document_added`); when the function refuses, the
object is deleted at once (an object a crash leaves between the store and the commit is the
retention job's, Slice 7, which reconciles objects without a row). Opening is an explicit, logged request (`document_opened`) that answers
a same-origin link valid 60 s, bound to the session that asked, stored only as its token's
SHA-256 (`document_link`); the file is always a download (`attachment`, `nosniff`, `no-store`,
`default-src 'none'; sandbox`), never shown inline from our origin. A deletion keeps the row as a
tombstone (type, dates, who by kind, reason code; the file name erased) and purges the object
through the job `documents.purge-object` (ADR-0011). The runtime role never selects the wrapped
key or the content hash and has no privilege on the links (ADR-0002, documents). Upload logs carry
the request id, participation id, type, a size bucket and the outcome, never a name, content,
hash, token or key. Neither the store nor the scanner is wired with `NODE_ENV=production`:
uploads and openings answer `503 storage_unavailable` there until the S3 store and ClamAV exist
with their AVV (Q149, ADR-0005 pre-pilot gate). Completeness counts live documents only
(`documentState`): a deleted one counts nothing.

**Documents in the portal and the staff app** *(assumed, Q142, Q146, Q147; Slice 4b, PR 4b-3)*:
- **Portal:** the wizard page "Unterlagen" (regional-variation.md, self-service wizard): one
  section per type the participant adds (`wizardDocumentTypes`: CV, other uploads, certificates),
  each document with its kept file name, size, date, "von Ihnen" / "vom Beratungsteam" and its
  review state (a rejection with its reason), "Öffnen" and "Löschen" (after a confirmation) where
  the document's capabilities allow, and an upload per addable type. The browser reads the file
  into base64 in memory and sends it once: no preview, nothing in browser storage; the size is
  checked before sending; the picker offers `.pdf,.jpg,.jpeg,.png`, the API decides by the
  content. The copy asks for no health documents (no diagnoses, sick notes or medical
  certificates): no document type holds them, and the special-category answers are yes/no only.
- **Opening** posts the logged opening, then navigates to its link: a top-level, same-origin
  download, never a `blob:` URL or an inline view, so the CSP stays as it is.
- **Staff app, tab "Unterlagen"** (normal mode): the documents of the types the viewer reads,
  with Art, Datei (the kept file name), Größe, "hinzugefügt am / von" (Teilnehmer·in, Team or
  Team (assistiert): by kind, never a staff name) and Status; "Öffnen", "Annehmen", "Ablehnen"
  (a reason) and "Löschen" (a reason and a confirmation) as each document's capabilities say;
  "Unterlagen hinzufügen" (type, file) for the addable types. The tab "Selbstauskunft" names a
  missing document by its type.
- **Assisted mode:** the wizard's "Unterlagen" lists, adds (actor + `onBehalfOf`) and opens on
  the assisted routes; review and deletion stay on the tab (ADR-0007, documents in assisted mode).
- The API's capabilities decide every button; neither app derives a permission itself, and the
  API checks each action again.
