# Data protection (DSGVO / social data) — engineering rules

> This is an engineering guideline, not legal advice. Have it reviewed by the company's data
> protection officer before go-live.
>
> Status: updated 2026-10-15 from the decisions log, and 2026-10-16 from round 7 (roles per
> project, break-glass scope, evidence-set phase, write permissions, classification additions)
> and round 8 (regional operations manager, approval of profiling exceptions, deletion clock),
> and updated 2026-10-21 with Slice 3 PR 3d activation issuance and Article 14 notice evidence,
> and the self-service data, purposes notice and consent model of round 38.
> Most answers here are still **`assumed`**
> (rows marked 🔒 in `open-questions.md`). Build on them, but **nothing in this file may be
> `assumed` or `verify` at the pre-pilot gate.** Items marked *(Qnn)* point to the question.

## Roles under the GDPR *(assumed, Q14)*

- The **TG is an independent controller**, also in phase 1. It is neither a processor for the
  customer nor a joint controller.
- The **customer** is a separate controller for its own HR data and for transferring the import
  file to us.
- Consequences:
  - The customer contract needs a **data-sharing clause** (what is transferred, for which
    purpose), not an AVV.
  - The customer cannot order deletion. Deletion follows our retention rules only. There is no
    "customer deletion request" feature.
  - We need an **AVV with every processor**: the cluster operator chain (owned by the product owner, Q32; blocking for the
    pilot), SMS/mail providers, Gotenberg/storage if run by a third party.

## Classification *(assumed, Q29, Q43)*

| Class | Data | Handling |
|---|---|---|
| **Special category** | health restrictions, Schwerbehinderung/Gleichstellung, GdB | field-level encryption; never in list payloads; separate endpoint; every read logged |
| **Highly confidential** | RV/SV-Nummer, Steuer-ID, IBAN, BA-Kundennummer; Bürgergeld (yes/no only, concerns the spouse too); nationality, date of entry, residence status (incl. Duldung); profiling results (TL 407 section C ratings, Gesamteinschätzung, weiteres Vorgehen) | field-level encryption; never in list payloads; every read logged |
| **Confidential** | name, address, contact, date of birth, CV, qualifications, job wishes | role × project access |
| **Internal** | project, dates, statuses | role × project access |
| **Aggregated** | counts, rates per project | may go to the customer, with suppression |

- **Signed documents** (TL 407, Kug 200b, DSV) take the class of their most sensitive content
  and are stored encrypted.
- **TG sub-status periods** (sickness, parental leave) are payroll records: type and dates only,
  never diagnoses, never AU scans (Q51).
- **Activation credentials** are confidential. The printable code and in-person destination are
  transient secrets: only separately keyed hashes are stored. Code state, channel and timestamps
  are `case_internal`; hashes are never served. Article 14 delivery evidence (version, language,
  method, staff id and time) is internal and immutable.
- Free text in section C is **never** included in exports.
- **Additions (round 7, assumed, Q66):**
  - Familienstand, gender, Personalnummer, end of the old employment, knowledge date, work
    email, language skills, driving licence: **confidential**.
  - **Address country** (`addressCountry`, Q103/Q105, [round 32](../decisions/2026-10-19-answers-round-32.md), accepted pilot decision): personal data,
    **confidential**, part of the structured address (street, postal code, city, country), retention
    class `personnel_file`. It is not nationality or citizenship and not a special category (Art. 9
    GDPR). Only `DE` in the MVP; never inferred from the postal code.
  - **DSV amendment metadata** (PR 2h, Q102/Q105, round 32 pilot decision): **confidential**, retention class
    `participation_record`, part of the evidence set, never in ordinary participant lists or
    customer exports; no free text. The signed amendment itself is an `employment_contract`
    document: highly confidential, encrypted when uploaded, immutable, separately access-controlled.
  - **BA reporting tasks** (`baReportingTask`, PR 2h-3): **confidential**, not listable, never in
    customer exports, retention class `participation_record`; read like other confidential case
    data (assigned consultant, PL, back office; `packages/domain/src/fields/catalog.ts`).
  - **Entry-wave code and name** are text the PL types: they stay on the wave row and never enter
    audit details; a wave change records only the changed key names (and a changed date's old and
    new value).
  - End reason `long_term_illness_reduced_earning_capacity`: **special category**, never in
    ordinary lists. End reason `deceased`: confidential.
  - Profiling-exception reasons: **structured reason codes** where possible (Q81); a free-text
    reason is **special category**, because it may disclose illness.
  - Override and break-glass free text: **highly confidential**, encrypted, excluded from lists
    and logs, visible only to the actor and the authorised reviewer.
  - UI copy tells staff not to enter diagnoses or unnecessary personal details in free text.

## Access matrix *(assumed, Q28, Q49, Q51)*

| Data | Profiler/Berater (assigned) | PL (assigned project) | Back office | Regional admin / Admin | Participant |
|---|---|---|---|---|---|
| Confidential data | yes | yes | yes, as needed | no case data | own |
| Health, Schwerbehinderung (structured) | yes | no; except in assisted mode (`onBehalfOf`) or break-glass with reason | Schwerbehinderung/Gleichstellung + GdB only (payroll) | never | own |
| Highly confidential identifiers (RV-Nr., IBAN, Steuer-ID) | as needed for forms | no | yes (payroll) | never | own |
| Nationality, residence status, Bürgergeld | yes | no | yes | never | own |
| Section C ratings, Gesamteinschätzung, weiteres Vorgehen | yes | **no** | no | never | not in the portal |
| Signed TL 407 PDF | yes | yes, opening is an explicit logged action; normal UI shows metadata only | **no** | never | — |
| Signed Kug 200b PDF | yes | yes, logged as above | **no** | never | — |
| Sub-status periods | "abwesend" + dates | "abwesend" + dates | type + dates | never | own |
| Evidence set after exit | break-glass with reason (audits) | break-glass with reason | break-glass with reason | never | — |

- **Roles per project** *(assumed, Q61)*: a person has zero or more project roles per project
  (e.g. PL and profiler in the same project). Permissions are the **union** of those roles,
  but sensitive access still needs the participant assignment: a PL who is also a profiler sees
  section C only for participants assigned to them as profiler.
- **"Assigned" is strict** *(assumed, Q62)*: consultants/profilers get **no person-level data**
  of participants not assigned to them, only aggregate workload counts. The PL assigns. There is
  no project-wide directory of names.
- **Break-glass** *(assumed, Q63)*: mandatory reason, audited, flagged for review. One grant
  covers **one participant, one resource/category and one action**, never a reusable session;
  every action is logged on its own. The **regional operations manager** (Q80) reviews it by
  the next business day from audit metadata, without access to participant details. The DPO
  gets periodic reports and immediate escalation of suspicious access, but is not the
  operational approver.
- **Assisted mode** *(assumed, Q136; ADR-0007)*: the PL, the assigned consultant and back office
  open the participant's wizard after confirming the person is present or on the phone and asked
  for help (`in_person`/`phone`, audited `assisted_mode_started`, bound to the staff session).
  They see and write exactly what the matrix gives their role in mode `assisted`: the PL
  confidential data, health and disability, never identifiers or residence/social data; the
  assigned consultant every self-service field; back office confidential data, disability,
  identifiers and residence/social data, never health; an unassigned consultant nothing. A field
  the role can't see is hidden, never shown empty. Writes are actor + `onBehalfOf`.
- **Four-eyes** *(assumed, Q63, Q80)*: actor and reviewer are always different staff users.
  Break-glass and reconciliations of a TG entry are **reviewed after the fact** (next business
  day). A profiling exception needs **approval before** it can satisfy the TG entry guard.
- **Regional operations manager** *(assumed, Q80)*: an org role scoped to a region, with **no
  ordinary participant access**. It approves profiling exceptions, reviews reconciliations and
  break-glass, sees audit metadata, structured reason codes and the necessary dates, and can ask
  the PL for clarification. It never sees case files, section C, health fields or signed
  documents through this role.
