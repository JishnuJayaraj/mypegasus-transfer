# Database: appointments

## Amendment 2026-10-23: appointments and staff bookings (Slice 5b, PR 5b-1)

Migrations `0059_appointments.sql` (generated) and `0060_appointment_functions.sql` (hand-written,
the 0058 hardening); process-and-lifecycle.md and data-protection.md ("Appointments") hold the
rules.
- **`appointment`** (`project_master`, `internal`): id, project, kind, host (staff id, a
  consultation only), audience wave (a composite FK to the project's wave, an info event only),
  start, end, public cutoff, capacity, title, venue, status, closed cancel reason, `cancelled_at`,
  creator, `created_at`, `version`; `CHECK`s for the times (end after start, cutoff 0–14 days
  before the start), capacity 1–500, the texts (trimmed, lengths, no control characters), host and
  audience by kind and the cancellation columns. **`appointment_booking`** (`personnel_file`,
  `case_internal`, the field `appointmentBookings`): id, project, participation (composite FK),
  appointment (composite FK), origin, status, closed cancel reason, `booked_by` (null exactly for
  the participant), `booked_at`, `cancelled_by` (exactly for a staff or organizer cancellation),
  `cancelled_at`; the partial unique index `(appointment_id, participation_id) WHERE status =
  'booked'` backs `already_booked`. `transfer_app` selects both and writes neither.
- **The lock order.** Every function takes the project's advisory lock first: shared through
  `lock_participation` when it touches one participation, exclusive (`lock_project_setup`) when it
  changes an appointment. Then always: participation rows (in UUID order) → the appointment row →
  booking rows (in id order); never an appointment before a participation. One host's slots
  serialise across projects on an advisory lock of the host (`assert_host_free`), taken after the
  project lock.

  | Operation | Project lock | Then |
  |---|---|---|
  | `book_appointment`, `cancel_appointment_booking` | shared (`lock_participation`) | the participation → the appointment `FOR UPDATE` (capacity, overlaps) → the booking |
  | `create_appointment`, `update_appointment`, `change_appointment_host`, `cancel_appointment` | exclusive | the participations of its live bookings in UUID order → the appointment → its bookings in id order; the host lock for a slot's times or host |
  | a terminal status (`apply_status_change`) | shared (held) | the participation (held) → its booking rows in id order; no appointment lock (a freed seat only lowers a count) |

  Integration tests race the last seat, the same booking twice, two projects creating
  overlapping slots of one host (Q171), and a booking, an appointment
  cancellation and a terminal transition together (no deadlock, no live booking left on a
  cancelled appointment).
- **Functions** (`SECURITY DEFINER`, staff context in normal mode only, `actor_not_allowed`
  otherwise): `create_appointment(context, project, id, kind, host, wave, start, end, cutoff,
  capacity, title, venue)` (the PL any, a consultant their own slot, in a draft or active
  project, Q170; `host_not_allowed`, `not_ta_tg`, `wave_of_other_project`, `starts_in_past`, `host_overlap`);
  `update_appointment(context, id, version, the whole new state)` (`stale_version`,
  `appointment_cancelled`, `appointment_in_use` for times, cutoff or audience after any booking,
  `starts_in_past`, `capacity_below_bookings`, `host_overlap`, `appointment_unchanged`);
  `change_appointment_host(context, id, version, host)` (the PL, before the start; also
  `not_consultation`, `appointment_started`, `host_not_responsible`); `cancel_appointment(context,
  id, reason)` (every live booking `appointment_cancelled`; returns their number);
  `book_appointment(context, appointment, participation, id)` (origin `staff`; the PL or the
  assigned consultant; an active project only, `project_not_active`; the domain's refusals in its order, `after_cutoff` through
  `participation_before_cutoff`); `cancel_appointment_booking(context, booking)` (`staff_cancelled`;
  `booking_cancelled`, `appointment_started`).
- **The terminal cancellation** is the trigger `participation_terminal_cancel_bookings` beside the
  code revocation: in the status function's transaction, the live bookings of appointments that
  haven't started end `participation_closed`, audited as the system
  (`terminal-booking-cancellation`).
- **Events:** `appointment_created`, `appointment_changed`, `appointment_cancelled` (project-level),
  `appointment_booked`, `appointment_booking_cancelled` (`case`, need their participation), each
  with its `audit_event_projection` row; ids, codes and times only (`startsAt` as written), never
  the title or venue. All five are reserved (`record_audit_event` refuses them). Grants: `SELECT` on
  both tables, `EXECUTE` on the six functions; the helpers have none.

## Amendment 2026-10-23: attendance and `informed` (Slice 5b, PR 5b-2)

Migrations `0061_attendance.sql` (generated) and `0062_attendance_functions.sql` (hand-written, the
0060 hardening); process-and-lifecycle.md and data-protection.md ("Appointments", attendance) hold
the rules.
- **`appointment_booking`** gains `attendance` (`attended`, `absent`), `attendance_recorded_by/at`,
  `after_close_reason` (`late_entry`, `correction`), `informed_basis_by/at`,
  `conflict_escalated_by/at`, `conflict_resolution` (`replacement_basis`,
  `information_delivered_otherwise`), `conflict_resolved_by/at`, `attendance_superseded_by/at`
  (staff ids and times, all `appointmentBookings`); `CHECK`s keep each value with its actor and
  time, a walk-in recorded, a basis, an escalation or a resolution only on a recorded booking, and
  a supersession only on an absence cancelled with its appointment.
- **The lock order** (the table of the 5b-1 amendment, extended):

  | Operation | Project lock | Then |
  |---|---|---|
  | `record_attendance` | exclusive | the named participations in UUID order → the appointment `FOR UPDATE` → their live bookings in id order; each status change through `apply_status_change` (the shared lock re-entrant under the exclusive one) |
  | `confirm_information_delivered`, `escalate_attendance_conflict`, `resolve_attendance_conflict` | shared (`lock_participation`) | the participation → the booking's appointment `FOR SHARE` → the participation's bookings in id order (the booking alone for the review) |
  | `cancel_appointment` with the PL's `did_not_take_place` correction | exclusive | as before |

  An integration test races the bulk recording, a booking of another appointment and a terminal
  transition of a recorded participation (no deadlock; either the recording or the withdrawal
  comes first).
- **Functions** (`SECURITY DEFINER`, staff context in normal mode only):
  `record_attendance(context, appointment, participation ids, attendance values, informed ticks,
  information delivered, after-close reason)` (1–500 rows, all or nothing, walk-ins as bookings of
  origin `walk_in`; the closed-case flow for the PL, the terminal change's time from its
  `status_changed`; returns `{ recorded, informed, statusChanges }`);
  `confirm_information_delivered(context, booking, information delivered)` (a status change
  before `informed`, else a replacement basis resolving the open conflicts; returns the number of
  status changes); `escalate_attendance_conflict(context, booking)` and
  `resolve_attendance_conflict(context, booking, resolution)` (the PL; the attestation only). The
  status changes run in the internal `confirm_informed` through `apply_status_change`, which
  re-checks the edge, the project and the track; `before_cutoff` of `unreachable → contacted` is
  checked there with database time, and the API's status service checks each step's permission
  and guards before. `cancel_appointment` (replaced) refuses `attendance_recorded` but for the
  PL's `did_not_take_place` correction over absences only (each `attendance_superseded`, then
  cancelled with the appointment, `correction: true`); `cancel_appointment_booking` (replaced)
  refuses a booking with attendance.
