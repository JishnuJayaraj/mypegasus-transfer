# Slice 5b — Info events and appointments (F4)

Status: **draft**, waiting for the product owner's approval. Nothing is implemented before then.
Roadmap (Q158): info events and consultation slots; participant self-booking and cancellation;
attendance; invitations and their message logging; attendance driving the authorised `informed`
workflow; overdue appointments joining the work list of Slice 5. Only appointment polish stays in
v1.1 (D16).
Builds on: the lifecycle edges and the status function (process-and-lifecycle.md, main status and
rules), the work list and dashboard projection (`packages/domain/src/worklist/`), the reminders'
message log, channel, consent v2 and dispatch (`packages/domain/src/reminders/`,
`participant_reminder`, `reminders.send`), the audit history (`auditProjection`,
`audit_event_projection`), the portal (`apps/portal`) and the participant page's tabs.
Questions: **Q162–Q168** in `docs/open-questions.md`, each with a proposed answer marked
`assumed`. The plan builds on those proposals; an answer that differs changes the decision named
in its row.

## Decisions

- **D1. Two kinds of appointment, one table.** An `appointment` is an `info_event` (a group
  event of the project, many seats) or a `consultation` (a slot with one host, normally one
  seat). Both have a start and end (`timestamptz`, shown in Europe/Berlin), a capacity (1–500), a
  booking cutoff (`bookingClosesAt`), an optional title (≤ 100) and a location (1–200 characters,
  plain text, no control characters), a status `scheduled` or `cancelled`. An info event may be
  limited to one entry wave (`audienceWaveId`, `ta_tg`); a consultation has a `hostStaffUserId`,
  a PL or consultant of the project. Appointments are project data, not participant data, like
  entry waves; every project member sees the project's appointments and their booked count (an
  aggregate, Q62 allows it). *(assumed, Q164, Q166)*
- **D2. Who does what** *(assumed, Q162)*: the PL creates, changes and cancels info events and
  consultation slots for any host; a consultant creates, changes and cancels their own slots
  only. Staff booking for a participant, attendance and invitations: the PL for any participation
  of the project, an assigned consultant only for their assigned ones (Q62); back office reads
  bookings and attendance (`case_internal`) but does none of it; org roles, participants (beyond
  their own booking, D5), assisted mode and break-glass grant none of these operations. A
  consultation slot only takes participations its host may list: a consultant host only their
  assigned participations, so no attendee list ever shows a consultant a person not assigned to
  them. An info event's attendee list shows a consultant only their assigned participations
  (the booked count stays the total). New permission functions beside `mayPerformOperation`:
  `mayManageAppointment`, `mayBookFor`, `mayRecordAttendance`; invitations reuse `mayRemind`
  (Q153). Each joins the generated operation tables.
- **D3. Changes to an appointment** *(assumed, Q164)*: the capacity may rise any time and fall
  to no fewer than its live bookings; title, location, times, audience and host change only while
  it has no live booking (`appointment_has_bookings`): with bookings, staff cancel it and create
  a new one (rescheduling is v1.1 polish). Cancellation takes a closed reason
  (`organiser_unavailable`, `too_few_bookings`, `created_in_error`, `other`), no free text, cancels
  every live booking (`appointment_cancelled`) and, from 5b-2, sends each booked participant the
  change notice (D9). A started appointment can't be changed or cancelled. Appointments are never
  deleted. Created in a draft or active project; bookings, attendance and invitations need an
  active project (`project_not_active`).
- **D4. Bookings** *(assumed, Q164)*: one row per participation and appointment with `origin`
  `participant` (portal), `staff` (booked for them) or `walk_in` (created by recording
  attendance, D7); `status` `booked` or `cancelled` with a closed reason
  (`participant_cancelled`, `staff_cancelled`, `appointment_cancelled`, `participation_closed`);
  `attendance` `attended`, `absent` or not yet recorded. Rules for a booking (portal and staff
  alike): a scheduled appointment that hasn't started, before `bookingClosesAt` (staff too: a later
  arrival is a walk-in), with a free seat; a non-terminal participation of the project; an info
  event in the participation's audience (the project or its wave) while the participation is
  before `active_in_tg`; a consultation whose host may list the participation (D2); at most one
  live future booking per participation and kind (`booking_limit`), never two of the same
  appointment (`already_booked`); in `ta_tg`, before `informed`, no appointment starting after
  the participation's applicable latest entry date (`after_cutoff`: the cutoff would withdraw the
  person first, process-and-lifecycle.md, system withdrawal). The domain's `bookingEligibility`
  gives the capability and the code; the database function decides again.
