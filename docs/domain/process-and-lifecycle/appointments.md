# Process & lifecycle: appointments

### Appointments *(accepted, Q162, Q164, Q168; Slice 5b)*

An **appointment** is an `info_event` (a group event, for the whole project or, in `ta_tg`, one
entry wave) or a `consultation` (a slot with one host, a PL or consultant of the project). It has
start and end (`timestamptz`, shown in Europe/Berlin), a capacity of 1–500, a public booking cutoff
0–14 whole days before the start (default one day), an optional generic title (≤ 100) and the
shared venue (1–200), and is `scheduled` or `cancelled`. Title and venue are generic: no names,
diagnoses or consultation notes (data-protection.md, appointments). One policy in every project
(`appointmentPolicy`): nothing varies per Agentur.

- **Creating and changing** (as built in 5b-1; Q170): appointments are planned in a `draft` or
  `active` project; bookings (and later invitations and attendance) need `active`
  (`project_not_active`). Normal scheduling gives an appointment a future start, and its times
  move only while it is unused (`starts_in_past`); this check never applies to recording or
  correcting attendance of an existing appointment. Capacity rises any time and falls to no fewer
  than the live bookings (`capacity_below_bookings`); title and venue may be corrected with
  bookings present. Times, the public cutoff and the audience never change once the appointment
  has had a booking or (from 5b-3) an invitation, even a cancelled one (`appointment_in_use`:
  cancel it and create a new one), so every booking keeps its appointment's times; the kind never
  changes. A host can't conduct overlapping scheduled slots in any project (`host_overlap`, shown as
  "host unavailable" without naming the other project; intervals `[start, end)`, so consecutive
  slots touch; cancelled slots don't block; Q171). The PL changes a slot's host before its start,
  to a PL or consultant who may list every live booking of it (`host_not_responsible`) and is free
  then.
- **Cancelling by the organizer:** before or after the start, with a closed reason
  (`organiser_unavailable`, `too_few_bookings`, `did_not_take_place`, `created_in_error`,
  `other`); every live booking is cancelled with it (`appointment_cancelled`). A cancelled
  appointment leaves no attendance work. No operational delete; retention applies.
- **Booking** (`bookingEligibility`, the database decides again), refused in this order:
  `appointment_cancelled`, `appointment_started` (staff book until the start, also after the
  public cutoff; a late booking is a booking, not a walk-in), `booking_closed` (the participant
  after the public cutoff), `participation_closed` (terminal), `not_in_audience` (an info event of
  another wave, or a participation from `active_in_tg` on), `host_not_responsible` (a consultation
  whose host may not list the participation), `already_booked`, `info_event_limit` (one live
  info-event booking whose event hasn't ended; cancelled ones don't count, Q171), `booking_overlap` (two live bookings of one
  participation overlapping; touching is fine; any number of consultations), `appointment_full`,
  `after_cutoff` (before `informed` in `ta_tg`, today after the wave's `latestEntryDate`: the
  `before_cutoff` semantics, unchanged). A bookable appointment is booked with the warning
  `beyond_upcoming_cutoff` when its Berlin start date falls after the participation's applicable
  cutoff that hasn't passed yet: the planner's `latestEntryCutoff`, i.e. in `ta_tg` while the
  cutoff would withdraw or flag the participation (this can include `informed`), the wave's date
  or the project's final entry date without a wave (Q84, Q172). The warning is information only:
  nothing predicts a withdrawal and no guard changes.
- **Cancelling a booking:** staff (the PL, the assigned consultant) any live booking until the
  start; the participant their own from 5b-3. No waiting list.
- **A terminal status** cancels the participation's live bookings of appointments that haven't
  started (`participation_closed`, see "Main status"); bookings of started appointments stay for
  the attendance record.
- Invitations and the organizer's notices: data-protection.md, messages about appointments; the
  work list's items: "Appointment items" above.
- **Not in the MVP** (v1.1 or later): waiting lists, rescheduling, automatic appointment reminders
  (Q152), calendar files, booking confirmation messages, video-call links, recurring slot series,
  letters, the Agentur's own appointments, funded-measure evidence (Q169).

