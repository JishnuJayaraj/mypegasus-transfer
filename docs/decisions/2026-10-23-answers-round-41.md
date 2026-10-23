# Decisions — 2026-10-23, round 41 (Slice 5b, PR 5b-1 readings, Q170–Q172)

The product owner answered the three questions PR 5b-1 (#83) raised where
[the Slice 5b plan](../plans/slice-5b.md) didn't decide. Like rounds 32–40, these are pilot
answers in the placeholder roles for development and testing on synthetic data. Q170 and Q171 are
`accepted` (Q170 with amendments), Q172 is `accepted` as amended in `open-questions.md`.

## Q170 — Appointment changes (accepted with amendments)

- Normal scheduling creates appointments with a future start. Moving an appointment is allowed
  only while it is unused; a booked or invited appointment keeps its frozen times.
- The kind never changes. The public cutoff is frozen once a booking or invitation exists, even if
  it is cancelled later.
- The host changes only before the start; the replacement passes the authorization and overlap
  checks.
- **Amendment:** planning is allowed in draft projects. Appointments are created and edited in
  `draft` or `active`; bookings, invitations and attendance require `active`, so the PL prepares
  the schedule before the launch.
- **Amendment:** the future-start validation must not block late attendance recording or
  corrections on existing appointments (5b-2).

## Q171 — A host's slots and the info-event limit (accepted)

- A host can't conduct overlapping consultation slots across projects. This is enforced under
  concurrent writes: a project lock alone can't prevent a race between two projects. The refusal
  is a generic "host unavailable" that exposes neither the other project nor its participants.
- Intervals are `[start, end)`, so consecutive slots touch. Cancelled slots don't block.
- An ongoing info-event booking counts against the one-booking limit until the event's end, not
  its start. Cancelled bookings or appointments don't count.

## Q172 — The cutoff warning (amended: warnings and guards have different purposes)

The `before_cutoff` guard is wave-based; that doesn't make it the source of the appointment
warning. The warning uses the planner's `latestEntryCutoff` projection:
- only in `ta_tg`, where the cutoff is relevant to the participation (it would withdraw or flag
  it); this can include `informed`, but not automatically everyone before TG entry;
- the assigned wave's date, or the project's final entry date without a wave (Q84);
- shown when the appointment's Berlin start date falls after that applicable, **upcoming**
  deadline;
- informational only: the hard booking refusal (`after_cutoff`) isn't extended to `informed`, and
  no lifecycle guard changes.