- **Evidence-set phase** *(assumed, Q64)*: starts **after the first retention/deletion stage**,
  not at the terminal status. During close-out and the ordinary personnel-file retention,
  normal authorised access applies; once only the evidence set is left, break-glass only.
- **Signed TL 407 / Kug 200b for participants** *(assumed, Q67)*: not in the MVP portal; through
  the data-subject export or a manual request.
- **Regional admins and admins manage configuration, not cases.** They see no participant data.
  Escalations to the regional admin (e.g. TL 407 not submitted 14 days after TG start) show
  only: project, responsible PL, number of overdue items per type (e.g. "3 × TL 407 not
  submitted"), and days overdue for the oldest item. **No participant names.** For details the
  regional admin contacts the PL (Q57).
- **Regions and org roles** *(Q126 and Q131 confirmed)*: a project belongs to a
  region (Niederlassung, Q35); org roles are `staff_org_role` rows: `admin` global,
  `regional_admin` and `regional_operations_manager` per region. A regional role sees and acts only
  on projects of its regions; a project without a region (only those created before regions) is
  seen by global roles and its members. The permission target's region is the project's
  (`apps/api/src/access.ts`, `packages/domain/src/access/org.ts`).
- **Teams and assignments** *(Q61, Q62, Q126)*: only a global admin creates, changes and
  deactivates staff accounts, grants org roles and sets "may create projects"; whoever creates a
  project chooses its region and becomes its first PL. The PL adds and removes members and their
  project roles and assigns participations to the project's consultants; a global admin may add a
  replacement PL, never themselves, and gains no case access by it; regional admins manage no team.
  The last active PL can't be removed or deactivated. An admin can't remove their own authority;
  authority-removing operations serialise and re-check their actor so concurrent mutual changes
  preserve an active admin. Assignment rows are closed, never deleted;
  a consultant's access follows the open ones at the next request, and removing the consultant
  role or deactivating the account ends them. Deactivation also deletes every org-role grant in
  the transaction. Every change is audited (`project_member_added`,
  `project_member_removed`, `participant_assigned`, `participant_unassigned`; the account,
  org-role and region events in `staff_audit_event`), with ids and codes, never a name or email;
  each role removed by deactivation preserves role, region and `account_deactivated`.
- **Activation issuance and Article 14 notices (Slice 3, PR 3d):** only a project lead or a
  back-office member of that project may issue, hand over or revoke a code and record notice
  provision. Consultants and org administrators have no such case operation. The list and detail
  expose only derived status, dates and channel kinds; printable codes are returned once in a
  no-store response, and staff never retrieve an in-person destination or either keyed hash.
- **The work list and the dashboard (Slice 5; Q150, accepted):** the project's tabs
  "Übersicht" and "Teilnehmende" show one snapshot of the viewer's whole list scope
  (`participationListScope`, recalculated on every request): the PL and back office the project,
  an assigned consultant their currently assigned participations; an unassigned consultant and the
  org roles get `403`. Rows carry only the listable person fields (Personalnummer, names), codes
  and dates: the participant actions name only fields the viewer may know about, presence never a
  value; the portal column says whether the participant has a live channel and a live consent of
  the reminders' version (`portal-contact-consent:v2`), never an address. The dashboard's counts
  are exact, values below five included, because every count is the identically scoped list a
  click away; no Slice 5 aggregate leaves the application, and the n < 5 rule applies wherever an
  aggregate is disclosed outside that scope (the customer report). Aggregates of health,
  disability or other sensitive categories need a decision of their own. Both responses are
  `Cache-Control: private, no-store` and never enter analytics or telemetry. The name search runs
  in the browser over the snapshot (case and diacritics folded, `ß` as `ss`); the term is never
  sent, never in a URL, a query key, a log or browser storage, and the snapshot stays in memory.
  Only the code filters sit in the URL.
- **Reminders (Slice 5; Q152–Q156, accepted):** manual only; no scheduled reminder (ASU
  reminders wait for Q1 and Slice 6) and no regional rule (`reminderPolicy`, regional-variation.md).
  - *Who:* a current PL of the active project for any non-terminal participation, a current
    assigned consultant for their assigned ones (`mayRemind`); nobody else, never in assisted mode
    or through break-glass. A consultant naming a participation hidden from them gets
    `422 participation_not_found`, back office (who sees it) `403`. Authority is checked at the
    request and again at the dispatch claim; a lost membership or assignment cancels the reminder
    (`requester_no_longer_authorized`). Reminder records and their audit events are never used for
    staff rankings, productivity metrics or general performance monitoring.
  - *Channel and consent:* only a channel the participant registered, verified, neither removed
    nor suspended, whose consent is live with purpose `portal_contact` and version exactly
    `portal-contact-consent:v2`. Never imported contact data, the work email, postal data or a
    destination from staff. Among the eligible channels the most recently verified email, else the
    most recently verified mobile, the smaller channel id on a tie (`chooseChannel`). The channel
    and its consent, the account's language and the text version are fixed when the reminder is
    queued; a channel or consent that stops being eligible cancels it, never reroutes it. Skips:
    `no_channel` (no live channel), `consent_required` (a live channel, none with a live v2
    consent), `reminded_recently`, `nothing_open`, `participation_closed`; staff see both channel
    codes as the one text "Kein für Erinnerungen nutzbarer Kontaktweg."
  - *Text:* one kind (`open_items`, only while the participant has a participant action), the
    fixed generic text `portal-reminder:v1` (de/en, immutable, SHA-256 tests in the notice
    catalog; final wording with the DPO, Q132): no name, project, employer, Personalnummer,
    deadline or item; its only placeholder is the plain `PORTAL_PUBLIC_URL` (no token,
    participant id, campaign parameter or tracking redirect); plain-text mail, no pixel.
  - *Window:* one reminder per participation within 3 Berlin calendar days from the last queued
    request, whatever its outcome (a Monday's allows the next on the Thursday).
  - *Dispatch:* rows, `reminder_queued` and the `reminders.send` jobs commit together; the job
    locks the participation, evaluates the participant's actions and claims the dispatch, which
    rechecks exactly the queued channel and consent, the version, the status and the requester:
    no dispatch when the invalidating change committed before the claim (ADR-0011).
  - *The message log* (`participant_reminder`): ids, kind, text version, language, the channel's
    id and kind, the consent id, the requester's id, times, status and a closed cancel reason;
    never an address, rendered text, provider response, free text, error message, IP or tracking
    data. The tab "Nachrichten" shows it to whoever reads the participation's `case_internal`
    data (the PL, the assigned consultant, back office), the requester as "Team".
- **Appointments (Slice 5b; Q162, Q166, Q168, accepted; as built in 5b-1):** info events and
  consultation slots of a project (process-and-lifecycle.md, appointments).
  - *Who:* a current PL of the project creates, changes and cancels every appointment and alone
    changes a slot's host; a consultant of the project creates, changes and cancels their own slots
    only (`mayManageAppointment`). Staff booking and cancelling a booking: a current PL for any
    participation of the project, the consultant currently assigned to it for their assigned ones
    ("assigned is strict", Q62; `mayBookFor`). Back office reads bookings (`case_internal`) and
    does none of it; org roles, assisted mode and break-glass grant none of these operations.
    Appointments themselves (kind, times, capacity, title, venue, host, audience) are project data
    the project's members read; org roles outside the team get `403`. A slot takes only
    participations its host may list.
  - *Counts and seat state (Q150 exception, Q162):* a viewer gets the exact count of live bookings
    only while they may list every live booking of the appointment, recomputed per request (the PL
    and back office always, a consultant while all are of their assigned participations); everyone
    else gets the count among the participations they may list ("davon Ihre: 3") and the seat state
    `available`/`full`, never a number (`bookingView`). "Full" beside the visible capacity reveals
    the occupancy of that appointment, never a person: an accepted operational disclosure. No
    payload returns a total or remaining-seat count outside the exact-count scope. A consultant
    naming a participation hidden from them gets `422 participation_not_found`, back office `403`.
  - *Reassignment and a departing host (Q162):* access follows the open assignments and
    memberships at every request: a consultant whose assignment ended, who lost the role or the
    membership, or was deactivated, sees none of the participation's bookings at once, whatever slot
    they host. Bookings stay live; a live future consultation booking whose host may no longer list
    its participation needs resolution by the PL (shown on the appointment and its bookings): a new
    host who may list every live booking, or cancelling the booking or the appointment.
  - *Classification (Q166):* `appointment` is `internal` project data (`project_master`, Q58); its
    host and creator are staff ids (staff personal data, pseudonymised with the account, Q59).
    Title and venue are generic texts the form asks to keep free of names, diagnoses and
    consultation notes; they never enter an audit detail, a log line or (from 5b-3) a message.
    `appointment_booking` is `internal`, `case_internal` (field `appointmentBookings`, listable as
    codes and dates), `personnel_file`. Bookings are never BA evidence and no funding status is
    inferred from the kind: funded-measure evidence is a separate record (Q169).
  - *Attendance (as built in 5b-2; Q163):* the PL and the assigned consultant record and correct
    attendance and confirm `informed` on it (`mayRecordAttendance`); after the participation
    closed the PL only. The conflict review ("Eskalieren", "Anderweitig informiert") is the PL's
    (`mayResolveAppointmentItem`). Back office reads attendance with the bookings and records none.
    The booking holds the value, who recorded it and when, the closed-case reason, the basis of
    `informed` (who, when), the conflict's handling and resolution and the supersession (staff ids
    and times), all in `appointmentBookings`, `personnel_file` like the booking.
- **Customer**: no login in the MVP (Q47). See the next section.

### Resources, categories and the generated matrix *(assumed, round 11)*

The rules in this file are code in `packages/domain/src/access` (`decideAccess`), with tests for
every cell. **[The generated access matrix](generated/access-matrix.md)** (`pnpm generate`,
checked in CI) shows every subject × resource × action × mode × phase, and every cell the docs
don't cover yet as `undecided` (denied) with its question (Q65).

Access is decided per **resource kind**: a participant **field** (its category from the field
catalog), a **document** (its type from the document-type catalog), **audit metadata** (a
filtered projection) or an **aggregate**. An action a kind doesn't have (opening a field,
aggregate or audit entry as a document, writing an aggregate) is `not_applicable`.

