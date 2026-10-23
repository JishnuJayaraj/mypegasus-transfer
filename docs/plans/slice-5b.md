# Slice 5b — Info events and appointments (F4)

Status: **approved** 2026-10-23 by the product owner for development on synthetic data (PR #82,
[round 40](../decisions/2026-10-23-answers-round-40.md) with its second review): Q162–Q168 are
`accepted` as amended there, including the readings of this plan; this revision adds the second
review's amendments (the dispatch lock order, the retention branches, conflict recovery, the
correction of false no-shows, delivery attempts, portal visibility, follow-up chains). Q169
(funded-measure evidence) stays `verify`; 5b supplies no funded-measure evidence. PR 5b-1 built
the appointments and staff bookings (its readings: Q170–Q172); next 5b-2 and 5b-3.
Roadmap (Q158): info events and consultation slots; participant self-booking and cancellation;
attendance; invitations and their message logging; attendance driving the authorised `informed`
workflow; overdue appointments joining the work list of Slice 5. Only appointment polish stays in
v1.1 (D22).
Builds on: the lifecycle edges and the status function (process-and-lifecycle.md, main status and
rules), the project lock (ADR-0002), the work list and dashboard projection
(`packages/domain/src/worklist/`), the reminders' message log, channel, consent v2 and dispatch
(`packages/domain/src/reminders/`, `participant_reminder`, `reminders.send`), the audit history
(`auditProjection`, `audit_event_projection`), the portal (`apps/portal`) and the participant
page's tabs.

## Decisions

### Appointments

- **D1. Two kinds, one table.** An `appointment` is an `info_event` (a group event, many seats,
  optionally limited to one entry wave in `ta_tg`) or a `consultation` (a slot with one host, a PL
  or consultant of the project). Start and end (`timestamptz`, shown in Europe/Berlin), capacity
  (1–500), a public booking cutoff (`bookingClosesAt`, default 24 hours before the start, the
  creator chooses 0–14 days), an optional generic title (≤ 100) and the shared venue (1–200
  characters), status `scheduled` or `cancelled`. The form says: no participant names, diagnoses
  or consultation notes in title or venue (Q166). No operational delete; retention still applies
  (D17).
- **D2. Changes** (Q164): the capacity may rise any time and fall to no fewer than the live
  bookings; title and venue may be corrected with live bookings present, keeping the reservations
  and notifying the people booked (D14). Kind, times and audience never change once the
  appointment has had a booking or an invitation (`appointment_in_use`: cancel it and create a new
  one), so every booking's appointment times stay as they were (Q168); full rescheduling is v1.1.
  The host of a slot changes only through the PL (D4). No two slots of one host overlap
  (`host_overlap`).
- **D3. Cancellation by the organizer** (Q164): before or after the scheduled start, as long as
  no attendance is recorded for it (`attendance_recorded`), with a closed reason
  (`organiser_unavailable`, `too_few_bookings`, `did_not_take_place`, `created_in_error`, `other`),
  no free text. It cancels every live booking (`appointment_cancelled`) and notifies each person
  (D14); a cancelled appointment leaves no `attendance_missing` or `missed` item, so a late
  cancellation never becomes a false no-show. **Correcting false no-shows:** when the attendance
  recorded for an appointment is only `absent`, the PL may still cancel it with
  `did_not_take_place` as a correction (`appointment_cancelled` with `correction: true`): each
  absence stays in the booking's history and is superseded (`attendance_superseded`, the booking
  cancelled `appointment_cancelled`), so no `missed` item remains; no notices go out for a past
  event. A single `attended` record refuses the correction (`attendance_recorded`): each is
  investigated and corrected on its own first (D11, which may raise `attendance_conflict`, D13).

### Roles and visibility

- **D4. Who does what** (Q162): the PL creates, changes and cancels info events and slots for any
  host; a consultant creates, changes and cancels their own slots only. Staff booking, attendance
  and invitations: the PL for any participation of the project, an assigned consultant only for
  their assigned ones (Q62). Back office reads bookings and attendance (`case_internal`) and does
  none of it. Org roles, assisted mode and break-glass grant none of these operations. A slot takes
  only participations its host may list. Permission functions beside `mayPerformOperation`:
  `mayManageAppointment`, `mayBookFor`, `mayRecordAttendance`, `mayResolveAppointmentItem`;
  invitations use `mayRemind` (Q153); organizer notices need none (D14).
- **D5. Counts and seat availability** (Q150, Q162): a viewer gets the exact booked count of an
  appointment only while they may list every live booking of it (recomputed per request): the PL
  and back office always, a consultant for a slot whose bookings are all of their assigned
  participations. Otherwise the viewer gets the count among the participations they may list
  ("davon Ihre: 3") and the seat state `availability`: `available` or `full`, never a number.
  Participants get only `availability`. The seat state is an **explicit exception to Q150**,
  accepted as an operational disclosure: "full" beside the visible capacity reveals the occupancy
  of that appointment, never a person. No API payload returns a total or remaining-seat count to
  a viewer outside the exact-count scope, and no other aggregate of bookings is shown there.