#### Attendance and `informed` *(accepted, Q163, Q164; as built in 5b-2; readings Q173)*

Recording what happened and authorizing what happens next are two steps.
- **Attendance** (`attendanceEligibility`, the database decides again): the PL or the assigned
  consultant records `attended` from the start and `absent` after the end
  (`appointment_not_started`, `appointment_not_ended`) on a live booking they may list, in an
  active project, on a scheduled appointment; the start-in-the-future rule of normal scheduling
  never applies here (Q170). One request ("Teilnahme erfassen") takes 1–500 rows, all or nothing:
  one refused row records nothing and changes no status ("Keine Teilnahme erfasst", then each row's
  code). A participation without a live booking is a **walk-in**: `attended` only (`not_booked`),
  any non-terminal participation for an info event, one the host may list for a consultation
  (`host_not_responsible`); it gets a booking of origin `walk_in`, beyond the capacity and the
  booking rules (a record of what happened, Q173). A recorded value may be **corrected** to the
  other one (`attendance_unchanged` otherwise) by the same roles, audited with the previous and the
  new value; a correction never changes a status. A booking with attendance can't be cancelled
  (`attendance_recorded`).
- **After the participation closed** (the closed-case flow): only the PL records or corrects the
  attendance of a live booking of an appointment that started before the terminal change
  (`participation_closed` for anyone else and for a walk-in, `started_after_close`), with a closed
  reason (`late_entry`, `correction`; `after_close_reason_required`), audited with `afterClose`;
  never a status change and never "Als informiert erfassen". The participation isn't reopened and
  no guard is bypassed. A last-day event entered after the next night's cutoff withdrawal is this
  flow.
- **`informed`** (`attendanceStatusChanges`, only rows of the edge list): in the attendance
  request each `attended` row recorded for the first time, of a participation before `informed`,
  offers "als informiert erfassen" (preselected for an info event, never for a consultation); a
  request with any ticked row needs the recorder's confirmation "Die erforderlichen Informationen
  wurden vermittelt" (`informationDelivered`, unticked by default;
  `information_delivery_unconfirmed`), and a tick anywhere else is `mark_informed_not_allowed`.
  Later, on an existing qualifying attendance (`attended`, not recorded after a close, the
  participation before `informed`), the separate action "Als informiert erfassen" with the same
  confirmation (`qualifiesForInformed`) is the recovery path for an unticked row and for a
  correction from `absent` to `attended`. Either way one transaction writes
  `information_delivery_confirmed`, marks the booking as the **basis** and changes the status as
  the confirming staff user along the `manual` edges: `contacted → informed`, `imported →
  contacted → informed`, `unreachable → contacted` (its `before_cutoff` guard, with database time)
  `→ informed`, each its own `status_changed` through the status function. A failing guard
  refuses the request.
- **The conflict:** a correction of the basis to `absent` reverses nothing; the booking shows
  `attendance_conflict` ("Widerspruch zu klären") until one of two resolutions: a **replacement
  basis** ("Als Grundlage bestätigen" on another `attended` booking of the participation, with the
  same confirmation, by the PL or the assigned consultant, after the close the PL only), which
  changes no status; or the PL's attestation `information_delivered_otherwise` ("Anderweitig
  informiert"). The PL may record `escalated` ("Eskalieren") as the handling state: the conflict
  stays open, shown as escalated. An unresolved conflict stays visible after the participation
  closes, and the PL resolves it there too.
- **Correcting false no-shows:** when the attendance recorded for an appointment is only `absent`,
  the PL may still cancel it with `did_not_take_place` as a correction (`appointment_cancelled`
  with `correction: true`): each absence stays on its booking and in the history, superseded
  (`attendance_superseded`), and the bookings are cancelled with the appointment, so no missed
  appointment remains; no notices go out for a past event. Any other cancellation of an appointment
  with attendance, and a single `attended` record, refuse it (`attendance_recorded`): each is
  investigated and corrected on its own first.