**Participation detail** (`participationDetail`, `packages/domain/src/access/participation-view.ts`):
the case data is one gate, every `case_internal` field (statuses, dates, the placement Agentur)
readable or a 403; the
person fields are then projected one by one through `decideAccess`. The detail serves no field
whose read must be logged; such fields come with their separate logged endpoints.

| Category | Fields / documents | Class |
|---|---|---|
| `case_internal` | statuses, dates, the placement Agentur key (`placementAgenturKey`, listable, Q139) | internal |
| `confidential` | confidential data; CVs, uploads, qualification certificates | confidential |
| `health` | health (structured); profiling-exception evidence; the health-related end reason value (not storable before Slice 8, which applies this category to it) | special category |
| `disability` | Schwerbehinderung/Gleichstellung, GdB | special category |
| `identifiers` | RV-Nr., IBAN, Steuer-ID, BA-Kundennummer; ASU proof | highly confidential |
| `residence_social` | nationality, residence status, Bürgergeld | highly confidential |
| `profiling_assessment` | section C, Gesamteinschätzung, weiteres Vorgehen | highly confidential |
| `signed_tl407`, `signed_kug200b` | signed TL 407 / Kug 200b | most sensitive content |
| `employment_contract` | signed DSV and its cancellation | highly confidential, encrypted |
| `absence` | sub-status periods | payroll records; not in lists until Q85 |

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
| ASU proof | assigned profiler; PL metadata, the file only through break-glass | `participation_record` |
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
  operations stay `undecided` (Q65) until their slice: the signed scans, ASU proof and
  exception evidence with Slice 6, the DSV scan and cancellation with Slice 7.

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

Generated reports and exports become a resource of their own with the reporting slice; every
generation and download is logged.

**Audit metadata** *(assumed, Q87 A)*: no unrestricted audit stream; read-only filtered
projections. PL: the operational case history of their projects (lifecycle changes, document
status, assignments, corrections). Assigned consultant/profiler: that history for the assigned
participation, plus their own actions. Back office: DSV, payroll, absence and settlement
history. Regional operations manager: only events awaiting or recording their approval or
review. No projection contains sensitive-access or security events (except the break-glass
events the regional operations manager reviews) or a reason code the role couldn't otherwise
read. Participants: no audit-log UI in the MVP (data-subject export). Admins: none. Once only
the evidence set is left, the operational projections need break-glass; the review queue stays
open to the regional operations manager, who reviews those break-glass actions (round 12).

**The audit history as built** *(Slice 5, PR 5-3; Q157 accepted, the per-type readings Q161
assumed)*: the participant page's tab "Verlauf" shows one participation's history, newest first,
100 rows a page at most.
- *Who sees which rows:* the PL `case`, `profiling` and `dsv`; the assigned consultant `case`,
  `profiling` and only the `dsv` and `payroll` rows they acted in themselves; back office `dsv`
  and `payroll`; several roles get the union (Q61). An unassigned consultant, admins, regional
  admins, the regional operations manager and participants get no history (the regional review is
  a view of its own). `historyStreams` derives the streams from `decideAccess`.
- *Never shown:* `security` and `review` events (logins, logouts, one-time codes, step-ups,
  sensitive reads and writes, document openings, refused uploads, break-glass, exports, assisted
  mode, session and credential events, reviews) and project-level events. Each event type's
  stream and what it shows are the domain's `auditProjection`; the generated access matrix has
  the table "Audit history".
- *Redacted in the database:* `transfer_app` has no privilege on `audit_event`. The function
  `audit_history` is the authorization boundary: it resolves the staff user from the live
  session, reloads the memberships and the assignment, applies the row predicates and returns
  `field`, `from`, `to` and the reason code only where the type shows them, and of the details only
  the allowed keys. The field keys of a person-data change stay only for the categories the
  viewer's roles may know (in normal or assisted mode: the "Selbstauskunft" tab's rule). The API
  validates each row against the projection and localizes; it removes nothing.
- *Actor:* the staff member's current display name, also after deactivation, since case actions
  are attributable (Q157); "Ehemaliges Teammitglied" once the name isn't retained (the
  pseudonymised account, Q59); "Teilnehmer·in", "System", "(assistiert)" for assisted mode. Names
  aren't searchable or exportable here.
- *Purposes:* case reconstruction, correction, compliance and the investigation of a concrete
  incident; never staff rankings, productivity metrics or routine behavioural monitoring. Named
  technical action records can monitor employees, so deployment needs the works council's check
  under §87(1)(6) BetrVG and the staff informed that case actions are attributable (pre-pilot
  gate, ADR-0005).
- *Opening* the first page writes `audit_history_opened` (viewer, participation, time; a
  `security` event, never shown in a history); later pages write nothing.