- **D5. Self-booking and cancellation in the portal** *(assumed, Q164)*: an activated participant
  with a live session sees "Termine" (de/en, mobile-first, logical CSS properties): their live
  bookings and the appointments they may book (the D4 rules), each with kind, date and time
  (Berlin), title, location and "noch n Plätze frei" / "ausgebucht". "Buchen" and "Absagen" each
  after a confirmation. Booking until `bookingClosesAt` (default 24 hours before the start; the
  creator chooses 0–14 days), cancellation until the start (frees the seat); afterwards only staff
  cancel. A terminal status cancels every live future booking in its transaction
  (`participation_closed`, beside the revocation of activation codes) and the portal session
  ends anyway. No waiting list, no calendar file, no booking confirmation message (v1.1, D16).
- **D6. Concurrency: the last seat and double booking.** `book_appointment` locks the appointment
  row (`FOR UPDATE`), then the participation (`lock_participation`), counts the live
  non-walk-in bookings and inserts; a partial unique index on `(appointment_id,
  participation_id) WHERE status = 'booked'` makes a second live booking impossible whatever the
  race. Lock order everywhere: appointment before participation; the terminal transition locks
  only the participation's booking rows (by id), so no cycle with `cancel_appointment`
  (appointment, then its booking rows by id). Two participants racing for the last seat: one
  `201`, one `422 appointment_full`. A walk-in never counts against the capacity.
- **D7. Attendance** *(assumed, Q162, Q163)*: from the appointment's start, the PL or an assigned
  consultant records `attended` or `absent` for the bookings they may see, and adds walk-ins
  (`attended`, any non-terminal participation of the project for an info event, one the host may
  list for a consultation). One request records 1–500 rows all or nothing, like the bulk wave
  assignment: any refused row records none, and the answer names each refused row's index and code
  ("Keine Teilnahme erfasst" first). A recorded attendance may be corrected by the same roles
  (audited with the previous value); a correction never changes a status. Not before the start
  (`appointment_not_started`), not for a cancelled appointment or booking, not for a terminal
  participation (`participation_closed`).
