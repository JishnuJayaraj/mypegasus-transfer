# Data protection: forms and scans

### The profiling record *(accepted, Q49, Q85, Q192, Q193; as built in Slice 6, PR 6-2; readings Q198)*

- **Who:** the tab "Profiling" is the PL's and the assigned consultant's (`mayViewProfiling`);
  back office and the org roles have none (`403`), an unassigned consultant gets `404` ("assigned
  is strict"). The assigned consultant records the sessions, the pending declarations to the BA
  and the unemployment period (`mayRecordProfiling`) and alone reads and writes section C and p. 7
  (`mayUseProfilingAssessment`, the matrix's `profiling_assessment` cells; a PL who is also a
  consultant only where assigned, Q61). The PL reads the sessions and the statuses, never section
  C, the unemployment period or the pending declarations. Normal mode only: assisted mode and
  break-glass grant none of these writes (the functions refuse an `onBehalfOf`).
- **Tables** (one per access category and retention class; ADR-0002, the profiling record):

  | Table | Holds | Class / access category | Retention |
  |---|---|---|---|
  | `profiling_session` | date, `von`, `bis`, who recorded it last and when | confidential / `confidential` (`profilingSessions`) | `participation_record` (Q88) |
  | `participant_profiling` | the pending Jobbörse choice and BA contact declaration, who recorded them last and when, the record's `revision` | confidential / `confidential` | `personnel_file` |
  | `participant_profiling_assessment` | per section C line but health one ciphertext (rating, text, an "andere" line's label; 300 / 100 characters), Gesamteinschätzung and weiteres Vorgehen (2,000 each), presence flags, key id, `revision` | highly confidential / `profiling_assessment` | `personnel_file` (Q192) |
  | `participant_profiling_health_assessment` | the health line's rating ciphertext and its presence; **no text** | special category / `profiling_assessment` | `health_record` (Q40) |
  | `participant_residence_social_data` | adds `unemployment_period` (`{from, until}`, one ciphertext), its presence and its own `unemployment_revision` | highly confidential / `residence_social` | `personnel_file` (Q85 open, fail safe) |

- **The health-detail gate (Q192):** health detail beyond yes/no needs the explicit consent of
  "Legal basis and consent", which doesn't exist yet: the health line takes its rating only, and a
  text there is refused in the domain and in the database (`422 health_detail_not_recorded`),
  never stored. Neither the TL 407 signature nor the portal consent stands in for it.
- **Encryption and logging** as for the sensitive self-service fields: `write_profiling_assessment`
  / `read_profiling_assessment` and `write_unemployment_period` encrypt and decrypt with the key
  the API passes per call; each changed field is audited `sensitive_write` (keys
  `profilingAssessment.<line>`, `overallAssessment`, `nextSteps`, `profilingHealthAssessment`,
  `unemploymentPeriod`), each read field `sensitive_read` (the assessment's read logs all 16
  fields). The unemployment period is read by the assigned consultant and back office (normal
  mode) on `GET …/profiling/unemployment` through `read_unemployment_period`, one logged read
  that returns the value with its revision; it is not a self-service field and the portal doesn't
  show it in this slice. That is a UI scope, not a denial of access: the data-subject export and
  the correction route cover it (Q85's classification stays open). `transfer_app` selects the
  presence flags, never a ciphertext. The tab's view carries presence only; the values come on
  "Anzeigen" from their `no-store` routes and stay out of the browser's query cache.
- **The pending declarations** are not our consents (Q44): no `consent_record` is written; what was
  signed binds to the paper (ba-forms.md, declarations).
- **History** (`profiling` stream, the PL and the assigned consultant): `profiling_session_changed`
  (action, session id, date) and `profiling_declarations_recorded` (the changed keys, never the
  values); the sensitive reads and writes are `security` events, never shown.

### Generated forms and the readiness projection *(accepted, Q49, Q179, Q196–Q198; as built in Slice 6, PR 6-3a; readings Q199)*

- **A generated form is a document** (`tl407_form`, document catalog version 3; `kug200b_form`,
  version 6, as built below): unsigned, immutable, of the signed type's access category (`signed_tl407`)
  and data class (special category, for section C's health rating), stored encrypted like every
  file and opened only through the logged opening (`document_opened`) by the profiler and the PL
  (Q49), saved as `tl407-<date>.pdf`. No ordinary operation adds, reviews or deletes it (the
  catalog's operations `generated`: uploads refuse the type, `review_document` has no role for it,
  `delete_document` answers `document_immutable`); back office and the participant never see it.
  It is not evidence: no correction targets it, it expires. It counts against no upload limit:
  the 50 live documents and 20 an hour of uploads count uploads only.
- **Who generates:** the TL 407 only the assigned consultant (the profiler, who alone reads
  section C), as themselves in normal mode, while the participation is open
  (`record_form_generation` refuses anyone else and a terminal participation).
- **Provenance** (`form_generation`, confidential, class `form_working_copy`): the document, the
  form code and version, the revisions of the sources the generation read (the self-service
  profile, the profiling record with its sessions and pending declarations, section C, the
  unemployment period), the **source token** of the readiness the profiler checked and the
  organisation's fingerprint (the Träger printed), the **declaration snapshot** the form printed
  (the Jobbörse choice and the BA contact declaration), the warning codes the profiler confirmed,
  whether an Anlage was appended, who generated it and when.
- **Change detection, twice:** the profiler's readiness carries a **source token**, a SHA-256 over
  the form version, the date, the four revisions, the identity (names, birth date), the contact
  details, the effective contractual TG dates and the organisation's fingerprint. A generation
  names it; the API reads every source again in one REPEATABLE READ snapshot and refuses a
  different token **before any confirmation applies** (`409 source_changed` at `/sourceToken`), so
  a confirmation holds only for what the profiler saw. `record_form_generation` then compares,
  under the participation lock, the revisions, the person printed (identity, contact details and
  effective TG dates have no revision, so their values: `form_person`) and the printed
  declarations, and refuses a moved one the same way; the stored object is deleted at once. Audited `form_generated` (document, code, version, Anlage: the `case` history) and
  one `warning_confirmed` per confirmed code.
- **The generated DSV** (`dsv_form`, document catalog version 8; Slice 7, PR 7-1; readings Q226):
  the signed DSV's access category (`employment_contract`) and class (highly confidential), class
  `form_working_copy` with the working copies' expiry; generated and opened (the logged opening,
  `dsv-<date>.pdf`) by the PL and back office only, never a consultant or the participant. Its
  provenance row holds the template version, the offer deadline and how it was chosen, the
  handwriting checklist (keys only) and the source token over the printed values (names, birth date,
  address, the effective TG dates, the wave, the pinned template, the customer and the
  Transfergesellschaft's fingerprint), compared under the participation lock
  (`dsv_source_token`, `source_changed`). Audited `dsv_form_generated` (template version, deadline
  kind) in the `dsv` history; the project's pin `dsv_template_pinned` (project-level). No value it
  prints enters a log, an audit entry or the API's view.
- **The working copy's expiry** (Q179; ADR-0008; `workingCopyExpiry`): the file is deleted 30 days
  after a newer generation supersedes it or its signed scan is accepted (the scan's acceptance
  instant, `scanAcceptedAt`), 30 days after the participation's terminal status, and 90 days after
  its generation only while it is abandoned (neither a successor nor an accepted scan: a scan
  accepted on day 80 gives day 110), whichever comes first; a legal hold suspends each. The
  `form_generation` row and the document row stay as the tombstone with the provenance and the
  scans' links (a scan's `generation_document_id` and its signed declarations survive the purge). The periods await the DPO:
  the class is `unset`, so no job deletes anything before Slice 7's retention job.
- **The readiness projection** (`GET …/forms/tl407/readiness`, built per viewer; an unauthorized
  property is absent from the response schema, not hidden by the UI):
  - the profiler: every error and warning code by key and label and the overflow onto the Anlage
    per table and text; the decryptions it needs are each audited `sensitive_read` (the present
    sensitive answers, the unemployment period, and section C when one is stored, which logs all
    16 fields). The UI asks for it on "Prüfen" only;
  - the PL: `ready` and the missing applicable `*` fields whose source the PL may know about
    (`staffSelfServiceAccess(…).knows`), from presence flags only, no decryption; no warning, no
    overflow and no source token (both can derive from section C or the sensitive answers), never
    the unemployment period or an identifier. `ready` there means nothing the PL may know about is
    missing, a completeness summary for the PL: it is no generation guard and no entry guard, and
    the profiler's readiness decides generation;
  - anyone else `403`, an unassigned consultant `404`.
- **The school designation** (Q196, Q198, Q199): a row the participant marked (and the profiler
  confirmed or corrected in assisted mode) is the highest school qualification. Without a marked
  row, whether rows exist or none is recorded, the answer is open ("not clarified", generation
  refused) until the profiler confirms "Kein Schulabschluss" with the participant: the
  confirmation `school_qualification_none` of one generation, for exactly the sources its
  readiness's token covers. It is stored with that generation and never carried to a later one,
  so a later edit asks again. Without any row it stands in for the empty table, which stays
  blank; no row is made up, and the answer is never inferred from an unmarked row, the texts,
  recency or a missing row.
- **Characters the form can't print** (Q197): refused per field (`character_unsupported`), never
  transliterated; the readiness names the field, and the form is then completed on paper and
  uploaded as external paper (6-3b).
- **The generated Kug 200b** (`kug200b_form`, catalog version 6; Slice 6, PR 6-4b; readings
  Q202): the signed type's access category (`signed_kug200b`) and class (highly confidential),
  class `form_working_copy` with the TL 407's expiry, opened through the logged opening by the PL
  and the assigned consultant (Q49), saved as `kug200b-<date>.pdf`; back office never sees it.
  **Who generates** (Q179): the PL or the assigned consultant of an open participation of a `ta_tg`
  project, as themselves in normal mode; the PL also 1–100 at once (`lock_bulk_form_generation`:
  the project's exclusive lock, then the participations in UUID order; all recorded in one
  transaction or none, every stored object deleted on a refusal). **The values it prints** from
  the sensitive answers (10 nationality, 11 RV-Nummer, 12 Schwerbehinderung) are read by
  `read_kug200b_values`, a read bound to this purpose that the PL may make too, though the PL reads
  none of them elsewhere: they go only into the form the PL generates and may open (Q49, Q179),
  each key's read audited `sensitive_read`, never in a response, log or error. **Provenance:** as
  the TL 407's, without a declaration snapshot, confirmations or Anlage; with the **handwriting
  checklist** (`[{code, key}]`: `required_blank`, `text_not_fitting`; keys, never values), which the
  generation answers and the tab lists before printing (Q197 (8)). `record_form_generation`
  compares the profile's revision (which the sensitive answers' writes move too), the person
  printed and the employer printed (the SHA-256 of the project's customer name, which a project
  change writes under the exclusive project lock) under the lock (`409 source_changed`). Audited
  `form_generated` per form.

### Signed scans, signed declarations and quarantine *(accepted, Q49, Q183–Q185, Q191, Q193; as built in Slice 6, PR 6-3b; readings Q200)*

- **Signed scans** (`tl407_signed_scan`, document catalog version 4; `kug200b_signed_scan` with the
  same operations from version 6, below): PDF, JPEG or PNG under the upload limits, virus-scanned before anything is stored, stored
  encrypted, opened only through the logged opening by the profiler and the PL (Q49), class
  `evidence_set`. Added and reviewed by the assigned consultant and the PL, as themselves in normal
  mode only (assisted mode and break-glass add none: the paper is the staff's act), never by back
  office or the participant, and not after the participation's end. They are uploaded on the tab
  "Profiling", which names the origin; the tab "Unterlagen" lists them (open, delete, quarantine)
  and offers no upload or review of them.
- **The origin** (Q184): `generated`, printed from a generated form of the same participation and
  form (`generationDocumentId`; the scan takes its form code and version, and the generation's
  declaration snapshot is known), or `external_paper`, completed outside the app (before the
  platform, or for a name the renderer can't print, Q197): its version is named at the review from
  the registry, an expired one included. Nobody is asked to regenerate or re-sign.
- **The review** (Q184, Q185), once, by the assigned consultant or the PL in normal mode. An
  acceptance records the participant's and the profiler's actual signature dates (neither after
  today in Berlin; for a generated scan neither before its generation's Berlin date), the
  confirmations that both signatures and every page of the packet, the Anlage included, are
  present, external paper's version, and the declarations. A rejection keeps `unreadable`,
  `wrong_document` or `incomplete` and records nothing of the paper; a new scan follows.
  `document_reviewed` names a scan's origin and its accepted version.
- **Signed declarations** (`signed_declaration`, confidential, `participation_record`): on
  acceptance one immutable row per declaration (the Jobbörse choice, the BA contact declaration)
  with the value actually marked (null where nothing is), the form code and version, the later
  signature date, the scan, who recorded it and when; audited `signed_declaration_recorded`
  (codes only). For a generated scan the reviewer confirms the printed snapshot ("wie gedruckt",
  copied from the generation under the lock) or records what the paper shows; for external paper
  always what is marked. The pending values stay editable and are never rewritten by an
  acceptance, and an acceptance never rewrites an earlier signed record. The profiler's tab shows
  the current declarations as signed: those of the latest usable paper (accepted, not quarantined,
  not invalidated; the latest later signature date, then the latest acceptance), with that paper's
  signature date, version and acceptance, apart from the pending values; the PL none (as the
  pending ones). Which paper the guard counts is a separate question (process-and-lifecycle.md,
  the TL 407 facts).
- **Wrong paper** (Q183): before its review the PL deletes a scan as `wrong_person` or
  `wrong_file` (the tombstone keeps its origin and generation, the object is purged at once); a
  reviewed scan is `document_immutable`.
- **Quarantine, at once** (`quarantine_document`, `lift_document_quarantine`): the PL or the
  assigned consultant (the type's quarantine roles: its review roles unless the catalog names
  others, as for the ASU proof; normal mode, also after the end) quarantines a
  document with `suspected_wrong_person` or `suspected_wrong_acceptance`, audited
  `document_quarantined`. While quarantined it opens for nobody (break-glass opening comes with its
  slice; a link opened before answers nothing), is not reviewed, supplies no fact to any future
  evaluation (`tl407_facts` skips it; a past snapshot stays as it was) and counts nothing in
  completeness. Whoever quarantined it, while they still may, or the PL lifts it, audited
  `document_quarantine_lifted`; its fact counts as recorded from the lift, and past snapshots stay
  as they were (Q200). A pending correction refuses the lift (`correction_pending`), and an
  invalidated document isn't quarantined or lifted (evidence corrections, below).
- **History** (`case`, the PL and the assigned consultant): `document_quarantined` (its reason),
  `document_quarantine_lifted`; `signed_declaration_recorded` in `profiling` (form code, version,
  the declaration codes, never a value).
- **The signed Kug 200b** (Slice 6, PR 6-4b; Q184, Q185; readings Q202): added on the tab
  "Arbeitsuche" as `generated` (from a generated Kug 200b) or `external_paper`, by the PL or the
  assigned consultant (never back office, Q49); reviewed by either. The acceptance needs the date
  written in field 19 (not after today; for a generated scan not before its generation) and three
  confirmations made **on the actual paper, none preselected**: declarations 16 and 17 ticked, the
  mandatory information completed (also what the checklist left for handwriting), signed; for
  external paper its registry version. It records the signed declarations `kug200bJobSeeking` (16)
  and `kug200bProfileAccess` (17), each `yes`, on the field-19 date.
- **Declaration 17 as written** (Q185 `verify`): it is an acknowledgement of the TG's selective
  access to the BA applicant profile and is recorded as written; for compatibility the acceptance
  also writes one `consent_record` (purpose `kug200b_profile_access`, source `paper_form`, text
  version `kug200b-<form version>:v1`, `de`, `given_on` the date on the paper, the scan's id, the
  reviewer as actor; `consent_given` with its source). Whether it is a GDPR consent and what a
  withdrawal effects stay the DPO's and legal's check. One record is in force, decided by the
  dates and never by the order of acceptance (Q202 (4)): an accepted paper is in force only if
  its date is after every withdrawal received and not before a record in force whose paper is
  usable; it then ends the earlier records `superseded`. An older paper is kept as history: its
  record is written and ended `superseded` at once (`consent_given`, `consent_ended`), so a
  renewed declaration needs a later paper. The tab shows declaration 17 in force only while its
  paper is usable (not quarantined, deleted or invalidated); the withdrawals and their BA notice
  stay either way. A written **withdrawal** that reaches the TG ends it
  `revoked` (`consent_ended`) with the date received (`kug200b_withdrawal`, `internal`,
  `case_internal` as `kug200bOffer`, `participation_record`), recorded by the PL or the assigned
  consultant, also after the end; "BA informiert am" is recorded with its date, never a claim that
  the BA disabled anything. A **decline** (`kug200b_decline`, the same classification) keeps its
  date. Neither touches a registration. Back office reads the offer's outcome, dates and
  withdrawals on the tab, never a form or scan. History (`case`): `kug200b_offer_declined`,
  `declaration_withdrawal_recorded`, `declaration_withdrawal_ba_notified` (dates), `consent_given`
  and `consent_ended` with their source.

### The ASU record *(accepted, Q49, Q184, Q186, Q201; as built in Slice 6, PR 6-4a)*

- **The route and the registration** (`asu_record`, `asu_registration`; `internal`, `case_internal`
  as `asuChannel` and `asuRegistration`, listable as codes and dates; class
  `participation_record`, part of the evidence of entry, Q88): written only by `set_asu_route`,
  `record_asu_registration` and `link_asu_proof`, read by the case readers (the PL, the assigned
  consultant, back office) on the tab "Arbeitsuche" (`ta_tg` only). The route and a registration
  without the attestation are the PL's or the assigned consultant's; a registration names the
  route version its recorder reviewed (`409 stale_revision` once changed, so no unseen route is
  frozen). The history shows the route, the registration's route, date, proof kind and attestation
  source, and the link. **Back office reads the case summary only**: the route, the registration
  with its proof's kind, source and instants, and the step's items, never the BA confirmations'
  metadata (no list, no document id; it has no right on `asu_proof`).
- **The attestation** (Q184, Q186): the PL alone records the BA-Kundennummer together with the
  actual registration date and where it was verified; a number alone says nothing about when the
  person registered. The number is highly confidential (`identifiers`): encrypted beside the
  RV-Nummer on `participant_identifier_data` (`baCustomerNumber`, the row's key, `key_unknown`
  under another), audited `sensitive_write` with its key, write-only for the PL, masked as typed,
  never returned, logged, put in an error or in an audit detail; `transfer_app` selects only its
  presence. Its reading by the assigned consultant and back office comes with the slice that needs
  it.
- **The BA confirmation** (`asu_proof`, document catalog version 5, the owner's choice of
  2026-10-28): evidence, so the catalog marks it `signed` for immutability only (normal mode, never
  changed once reviewed; a BA confirmation needs no wet signature): added by the assigned
  consultant or the PL in normal mode (the PL sees its metadata and opens the file only through
  break-glass), reviewed by the assigned consultant, deleted by the PL before its review only, as
  `wrong_person` or `wrong_file`; never by back office or the participant. **Quarantined at once
  by the PL or the assigned consultant** (the catalog's quarantine roles, a type's review roles
  unless it names others), the PL without any right to open, review or link it; the lift is the
  quarantining person's or the PL's. The permanent correction is an approved evidence correction.
  The assigned consultant, who opens it, links an accepted one as the registration's proof,
  confirming it supports the registration's date. A quarantined or invalidated proving document
  supplies no fact.
- **The knowledge date** (`knowledgeDate` on `participant_details`, confidential, `personnel_file`):
  the import's optional target (`participant_data_changed` names it) and the PL's correction,
  audited `knowledge_date_set` with the kind of change (`set`, `changed`, `cleared`), never the
  date.

### Exception evidence *(accepted, Q49, Q80, Q81, Q94, Q194; as built in Slice 6, PR 6-7; readings Q208)*

The evidence a profiling exception rests on (process-and-lifecycle.md, profiling exceptions):
- **Evidence documents** (`profiling_exception_evidence`, document catalog version 7): special
  category (`health`), the stricter class for every unstructured upload, since a certificate may
  be medical. Evidence, so the catalog marks it `signed` for immutability only (normal mode, never
  changed once reviewed). **Write-only for the PL**: the PL and the assigned consultant add it, the
  PL opens it only in assisted mode or through break-glass (the database's opening refuses the PL
  as themselves, `open_roles` is the consultant only), the assigned consultant reviews it (a file's
  presence is no verification), both quarantine it at once, the PL deletes it before its review
  only. The tab "Profiling" gives the PL only its id, upload instant and review state (and whether
  it still counts), never a file, a name, a media type or a size; the regional operations manager
  never more than "Nachweis vorhanden". The PL's safety actions (quarantine, its lift, deletion
  before the review) are authorised by the operation alone, without a read right (the review of
  PR #102): the document service finds the document for them by the types the actor reads or may
  perform the operation on, never for an opening or a review.
- **The evidence record** (`profiling_exception_evidence_record`, confidential,
  `participation_record`, part of the evidence of a request, Q81): one immutable row per attempt,
  written only by `create_exception_evidence_record` (the PL, as themselves, while `informed`),
  never updated or deleted (a trigger refuses it to every role). Either the ids of the accepted,
  live, not quarantined or invalidated evidence documents of the participation (1–20, in id order;
  any other id is `document_not_found`, a 404; an unreviewed one `evidence_missing`), or a
  **structured BA confirmation**: the Agentur's key, the confirming contact or reference and the
  confirmation date (the field `profilingExceptionEvidence`, confidential, never in lists), never a
  clinical file; the Agentur one of the participation's choices (the catalog's and the project's),
  checked by the API (`agentur_unknown`). A request from before evidence records rests on a
  `legacy_unverified` record without any source, which never counts (the upgrade, ADR-0002). The reference is normalised: NFC, inner spaces as one, trimmed, lower case
  (Unicode's default mapping, the database's ICU `lower`), no control character, at most 100
  characters (`reference_invalid`); the date is an ISO date not after today (`confirmation_in_future`).
  The PL is told on the form not to enter health details.
- **The fingerprint** (round 17): `sha256:v1:` and the SHA-256 of the UTF-8 lines
  `profiling-exception-evidence:v1`, the participation id, the kind, then either the sorted,
  de-duplicated content digests of the documents or `agenturKey=…`, `confirmedOn=…`,
  `reference=…` of the normalised confirmation. Computed by the database
  (`exception_evidence_fingerprint`), mirrored by the domain's `canonicalEvidence` (a test holds
  them equal). Identical bytes under a new id, another order or an equal confirmation re-entered
  give the same fingerprint, and equal evidence of two participants never does. Confidential
  evidence metadata: on the record and the request only, never in a response, a log, an error or
  the history.
- **History:** `exception_evidence_recorded` (`profiling`; the record's id, its kind and, for
  documents, how many), never a document id, the Agentur, the reference or the fingerprint; the
  request's events keep round 17's details (the opaque record id on the request).

### DSV scan operations (catalog version 9)

`dsv_signed_scan` is uploaded and reviewed by the PL or back office in normal mode; either may
quarantine it. The existing lift rule applies: the person who quarantined it, while still allowed,
or the PL. Only the PL deletes, before review, with `wrong_person` or `wrong_file`; deletion
queues encrypted-object purging through the existing document path. Earlier documents retain their
catalog policy.

Scan receipt, offer linkage and confirmed signature rows are highly confidential employment
contract evidence, retained as `personnel_file`. Signature rows carry project and participation
ids; the runtime role reads them but cannot insert, change or delete them directly. The DSV tab
is restricted to PL/back office. No file name is retained for DSV scans. The receiver selector
shows active staff assigned to the project; the receipt records the explicitly chosen staff id.
DSV document events appear in the DSV history stream, including for back office; their projection
shows codes and confirmed signature kinds, not signature dates or receipt identities.

`dsv_contract` (internal case data, `participation_record`, `project_id` on the row) holds the
facts retained after the scans are deleted: signature dates, `fullyExecutedOn`, the acceptance days
and the kind of role that received and accepted (never a staff id), and the original's received and
sent days; the original's location is deleted with the personnel file. The runtime role reads the
row; only `sync_dsv_contract` (through the status function and the review) and `record_dsv_original`
write it. A fact withheld for the guards while its scan is quarantined, invalidated or deleted is
not rewritten in the contract; after a lift the scan's dates stay and only its recording instant
moves.

The counting rule preserves actual dates through quarantine lifts; see
[DSV scans and participant signature](../process-and-lifecycle/dsv.md#dsv-scans-and-participant-signature-as-built-7-2b).

### The DSV cancellation and the customer notice (catalog version 10; Slice 7, PR 7-5)

`dsv_cancellation` takes the DSV scan's operations: upload and review by the PL or back office in
normal mode, quarantine by either with the existing lift rule, deletion by the PL before review. It
is highly confidential `employment_contract` evidence, class `personnel_file`, no file name kept; its
upload names the signed offer (the contract it cancels) and records the dates on the paper, the
receiver and the day received, nothing defaulted, as a DSV scan does. Its review confirms the three
parties' signatures as `dsv_scan_signature` rows (`cancellation_signatures_missing` with fewer). Only
while the participation is `informed` on the signed DSV (`cancellation_not_open`). Its document
events are in the DSV history stream with the signature kinds, never a date. `dsv_cancellation_facts`
gives the counting cancellation (accepted, live, neither quarantined nor invalidated): valid on the
latest actual signature, recorded at the acceptance or a later lift.

`dsv_customer_notice` (internal case data, `case_internal`, class `participation_record`,
`project_id` on the row) holds "Kunde informiert am", who recorded it and when: once per
participation, written only by `record_customer_notice` (the PL), selected by the runtime role. It
records that the PL told the customer of the cancellation, never what: the customer whitelist
(CLAUDE.md rule 6) and the monthly export (Q47) are unchanged, and nothing is sent from the app.
The audit event `dsv_customer_notified` carries the day only (DSV history stream).

The primary end reason is in the participation detail only for the PL who may correct it (Q72):
`deceased` is confidential (Q66) and nobody else needs it there.