- *Appointments (Q168):* `appointment_created`, `appointment_changed` (the changed keys, a new
  host's id) and `appointment_cancelled` (the closed reason, `correction`) are project-level, in no
  history. `appointment_booked` (`case`: the appointment's id, kind, start as written then and the
  origin) and `appointment_booking_cancelled` (`case`, with its reason) show the PL and the assigned
  consultant the booking, back office nothing. The start is written into the event, so the history
  never depends on the current appointment row; no title or venue is in any detail. Attendance
  (5b-2, `case`, the same viewers): `attendance_recorded` (the value and the previous one,
  `afterClose`, the closed-case reason), `attendance_superseded` (the PL's `did_not_take_place`
  correction, the previous `absent`), `information_delivery_confirmed` (whether it changed the
  status; the changes are their own `status_changed` rows), `attendance_conflict_escalated` and
  `attendance_conflict_resolved` (its reason: `replacement_basis` or
  `information_delivered_otherwise`); each names the appointment, its kind and start as written.
- The reference tables `audit_event_projection`, `role_field_knowledge` and
  `field_access_category` hold no personal data (`reference_data`); the history's events are
  `audit_log` (three years, the participation reference pseudonymised when the record is deleted).

**Evidence set** *(assumed, Q87 C, round 12)*: access is the intersection of the role's
active-phase entitlement (in any mode) and break-glass, with the active view; lists never.
Immutable through field and document writes. Of the raw files, only what the evidence set
lists stays (signed TL 407 / Kug 200b, proof of submission); otherwise only the **minimum
derived evidence facts** remain after stage-one deletion (e.g. ASU proof checked; exception
decision, reason and approval; references and timestamps), not raw health-related exception
evidence.

**Evidence corrections** *(assumed, Q88, round 12)*: never by in-place editing, only through
**`append_evidence_correction`**, targeting a document or a field. Who may request it is an
explicit correction-authority table (`packages/domain/src/access/corrections.ts`), separate from
who may open a document; requesting grants no read access.
- Documents: PL for TL 407, Kug 200b, ASU proof, exception evidence, CVs, uploads and
  certificates;
  PL or back office for the DSV and its cancellation.
- Fields (round 13), only those retained in the evidence set: PL for `firstName`, `lastName`,
  `birthDate`, `personnelNumber`, `profilingSessions` (one session per correction, never the
  whole collection), `withdrawnOn`, `profilingDoneOn`; back office for
  `pensionInsuranceNumber`, `baCustomerNumber`; either for `dsvSignedOn`, `tgStart`, `tgEnd`,
  `tgEntryDate`, `exitDate`. Payroll and personnel fields (address, tax ID, IBAN, absence
  periods) don't join the evidence set to be corrected; while retained, their own active or
  payroll operations correct them. Statuses change only through the status functions.
- Consultants and participants can't alter the evidence set; they raise a task or rectification
  request for the responsible role.
- Append-only, the original kept and linked (corrects/supersedes); a reason code and a
  documented source (BA/legal reference, data-subject rectification request, corrected source
  document or documented internal error); approval by the regional operations manager, four
  eyes; corrected sensitive values encrypted; audit events with IDs, field key, actor and
  timestamps, never the values; the approver sees category, basis and references, no value they
  couldn't otherwise read.
- A correction alone never bypasses lifecycle guards or changes Transfer-KuG eligibility,
  contractual dates or payments: that takes a reconciliation, contractual amendment or recorded
  BA/legal determination.

**Sensitive writes** are audited as `sensitive_write` with the field or document key, actor,
subject and timestamp, **never the old or new value**. `sensitive_write` covers special-category
and highly confidential data only; ordinary person-data writes are `participant_data_changed`
(below).

### Write permissions *(assumed until DPO and PL review, Q65)*

| Who | May write |
|---|---|
| Participant | own self-service fields and uploads; never lifecycle, payroll, audit or derived fields |
| Profiler/Berater (assigned) | the case and profiling data their work needs; section C and health data only for assigned participants |
| PL (project) | operational dates, assignments, status actions, exceptions, case administration; **no ordinary editing** of health data, section C or payroll identifiers |
| Back office | DSV administration, payroll identifiers, payroll-relevant disability facts, absence types and dates, settlement data |
| Regional admin / Admin | configuration only, no case data |

- Assisted writes are recorded as actor + `onBehalfOf`.
- **Self-service fields** (Q136): staff write them only in assisted mode (above), never in normal
  mode (`needs_assisted_mode`). Staff writes of a category's other fields outside a domain
  operation (e.g. a consultant's IBAN, back office's birth date) stay `undecided` (Q65).
- **Signed or submitted documents are immutable**; corrections create a new version or a
  correction record.
- Sensitive writes and corrections are audited.

### Person-data writes and the HR import

- **Write paths:** identity and personnel-file data are written only by the HR import, manual
  creation and the seed, all through `write_participant_data`; there is no generic edit. The
  function computes the changed fields and audits them as `participant_data_changed` with the
  field names, never values. The matrix cell for ordinary PL edits stays `undecided` (Q65).
- **No target for sensitive data:** the import maps only identity, Austrittsdatum, address and
  contact (`packages/domain/src/import/targets.ts`); there is no target for special-category or
  highly confidential data. Columns such as Steuer-ID, IBAN, RV-Nummer, GdB or nationality can't
  be mapped, so their values are dropped: never stored or echoed. The preview report is a 200
  response (`packages/domain/src/import/contract.ts`); its issues carry row, target and code,
  never a value.
- **Logs:** preview and confirm log the project id, request id, counts and duration only; never
  file names, headers or values. The base64 file body never reaches a log or an error
  (validation problems carry the code and location, never the submitted value).
- **Keys** (`apps/api/src/imports/keys.ts`): the saved mappings' header hashes and the preview
  token are HMACs with keys HKDF-derived from `SESSION_SECRET` (`import-header-mapping:v1`,
  `import-preview-token:v1`), so one key never gives the other. Rotating the secret unlinks every
  saved mapping (only suggestions are lost) and invalidates open previews; in development the
  secret is random per start.

### Self-service data *(assumed, Q112, Q138, Q140, Q141)*

- **What the participant writes:** the wizard's confidential fields (TL 407 section B; pages and
  value sets in `regional-variation.md`, "Self-service wizard"): the profile in
  `participant_profile` (one row per participation: gender, Familienstand, education and work
  history, languages, driving licence, vehicle, working time, job wishes, locations, distance,
  earliest start, the chain's confidential custom fields; class `confidential`, retention
  `personnel_file`) and the contact fields address, phone, mobile and private email in
  `participant_details` (never the login channels or the work email; names and birth date are
  shown read-only). The highly confidential and special-category answers have their own
  encrypted tables and logged endpoints (below); no page write, list or wizard response carries
  them (unknown keys are refused).
- **Write path:** only `write_self_service_data` (SECURITY DEFINER; the runtime role selects the
  tables and writes none). One page per call, saved whole into the real fields (no draft store),
  with the profile's `revision` (optimistic concurrency: a stale one is `409 stale_revision`). The
  function computes the changed fields and audits them as `participant_data_changed` with their
  names (`custom.<key>` for a custom field), never a value; an unchanged page writes nothing.
  Refused when the participation is terminal (`participation_closed`), for any session but the
  live `active` session of this participation (an `activating` one included, `401`), before the
  current purposes notice is acknowledged (`409 notice_required`), and in the evidence-set phase
  (no writes, the matrix above). Staff write through assisted mode only (ADR-0007).
- **Participant-maintained contact fields (Q112):** a contact field the participant changes (also
  in assisted mode) is recorded in `participant_details.participant_maintained`; the HR import
  (`write_participant_data`) never overwrites it, and its preview reports a differing value as
  `participant_maintained` by row and target, never the value. A written address also notes its
  time, for the placement-Agentur hint (`regional-variation.md`, "Placement Agentur").
- **Purposes notice (Q138):** before the first page the portal shows `self-service-purposes:v1`
  (de/en, `packages/domain/src/notices/catalog.ts`): the purposes per phase and their legal bases
  (Art. 6(1)(b)/(c), Art. 9(2)(b) for the yes/no health answers). Its acknowledgement (version,
  language, the participant or staff on their behalf, time) is a record in
  `self_service_notice_acknowledgement`, immutable, retention `personnel_file`, audited as
  `self_service_notice_acknowledged`: **not a consent**. A new version is shown, and acknowledged,
  again before the next page.
- **Staff read** (`GET /api/v1/participations/{id}/self-service`, normal mode): each value the
  access matrix lets the viewer read (confidential: the assigned consultant, the PL, back office;
  an unassigned consultant and the org roles get a `403`), the maintained contact fields, the
  notice acknowledgement and the missing items of the data-collection and profiling steps as
  codes, for the fields the viewer may know about (below). Nothing on it needs a logged read.
- **The tab "Selbstauskunft"** (staff app, normal mode): the confidential answers the viewer
  reads, by wizard page; the highly confidential and special-category answers only as "angegeben
  / fehlt" (`sensitive`, presence) for the fields the viewer may know about: those they read in
  normal mode or see in assisted mode or through break-glass (so the PL sees whether health and
  disability are given, never the value). "Anzeigen" appears for the fields the viewer may read
  in normal mode (`sensitiveReadable`: the assigned consultant all, back office all but health)
  and reads that one field on `GET …/self-service/sensitive/{group}?field=…`, a logged read
  (`sensitive_read`), never cached. The missing items of the data-collection and profiling steps
  are listed per step as labels; custom fields by their German label (`customLabels`).
