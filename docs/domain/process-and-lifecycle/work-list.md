# Process & lifecycle: work list

- **Deadline warnings** (Slice 5; Q151; `deadlinesOf`, `packages/domain/src/worklist/`): the
  work list and the dashboard list every applicable deadline of a participation as
  `{ kind, date, state }`. They inform, never guard. `upcoming` from 14 calendar days before the
  date up to the date itself, `overdue` from the day after (deadlines are inclusive, Q69); a date
  further away isn't listed. The kinds, in their tie order:

  | Kind | Applies while | Date | Replaces the flags |
  |---|---|---|---|
  | `offer_deadline` | `dsv_offered` | the effective offer deadline | — |
  | `tg_start` | `informed` | the effective TG start | `tg_start_missed` |
  | `asu_due` | `ta_tg`, before `active_in_tg`, not terminal, no registration with proof, a knowledge date and the end of the old employment known (Slice 6) | the statutory ASU due date (Dates) | — |
  | `tl407_submission` | `ta_tg`, `informed` or `active_in_tg`, no TL 407 submission standing (Slice 6, PR 6-5b) | the effective TG start minus the placement Agentur's `leadTimeDays`; under an approved exception the day profiling was done (TL 407 submission) | — |
  | `latest_entry_cutoff` | the cutoff would withdraw or flag it, as it will be at the cutoff (`latestEntryCutoff`, the warning's condition) | the applicable latest entry date (the wave's, else the project's final one, Q84) | `cutoff_warning`, `cutoff_final_reminder` |
  | `privacy_notice` | the Article 14 notice isn't provided (Q124; any status, *assumed*, Q160) | its due date | — |
  | `profiling_exception` | `active_in_tg` under an approved exception, profiling neither done nor declined | entry + 1 month (Q74) | `profiling_exception_deadline_missed` |

  `latest_entry_cutoff` carries `final: true` from 3 days before the cutoff while it is upcoming
  (Q78). A flag a deadline replaces is never listed beside it, so a cutoff counts once; the flags
  that stay flags are `conflict_dsv_signed_profiling_declined`, `dsv_never_offered`,
  `informed_without_wave_at_cutoff` and `profiling_declined_after_entry`. A row shows its most
  urgent deadline: the oldest overdue one, else the earliest upcoming one, a tie by kind order.
  Without a knowledge date the row carries the item `knowledge_date_missing` with the reference
  date as a labelled orientation ("Orientierung … – Kenntnisdatum klären"), shown when no dated
  deadline is due and never overdue; no automatic reminder (Q1, Q152).
- **Participant actions** (Slice 5; Q151; `participantActions`): what the participant still has
  to do in the portal, from the wizard's steps (`data_collection`, `profiling`) of the
  participation's own resolved chain: one action per missing field on a wizard page (custom fields
  included) that the viewer may know about (the "Selbstauskunft" tab's rule), then one per
  document type of the participant's own types: `missing` when a rule needs a live document and
  there is none, `rejected` when every live document of the type is rejected (a required type
  never counts as both). An upload waiting for its review asks nothing of the participant. A
  terminal participation has no actions (*assumed*, Q160). Codes only, never a value.
- **Appointment items** (Slice 5b; Q167, accepted; readings Q175; `appointmentItems`,
  `packages/domain/src/worklist/appointments.ts`): beside the deadline warnings each row has
  `appointments: { next, items }`. `next` is the earliest live booking of a scheduled appointment
  that hasn't started (kind and start). The items, each `{ kind, appointmentId, appointmentKind,
  startsAt }`, in this urgency order, then by start (the row shows the first, else `next`):
  - `attendance_missing`: a live booking whose appointment's Berlin end date has passed (from the
    next day), attendance unrecorded; it stays after the participation closed (the PL's
    closed-case flow, "Attendance and `informed`");
  - `missed`: a live booking recorded `absent` (not a basis of `informed`: its absence is the
    conflict's) without an explicit resolution and without a **live follow-up**. For an info event
    the follow-up is any later info-event booking of the participation (the same briefing purpose,
    matched automatically); for a consultation only a consultation staff booked as its follow-up
    (`followUpOf`; an unrelated consultation clears nothing). A follow-up counts while it is live
    (upcoming, unrecorded or attended): cancelled, the item is back; recorded `absent`, the
    follow-up is the chain's one missed item. "Keine weitere Nachverfolgung" by the PL or the
    assigned consultant, with a closed reason (`participant_declined`,
    `information_delivered_otherwise`, `no_longer_needed`), ends the chain
    (`resolve_missed_appointment`, audited `missed_appointment_resolved`; once: `already_resolved`;
    only while missed: `not_missed`; not for a closed participation: `participation_closed`).
    "Folgetermin buchen" books another appointment of the kind; a consultation is linked
    (`book_appointment` with `follow_up_of`: a missed consultation of the same participation,
    `follow_up_not_found`, `follow_up_kind_mismatch`, `follow_up_not_missed`);
  - `notice_undelivered`: an organizer's notice without its follow-up (data-protection.md,
    messages about appointments);
  - `needs_resolution`: a live future consultation booking whose host may no longer list the
    participation, for the PL only (data-protection.md, appointments);
  - `attendance_conflict`: a basis corrected to `absent`, open or escalated, also after the close.

  They inform staff: never a guard, a participant action or a reminder. A terminal participation
  keeps `attendance_missing` and an unresolved `attendance_conflict`, nothing else. The filter
  `appointment` takes `upcoming` (a `next`), `overdue` (`attendance_missing` ∪ `missed`),
  `to_resolve` (`notice_undelivered` ∪ `needs_resolution` ∪ `attendance_conflict`) or one kind; the
  dashboard's tiles "Termine überfällig" and "Termine zu klären" and its group "Termine" count the
  distinct participations each value matches in the same snapshot.
- **The work list's next step and default order** (Slice 6b; `nextStep`, `openSteps`,
  `urgencyOrder`, `packages/domain/src/worklist/next-step.ts`): the column "Nächster Schritt"
  names one item per row out of everything the row already carries; it reads, never changes a
  status. The items are ranked by tier:

  | Tier | Items | Within the tier |
  |---|---|---|
  | 1 Overdue | overdue deadlines; every appointment item (`overdue` and `to_resolve` alike) | oldest date first (an appointment item by its Berlin date) |
  | 2 Undated or escalated work that must not wait for a date | case items (`evidence_invalidated` "Nachweis ungültig", `kug200b_offer_open`, `kug200b_withdrawal_ba_notice`, `knowledge_date_missing`), Agentur items, lifecycle flags | oldest date first; then the undated ones (flags, and `knowledge_date_missing`, whose date is an orientation) |
  | 3 Upcoming deadlines (the 14-day horizon) | upcoming deadlines | nearest first |
  | 4 Participant actions | rejected uploads, then missing documents, then missing fields | the row's order |

  A tie keeps the existing kind order: the source (deadline, appointment item, case item, Agentur
  item, flag) and within it its kind's enum order (`DeadlineKind`, `AppointmentItemKind`, …). An
  undated item is never ranked below a dated one of a lower tier. Nothing open is "–". The column
  shows the item's label, for tiers 1 and 3 its relative and absolute date, and "+n weitere" with
  the number of the row's other open items. **The default order** of the work list (in the
  browser, over the snapshot; the API keeps its own deterministic order) uses the same ranking on
  each row's next step, then the most open items, then the last name in German order (none last),
  then the snapshot's order; so the first row is the most urgent *step*, not only the nearest date.
  A sortable column header overrides it; the sort is a code in the URL (`sort`). Slice 7 adds its
  DSV items to a tier in its own PR.