- **D8. Attendance drives `informed` only along existing edges** *(assumed, Q163)*. Recording
  `attended` (info event or consultation: process-and-lifecycle.md, "attended info event /
  consultation") for a participation before `informed` offers "als informiert erfassen",
  preselected; the recorder may untick it. When ticked, the same transaction changes the status
  through the status function as the recording staff user (actor `user`, `manual` edges,
  `mayPerformTransition`): `contacted → informed`; from `imported`, `imported → contacted` then
  `contacted → informed`; from `unreachable`, `unreachable → contacted` (with its `before_cutoff`
  guard) then `contacted → informed`. Each change is its own `status_changed` event; no edge is
  added, none is skipped, and the domain's `attendanceStatusChanges` is tested to return only
  rows of `edges`. If any change fails its guard, the whole request is refused with that row's code
  (the recorder unticks the row or resolves it). `informed` and later: attendance only. `absent`
  never changes a status. 5b adds no other path to `informed` (a general status action isn't in
  this slice).
- **D9. Invitations and change notices reuse the reminders** *(assumed, Q165)*. The message log
  stays one table, `participant_reminder`, with two more kinds: `appointment_invitation` (staff ask
  a participant to book or attend one appointment) and `appointment_cancelled` (an appointment
  with their live booking was cancelled), each with the `appointment_id`. Everything else is the
  reminders' contract (data-protection.md, reminders; Q153, Q154, Q156): who may send (`mayRemind`;
  the change notice is requested by the cancelling staff member), the channel choice
  (`chooseChannel`), a live `portal-contact-consent:v2` (its "Benachrichtigungen zur Nutzung des
  Portals" covers both; no v3), channel, consent, language and text version fixed when queued,
  cancelled rather than rerouted, the `reminders.send` job with its dispatch claim and outcomes, the
  log's fields and the tab "Nachrichten". Differences: an invitation needs a bookable appointment
  for the participation instead of a participant action (skips `not_eligible`, `already_booked`,
  `already_invited`: one invitation per participation and appointment), and neither kind uses or
  consumes the 3-day reminder window. The dispatch claim rechecks the appointment (cancel reason
  `appointment_unavailable`; an invitation whose participant booked meanwhile `nothing_open`).
  Participants without a usable channel are booked by staff (phone, in person); letters are out of
  scope.
- **D10. Fixed generic texts, versioned and immutable** *(assumed, Q165; final wording with the
  DPO, Q132)*: `portal-invitation:v1` and `portal-appointment-change:v1` in the notice catalog,
  de/en, with SHA-256 tests like `portal-reminder:v1`; no name, project, employer, kind, date,
  time, place or title; the only placeholder the plain portal URL; plain-text mail, no pixel or
  tracking.
  - de invitation: subject "Neue Einladung im Teilnehmerportal"; text "In Ihrem Teilnehmerportal
    gibt es eine Einladung zu einem Termin. Bitte melden Sie sich an: {{portalUrl}}".
  - en invitation: subject "New invitation in the participant portal"; text "There is an
    invitation to an appointment in your participant portal. Please sign in: {{portalUrl}}".
  - de change: subject "Änderung im Teilnehmerportal"; text "Bei einem Ihrer Termine im
    Teilnehmerportal gibt es eine Änderung. Bitte melden Sie sich an: {{portalUrl}}".
  - en change: subject "Change in the participant portal"; text "One of your appointments in the
    participant portal has changed. Please sign in: {{portalUrl}}".
  - Email only, both languages: the reminders' privacy note ("Diese Nachricht enthält aus
    Datenschutzgründen keine weiteren Einzelheiten." / "For privacy reasons, this message
    contains no further details.").
- **D11. Overdue appointments: one more item kind of the work list** *(assumed, Q167)*. Each
  `WorklistItem` gains `nextAppointment` (`{ kind, date }` of the earliest live future booking,
  or `null`) and `appointmentItems[]` of `{ kind, appointmentKind, date }`:
  `attendance_missing` (a live booking whose appointment's Berlin date has passed, no attendance
  recorded: work for staff) and `missed` (recorded `absent`, no later live booking or attendance
  of the same kind; for an info event only while the participation is before `informed`). From
  the day after the appointment's date, like deadlines; never a guard, never a participant action
  (so no `open_items` reminder from it), none for a terminal participation (Q160's rule). The
  filter `appointment` (`upcoming`, `overdue`, `attendance_missing`, `missed`) joins
  `WorklistFilter`; the dashboard gains the tile "Termine überfällig" (`appointment: overdue`) and
  the group "Termine" (one count per filter value); each count is its filter over the same
  snapshot (`projectFunnel`), so a count and its drill-down stay one predicate.
- **D12. The history** *(assumed, Q168)*: new audit event types, each with its `auditProjection`
  row and an `audit_event_projection` migration row (the drift test): `appointment_created`,
  `appointment_changed` (changed keys only), `appointment_cancelled` (reason) are project-level
  (no stream); `appointment_booked` (`case`: `appointmentId`, `appointmentKind`, `origin`),
  `appointment_booking_cancelled` (`case`: reason, `appointmentId`, `appointmentKind`),
  `attendance_recorded` (`case`: `appointmentId`, `appointmentKind`, `attendance`,
  `previousAttendance`). The page resolves `appointmentId` to its date from the project's
  appointments, as it does wave ids. Invitations and change notices are `reminder_queued` /
  `reminder_delivery` with their kind (shown already). `informed` is the existing `status_changed`.
  None is a `security` event; titles and locations never enter an audit detail.
- **D13. Retention and classification** *(assumed, Q166)*: `appointment` is `project_master`,
  `internal`, no participant data (the host is a staff id); its free-text title and location are
  project data, and the form says not to enter personal data. `appointment_booking` is `internal`,
  `case_internal` (new field `appointmentBookings`, listable: the work list shows codes and dates),
  `personnel_file`: deleted with the 90-day non-signer deletion, otherwise at the end of the third
  calendar year after exit, like the reminders (Q156), unless the attendance turns out to be
  evidence of a BA-funded §110 measure (Q166 asks). The new message-log column follows
  `participant_reminder`. The new audit events are `audit_log`.
- **D14. Nothing varies per Agentur.** Appointments, booking rules, texts and the overdue rule are
  one domain policy in every project (regional-variation.md: no regional reminder rules; deadlines
  are wave data). No template key is added; whether an Agentur attends info events (the open item
  in regional-variation.md) concerns the Kug 200b batch of Slice 6.
- **D15. Writes go through SECURITY DEFINER functions** (ADR-0002): `transfer_app` selects the new
  tables and writes none of them; every function writes its audit events in its transaction, and
  `record_audit_event` refuses the new types. Status changes go only through the status function.
- **D16. Not in this slice (v1.1 polish or later):** waiting lists, rescheduling a booked
  appointment, automatic appointment reminders (Q152: manual messages only), calendar files,
  booking confirmation messages, video-call links, recurring slot series, letters for participants
  without a channel, the Agentur's own appointments.

## PRs

One planned PR = one branch, each based on `main` after 5b-1 merged (none stacked): 5b-2 and 5b-3
both need 5b-1's tables and functions but not each other; 5b-3 archives the plan, so it goes
last. About 1,500 changed production lines is a soft limit.

| PR | Scope | Est. lines |
|---|---|---|
| 5b-1 | Appointments, staff bookings and attendance (D1–D8, D12–D15): the domain model, permissions, `bookingEligibility` and `attendanceStatusChanges`; `appointment`, `appointment_booking`, their functions, the terminal cancellation, events and projection rows; the staff routes; the project tab "Termine" with the appointment page (attendees, attendance, walk-ins) and the participant tab "Termine" | ~1,500 |
| 5b-2 | Self-booking, invitations and change notices (D5, D9, D10): the portal routes and page "Termine"; the two texts; the message-log kinds and column, `request_invitations`, the change notices in `cancel_appointment`, the dispatch claim's appointment check; the work list's bulk "Zu Termin einladen" and the kinds in "Nachrichten" | ~1,300 |
| 5b-3 | Overdue appointments (D11): the projection, filter and dashboard group and tile; the work list column "Termin"; docs; archive this plan | ~600 |

## Design

### Domain (`packages/domain`, no I/O, no system time)

5b-1, `src/appointments/`:
- Enums: `AppointmentKind` (`info_event`, `consultation`), `AppointmentStatus` (`scheduled`,
  `cancelled`), `AppointmentCancelReason`, `BookingOrigin` (`participant`, `staff`, `walk_in`),
  `BookingStatus` (`booked`, `cancelled`), `BookingCancelReason`, `Attendance` (`attended`,
  `absent`).
- `appointmentPolicy` (capacity 1–500; cutoff 0–336 hours before the start, default 24; title
  ≤ 100, location 1–200; 1–500 attendance rows per request); `AppointmentInput` (Zod, the
  start before the end, the cutoff not after the start).
- `mayManageAppointment(actor, target, { kind, hostStaffUserId })`, `mayBookFor`,
  `mayRecordAttendance` (D2).
- `bookingEligibility(appointment, participation, project, now, today)` → `ok` or a code (D4, in
  this order): `project_not_active`, `appointment_cancelled`, `appointment_started`,
  `booking_closed`, `participation_closed`, `not_in_audience`, `host_not_assigned`,
  `after_cutoff`, `already_booked`, `booking_limit`, `appointment_full`;
  `cancellationEligibility` (participant until the start, staff any live future booking).
- `attendanceStatusChanges(status, attendance, markInformed)` → the ordered status changes of D8
  (each a row of `edges`, checked with `canTransition` and `mayPerformTransition`).
- Audit events (D12) in `events.ts`; their `auditProjection` rows.

5b-2: `ReminderKind` adds `appointment_invitation`, `appointment_cancelled`; `ReminderSkip` adds
`not_eligible`, `already_booked`, `already_invited`; `ReminderCancelReason` adds
`appointment_unavailable`; `invitationEligibility` (D9); the notice catalog's
`portal-invitation:v1` and `portal-appointment-change:v1` with `messageFor(kind, language,
channel, portalUrl)`.

5b-3, `src/worklist/`: `appointmentItems(bookings, status, today)` and `nextAppointment`;
`WorklistItem` gains both; `AppointmentFilter` in `WorklistFilter`; `funnelFilters` gains the
group `appointments` and the tile `appointments_overdue`.

### Data model (data catalog; `project_id` on every table, composite FKs to `participation`)

| Table | PR | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|---|
| `appointment` | 5b-1 | id, project, kind, `host_staff_user_id` (consultation), `audience_wave_id` (info event, `ta_tg`), `starts_at`, `ends_at`, `booking_closes_at`, capacity, title, location, status, `cancel_reason`, `cancelled_at`, `created_by`, `created_at`, `version`; checks for the D1/D3 rules | internal / project data (no participant category; the project's members read it) | `project_master` |
| `appointment_booking` | 5b-1 | id, project, participation, appointment, origin, status, `cancel_reason`, `booked_by` (staff id or null for the participant), `booked_at`, `cancelled_at`, attendance, `attendance_recorded_by`, `attendance_recorded_at`; partial unique index (D6) | internal / `case_internal` (`appointmentBookings`) | `personnel_file` (Q166) |
| `participant_reminder` | 5b-2 | adds `appointment_id` (FK; set exactly for the two appointment kinds, a check) | as before (`reminderLog`) | as before (Q156) |

Enum values added in their PR's migration: `audit_event_type` (D12), `reminder_kind`,
`reminder_cancel_reason`.

### Functions and grants (hand-written, SECURITY DEFINER, audit in the same transaction)

5b-1:
- `create_appointment`, `update_appointment` (with the version seen), `cancel_appointment`
  (reason; cancels the live bookings, one `appointment_booking_cancelled` each): D2 and D3,
  re-checked against the current memberships and assignments.
- `book_appointment(context, appointment, participation)`: actor `user` (origin `staff`) or, from
  5b-2, `participant` (origin `participant`, the participation of the live portal session); D4
  under the locks of D6; `appointment_booked`.
- `cancel_appointment_booking(context, booking, reason)`: participant (own, until the start) or
  staff (D2).
- `record_attendance(context, appointment, entries jsonb)`: each entry a participation, the
  attendance and `mark_informed`; all or nothing; walk-ins as new bookings; for each ticked entry
  the status changes of D8 through the internal `apply_status_change`, which re-checks the edge,
  the actor's permission, the project, the track activity and `before_cutoff` (the status service
  validates the domain guards first, like every manual change). `attendance_recorded` per entry.
- The terminal block of `apply_status_change` (where activation codes are revoked) also cancels the
  participation's live future bookings `participation_closed`.
- Grants: `SELECT` on both tables; `EXECUTE` on the new functions; `record_audit_event` refuses the
  D12 types.

5b-2: `request_invitations(context, appointment, participation ids, batch id)` (exclusive project
lock; per row the reminder id or a skip; `reminder_queued`); `cancel_appointment` also queues an
`appointment_cancelled` message per cancelled booking with a usable channel (no window, no skip
shown to staff beyond the counts); `claim_reminder_dispatch` rechecks the appointment for the
two kinds instead of the participant actions.

### API (`/api/v1`, OpenAPI, RFC 9457, capabilities on every item)

| PR | Route | Does |
|---|---|---|
| 5b-1 | `GET /projects/{id}/appointments` | the project's appointments, newest start first (cursor): kind, times, title, location, host, audience, capacity, booked count, status, capabilities |
| 5b-1 | `POST /projects/{id}/appointments` | create (D1, D2) → `201` |
| 5b-1 | `PATCH /appointments/{id}` | change (D3) with `version` → `200`; `409 stale` |
| 5b-1 | `POST /appointments/{id}/cancellation` | `{ reason }` → `200 { cancelledBookings }` |
| 5b-1 | `GET /appointments/{id}/bookings` | the bookings the viewer may list (D2): booking, participation, listable person fields, origin, status, attendance, capabilities; `private, no-store` |
| 5b-1 | `POST /appointments/{id}/bookings` | staff booking `{ participationId }` → `201`; `422` with the D4 code |
| 5b-1 | `POST /appointment-bookings/{id}/cancellation` | staff cancellation → `200` |
| 5b-1 | `POST /appointments/{id}/attendance` | `{ entries: [{ participationId, attendance, markInformed }] }` → `200 { recorded, statusChanges }`; `422` with `errors[]` at `/entries/<i>` per refused row |
| 5b-1 | `GET /participations/{id}/appointments` | one participation's bookings and the appointments staff may book for it (the tab "Termine") |
| 5b-2 | `GET /portal/appointments` | the session's own live bookings and the bookable appointments (D5) |
| 5b-2 | `POST /portal/appointments/{id}/booking` | → `201`; `422` with the D4 code |
| 5b-2 | `POST /portal/appointment-bookings/{id}/cancellation` | → `200`; `404` for another participation's booking |
| 5b-2 | `POST /appointments/{id}/invitations` | `{ participationIds }` (1–500) → `201 { batchId, queued, skipped }`, like reminders |
| 5b-3 | `GET /projects/{id}/worklist`, `/dashboard` | the D11 fields, filter and counts |

Order as in ADR-0010: schema → visibility (`404`; `participation_not_found` for a hidden id in a
body) → permission `403` → state `422`. Logs carry ids and codes only, never a title, location,
name or address.

### Web UI (`apps/web`, German) and portal (`apps/portal`, de/en)

- 5b-1: project tab "Termine": the list (Art, Datum, Ort, Gastgeber·in, gebucht / Plätze,
  Status), "Infoveranstaltung anlegen" (PL), "Beratungstermin anlegen" (PL, consultant for
  themselves), the hint "Bitte keine personenbezogenen Daten in Titel oder Ort". The appointment
  page: details, "Ändern", "Absagen" (reason, confirmation), the attendees the viewer may list,
  "Teilnahme erfassen" (per row "teilgenommen" / "nicht erschienen", "als informiert erfassen"
  preselected before `informed`), "Ohne Buchung erschienen" (a picker over the work list snapshot,
  the same name search), the refusal text of D7. Participant page tab "Termine": bookings with
  attendance, "Termin buchen" (the bookable appointments), "Buchung absagen".
- 5b-2: portal "Termine" (D5) linked from the start page, de/en, keyboard and screen-reader
  usable, 320 px wide without horizontal scrolling; work list bulk "Zu Termin einladen" (choose
  the appointment, counts per channel and skip code from the rows, the text as preview, then the
  result); "Nachrichten" names the kinds ("Erinnerung", "Einladung", "Terminänderung").
- 5b-3: the work list column "Termin" (the next booking, or "Teilnahme nicht erfasst" / "Termin
  versäumt"), the filter "Termine", the dashboard tile and group.
- Every button by its capability; neither app derives a permission.

## User flows

1. **PL plans an info event:** "Termine" → "Infoveranstaltung anlegen" (Welle W1, 40 Plätze,
   Kantine Werk 2) → work list filtered to W1, status `contacted` → "Zu Termin einladen" → 31 per
   E-Mail, 4 "Kein für Erinnerungen nutzbarer Kontaktweg" (booked by phone from the tab
   "Termine").
2. **Participant books on the phone:** login → "Termine" → "Buchen" → confirmation; later
   "Absagen" frees the seat. Two people take the last seat at once: one booking, one "ausgebucht".
3. **After the event:** the PL opens the appointment → "Teilnahme erfassen": 33 attended (three
   walk-ins from the picker), 2 absent; "als informiert erfassen" stays ticked → 30 `contacted →
   informed`, 3 `imported → contacted → informed`; "Verlauf" shows the attendance and each change.
4. **Consultant:** creates slots for themselves; only their assigned participations can book; the
   info event's attendee list shows only theirs.
5. **Next morning:** "Übersicht" → "Termine überfällig: 3" → the two no-shows and one slot whose
   attendance isn't recorded.

## Acceptance criteria

**5b-1**
- Domain tests first (100 % coverage on the new rules): every `bookingEligibility` code and its
  order; the cutoff and the start at the boundary second; capacity with walk-ins; `booking_limit`
  per kind; `after_cutoff` only in `ta_tg` before `informed`; each role and assignment state for
  the three permission functions (back office, unassigned consultant, org roles, assisted mode and
  break-glass refused); `attendanceStatusChanges` from every main status, returning only `edges`
  rows and nothing for `absent`, `informed` or later.
- Database tests: two concurrent bookings of the last seat give one booking; two concurrent
  bookings of the same participation give one; no deadlock between booking, appointment
  cancellation and a terminal transition (a concurrency test); a terminal transition cancels the
  live future bookings `participation_closed` and keeps past ones; `transfer_app` can't write the
  tables or record the new event types; `record_attendance` with one refused row records nothing
  and changes no status; an `unreachable` attendee after the cutoff is refused `before_cutoff`.
- API tests: a consultant listing an info event's bookings sees only assigned rows; a consultant
  booking an unassigned participation into a slot gets `participation_not_found`, back office
  `403`; each `422` code; attendance with "als informiert erfassen" writes the attendance and each
  `status_changed` in one transaction with the staff actor.
- History: the drift test passes with the new types; the PL and the assigned consultant see
  booking and attendance rows, back office none (`case` isn't its stream); titles and locations
  appear in no audit detail and no log line.
- UI component tests: the attendance dialog (preselection, untick, refusal text); e2e: PL creates
  an info event, books a participant, records attendance, the participant is `informed`.

**5b-2**
- The two texts' SHA-256 tests (de/en) and a test that a rendered message contains no name,
  project, kind, date, time, place or title, only the portal URL.
- Invitations: a v1-only channel is skipped `consent_required`; one per participation and
  appointment (`already_invited`); a participant who booked before the dispatch gets none
  (`nothing_open`); a cancelled appointment cancels queued invitations (`appointment_unavailable`);
  neither kind blocks or is blocked by the 3-day reminder window.
- Cancelling an appointment queues one change notice per cancelled booking with a usable
  channel, in the cancellation's transaction (ADR-0011: the job payload is the reminder id).
- Portal: booking and cancellation in de and en at 320 px; the cutoff and "ausgebucht" states; a
  terminal participation's session can't book; e2e: participant books and cancels.

**5b-3**
- Domain: `attendance_missing` from the day after the appointment's date; `missed` cleared by a
  later booking or attendance of the same kind; `missed` for an info event only before
  `informed`; none for a terminal participation; for every new count `count =
  items.filter(filter).length`.
- The work list over 2,000 participations with bookings keeps the Slice 5 performance criterion.

## Docs updated by the PRs

- 5b-1: process-and-lifecycle.md (appointments, attendance and `informed`; the Phase 1 table),
  data-protection.md (the access rules of D2, the attendee lists, the history rows, the tables'
  classes), architecture/overview.md (the project tab "Termine", the participant tab "Termine"),
  the generated access matrix and lifecycle table (`pnpm generate`).
- 5b-2: data-protection.md (reminders → messages: invitations and change notices, the texts),
  architecture/overview.md (the portal page, the job's kinds).
- 5b-3: process-and-lifecycle.md (overdue appointments beside the deadline warnings),
  architecture/overview.md (the dashboard), roadmap.md (Slice 5b done); this plan to
  `docs/plans/archive/`; the readings confirmed by the owner moved into the rows of Q162–Q168.