- **D6. Reassignment and a departing host** (Q162): access follows the open assignments and
  memberships at every request, so a consultant whose assignment ended, who lost the consultant
  role or the membership, or was deactivated, sees none of the participation's bookings at once,
  whatever slot they host. Bookings stay live. A live future consultation booking whose host may no
  longer list its participation is `needs_resolution` for the PL (on the appointment page and the
  work list, D19). The PL resolves it by changing the slot's host to a member who may list every
  live booking of it, by cancelling the booking (the person is notified) or by cancelling the
  appointment.

### Booking

- **D7. Booking rules** (Q164), portal and staff alike; the domain's `bookingEligibility` gives the
  capability and the code, the database decides again:
  - a scheduled appointment that hasn't started; the participant only until `bookingClosesAt`,
    authorized staff until the start while a seat remains (origin `staff`, never a walk-in);
  - a non-terminal participation of the project; an info event in the participation's audience
    (the project or its wave) while the participation is before `active_in_tg`; a consultation
    whose host may list the participation;
  - never two live bookings of one appointment (`already_booked`); at most one live future
    info-event booking (`info_event_limit`); any number of consultations; no two live bookings
    of one participation overlapping in time (`booking_overlap`);
  - a free seat (`appointment_full`);
  - before `informed` in `ta_tg`, an already-passed cutoff refuses (`after_cutoff`: today after the
    applicable latest entry date, the `before_cutoff` semantics); an appointment after an
    **upcoming** cutoff is bookable with the warning `beyond_upcoming_cutoff` (staff see the date,
    the portal a generic hint "Dieser Termin liegt nach einer für Sie geltenden Frist."). Nothing
    predicts a withdrawal.
- **D8. Cancelling a booking** (Q164): the participant their own until the start; staff
  (D4) any live booking until the start, with the person notified (D14). A terminal status cancels
  the participation's live bookings of appointments that haven't started (`participation_closed`,
  in the transaction that revokes the activation codes); bookings of started appointments stay for
  the attendance record (D11). No waiting list.
- **D9. Self-booking in the portal** (Q164, Q165), de/en, mobile-first, logical CSS properties, an
  activated participant with a live session: "Termine" shows
  - **Einladungen**: every appointment the participant was invited to (D14) and hasn't booked,
    whether or not the email or SMS arrived, until its start; a full one shows "ausgebucht", one
    past its public cutoff "Buchung geschlossen", each with booking disabled and the next step
    ("Anderen Termin buchen" when an alternative of the same kind is bookable, else "Bitte wenden
    Sie sich an Ihr Beratungsteam"); a cancelled one moves to "Abgesagt". Its details (title,
    venue, time) only while the appointment is still in the participation's audience or host rule
    (D7), otherwise only its kind and "Diese Einladung gilt nicht mehr";
  - **Meine Termine**: live bookings with kind, date, time, title, venue, "Absagen" (with a
    confirmation) until the start;
  - **Abgesagt**: bookings, and invited appointments, cancelled by the organizer or the team, until
    14 days after the later of the original start and the cancellation: which appointment, "vom Veranstalter abgesagt" / "vom Beratungsteam abgesagt", and
    "Anderen Termin buchen" when a bookable alternative of the same kind exists;
  - **Termine buchen**: the bookable appointments with `availability` ("Plätze frei" /
    "ausgebucht") and the D7 hint; "Buchen" after a confirmation.
  No booking confirmation message, calendar file or waiting list (v1.1).