- **Highly confidential and special-category answers (Q135, Q141):** encrypted in the database
  (ADR-0002, field encryption), one table per access category and retention class:

  | Table | Fields (TL 407 section B) | Class / access category | Retention |
  |---|---|---|---|
  | `participant_identifier_data` | RV-Nummer | highly confidential / `identifiers` | `participation_record` (evidence set, Q88) |
  | `participant_residence_social_data` | nationality (`german`, or `other` with an ISO 3166-1 alpha-2 country), entry date and residence status (only with another nationality, never required), Bürgergeld yes/no | highly confidential / `residence_social` | `personnel_file` |
  | `participant_health_data` | health restrictions yes/no, Schwerbehinderung/Gleichstellung yes/no; never a diagnosis or the GdB | special category / `health`, `disability` | `health_record` |

  Each value is a ciphertext (`pgp_sym_encrypt`, AES-256, an envelope binding it to its
  participation and field) beside an unencrypted presence flag; completeness, the wizard state
  and every list use the presence only, never the value. The runtime role can't select a
  ciphertext column and writes none of the tables; only `write_sensitive_fields` and
  `read_sensitive_fields` encrypt and decrypt, with the key the API passes per call
  (`FIELD_ENCRYPTION_KEY`, HKDF `field-encryption:v1`). Every field written is audited as
  `sensitive_write`, every field read as `sensitive_read`, with its key only.
- **Their endpoints:** the participant reads and writes a group (`ba_details`, `health`) on
  `GET`/`PUT /api/v1/portal/self-service/sensitive/{group}` (`no-store`; the write as a page write:
  whole, with the revision, after the notice; `422` with codes and locations, never a value); the
  health group needs the session's step-up (`403 step_up_required`; ADR-0007, step-up). Staff read
  on `GET /api/v1/participations/{id}/self-service/sensitive/{group}` in normal mode exactly the
  fields the matrix gives them (the assigned consultant all; back office identifiers,
  residence_social and disability; the PL none without assisted mode or break-glass), each read
  logged (`field` narrows it to one); the others are left out, not shown empty. In assisted mode
  staff read and write on `GET`/`PUT /api/v1/participations/{id}/assisted/self-service/
  sensitive/{group}` the group's fields their role sees there (a write leaves the others as they
  are), each field audited with actor and `onBehalfOf`; no step-up for staff.
- **Assisted mode records** (`assisted_mode`, ADR-0007): the staff session's hash, the staff
  user, the participation, how and when it started and ended; class internal, `case_internal`,
  retention `access_credential`. No value of the participant's is on it.
- **Step-up (Q129, Q137):** before the health and disability answers, once per portal session: a
  birth-date account enters its birth date again (the session after an activation with that step
  counts; the fifth wrong one ends the session, audited `step_up_failed`), a photo-ID account a
  step-up code sent to a verified channel it picks (the login code never counts; the code has its
  own five attempts). Only the special-category fields are gated.
- **The portal's own consents** (`GET /api/v1/portal/consents`): purpose, source, text version,
  language, given and ended, and the channel id of a portal contact consent; never an address.
  The portal page "Einwilligungen" lists them; revoking `portal_contact` is removing the channel.
- **The wizard in the portal** (`@transfer/self-service-ui`, "Meine Angaben"): the purposes notice
  first, then one page at a time, saved whole on "Weiter" with the revision read ("Zurück" doesn't
  save); a `409` reloads the state and says so, a `422` shows the codes at their fields. The copy
  says optional data may be left for the Berater and asks for no diagnoses in free text; the
  "Gesundheit" page says it asks yes or no only. "Angaben für die Agentur" (after Kontakt) and
  "Gesundheit" (last before "Weitere Angaben", behind the step-up) read their group each time they
  open and keep the values only in the page's form, never in the query cache; the progress bar
  counts them by presence. Nothing is kept in browser storage; logging out drops the cached state.

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

## Legal basis and consent *(assumed, Q4, Q44)*

| Purpose | Legal basis |
|---|---|
| Import from the customer (name, contact, Personalnummer) | Art. 6(1)(f), backed by the Transfersozialplan |
| Information, data collection, DSV preparation | Art. 6(1)(b), pre-contractual |
| beE employment, payroll, Transfer-KuG | Art. 6(1)(b) + (c) (SGB III, SGB IV, AO) |
| Profiling and reporting to the Agentur | Art. 6(1)(c) (§110/§111 SGB III) + signed TL 407 declaration |
| Health / disability | Art. 9(2)(b). Details beyond yes/no only with explicit consent, Art. 9(2)(a) |
| Private email/mobile for portal login and portal notifications (reminders) | consent, Art. 6(1)(a), revocable (`portal-contact-consent:v2`) |
| TG access to the BA applicant profile (Kug 200b) | own consent record |
| Aggregated customer reporting | Art. 6(1)(f), anonymised |

- Each processing purpose is stored with its legal basis.
- **Our consents** are records (`consent_record`, Q138): purpose (`portal_contact`,
  `kug200b_profile_access`), source (`portal`, or `paper_form` that staff record from a signed
  form), text version and language, who and when, and when and why it ended. A channel is named
  exactly for `portal_contact` (a `CHECK`), which is given in the portal; revoking it is the
  channel's removal. `kug200b_profile_access` is recorded from the signed Kug 200b (Slice 6).
  Revoking consent never blocks contract-based or legally required processing.
- **Consent v2 (Slice 5; Q154, final):** `portal-contact-consent:v2` (de/en, immutable, SHA-256
  tests) covers login codes and operational notifications from the portal, such as a reminder
  that something is open; no advertising; voluntary and revocable by removing the channel or
  writing to the controller. From Slice 5 on, activation, recovery and a new channel record v2
  only (`complete_activation` and `add_participant_channel` refuse v1). No migration converts v1
  evidence: a v1 channel keeps login codes but gets no reminder. "Meine Kontaktwege" offers each
  v1 channel a voluntary upgrade (the v2 text, "Zustimmen", "Später"); declining removes no
  channel, ends no session and doesn't affect login; the offer comes back on the next visit only
  there. The verified address isn't verified again; staff can't give v2 on a participant's behalf
  (no staff or assisted route). `upgrade_channel_consent` locks the participation, the channel and
  its consent, ends the v1 consent `superseded` (never `revoked`), inserts the participant's v2
  consent, points the channel to it and audits `consent_ended` and `consent_given`, or answers
  `already_current`. Staff channel views show the consent version beside kind and state.
- **Acknowledgements are not consents:** the self-service purposes notice is acknowledged, not
  consented to (above, "Self-service data").
- **Declarations to the BA** are not our consents: the Jobbörse choice (TL 407 field 50) is
  stored as an enum on the profiling record, and the BA contact/research consent as a boolean,
  each with a date. Revocation goes to the BA.

## Retention and deletion *(verify, Q3, Q24, Q40, Q51, Q52)*

**Each data item or document follows its own retention class.** Where one item falls under
several rules, the longest of those rules applies. Retention is **per item, never per person**,
so a long payroll rule never keeps a whole profile.

| Data | Retention (from) |
|---|---|
| Non-signers (`withdrawn` pre-TG) without BA-funded measures | full deletion **90 calendar days after `withdrawnOn`** (manual or automatic withdrawal), if there was no fully executed DSV, funded §110 participation, legal hold or other retention duty. *Assumed (Q77): `unset` in executable configuration until the DPO confirms.* |
| Non-signers with BA-funded §110 measures | full deletion after 90 days, **except the evidence set** |
| Structured health fields (class `health_record`, Q141) | 3 months after beE exit, or with non-signer deletion |
| Schwerbehinderung status for payroll | with payroll records, as long as payroll needs it |
| TG personnel file, DSV, profiling, placement data | 3 years after the end of the year of exit |
| Sub-status periods (sickness etc.) | payroll retention |
| Lohnkonto | end of the 6th calendar year after the last entry (§41 EStG) |
| Entgeltunterlagen | end of the calendar year after the last social-security audit (§28f SGB IV) |
| Accounting vouchers | 8 years (BEG IV); books and annual statements 10 years |
| ESF-funded projects (later) | per funding notice, configurable |
| Audit log | 3 years; pseudonymise subject references when the subject's data is deleted (also `reminder_queued` and `reminder_delivery`, Q156) |

