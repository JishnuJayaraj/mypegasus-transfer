# Decisions — 2026-10-23, round 40 (Slice 5b planning, Q162–Q168)

The product owner reviewed [the Slice 5b plan](../plans/slice-5b.md) (PR #82, commit `9869120`).
Like rounds 32–39, these are pilot answers in the placeholder roles: no external DPO, legal or
works-council confirmation is involved yet, and none blocks development or testing on synthetic
data. Q162–Q168 are `accepted` in `open-questions.md` as amended below; the 🔒 rows keep the
pre-pilot gate (DPO/DPIA confirmation; works-council review for Q168 with Q157). Q169 is new
(`verify`). The three-PR split was found reasonable; the revised plan splits into four PRs because
the amendments add a recovery path, a closed-case flow and staff follow-up items.

## Required plan amendments (documented-rule conflicts)

1. **Locking:** `lock_participation` takes the shared project lock first, and ADR-0002 requires
   project-first locking (project → template version → participation row). The plan's appointment
   lock before the participation lock broke that order. One order must cover booking, bulk
   attendance, cancellation, terminal transitions and notification dispatch; "no deadlock" is shown
   by tests, not claimed.
2. **Retention:** "personnel file unless it becomes evidence" mixes records that may need different
   deletion rules. Decide the boundary now, and use the full `personnel_file` triggers of Q105
   (an executed DSV without TG entry ends with its cancellation or contractual end, not an exit).

## Q162 — Roles (accepted with two amendments)

PL management, consultants managing their own slots, assignment-scoped participant operations and
back-office read access stay.
- **Counts (Q150):** no exact project-wide booking count for a consultant who can't list every
  attendee; authorized counts only, any broader aggregate under the suppression policy. Shared
  seat availability needs an explicit treatment, not an assumed exemption.
- **Reassignment and a departing host:** existing bookings stay, under the PL's responsibility,
  with a visible need to resolve them. A former consultant loses participant access at once;
  bookings neither disappear silently nor grant continued access.

## Q163 — Attendance and `informed` (proposal rejected; decided as follows)

Attendance can't be the only opportunity to reach `informed`: an unticked "als informiert
erfassen" or a correction from `absent` to `attended` would leave no way to record it later.
- A focused, authorized "Als informiert erfassen" action on an existing qualifying attendance.
- The audited transitions through `contacted` stay, with every existing guard.
- Staff confirm that the necessary information was actually delivered; attendance at an arbitrary
  consultation carries no blanket preselected confirmation.
- Corrections never reverse a status automatically. A correction to `absent` of an attendance that
  led to `informed` is flagged for review.
- Late recording or correction of factual attendance after a participation closes, through a
  restricted audited flow that never reopens the participation or bypasses a guard.

Recording what happened is distinct from authorizing what happens next.

## Q164 — Booking and change rules (amended)

- No blanket ban on appointments after `latestEntryDate`: that predicts a withdrawal from today's
  status. Evaluate current eligibility, warn when a booking extends beyond an upcoming cutoff,
  cancel future bookings when the participation actually becomes terminal; existing guards for an
  already-passed cutoff still apply.
- Duplicate-booking prevention and serialized capacity checks stay.
- One future info-event booking; several non-overlapping consultations.
- No overlapping bookings of one participant; no overlapping slots of one host.
- Authorized staff may book after the public booking cutoff while a seat remains and the
  appointment hasn't started; a late phone booking is a booking, not a walk-in.
- Title and location corrections with bookings present keep the reservations and notify the
  people affected.
- An organizer cancellation after the scheduled start, so a late cancellation doesn't become false
  no-show data.
- `attended` from the start; `absent` after the end.
- Full rescheduling and waiting lists stay deferred.

## Q165 — Invitations and change notices (accepted; the experience fixed)

Reusing delivery and consent v2 is accepted ("notifications about using the portal"), subject to
the DPO wording review (Q132). Required:
- Identifiable invitations inside the portal.
- Cancelled bookings showing which appointment was cancelled and any available next step.
- Portal visibility independent of whether email/SMS succeeds (the existing message log, no
  second delivery log).
- A staff follow-up list for cancellations that couldn't be delivered.
- A separate authorization for organizer-triggered change notices: a defined project/system
  notification path (a consultant's current `mayRemind` must not suppress a necessary notice after
  reassignment), keeping the recipient, channel and consent checks.
- A controlled invitation retry policy: a failed first delivery doesn't exhaust the allowance.

## Q166 — Retention and classification (decided; funding linkage to verify)

The owner's fact check, an inference from the current BA guidance (Fachliche Weisungen, effective
4 May 2026, sections 1.5 and 1.8, <https://www.arbeitsagentur.de/datei/dok_ba036500.pdf>): the
introductory information event is described separately from funded profiling and consultation;
funded consultation can require evidence of the consultations actually performed (for example an
invoice with an overview of them). So some consultation records can support funding evidence, but
attendance at an appointment isn't automatically such evidence.
- Ordinary bookings and attendance may use `personnel_file`.
- Actual funded-measure evidence needs an explicit measure linkage and separately classified
  minimum evidence under the existing evidence-retention policy.
- No funding status inferred from `info_event` versus `consultation`.
- Host identifiers are staff personal data.
- Generic titles and shared venue information; no participant names, diagnoses or consultation
  notes.
- "No operational delete; retention still applies" instead of "never deleted".
- The exact linkage and evidence requirements need confirmation against the project's approved
  measure documents (Q169); the guidance doesn't settle project-specific facts or validate the
  repository's retention periods.

## Q167 — Overdue appointments (accepted with precise rules)

- `attendance_missing`: the appointment has ended, its Berlin end date has passed, attendance is
  unrecorded.
- `missed`: recorded absent, with unresolved follow-up.
- `overdue`: the union. Dashboard counts are distinct participations, matching the drill-down.
- A later appointment resolves a missed one only when it is the relevant follow-up; an unrelated
  consultation doesn't clear it. An explicit "no further follow-up required" resolution with a
  controlled reason.
- Informational and staff-facing; terminal participants get no participant task, but outstanding
  factual attendance work stays discoverable for staff.

## Q168 — History (accepted; reconstruction strengthened)

- Historical appointment times are preserved: immutable versions or snapshots, so a later edit
  can't rewrite the apparent date of an old booking.
- The appointment linkage and the message kind appear in both the queued and the delivery
  projections (the delivery projection showed only `outcome`).
- Corrections stay attributable with previous and new attendance; titles and locations stay out
  of audit details.

## Scenarios required before implementation is accepted

Attendance corrected later; last-day attendance entered after withdrawal; reassignment before a
cancellation's delivery; cancellation without a usable channel; concurrent booking, cancellation
and dispatch.

## Approval after the second review (commit `12695eb`)

The product owner approved the revised direction and the four-PR split for development on
synthetic data, with the focused amendments below; no further planning round. The plan's details
listed as readings in Q162–Q168 are accepted with these amendments.

**Standards**
1. **Dispatch lock order:** the claim follows the one order: participation → appointment →
   booking → message → channel → consent (a plan inconsistency, not an observed deadlock).
2. **Retention branches:** the 90-day non-signer branch excludes people with an executed DSV or a
   funded measure (Q105, Q77); `ta_completed` in a `ta_only` project has no TG exit date, so
   "otherwise after exit" leaves it undefined. The trigger mapping stays awaiting confirmation and
   the executable periods `unset`; it must be settled before deletion runs, not before synthetic
   development. The separate funded-evidence boundary is accepted; Q169 stays `verify`, and 5b
   isn't presented as the system that supplies funded-measure evidence.

**Spec**
1. **Conflict recovery (5b-2):** a replacement basis can be confirmed without a status change (the
   person is already informed); `information_delivered_otherwise` is an explicit PL attestation;
   `escalated` keeps the issue open; unresolved conflicts stay visible after closure.
2. **False no-shows (5b-2):** a restricted, audited PL `did_not_take_place` correction when only
   absences are recorded, preserving their history and superseding them; an `attended` record
   needs individual investigation.
3. **Delivery attempts (5b-3):** three explicit delivery attempts in total, the first included;
   rows created without a usable channel or consent use none; automatic transport retries are the
   same attempt; a currently authorized staff member may retry after
   `requester_no_longer_authorized`; no resend while an outcome is uncertain.
4. **Portal visibility (5b-3):** the 14-day cancellation window counts from the later of the
   original start and the cancellation; an invitation stays identifiable when the event is full or
   public booking has closed ("ausgebucht", "Buchung geschlossen", booking disabled, the next
   step); only currently authorized appointment details stay visible.
5. **Follow-up chains (5b-4):** automatic matching to a later eligible information event with the
   same briefing purpose, explicit `followUpOf` for consultations; a follow-up counts only while
   live or attended; cancelling it restores the missed item; a later no-show leaves actionable
   follow-up work.

**Accepted choices:** `available` / `full` as an explicit Q150 exception ("full" beside the visible
capacity reveals occupancy; no unauthorized total or remaining-seat count in any API payload);
`information_delivered_otherwise` as a resolution and `escalated` as an open handling state; three
delivery attempts and the amended 14-day window; inferred information-event and linked
consultation follow-up with the rules above; frozen times plus historical snapshots.