- **Events:** `attendance_recorded`, `attendance_superseded`, `information_delivery_confirmed`,
  `attendance_conflict_escalated`, `attendance_conflict_resolved` (`case`, need their
  participation), each with its `audit_event_projection` row; ids, codes, flags and times only.
  All five are reserved. Grants: `EXECUTE` on the four functions; the helpers
  (`booking_event_details`, `participation_closed_at`, `booking_conflict_open`,
  `confirm_informed`, `lock_conflict_booking`) have none.

## Amendment 2026-10-23: the portal's bookings and messages about appointments (Slice 5b, PR 5b-3)

Migrations `0063_messages.sql` (generated) and `0064_message_functions.sql` (hand-written, the
0062 hardening); data-protection.md ("Messages about appointments", "Appointments": the portal)
holds the rules.
- **`participant_reminder`** gains `appointment_id` (composite FK to `appointment`),
  `booking_id`, `followed_up_method` (`phone`, `in_person`, `letter`, `not_needed`),
  `followed_up_by/at`; `requested_by` is null exactly for an organizer's notice; `channel_id`,
  `channel_kind` and `consent_id` are null exactly for a row cancelled at the request
  (`no_channel`, `consent_required`; never a reminder). `CHECK`s tie each to its kind: an
  appointment for every kind but `open_items`, a booking and no requester exactly for the two
  notices, a follow-up only on an undelivered notice. The new enum values are compared as text in
  the `CHECK`s and functions (one migration run). Only `open_items` counts the reminder window
  (`request_reminders` replaced).
