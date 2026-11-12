# Process & lifecycle: dates

## Dates

- Legal and calendar dates (signing deadline, TG start/end, exit date, ASU due date, settlement
  dates) are stored as `date`, not timestamps. Timestamps (`timestamptz`) are for events
  (audit, uploads).
- **The project carries no contractual dates** (Slice 2): they live on its entry waves. A
  project is `draft` (setup, import, creation; no post-creation lifecycle transition) until it is
  activated once its blockers are gone, then `active` (Q98).
- **Draft and active**: a draft project takes project data, the Project
  Agentur, pins, overrides, waves, import, creation along the creation edge, wave assignment,
  person data and individual dates, but **no post-creation lifecycle transition**, manual or
  system: the status service refuses it (`project_not_active`), the database function refuses it
  too, and the nightly job plans nothing for a draft project. The PL activates the project
  (`POST /projects/{id}/activation`) once `projectActivationBlockers` is empty: a pinned
  Project-Agentur template (Q76, Q90) and, in `ta_tg`, a wave with a `latestEntryDate` (Q77).
  Agentur-submission blockers never block activation; they come back as warnings with their
  Agentur and step (Q91, Q92). Activation is one-way; the type and the Project Agentur are fixed
  from then on (Q98).
- **Editing a project** (Q98): name and customer change any time; the type only while the project
  is `draft` and has neither participations nor waves (`project_not_draft`,
  `project_has_participations`, `project_has_waves`).
- **TG start and end are per participation**, defaulting from the participation's entry wave (Q18, Q79). TL 407 needs
  both ("voraussichtliche Verweildauer in der beE von/bis").
- **ASU due date** *(verify, Q1; corrected 2026-10-24, Q178)*: the two branches of §38(1)
  SGB III, where `endDate` is the end of the old employment and `knowledgeDate` is when the person
  learned of it. The reference date is `endDate − 3 months` (to subtract months, clamp to the last
  day of the target month: 31.05. → 28./29.02., 31.12. → 30.09.). Knowledge on or before the
  reference date → due on the reference date; knowledge after it (less than three months before
  the end) → due 3 days after the knowledge. The earlier unconditional `max(endDate − 3 months,
  knowledgeDate + 3 days)` is wrong (end 30.06.2027, knowledge 29.03.2027: due 30.03.2027, not
  01.04.2027); `asuDueDate` (`packages/domain/src/dates.ts`) follows the two branches since Slice 6
  (PR 6-4a) and names the branch. Without a knowledge date the due date is unknown: the reference
  date is only an orientation, never an overdue finding. Calendar, boundary, weekend/holiday and
  unusual cases stay under Q1.
- **The knowledge date** (`knowledgeDate`, `participant_details`, `personnel_file`, confidential) is
  the individual's fact: an optional import target and the PL's audited correction on the tab
  "Arbeitsuche" (`set_knowledge_date`, `knowledge_date_set` without the date; not after today;
  `409 stale_value` against the date read), never inherited from a wave or a project (Q201).
- **Signing and entry deadlines come from the Sozialplan / DSV / entry wave** (Q69), never from
  an Agentur template and never invented by the system.
- **Entry waves** (Q79): every `ta_tg` project has **one or more entry waves**, each with a
  name/code, `signingDeadline`, default TG start and end, and **`latestEntryDate`**. Each
  participation belongs to **exactly one wave before its DSV is offered**; individual
  contractual dates may override the wave defaults, with audit. An active `ta_tg` project needs
  at least one wave with a `latestEntryDate`, otherwise it stays draft (Q77). The project's final
  entry date (the latest wave cutoff) is derived, for project-level reporting only.
  A wave is a **timing cohort**, not a beE and not a Transfer-KuG bucket (round 10): one beE may
  hold several waves, or a later wave gets its own beE with its own term; a later `bee_unit` /
  Transfer-KuG case is a separate entity that waves reference. `ta_only` projects have no waves
  (their cohorts are measure groups).
  - `signingDeadline` (wave): the deadline of the first DSV offer. A **re-offer** needs an
    explicit participation-level **`offerDeadline`**, no later than the wave's `latestEntryDate`
    and the planned TG start. If no contractual rule is recorded, the PL enters the deadline.
  - **`latestEntryDate`** (wave): the last possible entry into the beE, inclusive. The **final
    admission cutoff** starts the following Berlin calendar day (Q77). It **replaces the former
    "signing deadline + 90 days" grace period**.
  - Deadlines are **inclusive**: expiry happens the following day.
  - **Creating and editing waves** (Q101): only the
    PL, through `create_entry_wave` / `update_entry_wave` under the exclusive project lock, each
    with one audit event (changed keys and old/new dates, never the name). The `code` matches
    `^[A-Za-z0-9_-]{1,20}$` and is unique in the project; the `name` is 1–100 characters
    (trimmed, no control characters). The dates are ordered
    `signingDeadline ≤ defaultTgStart ≤ latestEntryDate`, `signingDeadline ≤ latestEntryDate`,
    `defaultTgStart ≤ defaultTgEnd`, and the default period is at most twelve months
    (`defaultTgEnd ≤ addMonths(defaultTgStart, 12) − 1 day`, Q102). Once in use: a
    `latestEntryDate` is never set before today and never changes once its cutoff has passed; the
    `signingDeadline` doesn't change while first offers of the wave are open; a default TG start
    that has been reached (`≤ today`) doesn't change, and a new one isn't before today while
    participations rely on it; dates are cleared only while the wave has no participation, never
    the last `latestEntryDate` of an active project. Waves aren't deleted.
  - **Assigning a wave** (`ta_tg` only, PL): while `imported`, `contacted`, `unreachable` or
    `informed` and the DSV is `not_offered`. A participation with its own `tgStart` or `tgEnd`
    keeps its wave (`individual_dates_set`, in the domain and the database function), so a wave
    change never silently changes individual contractual dates. A wave change creates no DSV
    amendment and no BA reporting task.
  - **Bulk assignment** (Slice 5): the PL assigns one wave to 1–500 participations of the work
    list, all or nothing, under the exclusive project lock: every participation passes the same
    checks first, then each gets `assign_entry_wave` (one `entry_wave_assigned` each). Any refusal
    assigns none and names every refused row's index and code; a participation already in the
    wave stays as it is (`unchanged`).

