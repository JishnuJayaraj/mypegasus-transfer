# Data protection: access matrix

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
  - **The regional view as built** (Slice 6, PR 6-5b; readings Q206): `GET /escalations`,
    "Eskalationen" (`/admin/escalations`), for a regional admin the `ta_tg` projects of their
    regions and for the global admin every one; anyone else `403`, the PL and the regional
    operations manager included. Per project: its name, its active PLs' display names and, per
    type (`tl407_not_submitted`, `profiling_compliance`), the number of escalated participations
    and the days since the oldest escalated (each escalation dated by its current episode,
    process-and-lifecycle.md, TL 407 submission). Projects without one aren't listed. The response's
    schema has no participant id, name or date of a person; the API reads only the open
    participations a rule applies to, and a refusal's date through `profiling_declined_dates`
    (dates only, no audit row leaves the database). Not cached (`no-store`).
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
  Only the code filters and the sort (a column code) sit in the URL. From Slice 6b the term, the
  column choice and the scroll position are kept in the page's memory for the way back from a
  participant (ui-patterns.md, C6), never in browser storage, so a reload forgets them. The participant page's breadcrumb links back
  with the list's code filters and sort (the URL's, never the term), handed over in the
  navigation's history state; the participant page reads its open items, deadlines and
  appointments from the same snapshot, so it shows nothing beyond the viewer's list scope. From Slice 5b each row carries its appointment items and
  next booking (process-and-lifecycle.md, appointment items): codes, ids and times, never a title
  or venue; the `needs_resolution` item only for the PL, who alone resolves it.
- **Page titles (Slice 6b):** the staff app's document title names the page and its project
  ("Teilnehmende · Projekt Nord – Transferplattform"), never a participant's name or any other
  personal data, since the browser keeps titles in its history and shows them in tab lists and
  shared screens. The shell keeps its state (the navigation's open state, the user menu) in
  component state only, never in browser storage.

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
  - *The portal's "Termine" (as built in 5b-3; Q164, Q165, readings Q174):* an activated
    participant with a live session sees their own invitations (until the start, whether or not
    the message arrived; "ausgebucht", "Buchung geschlossen" or another refusal with booking
    disabled and the next step: "Anderen Termin buchen" when an appointment of the same kind is
    bookable, else "Bitte wenden Sie sich an Ihr Beratungsteam"; title, venue and time only while
    the appointment is in their audience or host rule, else its kind and "Diese Einladung gilt
    nicht mehr"), their live bookings until the end with "Absagen" until the start, bookings and
    invited appointments cancelled by the organizer or the team until 14 days after the later of
    the original start and the cancellation, and the appointments they may book with the seat
    state only (`portalAppointments`). They book until the public cutoff and cancel their own
    booking until the start through their session (`book_appointment`,
    `cancel_appointment_booking` with the session's token); another participation's booking, or an
    appointment outside their project or rule, is a `404`. No booking confirmation message.
  - *Attendance (as built in 5b-2; Q163):* the PL and the assigned consultant record and correct
    attendance and confirm `informed` on it (`mayRecordAttendance`); after the participation
    closed the PL only. The conflict review ("Eskalieren", "Anderweitig informiert") is the PL's
    (`mayResolveAppointmentItem`). Back office reads attendance with the bookings and records none.
    The booking holds the value, who recorded it and when, the closed-case reason, the basis of
    `informed` (who, when), the conflict's handling and resolution and the supersession (staff ids
    and times), all in `appointmentBookings`, `personnel_file` like the booking.
  - *Missed appointments (as built in 5b-4; Q167, readings Q175):* the PL and the assigned
    consultant end a missed appointment's follow-up with a closed reason ("Keine weitere
    Nachverfolgung", `mayResolveAppointmentItem`, normal mode only, not for a closed participation)
    and book a consultation as a missed one's follow-up (`mayBookFor`). The booking holds the
    follow-up link (the missed booking's id, of the same participation) and the resolution (reason,
    staff id, time), in `appointmentBookings`, `personnel_file` like the booking. Back office reads
    them and does neither.
- **Customer**: no login in the MVP (Q47). See the next section.

### Resources, categories and the generated matrix *(assumed, round 11)*

The rules in this file are code in `packages/domain/src/access` (`decideAccess`), with tests for
every cell. **[The generated access matrix](../generated/access-matrix.md)** (`pnpm generate`,
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
  From 5b-4 `appointment_booked` names the missed booking a consultation follows up
  (`followUpOf`; null otherwise, absent in older events), and `missed_appointment_resolved`
  (`case`, the same viewers) the closed reason and the appointment as written.
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

### The entry clarification (Slice 7, PR 7-4)

`entry_clarification` and its steps `entry_clarification_step` are internal case data
(`participation_record`, `project_id` on the row, scoped to the participation), written only by
`record_entry_clarification`, `escalate_entry_clarification`, `record_clarification_instruction` and
`request_entry_clarification_reply`; the runtime role selects them. It holds the PL's pending code
and the manager's instruction code, each with a documented source: one line of at most 200
characters under Q209's rules, `case_internal`, shown to the PL who wrote it, the PL and back office
reading the tab and the manager who instructs (in "Freigaben", where the queue names the project and
dates but no participant and no participation id). The sources never reach the history, an audit
event, a log or a job payload. The PL and back office see the work list's DSV items and the bulk
generation; a consultant sees neither. The queue "Freigaben" lists an escalated case to the regional
operations managers of the project's region only.

### The reconciliation and its review (Slice 7, PR 7-6)

`tg_entry_reconciliation` and its steps `tg_entry_reconciliation_step` are internal case data
(`participation_record`, `project_id` on the row, scoped to the participation), written only by
`reconcile_tg_entry`, `review_reconciliation` and `reply_reconciliation_clarification`; the runtime
role selects them. The row holds the evidence's kinds, record ids, valid days and recording instants,
the PL's confirmation and the review's stage; a step holds the manager's outcome or the PL's reply,
its code and one documented source line (Q209's rules, `case_internal`). The sources are shown to the
PL and back office on the tab "DSV" and to the regional operations managers of the project's region
in "Freigaben", where the queue names the project, the TG start and the evidence's kinds with their
days but no participant, no participation id, no record id and no file (Q80). The sources never reach
the history, an audit event, a log or a job payload: `tg_entry_reconciled` (history `case`) carries the
evidence kinds; `reconciliation_reviewed` and `reconciliation_replied` (stream `review`) the codes.