- **D10. Lock order** (ADR-0002: project → template version → participation row). Every new
  function takes the project's advisory lock first: shared through `lock_participation` when it
  touches one participation, **exclusive** when it touches several participations or an
  appointment's bookings. After it, always in this order: participation rows (in UUID order) →
  the appointment row → booking rows (in id order) → message rows → channel and consent rows
  (`FOR SHARE`). Never an appointment before a participation.

  | Operation | Project lock | Then |
  |---|---|---|
  | book, cancel one booking (portal, staff), "Als informiert erfassen", resolve one item, record a follow-up | shared (`lock_participation`) | participation → appointment `FOR UPDATE` (capacity, overlaps) → booking |
  | create, change, cancel an appointment; change a host; record attendance (bulk, after close); request invitations | exclusive | the affected participations in UUID order → appointment → bookings → messages |
  | a terminal status change (`apply_status_change`) | shared (held) | participation (held) → its booking rows in id order; no appointment lock (freeing a seat only lowers the count, so a concurrent capacity check can only be stricter) |
  | the dispatch claim (`claim_reminder_dispatch`) | shared (`lock_participation`) | participation → appointment and booking `FOR SHARE` (their ids read from the message's immutable columns without a lock) → message `FOR UPDATE` → channel, consent `FOR SHARE`; an `open_items` reminder skips the appointment step |

  Two participants racing for the last seat serialize on the appointment row: one booking, one
  `appointment_full`. The partial unique index `(appointment_id, participation_id) WHERE status =
  'booked'` backs `already_booked`. Concurrency tests show the absence of deadlocks (D23), the
  plan doesn't assume it.

### Attendance and `informed`

- **D11. Attendance** (Q163, Q164): the PL or the assigned consultant records `attended` from the
  start and `absent` after the end, for the bookings they may list, and adds walk-ins (`attended`;
  any non-terminal participation for an info event, one the host may list for a consultation). One
  request records 1–500 rows, all or nothing ("Keine Teilnahme erfasst" first, then each refused
  row's code). A recorded attendance may be corrected by the same roles, audited with the previous
  and the new value; a correction never changes a status.
- **D12. After a participation closed** (Q163): only the PL records or corrects the attendance of
  an appointment that started before the terminal status change, with a closed reason
  (`late_entry`, `correction`); never a status change and never "Als informiert erfassen"; audited
  with `afterClose`. The participation isn't reopened and no guard is bypassed. A last-day event
  entered after the next night's cutoff withdrawal is this flow.
- **D13. `informed`** (Q163): recording what happened and authorizing what happens next are two
  steps.
  - In the attendance request, each `attended` row of a participation before `informed` offers
    "als informiert erfassen": preselected for an info event, never for a consultation. A request
    with any such row ticked needs the recorder's confirmation "Die erforderlichen Informationen
    wurden vermittelt" (`informationDelivered`, unticked by default).
  - Later, on an existing qualifying attendance (`attended`, not recorded after close, the
    participation non-terminal and before `informed`), the separate action "Als informiert
    erfassen" with the same confirmation, by the PL or the assigned consultant. This is the
    recovery path for an unticked row and for a correction from `absent` to `attended`.
  - Either way the same transaction writes `information_delivery_confirmed` (the attendance it
    rests on), marks that booking as the basis, and changes the status as the confirming staff user
    along existing `manual` edges only: `contacted → informed`; `imported → contacted → informed`;
    `unreachable → contacted` (its `before_cutoff` guard) `→ informed`; each change its own
    `status_changed` through `apply_status_change`. `attendanceStatusChanges` is tested to return
    only rows of `edges`. A failing guard refuses the request.
  - A correction of the basis attendance to `absent` reverses nothing: the participation shows
    `attendance_conflict` (D19) until one of two resolutions:
    - **a replacement basis:** "Als Grundlage bestätigen" on another `attended` booking of the
      participation, with the same delivery confirmation, by the PL or the assigned consultant (after
      close the PL only); it marks the new basis and changes no status
      (`information_delivery_confirmed` with `statusChanged: false`);
    - **the PL's attestation** `information_delivered_otherwise` (`attendance_conflict_resolved`).

    The PL may record `escalated` as the handling state (`attendance_conflict_escalated`): the item
    stays open, shown as escalated, until a resolution. An unresolved conflict stays visible after
    the participation closes, and the PL resolves it there too (no status change).

### Messages

- **D14. One message log, more kinds** (Q165). `participant_reminder` gains the kinds
  `appointment_invitation`, `appointment_changed` (title or venue corrected) and
  `appointment_cancelled` (the appointment, or the booking by staff), with `appointment_id` and,
  for the two notices, `booking_id`. The reminders' contract applies (data-protection.md,
  reminders; Q154, Q156): channel choice, a live `portal-contact-consent:v2` (its "notifications
  about using the portal" covers these; no v3), channel, consent, language and text version fixed
  when queued, cancelled rather than rerouted, the `reminders.send` job and its outcomes, the log's
  fields, the tab "Nachrichten". Neither kind uses or consumes the 3-day reminder window.
  - **Invitations** are requested by staff (`mayRemind`, rechecked at dispatch). Each eligible
    participation gets a row, also without a usable channel: then it is `cancelled` at once with
    `no_channel` or `consent_required` (no job), so the portal shows the invitation either way.
    Skips without a row: `participation_closed`, `not_eligible` (D7), `already_booked`,
    `already_invited`, `invitation_limit`. Retry: a new invitation is allowed after the latest one
    for that participation and appointment ended `failed`, was cancelled for a delivery reason
    (`no_channel`, `consent_required`, `channel_unavailable`, `consent_ended`,
    `delivery_unavailable`) or, for a currently authorized requester, `requester_no_longer_authorized`;
    refused while it is `queued`, `dispatching`, `sent` or `delivery_unknown` (an uncertain outcome
    is never resent). **At most three delivery attempts per participation and appointment, the
    first included:** an attempt is a row the claim handed to the provider (outcome `sent`,
    `failed` or `delivery_unknown`); a row cancelled before that (at the request without a usable
    channel or consent, or at the claim) uses none, and the job's transport retries are the same
    attempt. The claim rechecks that
    the appointment is still bookable for the participation (`appointment_unavailable`) and not
    booked meanwhile (`nothing_open`).
  - **Organizer notices** follow from the organizer's change, not from a requester's authority:
    the function that cancels the appointment or booking, or corrects title or venue, queues them
    as the system (`requested_by` empty, actor `system`, job `appointments.notify`) in its own
    transaction, so a reassignment between the change and the dispatch can't suppress them. The
    claim keeps the recipient, channel and consent checks (non-terminal participation, the queued
    channel and v2 consent) and has no requester check. Without a usable channel the row is
    `cancelled` at once like an invitation's.
  - **Follow-up of undelivered notices:** a notice that ended `failed`, `delivery_unknown` or
    cancelled for any reason but `participation_closed` is `notice_undelivered` (D19) until the PL
    or the assigned consultant records how the person was told (`phone`, `in_person`, `letter`) or
    that it isn't needed (`not_needed`), audited.
  - Participants without a usable channel are booked by staff (phone, in person); letters stay out
    of scope, the follow-up records them.
- **D15. Fixed generic texts, versioned and immutable** (Q165; final wording with the DPO, Q132):
  `portal-invitation:v1` and `portal-appointment-change:v1` (for both notice kinds) in the notice
  catalog, de/en, SHA-256 tests like `portal-reminder:v1`; no name, project, employer, kind, date,
  time, venue or title; the only placeholder the plain portal URL; plain-text mail, no pixel or
  tracking.
  - de invitation: subject "Neue Einladung im Teilnehmerportal"; text "In Ihrem Teilnehmerportal
    gibt es eine Einladung zu einem Termin. Bitte melden Sie sich an: {{portalUrl}}".
  - en invitation: subject "New invitation in the participant portal"; text "There is an
    invitation to an appointment in your participant portal. Please sign in: {{portalUrl}}".
  - de change: subject "Änderung im Teilnehmerportal"; text "Bei einem Ihrer Termine im
    Teilnehmerportal gibt es eine Änderung. Bitte melden Sie sich an: {{portalUrl}}".
  - en change: subject "Change in the participant portal"; text "One of your appointments in the
    participant portal has changed. Please sign in: {{portalUrl}}".
  - Email only: the reminders' privacy note ("Diese Nachricht enthält aus Datenschutzgründen keine
    weiteren Einzelheiten." / "For privacy reasons, this message contains no further details.").

### Data protection, history and scope

- **D16. Classification:** `appointment` is `internal` project data with `project_master`
  retention (Q58); its host and creator are staff personal data (staff ids, pseudonymised with the
  account, Q59). Bookings, attendance, the basis and follow-up resolutions are `internal`,
  `case_internal` (field `appointmentBookings`, listable as codes and dates). Titles and venues
  never enter a message, audit detail or log line.
- **D17. Retention boundary** (Q166, Q105, Q77): bookings, attendance and their resolutions, and
  the messages (Q156), are `personnel_file` in every project and for every kind. Their triggers,
  **mapping awaiting confirmation, executable periods `unset`** in the data catalog until the
  Slice 7 job (settled before any deletion runs, not before synthetic development):
  - a non-signer withdrawn **without** a fully executed DSV, funded §110 participation, legal hold
    or other duty: 90 days after `withdrawnOn`;
  - an executed DSV without TG entry: the end of the third calendar year after its cancellation or
    contractual end;
  - a TG participant: the end of the third calendar year after exit;
  - `ta_completed` in a `ta_only` project (no TG exit date): proposed the end of the third calendar
    year after the `ta_completed` change;
  - withdrawn with a funded §110 participation (outside the 90-day branch): proposed the end of the
    third calendar year after `withdrawnOn`;
  - a legal hold suspends only the affected rows.

  They are never BA evidence, and no funding status is inferred from `info_event` or
  `consultation`: 5b isn't the system that supplies funded-measure evidence. That evidence is a
  separate, separately classified minimum record linked to an explicit measure under the
  evidence-set policy; 5b builds none (Q169). `appointment` follows `project_master`.
- **D18. The history** (Q168): new event types, each with its `auditProjection` row and an
  `audit_event_projection` migration row (the drift test):
  - project-level, in no history: `appointment_created`, `appointment_changed` (changed keys),
    `appointment_cancelled` (reason, `correction`);
  - `case`: `appointment_booked` (`appointmentId`, `appointmentKind`, `startsAt`, `origin`,
    `followUpOf`), `appointment_booking_cancelled` (reason; `appointmentId`, `appointmentKind`,
    `startsAt`), `attendance_recorded` (reason after close; `appointmentId`, `appointmentKind`,
    `startsAt`, `attendance`, `previousAttendance`, `afterClose`), `attendance_superseded`
    (`appointmentId`, `appointmentKind`, `startsAt`, `previousAttendance`; D3),
    `information_delivery_confirmed` (`appointmentId`, `appointmentKind`, `startsAt`,
    `statusChanged`), `attendance_conflict_escalated`, `attendance_conflict_resolved`,
    `missed_appointment_resolved` (reason; `appointmentId`), `appointment_notice_followed_up`
    (`method`; `appointmentId`);
  - `reminder_queued` adds `appointmentId` and `startsAt` and may have the system actor;
    `reminder_delivery` adds `kind` and `appointmentId` to its details and both to its shown keys
    (a migration updates the existing projection rows; older events simply lack them).

  `startsAt` is the appointment's start when the event was written, so the history never depends
  on the current appointment row (D2 freezes it too). The staff name is shown as for every case
  action (Q157); `informed` is the existing `status_changed`.
- **D19. The work list** (Q167, the rest of round 40): `WorklistItem` gains
  `appointments: { next, items }`: `next` the earliest live future booking (`{ kind, startsAt }`)
  or `null`; `items[]` of `{ kind, appointmentId, appointmentKind, startsAt }`:
  - `attendance_missing`: a live booking whose appointment has ended and whose Berlin end date has
    passed, attendance unrecorded (also for a terminal participation: factual work the PL can
    still do, D12);
  - `missed`: recorded `absent` with unresolved follow-up. A follow-up counts only **while it is
    live or attended**: for an info event, a later eligible info-event booking (the same briefing
    purpose, matched automatically); for a consultation, only a booking staff link as its
    follow-up (`followUpOf`); an unrelated consultation clears nothing. Cancelling the follow-up
    restores the item; a follow-up recorded `absent` becomes the missed item of the chain, so
    exactly one actionable item remains. Or an explicit resolution with a closed reason
    (`participant_declined`, `information_delivered_otherwise`, `no_longer_needed`) by the PL or
    the assigned consultant ends the chain;
  - `notice_undelivered` (D14), `needs_resolution` (D6), `attendance_conflict` (D13).

  None of these is a guard or a participant action (no `open_items` reminder from them); a
  terminal participation keeps `attendance_missing` and an unresolved `attendance_conflict`
  (unfinished staff work), nothing else. Filter `appointment`: `upcoming`,
  `overdue` (`attendance_missing` ∪ `missed`), `to_resolve` (`notice_undelivered` ∪
  `needs_resolution` ∪ `attendance_conflict`) and each kind. Dashboard tiles "Termine überfällig"
  (`overdue`) and "Termine zu klären" (`to_resolve`) and the group "Termine" (one count per filter
  value); each count is the number of distinct participations its filter matches in the same
  snapshot (`projectFunnel`), so a count and its drill-down stay one predicate.
- **D20. Writes go through SECURITY DEFINER functions** (ADR-0002): `transfer_app` selects the new
  tables and writes none; every function writes its audit events in its transaction;
  `record_audit_event` refuses the new types. Status changes only through the status function.
- **D21. Nothing varies per Agentur.** One domain policy in every project (regional-variation.md:
  no regional reminder rules; deadlines are wave data); no template key.
- **D22. Not in this slice (v1.1 or later):** waiting lists, rescheduling, automatic appointment
  reminders (Q152), calendar files, booking confirmation messages, video-call links, recurring slot
  series, letters, the Agentur's own appointments, funded-measure evidence (Q169).
- **D23. Required scenarios** (round 40), each an integration test in the PR named: attendance
  corrected later, both directions (5b-2); last-day attendance entered after the withdrawal (5b-2);
  reassignment before a cancellation notice's dispatch (5b-3); cancellation without a usable channel
  (5b-3, then its follow-up item in 5b-4); concurrent booking, cancellation and dispatch (5b-3, on
  top of 5b-1's booking races).

## PRs

One planned PR = one branch, each based on `main` after the PRs it needs merged (none stacked).
5b-2 and 5b-3 need 5b-1 but not each other; 5b-4 needs both and archives the plan. Round 40 added a
recovery path, a closed-case flow, organizer notices and follow-up items, so the slice now has four
PRs; each stays near or below the soft limit of about 1,500 changed production lines.

| PR | Scope | Est. lines |
|---|---|---|
| 5b-1 | Appointments and staff bookings (D1–D8, D10, D16–D18 for its events, D20): the domain model, permissions, `bookingEligibility`, counts and availability; `appointment`, `appointment_booking`, their functions under the lock order, the terminal cancellation; the staff routes; the project tab "Termine" with the appointment page and the participant tab "Termine" | ~1,400 |
| 5b-2 | Attendance and `informed` (D11–D13): bulk recording, corrections, walk-ins, the closed-case flow, the confirmation, "Als informiert erfassen", the basis and the conflict review; their events; the attendance dialog | ~1,100 |
| 5b-3 | Portal and messages (D9, D14, D15): the portal routes and page; the texts; the message-log kinds and columns; invitations with retry; organizer notices; the claim's changes; the reminder events' projection; the follow-up record; the work list's bulk "Zu Termin einladen" | ~1,500 |
| 5b-4 | The work list (D19): the items, follow-up links and the missed resolution, filter, tiles and group, the column "Termin"; docs; archive this plan | ~900 |

## Design

### Domain (`packages/domain`, no I/O, no system time)

5b-1, `src/appointments/`:
- Enums: `AppointmentKind`, `AppointmentStatus`, `AppointmentCancelReason`, `BookingOrigin`
  (`participant`, `staff`, `walk_in`), `BookingStatus`, `BookingCancelReason`
  (`participant_cancelled`, `staff_cancelled`, `appointment_cancelled`, `participation_closed`),
  `SeatAvailability` (`available`, `full`).
- `appointmentPolicy` (capacity, cutoff range and default, text limits, 1–500 rows);
  `AppointmentInput` (Zod: start before end, cutoff not after start).
- Permissions of D4; `bookingView(viewer, appointment, bookings)` (D5: exact count or own count and
  availability).
- `bookingEligibility(appointment, participation, otherBookings, project, actor, now, today)` →
  `{ code: ok | refusal, warnings }` (D7, refusals in the order listed there);
  `cancellationEligibility`; `needsResolution(booking, hostMayList)` (D6).

5b-2: `Attendance`, `AttendanceAfterCloseReason`, `AttendanceConflictResolution`;
`attendanceEligibility(booking, appointment, attendance, now, closedAt)` (D11, D12);
`attendanceStatusChanges(status, …)` (D13, only `edges` rows); `qualifiesForInformed(booking)`.

5b-3: `ReminderKind` adds the three kinds; `ReminderSkip` adds `not_eligible`, `already_booked`,
`already_invited`, `invitation_limit`; `ReminderCancelReason` adds `no_channel`,
`consent_required`, `appointment_unavailable`; `invitationRetryAllowed(previous[])`;
`NoticeFollowUpMethod`; the two texts in the notice catalog and `messageFor(kind, language,
channel, portalUrl)`; `portalAppointments(…)` (D9's sections).

5b-4, `src/worklist/`: `appointmentItems(bookings, notices, status, closedAt, today)`,
`MissedResolution`, `AppointmentFilter` in `WorklistFilter`, the tiles and group in
`funnelFilters`.

### Data model (data catalog; `project_id` on every table, composite FKs to `participation`)

| Table | PR | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|---|
| `appointment` | 5b-1 | id, project, kind, `host_staff_user_id`, `audience_wave_id`, `starts_at`, `ends_at`, `booking_closes_at`, capacity, title, venue, status, `cancel_reason`, `cancelled_at`, `created_by`, `created_at`, `version`; `CHECK`s for D1 | internal / project data, read by the project's members (staff ids: Q59) | `project_master` |
| `appointment_booking` | 5b-1 (+5b-2, 5b-4 columns) | id, project, participation, appointment, origin, status, `cancel_reason`, `booked_by` (null for the participant), `booked_at`, `cancelled_by`, `cancelled_at`; 5b-2: attendance, `attendance_recorded_by/at`, `after_close_reason`, `informed_basis_by/at`, `conflict_escalated_by/at`, `conflict_resolution`, `conflict_resolved_by/at`, `attendance_superseded_by/at`; 5b-4: `follow_up_of`, `missed_resolution`, `missed_resolved_by/at`; the partial unique index (D10) | internal / `case_internal` (`appointmentBookings`) | `personnel_file` (D17) |
| `participant_reminder` | 5b-3 | adds `appointment_id`, `booking_id`, `followed_up_method/by/at`; `requested_by` nullable for organizer notices; `channel_id`, `channel_kind`, `consent_id` nullable only for a row cancelled at the request (`no_channel`, `consent_required`); `CHECK`s tie each to its kind | as before (`reminderLog`) | as before (Q156, D17) |

Enum values are added in their PR's migration (`audit_event_type`, `reminder_kind`,
`reminder_cancel_reason`).

### Functions (hand-written, SECURITY DEFINER, audit in the same transaction, the lock order of D10)

- 5b-1: `create_appointment`, `update_appointment` (version; D2), `change_appointment_host` (PL;
  D6), `cancel_appointment` (D3), `book_appointment` (actor `user` → `staff`; from 5b-3
  `participant` → `participant`), `cancel_appointment_booking`; the terminal block of
  `apply_status_change` cancels the bookings of D8. Grants: `SELECT` on both tables, `EXECUTE` on
  these.
- 5b-2: `record_attendance(context, appointment, entries, information_delivered, after_close_reason)`
  (all or nothing; walk-ins; the D13 changes through `apply_status_change`, which re-checks edge,
  permission, project, track activity and `before_cutoff`; the status service validates the
  domain guards first), `confirm_information_delivered(context, booking)` (D13: with a status
  change before `informed`, as a replacement basis without one after it),
  `escalate_attendance_conflict`, `resolve_attendance_conflict`; `cancel_appointment` takes the
  PL's `did_not_take_place` correction over absences only (D3).
- 5b-3: `request_invitations` (exclusive lock; D14), the organizer notices inside
  `update_appointment`, `cancel_appointment` and `cancel_appointment_booking`;
  `claim_reminder_dispatch` and `record_reminder_outcome` replaced for the new kinds and details;
  `record_notice_follow_up`.
- 5b-4: `resolve_missed_appointment`; `book_appointment` takes `follow_up_of`.

### API (`/api/v1`, OpenAPI, RFC 9457, capabilities on every item)

| PR | Route | Does |
|---|---|---|
| 5b-1 | `GET /projects/{id}/appointments` | the appointments (cursor): kind, times, title, venue, host, audience, capacity, the D5 count view, status, `needsResolution` count for the PL, capabilities |
| 5b-1 | `POST /projects/{id}/appointments`; `PATCH /appointments/{id}`; `POST /appointments/{id}/host`; `POST /appointments/{id}/cancellation` | create; change (version, `409 stale`); change the host; cancel (`{ reason }`) |
| 5b-1 | `GET /appointments/{id}/bookings`; `POST /appointments/{id}/bookings`; `POST /appointment-bookings/{id}/cancellation` | the bookings the viewer may list (`private, no-store`); staff booking (`422` with the D7 code, `warnings`); staff cancellation |
| 5b-1 | `GET /participations/{id}/appointments` | the tab "Termine": bookings, attendance, items, bookable appointments |
| 5b-2 | `POST /appointments/{id}/attendance` | `{ entries: [{ participationId, attendance, markInformed }], informationDelivered, afterCloseReason? }` → `200 { recorded, statusChanges }`; `422` with `errors[]` at `/entries/<i>` |
| 5b-2 | `POST /appointment-bookings/{id}/informed`; `POST /appointment-bookings/{id}/conflict-review` | "Als informiert erfassen" or "Als Grundlage bestätigen" (`{ informationDelivered: true }`); the PL's `escalated` or `information_delivered_otherwise` (`{ reason }`) |
| 5b-3 | `GET /portal/appointments`; `POST /portal/appointments/{id}/booking`; `POST /portal/appointment-bookings/{id}/cancellation` | D9's sections; book; cancel (`404` for another participation's booking) |
| 5b-3 | `POST /appointments/{id}/invitations`; `POST /participations/{id}/reminders/{reminderId}/follow-up` | `{ participationIds }` → `201 { batchId, queued, notDeliverable, skipped }`; the follow-up (`{ method }`) |
| 5b-4 | `POST /appointment-bookings/{id}/missed-resolution`; `GET /projects/{id}/worklist`, `/dashboard` | `{ reason }`; the D19 fields, filter and counts |

Order as in ADR-0010: schema → visibility (`404`; `participation_not_found` for a hidden id in a
body) → permission `403` → state `422`. Logs carry ids and codes only.

### Web UI (`apps/web`, German) and portal (`apps/portal`, de/en)

- 5b-1: project tab "Termine" (Art, Datum, Ort, Gastgeber·in, gebucht or "davon Ihre" with
  "Plätze frei / ausgebucht", Status, "Klärung nötig"); create forms with the hint on personal
  data; the appointment page (details, "Ändern", "Gastgeber·in ändern" (PL), "Absagen" with reason
  and confirmation, the bookings the viewer may list, "Teilnehmende buchen" with the D7 warning).
  Participant tab "Termine": bookings, "Termin buchen", "Buchung absagen".
- 5b-2: "Teilnahme erfassen" (per row "teilgenommen" from the start, "nicht erschienen" after the
  end, "als informiert erfassen" as D13, the confirmation checkbox, "Ohne Buchung erschienen" with
  the snapshot's name search, the refusal text); on a booking "Als informiert erfassen",
  "Teilnahme korrigieren", "Als Grundlage bestätigen" on a conflict, for the PL "Eskalieren" and
  "Anderweitig informiert" and the after-close reason; "Fand nicht statt (Korrektur)" (PL) on an
  appointment with absences only.
- 5b-3: portal "Termine" (D9) linked from the start page, keyboard and screen-reader usable, 320 px
  without horizontal scrolling; work list bulk "Zu Termin einladen" (the appointment, counts per
  channel, "nicht zustellbar, im Portal sichtbar", skips, the text as preview, the result);
  "Nachrichten" names the kinds and offers "Nachverfolgung erfassen" on an undelivered notice.
- 5b-4: the work list column "Termin" (the next booking or the most urgent item), the filter
  "Termine", the two tiles and the group; "Folgetermin buchen" and "Keine weitere Nachverfolgung"
  on a missed appointment.
- Every button by its capability; neither app derives a permission.

## User flows

1. **PL plans an info event:** "Termine" → "Infoveranstaltung anlegen" (W1, 40 Plätze, Kantine
   Werk 2) → work list W1, `contacted` → "Zu Termin einladen": 31 per E-Mail, 4 "nicht zustellbar,
   im Portal sichtbar" → books two of the four by phone after the public cutoff.
2. **Participant:** login → "Termine" → the invitation → "Buchen"; two people take the last seat at
   once: one booking, one "ausgebucht". The PL corrects the room: the booking stays, the person gets
   the change notice and sees the new venue.
3. **After the event:** "Teilnahme erfassen": 33 attended (three walk-ins), 2 absent; "als
   informiert erfassen" preselected, the PL confirms delivery → 30 `contacted → informed`, 3
   `imported → contacted → informed`. One row was unticked by mistake: "Als informiert erfassen" on
   that booking the next day.
4. **Consultant reassigned:** a participant with a booked slot moves to another consultant; the old
   host no longer sees them; the PL sees "Klärung nötig", makes the new consultant the host.
5. **Organizer cancels late:** the slot didn't take place → "Absagen", `did_not_take_place`; the
   person without a channel appears under "Termine zu klären" until the consultant records "per
   Telefon".
6. **Withdrawn after the last day:** the cutoff withdrawal ran at night; the PL enters the
   attendance of yesterday's event with `late_entry`; no status changes.

## Acceptance criteria

**5b-1**
- Domain tests first (100 % coverage on the new rules): every `bookingEligibility` refusal and its
  order, `beyond_upcoming_cutoff` versus `after_cutoff` at the boundary day; the public cutoff for
  the participant versus staff until the start; `info_event_limit`, several consultations,
  `booking_overlap` and `host_overlap` at touching and overlapping intervals; capacity; each role
  and assignment state for the permissions (back office, unassigned consultant, org roles, assisted
  mode, break-glass refused); D5 for each viewer; `needsResolution` after an unassignment, a role
  removal and a deactivation.
- Database tests: the last seat raced by two bookings gives one; the same participation raced twice
  gives one; booking, appointment cancellation and a terminal transition run concurrently without
  deadlock under the D10 order; a terminal transition cancels bookings of unstarted appointments
  only; `appointment_in_use` once a booking or invitation exists; `transfer_app` can't write the
  tables or record the new event types.
- API: a consultant sees only listable bookings and the D5 view; a hidden participation in a body
  is `participation_not_found`, back office booking is `403`; a former host sees nothing at once.
- History: the drift test passes; the PL and the assigned consultant see booking rows, back office
  none; no title or venue in any audit detail or log line.

**5b-2**
- Domain: `attendanceStatusChanges` from every main status returns only `edges` rows, nothing for
  `absent`, after close, `informed` or later; `attended` before the start and `absent` before the
  end are refused.
- Scenarios (D23): attendance corrected `absent → attended`, then informed through the separate
  action; `attended → absent` after it led to `informed` leaves the status and shows the conflict,
  which a replacement basis or the PL's attestation clears and `escalated` doesn't, and which stays
  visible after the participation closes; an appointment recorded all absent is corrected to
  `did_not_take_place` with the absences superseded and kept in the history, while one `attended`
  record refuses it; last-day attendance entered after the cutoff withdrawal by the PL with
  `late_entry` changes no status, and the consultant is refused.
- A request without `informationDelivered` but a ticked row is refused; consultation rows are never
  preselected (component test); one refused row records nothing and changes no status; an
  `unreachable` attendee after the cutoff is refused `before_cutoff`.
- e2e: PL creates an info event, books a participant, records attendance with the confirmation, the
  participant is `informed`.

**5b-3**
- The two texts' SHA-256 tests (de/en); a rendered message contains only the portal URL beyond the
  fixed text.
- Invitations: no usable channel → a `cancelled` row, the invitation visible in the portal; retry
  after `failed`, after `no_channel` once a channel exists and after `requester_no_longer_authorized`
  by an authorized requester, refused while `sent` or `delivery_unknown`; three delivery attempts at
  most, rows cancelled before the provider and transport retries counting none; a booking before dispatch cancels it `nothing_open`; neither
  kind touches the reminder window.
- Scenarios (D23): a consultant reassigned between a cancellation and its dispatch: the notice is
  still sent (system path); a cancellation without a usable channel writes a `cancelled` notice;
  booking, appointment cancellation and the dispatch claim run concurrently: no booking survives a
  cancelled appointment, no notice goes to a booking that wasn't cancelled, no deadlock.
- Portal at 320 px in de and en: invitations (also "ausgebucht" and "Buchung geschlossen" with
  booking disabled, and "gilt nicht mehr" without details), booking, cancellation, the "Abgesagt"
  section with an alternative and its window from a late cancellation; e2e: participant books and cancels.

**5b-4**
- Domain: `attendance_missing` from the day after the end date, also for a terminal participation;
  `missed` cleared only while its follow-up (a later info-event booking, or a linked consultation)
  is live or attended, back when the follow-up is cancelled, passed on when the follow-up is absent
  (one item per chain), never cleared by an unrelated consultation, ended by an explicit
  resolution; `notice_undelivered` until the
  follow-up; for every new count `count = items.filter(filter).length`, distinct participations.
- The work list over 2,000 participations with bookings keeps the Slice 5 performance criterion.

## Docs updated by the PRs

- 5b-1: process-and-lifecycle.md (appointments and booking in Phase 1), data-protection.md (D4–D6,
  D16, D17, the history rows), ADR-0002 (the appointment functions and the lock order of D10),
  architecture/overview.md (the tabs "Termine"), the generated tables (`pnpm generate`).
- 5b-2: process-and-lifecycle.md (attendance, the two-step `informed`, the closed-case flow),
  data-protection.md (the history rows).
- 5b-3: data-protection.md (reminders → messages: invitations, organizer notices, retry, follow-up,
  the texts; the portal's sections), ADR-0002 and ADR-0011 (the claim and the notice path),
  architecture/overview.md (the portal page).
- 5b-4: process-and-lifecycle.md (appointment items beside the deadline warnings),
  architecture/overview.md (the dashboard), roadmap.md (Slice 5b done); this plan to
  `docs/plans/archive/`; the retention trigger mapping (D17) still awaiting confirmation noted in Q166.