### TG sub-status periods *(provisional, Q33, Q51)*

While `active_in_tg`, a participation has **dated periods** (from, to): `active`, `sick_paid`
(first 6 weeks), `sick_krankengeld` (no KuG), `parental_leave`, `qualification`,
`temp_employment_elsewhere` (fixed-term job with a right to return).

- These are payroll records: type and dates only. Never diagnoses, never AU scans (eAU: we only
  store "AU confirmed: yes, dates").
- Visibility: back office sees the type. PL and profiler see only "abwesend" with dates.
- Transfer-KuG is limited to 12 months per person: remind the PL before `max_duration_reached`.
- **What `tgStart` and `tgEnd` mean** (Q102, accepted sample-data pilot decision in
  [round 32](../../decisions/2026-10-19-answers-round-32.md)):
  the inclusive contractual dates of employment with the Transfergesellschaft under the DSV. An
  earlier actual departure is `exitDate`. They are **not** the Transfer-KuG entitlement or funding
  period: with staged entry into an existing beE only its remaining term is funded, and the app
  never derives, shows or promises entitlement ("twelve months from `tgStart`" is never shown).
  DSV periods over twelve months are **not supported by the MVP** (not unlawful: §111 SGB III limits
  Transfer-KuG, not the contract) and are handled outside the app with their records.