- **The lock order** (the tables above, extended):

  | Operation | Project lock | Then |
  |---|---|---|
  | `book_appointment` and `cancel_appointment_booking` by the participant (the session's token) | shared (through `lock_active_session`) | the participation → the session → the appointment `FOR UPDATE` → the booking |
  | `request_invitations` | exclusive | the named participations in UUID order → the appointment `FOR UPDATE` → message rows (inserted) |
  | `update_appointment` (title or venue), `cancel_appointment`, `cancel_appointment_booking` (staff) with their notices | as before | as before, then the notices' message rows (inserted) |
  | `claim_reminder_dispatch` | shared (`lock_participation`) | the participation → the appointment and the booking `FOR SHARE` (their ids read from the message's immutable columns without a lock) → the message `FOR UPDATE` → the channel and the consent `FOR SHARE`; a reminder skips the appointment step |
  | `record_notice_follow_up` | shared (`lock_participation`) | the participation → the message `FOR UPDATE` |

  An integration test races a participant's booking, the appointment's cancellation and an
  invitation's claim: no booking survives the cancelled appointment, every cancellation notice
  belongs to a booking the cancellation cancelled, no deadlock.
- **Functions** (`SECURITY DEFINER`): `book_appointment(context, appointment, participation, id,
  token)` and `cancel_appointment_booking(context, booking, token)` (recreated with the optional
  token): a staff context without a token as before; a participant context with the token of their
  live active session (`session_invalid` otherwise), origin `participant` until the public cutoff
  (`booking_closed`), their own booking only (`booking_not_found` for another), no notice. The
  booking rules are one helper, `appointment_booking_refusal(participation, appointment,
  participant)`, in the domain's order. `request_invitations(context, appointment, participation
  ids, batch)`: the PL or the assigned consultant in normal mode, 1–500 participations of the
  active project; refused as a whole for `appointment_cancelled`, `appointment_started`,
  `booking_closed`, `appointment_full`; per row a skip code, or an invitation (cancelled at once
  without a usable channel). Organizer notices: `update_appointment` (title or venue before the
  start), `cancel_appointment` (not for the PL's correction) and `cancel_appointment_booking` (staff)
  queue one per person booked through the internal `queue_appointment_notice`, as the system
  (`appointments.notify`, the organizer's request id), none for a closed participation.
  `claim_reminder_dispatch` (replaced) rechecks per kind (no requester check for a notice;
  `nothing_open` or `appointment_unavailable` for an invitation); `settle_reminder` (replaced)
  writes the kind and the appointment and records a notice's outcome as `appointments.notify`.
  `update_appointment` counts an invitation as use (`appointment_in_use`).
  `record_notice_follow_up(context, message, method)`: the PL or the assigned consultant, once
  (`already_followed_up`), on an undelivered notice (`notice_delivered` otherwise) of an open
  participation (`participation_closed`).
- **Events:** `reminder_queued` adds `appointmentId` and `startsAt` (the start as written then)
  and has the system actor for a notice and no `channelKind` for a row without a usable channel;
  `reminder_delivery` adds `kind` and `appointmentId` and has the requester's or the system's
  context when written at the request. Both projections show the new keys (a migration updated
  their rows; older events lack them). New: `appointment_notice_followed_up` (`case`, `method`,
  `appointmentId`), reserved. Grants: `EXECUTE` on `request_invitations` and
  `record_notice_follow_up` (and the two recreated functions); the helpers
  (`appointment_notice_context`, `message_job_context`, `appointment_booking_refusal`,
  `queue_appointment_message`, `queue_appointment_notice`) have none.

## Amendment 2026-10-24: missed appointments on the work list (Slice 5b, PR 5b-4)

Migrations `0065_missed_appointments.sql` (generated; its unique key is moved before the foreign
key that needs it) and `0066_missed_appointment_functions.sql` (hand-written, the 0064
hardening); process-and-lifecycle.md ("Appointment items") holds the rules.
- **`appointment_booking`** gains `follow_up_of` (a composite FK `(follow_up_of,
  participation_id)` to `(id, participation_id)`, so a follow-up is of the same participation;
  only a staff booking, never itself), `missed_resolution` (`participant_declined`,
  `information_delivered_otherwise`, `no_longer_needed`) and `missed_resolved_by/at` (all or
  none, only on an `absent` booking). `transfer_app` writes none of them.
- **The lock order** (the tables above, extended):

  | Operation | Project lock | Then |
  |---|---|---|
  | `resolve_missed_appointment` | shared (`lock_participation`) | the participation → the appointment `FOR SHARE` → the booking `FOR UPDATE` |
  | `book_appointment` with `follow_up_of` | as before | as before, then the followed booking `FOR UPDATE` (after the appointment) |

- **Functions** (`SECURITY DEFINER`): `resolve_missed_appointment(context, booking, reason)`: the
  PL or the assigned consultant in normal mode; `booking_not_found`, `actor_not_allowed`,
  `participation_closed`, `already_resolved`, `not_missed`; audited `missed_appointment_resolved`.
  `book_appointment(context, appointment, participation, id, token, follow_up_of)` (recreated with
  the optional link; a participant links nothing): after the booking rules
  `follow_up_not_found`, `follow_up_kind_mismatch`, `follow_up_not_missed`; `appointment_booked`
  names `followUpOf`. The internal `booking_missed(booking)` is the domain's `missedBookings` for
  one booking (never null). `record_audit_event` refuses the new type.
