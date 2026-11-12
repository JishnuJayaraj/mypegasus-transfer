# Data protection: messages

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
    id and kind, the consent id, the requester's id, the appointment and booking an appointment's
    message is about, times, status, a closed cancel reason and a notice's follow-up; never an
    address, rendered text, provider response, free text, error message, IP or tracking data. The
    tab "Nachrichten" shows it to whoever reads the participation's `case_internal` data (the PL,
    the assigned consultant, back office), the requester as "Team", an organizer's notice as
    "System (Veranstalter)", a row without a usable channel as "kein Kontaktweg".
- **Messages about appointments (Slice 5b; Q165, accepted; as built in 5b-3, readings Q174):**
  one message log with three more kinds: `appointment_invitation`, `appointment_changed` (title
  or venue corrected) and `appointment_cancelled` (the appointment, or the booking by staff). The
  reminders' contract applies (channel choice, a live consent v2, whose "notifications about using
  the portal" cover them; channel, consent, language and text version fixed when queued;
  cancelled rather than rerouted; the outcomes; the log's fields). Neither kind uses or consumes
  the 3-day reminder window.
  - *Invitations:* requested by staff for 1–500 participations under the exclusive project lock
    (`mayRemind`; the requester rechecked at the dispatch). An appointment no participant can book
    from the portal now (cancelled, started, past its public cutoff, full) refuses the request as a
    whole. Each eligible participation gets a row, also without a usable channel: then it is
    `cancelled` at once (`no_channel`, `consent_required`; no job; "nicht zustellbar, im Portal
    sichtbar"), so the portal shows the invitation either way. Skips without a row:
    `participation_closed`, `not_eligible` (another booking rule for the participant),
    `already_booked`, `already_invited`, `invitation_limit`.
  - *Retry:* a new invitation to the same appointment is allowed after the latest one ended
    `failed`, was cancelled for a delivery reason (`no_channel`, `consent_required`,
    `channel_unavailable`, `consent_ended`, `delivery_unavailable`) or, by a currently authorized
    requester, `requester_no_longer_authorized`; refused while it is `queued`, `dispatching`,
    `sent` or `delivery_unknown` (an uncertain outcome is never resent) and after any other
    cancellation. At most three delivery attempts per participation and appointment, the first
    included: an attempt is a row the claim handed to the provider (`sent`, `failed`,
    `delivery_unknown`); a row cancelled before that uses none, and the job's transport retries are
    the same attempt (`invitationRetryAllowed`).
  - *Organizer notices:* the function that cancels the appointment or a booking (staff), or
    corrects the title or venue of an appointment that hasn't started, queues one notice per
    person booked as the system (no requester, actor `system`, job `appointments.notify`) in its
    own transaction, so a reassignment between the change and the dispatch can't suppress it. A
    cancellation after the start notifies too; the PL's `did_not_take_place` correction of a past
    event over absences only sends none, nor does the participant's own cancellation or a closed
    participation. The claim keeps the recipient, channel and consent checks and has no requester
    check. Without a usable channel the notice is `cancelled` at once like an invitation.
  - *The claim's rechecks* for an invitation: still bookable for the participant
    (`appointment_unavailable`), not booked meanwhile (`nothing_open`). Lock order: participation
    → appointment and booking `FOR SHARE` → message `FOR UPDATE` → channel, consent `FOR SHARE`
    (ADR-0002, messages).
  - *Texts (Q165; final wording with the DPO, Q132):* `portal-invitation:v1` and
    `portal-appointment-change:v1` (both notice kinds), de/en, immutable, SHA-256 tests in the
    notice catalog; no name, project, employer, kind, date, time, venue or title; the only
    placeholder the plain portal URL; plain-text mail with the reminders' privacy note in email
    only (`messageFor`).
  - *Follow-up:* a notice that ended `failed`, `delivery_unknown` or cancelled for any reason but
    `participation_closed` is undelivered (`noticeUndelivered`) until the PL or the assigned
    consultant records once how the person was told (`phone`, `in_person`, `letter`) or that it
    isn't needed (`not_needed`; "Nachverfolgung erfassen" in "Nachrichten";
    `mayResolveAppointmentItem`), audited `appointment_notice_followed_up` (method and
    appointment). Not for a closed participation. Participants without a usable channel are booked
    by staff (phone, in person); letters stay out of scope, the follow-up records them.