- **Changing them** (Q102, Q110, Q111): only the project's PL (`PUT /participations/{id}/dates`:
  both own dates, `null` = back to the wave default, with the `statusVersion` seen). First the
  preconditions: a `ta_tg` project, a wave with a `latestEntryDate`, a non-terminal participation
  (`participation_closed`) and no open DSV offer (`dsv_offer_open`: the paper carries the old
  dates). Every rule applies to the **effective** dates (own, else the wave's): no effective
  change is `dates_unchanged`; clearing a date to a wave without that default is `start_missing`
  / `end_missing`. All refusals are listed at once.
  - **New start**: fixed once entered (`entered`). Never in the past, not today once today's entry
    run has completed, never after the wave's `latestEntryDate`, never before the participation's
    own `offerDeadline`. A missed start gets a genuinely new date. The transition from the former
    employment must be direct: `oldEmploymentEndDate` is exactly the day before the new start.
    With a gap it is `ba_review_required` for a recorded BA/legal determination, never an
    ordinary late entry; an overlap is refused (`employment_overlap`); without a recorded
    `oldEmploymentEndDate` it is refused (`old_employment_end_unknown`). The date change never
    changes `oldEmploymentEndDate` (a re-import does).
  - **New end**: never in the past. Once the DSV is signed, before entry too, it only **extends**
    (`end_not_extension`); a shortening is an early termination through the cancellation/exit
    workflow (§623 BGB: paper form). Start ≤ end and at most twelve months
    (`end ≤ addMonths(start, 12) − 1 day`).
  - **DSV amendment**: required exactly when the DSV is `dsv_signed`
    (`dsv_amendment_required`), refused before (`amendment_not_allowed`; the later offer carries
    the new dates). Kind `new_start` when the start changes (also together with the end), else
    `extension`. `fullyExecutedOn` (all original parties) is ≤ today, before the new start when
    the start changes, and ≤ the current `tgEnd` whenever the end changes
    (`amendment_not_executed_in_time`). The PL confirms the original was inspected, all parties
    signed and it is retrievable (`amendment_unconfirmed`); the original location is a controlled
    value (only `paper_personnel_file`, Q110), an optional document number, no free text.
  - The hint `new_start_needs_ba_review` is derived, never stored: a missed start where every
    allowed new start would leave a gap after the former employment.
  - Past-date corrections only through the audited Slice 7 correction/reconciliation process.
- **BA reporting** (Q102, Q111): every contractual date change creates a durable reporting task
  (`later_entry`, `planned_end_changed`, or `early_exit` for an exit before the contractual end),
  `pending` until reported through the Agentur's channel (Kug 208 for later entries and early
  exits; a changed planned residence before any newly affected month is claimed). The report is
  due before the affected monthly claim and before project closure, but neither exists in the MVP,
  so the app enforces no due date (Q207).
  `set_participation_dates` creates one task per changed effective date (`later_entry` with the
  new start, `planned_end_changed` with the new end; a change of both is one `new_start`
  amendment with two tasks) in the change's own transaction, and a database trigger creates `early_exit` with the exit date
  when a participation exits before its effective `tgEnd` or without one (`exitDate` is the last
  day of employment, Q111 f). Every task starts `pending`, and a task is never deleted.
  - **Closing a task** (D28, PR 6-6, Q207): on the overview's "BA-Meldungen" the PL or back office
    (never a consultant) records once either "Gemeldet am", the actual date the report was sent
    (not in the future, not before the Berlin day the task was created), or "Nicht erforderlich"
    with a closed reason: `agentur_confirmed_not_required`, `no_claim_month_affected` or
    `created_in_error` (a task that should never have existed). "Gemeldet am" records staff's
    confirmation that the report was sent, never its delivery or the Agentur's acceptance; no
    channel or reference is recorded yet. Each is confirmed in a dialog that names the task, with no default date
    or reason. Who and when are kept, audited `ba_report_recorded` in the `dsv` stream. A closed
    participation's task is closed the same way. The outcome is never edited: a wrong one is
    superseded by an approved correction (data-protection.md, evidence corrections), which
    invalidates any older open confirmation. As built (PR 6-8, Q209): the PL requests it on a
    closed task ("Korrektur beantragen", a reason code and the documented source); once the
    regional operations manager approves, a **linked replacement task** is created `pending`
    (same kind, date and amendment; "Ersetzt eine korrigierte Meldung") and the original keeps its
    outcome, marked "Durch Korrektur ersetzt". The original is never reopened, so a dialog still
    open for it records nothing (`already_recorded`); the replacement is closed as any task, its
    "Gemeldet am" not before the day the original obligation's first task was created (a report
    actually sent before the correction keeps its true date), through repeated corrections too.
  - **The work list** shows a pending task as the Agentur item `ba_report_pending` ("BA-Meldung
    offen", from the oldest pending task's day; also for a closed participation) to whoever reads
    the tasks. It has no due date and doesn't escalate.

### Date corrections as built (7-8)

*(Q88 assumed, Q191 accepted, Q209 accepted; readings Q232; Q220 stays open.)*

**A wrong `profilingDoneOn`** (the profiling track) is corrected only by an approved field correction
(data-protection.md, evidence corrections: date corrections): "Korrektur beantragen" beside
"Abgeschlossen am" on the tab "Profiling" (the PL), approved by the regional operations manager of the
region in "Freigaben". The corrected date is not in the future and not before the later actual
signature date of a usable accepted TL 407 (Q191). The status stays `profiling_done`; the corrected
fact is recorded at the approval: `tl407_facts` gives `profilingDone` valid on the corrected date and
recorded at the latest of the supporting scan's availability, the status change and the approval. A
scheduled entry run before the approval keeps what it saw (the snapshot rule); a later run or "Eintritt
nachträglich erfassen" uses the corrected date, so a start missed on the wrong date is reconciled
(the reconciliation as built, 7-6).

**A wrong manual `withdrawnOn`** ("Rückzugsdatum korrigieren" in the page header's actions, the PL):
not for a system withdrawal (its date is derived), not in the future, and for a withdrawal of a signed
DSV not before the cancellation's validity. The status and the end reason stay.

**A wrong DSV signature date** is superseded, never edited: "Korrektur beantragen" beside each
signature of an accepted scan on the tab "DSV" (the PL or back office), approved in "Freigaben". The
approval appends a linked replacement signature row on every accepted scan of that paper (the
contract's scans, or the cancellation's) showing the signature, with the corrected actual date,
recorded at the approval; the original row stays. `dsvSignedOn`, the packet's validity and the
cancellation's validity read the current rows (`recordedAt` the later of the acceptance or lift and
the approval), so no scheduled run before the approval counts the corrected date; the contract's
retained dates follow it. The corrected date keeps the paper's order (received not before the
participant's signature). When a corrected date no longer supports an entry already recorded (a
packet now completed after the TG entry date, a completion now after it), the PL's work list shows
"Nachweis ungültig" until the current facts support it again; it is resolved through the
reconciliation rules or the entry clarification, never repaired, and Q220 decides what else exists for
an entry that stays unsupported.