**Evidence set** (for anyone who took part in a BA-funded §110 measure or received
Transfer-KuG): identity, measure, dates and times of participation, signed participation pages
(TL 407, Kug 200b), proof of submission, and the matching audit entries.
- It expires at the end of the calendar year of the **later** of `kugFinalSettlementDate` and
  `measure110SettlementDate`, plus 4 years (configurable, must be verified).
- It is **not deleted until the required settlement dates are set**. The admin dashboard warns
  when a project ended more than 12 months ago without them.
- Access is break-glass only.

**Retention classes of the tables so far** (`packages/db/src/data-catalog.ts`). The data catalog
keeps every period `unset` until the retention job (Slice 7) implements the accepted rules, so no
deletion job touches any class before then. Round 32 recorded accepted sample-data pilot rules for
`project_master`, `participation_record` and `personnel_file` (Q58, Q105, pilot DPO role); among
them, a legal hold suspends only the affected records, never the whole participant profile:

| Class | Tables | Rule |
|---|---|---|
| `project_master` | `appointment` (an info event or slot: kind, times, capacity, the generic title and the shared venue, status and closed cancel reason, host and creator staff ids; Slice 5b, Q166), `project` (from Slice 3 with its region), `project_membership` (staff ids and project roles, Slice 2; a removed role's row is deleted, its event stays, PR 3c), `project_entry_wave`, `import_column_mapping` (the keyed hash of a normalised column header and its target, saved by a confirmed import, never header text; Slice 2, PR 2g. **Classed `confidential`, possibly pseudonymised participant data**: if a PL picks a data row as the header row, the hashes are keyed hashes of a person's values, which are pseudonymised, not anonymised (Art. 4(5) GDPR). The confirm saves no mapping when the chosen header row looks like a data row (a date, an `@` or five or more digits in a cell); hashes are never served, logged or exported; rotating the derived key makes every stored hash unlinkable. It stays in this class because it can't be linked to a person or participation. The runtime role writes it directly (SELECT, INSERT, UPDATE; no DELETE; not audited, a cache of hashes): the one project-data table written outside a database function), `project_template_pin` (which template versions a project pinned, by which staff user, Slice 2), `project_config_override` (override versions: Agentur-scoped settings with source codes, the confirming staff id and date, approved relaxations with rule id, reason code, approving staff id and date; project-wide, no participant data; append-only, PR 2d-1), `config_relaxation_request` (relaxation requests: rule id, controlled reason code, status, requesting and deciding staff ids and dates; project-wide, no participant data, PR 2d-2) | accepted in [round 32](../decisions/2026-10-19-answers-round-32.md) for the pilot (Q58): retained while active or unsettled; after closure until the later of the end of the 3rd calendar year after closure and the end of the 4th calendar year after the later BA/§110 final settlement date; a never-activated draft without participants, never submitted externally: 1 year after its last activity. At expiry membership links and actor references are deleted or pseudonymised per the audit policy and identifying free text deleted; accounting, payroll, contract and tax records keep their own classes |
| `staff_account` | `staff_user` (name, email, `may_create_projects`; from Slice 3 the bound OIDC identity `oidc_issuer`/`oidc_subject` and `deactivated_at`; the flat role is gone, PR 3c), `staff_org_role` (current org-role grants: role, region, who granted it when; `internal`; revocation or account deactivation deletes the row while the event preserves role, region and reason; Slice 3, PR 3c/Q131) | deactivate and pseudonymise the account, never delete it (Q59, assumed); executable period remains `unset` |
| `access_credential` (Slice 3, PR 3b/3d) | `staff_session` (the SHA-256 of a session token, never the token; the staff user, start, expiry, end and end reason; `internal`); `activation_code` (a separately keyed code hash and, only for in-person issuance, a separately keyed destination hash; channel, non-secret state, staff ids and times; never the code or destination; `confidential`, project-scoped); from PR 3e `one_time_code_challenge` (a keyed one-time-code hash, the normalised address it went to, outcome, attempts, times; `confidential`) and `participant_session` (a token's SHA-256, state, steps done, step-up, from Slice 4a the step-up before special-category data and its wrong birth dates, times; `internal`); from Slice 4b `document_link` (an opening's link: a token's SHA-256, the document, the session's kind and hash, expiry; `internal`, no privilege for the runtime role) | deleted, or stripped of hashes and addresses, 30 days after use, expiry, lock, revocation or end; a legal hold never keeps a secret usable (Q122, assumed). The executable period remains `unset` until Slice 7 |
| `participation_record` | `participation` (statuses, dates, end reasons and, from Slice 4a, the placement Agentur key and when it was set: `internal`, `case_internal`, listable; written only by `set_placement_agentur`, PR 4a-1), `participant_assignment` (which consultant a participation is assigned to, by whom and when, how it ended; ids and codes, `internal`, closed, never deleted; Slice 3, PR 3c), `participant_identity` (Personalnummer, last and first name, birth date; Slice 2, PR 2f), `participant_identifier_data` (the encrypted RV-Nummer, its presence, key id and times; `highly_confidential`; Slice 4a, PR 4a-4), `participation_dsv_amendment` (DSV amendment metadata: kind, date fully executed, old and new effective dates, the confirming staff id and instant, the controlled original location, an optional document number; no free text; immutable; part of the evidence set, round 32 D3; Slice 2, PR 2h-3), `ba_reporting_task` (BA reporting tasks: kind, the date reported on, status; Slice 2, PR 2h-3), `profiling_exception_request` (reason codes and an evidence id and fingerprint, never evidence contents; the fingerprint is confidential evidence metadata, never in audit details, logs or responses, round 17; the evidence becomes a document, `profiling_exception_evidence`, with Slice 6) | accepted in [round 32](../decisions/2026-10-19-answers-round-32.md) for the pilot (Q77/Q105): non-signer without a fully executed DSV or funded §110 participation 90 calendar days after `withdrawnOn` (unless a legal hold or documented dispute); fully executed DSV without TG entry, end of the 3rd calendar year after cancellation or contractual end; TG participant, end of the 3rd calendar year after exit; BA-funded, the minimum evidence set until the end of the 4th calendar year after the later of `kugFinalSettlementDate`/`measure110SettlementDate`, never while one is missing |
| `audit_log` | `audit_event`, `staff_audit_event` (staff authentication and administration history: staff ids, codes and counts; account, org-role and region changes; removed org roles preserve role, region and reason; never a name, email, claimed identity, token or claim; no `project_id`, `internal`; Slice 3, PR 3b/3c) | 3 years; subject references pseudonymised when the subject's data is deleted; entries of an evidence set follow it (Q3, verify) |
| `personnel_file` (Slice 2, PR 2f; Slice 3, PR 3d) | `participant_details`: street and house number, postal code, city, `addressCountry`, phone, mobile, private and work email, `oldEmploymentEndDate`; `privacy_notice_delivery`: immutable Article 14 evidence with version, language, method, staff id, time and optional activation-code id, never notice text or destination (`internal`, project-scoped); from PR 3e `participant_account` (activation time, code id, identity assurance with the staff confirmer of a photo ID, language; `internal`), `participant_channel` (the field `portalChannels`: kind, normalised private address, verification, consent id, notice, suspension and removal dates; `confidential`; the address and its hash erased 30 days after removal, Q122) and `consent_record` (purpose, source, the channel id of a portal contact consent, text version, language, actor and dates, never the address; `confidential`); from Slice 4a (Q141) `participant_profile` (the self-service profile, TL 407 section B: `confidential`), `self_service_notice_acknowledgement` (the purposes notice acknowledged: version, language, actor, time; `internal`, immutable), `participant_residence_social_data` (the encrypted nationality, entry date, residence status and Bürgergeld, their presence, key id and times; `highly_confidential`; PR 4a-4) and, on `participant_details`, which contact fields the participant maintains and when they wrote the address (metadata); from Slice 5 (Q156) `participant_reminder` (the reminder log: ids, kind, text version, language, the channel's id and kind, the consent id, the requester's id, times, status, cancel reason; `internal`, `case_internal`; non-signers with the 90-day deletion, otherwise the end of the 3rd calendar year after exit; a legal hold extends only the affected rows; the channel's address is erased under its own rule, the reminder keeps the value-free channel id); from Slice 5b (Q166) `appointment_booking` (which appointment, origin, status, closed cancel reason, the booking and cancelling staff ids, times; `internal`, `case_internal`; its triggers, **mapping awaiting confirmation**: a non-signer without a fully executed DSV, funded §110 participation, legal hold or other duty 90 days after `withdrawnOn`; an executed DSV without TG entry the end of the 3rd calendar year after cancellation or contractual end; a TG participant the end of the 3rd calendar year after exit; proposed: `ta_completed` in a `ta_only` project the end of the 3rd calendar year after that change, withdrawn with a funded participation the end of the 3rd calendar year after `withdrawnOn`; a legal hold suspends only the affected rows; never BA evidence) | accepted in [round 32](../decisions/2026-10-19-answers-round-32.md) for the pilot (Q105): non-signer without an executed DSV or funded measure 90 days after `withdrawnOn`; TG participant or executed employment arrangement, end of the 3rd calendar year after exit, cancellation or contractual end; then the whole class is deleted unless a field was copied into a separately classified payroll, accounting or legal record; never part of the BA evidence set |
| `health_record` (Q141) | `participant_health_data` (Slice 4a, PR 4a-4): the encrypted health restrictions and Schwerbehinderung/Gleichstellung yes/no answers, their presence, key id and times (`special_category`) | 3 months after beE exit or with the non-signer deletion; executable period `unset` until Slice 7 |
| `by_document_type` (Slice 4b, PR 4b-2; Q145) | `document`: each row its type's class, held by its policy (`personnel_file` for the CV, other uploads and certificates; `evidence_set` for the signed TL 407 and Kug 200b scans; `personnel_file` for the DSV scan and cancellation; `participation_record` for the ASU proof and exception evidence). The metadata of an encrypted file (type, media type, size, the kept file name, who added and reviewed it, the content hash and the wrapped key the runtime role can't select); a deletion's tombstone (type, dates, who by kind, reason code; the file name erased) follows the type's class, its object is purged at once | the type's class; executable periods `unset` until Slice 7 |
| `evidence_set` (Slice 4b) | no table of its own: `document` rows of the signed TL 407 and Kug 200b scans | the BA evidence set (above); `unset` until Slice 7 |
| `reference_data` | `region` (code and name of a Niederlassung; Slice 3, PR 3c), `lifecycle_edge`, `job_run` (job names, run dates and instants, PR 1h-1), `config_template_version` (template contents as released; global, no `project_id`), `document_type_policy` (the document type catalog per version: classes, file names, roles; Slice 4b) | no personal data; never touched by the retention job |

Implementation:
- `retentionClass` per data category and document type, configured as data.
- A nightly, idempotent, **two-stage job** with the `system` actor: full deletion first, then
  evidence-set deletion.
- **Backups are kept for at most 30 days**, so that deletions take effect.
- All periods are configurable. The round 32 values are accepted for the sample-data pilot and
  should be reviewed again before production or real-personal-data use.

## Authentication *(assumed, Q7, Q11, Q27, Q28)*

- **Staff**: Entra ID via OIDC, MFA enforced by Conditional Access. Roles and assignments are
  managed in the app. Sessions last 8 hours, server-side, in httpOnly SameSite cookies.
  - **As built (Slice 3, PR 3b):**
    - **Sessions:** both login modes (OIDC, and the dev stub, never in production) start a
      `staff_session` row. The cookie `__Host-tp_staff` (`Secure`, `HttpOnly`, `SameSite=Lax`,
      `Path=/`; `tp_staff` over http in development) carries 32 random bytes. The table keeps only
      their SHA-256, so a database read gives no live session. Every login issues a new token and
      ends the one the browser carried (`superseded`). 8 hours absolute, no sliding window,
      checked in SQL against database time; logout ends the row.
    - **Binding:** staff accounts are created in the app. The first OIDC login of an active,
      unbound account binds the token's `(iss, sub)` to the account whose email equals the `email`
      claim (else `preferred_username`), compared case-insensitively; later logins match
      `(iss, sub)` only. Unknown, deactivated and differently bound accounts are refused
      (`unknown_account`, `account_deactivated`, `identity_mismatch`). The app doesn't check `amr`:
      MFA is the identity provider's. Use the tenant-specific issuer: the `email` claim is only
      trusted for the first binding of an account an admin created.
    - **Staff audit:** `staff_audit_event` records `staff_login` (with the method),
      `staff_logout`, `staff_login_refused` (the code, and the matched account where there is one;
      never the claimed email) and `staff_identity_bound` (the claim matched). The runtime role has
      no privilege on it.
    - **No secrets in logs:** request lines carry the route pattern and the staff user id; no
      token, cookie, authorization code, claim or email reaches a log line, an error or a URL.
  - **As built (Slice 3, PR 3c):** accounts are created and deactivated only by a global admin
    (`/admin/staff`); deactivation ends the account's sessions at once (`end_reason`
    `deactivated`), removes its org roles and memberships, closes its assignments, and is refused
    for a project's last active PL. The staff audit trail adds `staff_account_created`,
    `staff_account_changed` (the
    changed keys, never the name or email), `staff_account_deactivated` (counts), `org_role_granted`
    and `org_role_revoked` (role and region; deactivation also records `account_deactivated`),
    `region_created` and `region_changed` (the region's
    id). A login may return to `/admin` pages too.
- **Participants**:
  - First access: a personal activation code, generated when the PL issues it: a printed
    letter to the imported address, a sheet at the info event (both with a QR of the personal
    link; the code in the link's fragment, never in a URL the server logs), or in person, sent
    to a private email or mobile the person gives after an ID check, activated on the person's
    own device; the PL never sees the code (Q120). It is single-use,
    stored only as a keyed hash, valid 30 days from issuance, locked after 5 failed attempts;
    a new issuance revokes the old one. The PL or assigned back office issue it after verifying
    the person; no anonymous or self-service reissue; every issuance is audited
    ([round 35](../decisions/2026-10-20-answers-round-35.md), Q118). The letter or sheet is the
    Art. 14 GDPR notice, versioned (Q114).
  - The participant then registers at least one private email or mobile (their choice, Q117,
    Q119) and logs in with one-time codes to it. Contact data the participant maintains is never
    overwritten by an HR re-import (Q112). **Imported work emails are never used for login.** An email
    login never takes effect on a bare GET (mail scanners open links).
  - After an activation, a notice goes to the newly registered channel.
  - Links/codes are single-use and expire after 15 minutes, with at most 5 requests per hour
    per phone number or email.
  - Sessions: 30 minutes idle, 12 hours absolute.
  - Before special-category data is shown, the participant must enter their date of birth as a
    knowledge check. A real second factor comes later.
  - Fallbacks: a new activation code (letter or info event), and assisted mode.
  - **Round 36** ([answers](../decisions/2026-10-20-answers-round-36.md), Q121–Q130, assumed
    unless noted):
    - **Identity per channel (Q127):** a letter is delivery, not verification: assurance is the
      code plus the birth-date check, so no birth date, no letter. A sheet becomes activatable only
      once staff record its handover after inspecting an original official photo ID against the
      imported identity; an in-person send needs the same check first. Only the confirmer, time
      and method are stored, never an ID number, copy or image. Without a birth date only these
      two channels skip the birth-date step, and the method is recorded (Q129).
    - **Failures (Q128):** a well-formed wrong birth date, or for an in-person code a wrong
      delivery address, counts; the fifth locks. Unknown, expired, revoked, used or locked codes
      count nothing and get one generic answer. A per-IP throttle covers every code submission;
      a shared limiter is needed before a multi-process deployment with real data.
    - **Art. 14 notice (Q124, verify):** supplied at issuance (letter, sheet, or a durable notice
      or link in the first in-person message), never first in the portal; version, language,
      method and time recorded; due at the first communication and at the latest one calendar
      month after the data was received; the PL sees due and overdue. German and English for
      every format.
    - **Channels (Q123, Q125):** staff never retrieve a registered private email or mobile, only
      its kind, verification and consent state and dates; the app sends versioned portal
      notifications under the consent purpose `portal_contact`. One address belongs to at most one
      active account; a collision never names the other account.
    - **Cutoff and terminal statuses (Q121):** a first activation before `informed` needs the
      participation's cutoff not to have passed; a terminal status revokes open codes and ends
      sessions.
    - **Lost access (Q130):** a recovery code; issuing it ends the sessions and suspends the old
      channels at once; completion replaces them (consents end `lost_access_replaced`).
    - **Retention (Q122):** activation codes, one-time codes and sessions (class
      `access_credential`) are deleted or stripped of hashes and addresses 30 days after use,
      expiry, lock, revocation or end; a removed address and its hash are erased after 30 days
      while the value-free consent proof stays with the personnel file; a legal hold never keeps
      a secret usable.
  - **As built (Slice 3, PR 3d — issuance only):**
    - Codes are twelve Crockford base32 characters (about 60 bits, printed `XXXX-XXXX-XXXX`)
      generated only on issuance; input is normalised (upper case, spaces and hyphens dropped,
      O→0, I/L→1), and a malformed code counts nothing. HMAC keys for the
      code, destination and later one-time codes are independently HKDF-derived from
      `ACCESS_CODE_SECRET`; staff-session keys are unrelated. Rotation invalidates open codes but
      never staff sessions.
    - Letter and sheet batches are atomic. A letter requires the imported postal address and birth
      date. A sheet records Article 14 provision only when its photo-ID handover is confirmed.
      In-person issuance records the photo-ID check and commits `pending` before the provider call;
      a definitive successful send records notice provision, failure revokes, and an unknown
      outcome remains valid without claiming provision.
    - The immutable bilingual `art14-activation:v1` catalog is protected by fixed SHA-256 tests.
      Letter/sheet output embeds the text; the first in-person message links to a public static
      versioned page with no personal data or API request. Controller/DPO values come from
      organisation configuration and must receive final DPO review before real data.
    - Codes exist in staff memory only for the print result; QR links use the fragment. Application
      logs, audit details, errors and later responses contain no code, destination or hash.
  - **As built (Slice 3, PR 3e — activation and sessions):**
    - The portal takes the code from the link's fragment, removes it from the address bar and
      posts it only on a click. A code starts an `activating` session (cookie `__Host-tp_portal`,
      its SHA-256 stored) that opens only the activation steps; completion starts an `active` one
      with a new token. 30 minutes idle, 12 hours absolute, by database time; a terminal status
      ends every session.
    - Steps: the notice repeated (the version shown recorded), the birth date (skipped only for a
      handed-over sheet or an in-person code without one), then the retyped delivery address of
      an in-person code (keyed hash comparison) or a private email or mobile with the consent
      `portal-contact-consent:v1` (de/en, purpose `portal_contact`; v2 from Slice 5) and a six-digit one-time code.
      The imported work email is refused (`channel_invalid`); an address of another active
      account is the generic `channel_in_use`.
    - Failures: a wrong birth date or delivery address counts on the code and the fifth locks it
      (audited by the system); a wrong one-time code counts on that code and the fifth ends it.
      Unknown or unusable codes, and syntax errors, count nothing and get the one generic
      `code_invalid`. Every code submission passes the per-IP throttle (10 per 15 minutes, in
      memory per process; a shared limiter is a pre-pilot item, ADR-0005).
    - Completion is one transaction: code used, account (`birth_date`, or `photo_id` with the
      code's ID check), consent, channel, `imported`/`unreachable` → `contacted` by the participant
      (cutoff re-checked by database time), `participant_activated`, `consent_given`,
      `contact_channel_added`. The activation notice goes to the new channel through a job queued
      in that transaction.
    - Staff see that the account is activated, how the identity was assured, and per channel its
      kind, verification, consent and notice dates; never the address. The participant sees their
      own channels masked. No response, log line or audit row carries a code, one-time code,
      address or hash; portal request lines carry the participation id.
    - The consent and message wording are pilot drafts awaiting DPO review (Q132).
  - **As built (Slice 3, PR 3f — login, channels, lost-access recovery):**
    - **Login:** the participant types their private email or mobile; the answer (`202`) is the
      same whether or not it is a live channel of a usable account, and a code is sent only when it
      is, after the response so the timing doesn't tell either. The email carries the six-digit
      code and a link with it in the fragment (never the address); the page logs in only after the
      participant typed the address and clicked. An unknown address, a wrong, expired or used code
      and the fifth wrong entry get the same `one_time_code_invalid`. Login codes are limited to
      five per address and hour for every address alike (in memory, keyed hashes); the database
      also counts login and verification codes of known addresses together, and a request only it
      refuses is accepted silently. Logins are audited (`participant_login`, the channel's id).
    - **Channels:** the participant adds a private email or mobile with its own consent and a
      one-time code to it, and removes one, which ends its consent `revoked` (both audited as the
      participant). Removing the last channel ends all their sessions; the portal warns first
      that portal login is then no longer possible and that help in person, by phone or by letter
      remains (Q154). From Slice 5 a new channel records consent v2 (above, "Legal basis and
      consent"). An
      address of another account, or the participant's own, is the generic `channel_in_use`; the
      work email is `channel_invalid`. Staff still see only kind, states and dates.
    - **Recovery (Q130):** the PL or back office issue a recovery code (letter, sheet or in person)
      for an activated account only, after confirming they verified the person (Q133 for how).
      Issuing it ends every session and suspends every live channel in the same transaction
      (`contact_channels_suspended`); suspended channels get no login codes or notices. The
      participant runs the activation steps again; completion removes the old channels, ends their
      consents `lost_access_replaced` (never a withdrawal), adds the new channel and consent,
      changes no lifecycle status, and is a login. The account keeps its first identity
      assurance. The activation notice goes to the new channel. If the code expires or is revoked, the channels stay suspended.
- **Assisted mode**: staff act on behalf of the participant, audited as `actor` + `onBehalfOf`.
  No session sharing.
- **No self-registration.** There is no anonymous endpoint that creates participant records;
  every account is bound to a participation the PL created ([round 35](../decisions/2026-10-20-answers-round-35.md)).

## Other rules

1. **Purpose limitation per phase.** The UI explains each purpose to the participant.
2. **Audit log** for every read of special-category and highly confidential data, every
   document opening, every export, every break-glass, every guard override, and every confirmed
   plausibility warning.
3. **Hosting**: local for development on synthetic data only. Production and the pilot run on
   the company Hetzner cluster in German locations only (ADR-0005). Real data never goes on
   laptops, into cloud coding sessions or into the repo.
4. **No AI in the MVP.** Later, only EU-hosted providers with an AVV and no training on our
   data. US providers are never used for personal data, even with a contract *(assumed, Q38)*.
   Check the EU AI Act classification before any assessment feature.
5. **No real data in development, tests, cloud coding sessions or screenshots.** Synthetic data
   only (`pnpm db:seed`, `fixtures/`).
6. **Logs, error reports and job payloads contain no personal data.** Use IDs only.
7. **Uploads**: virus scan (adapter), file-type allowlist, size limit, encrypted before storage,
   stored outside the web root, signed short-lived URLs (documents, "Document files" above).
8. **Participant rights**: export of own data and deletion requests (admin workflow in the MVP),
   subject to the retention duties above.
9. **Exports**: no Steuer-ID, SV-Nummer or IBAN in the payroll export unless back office
   explicitly requests it. That request is logged.
10. **DPIA (DSFA)** must be completed before any real data is used (Q25).
