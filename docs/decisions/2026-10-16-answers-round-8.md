# Decisions — 2026-10-16, round 8 (Slice 1 planning, follow-ups)

The product owner's corrections to the readings noted in [round 7](2026-10-16-answers-round-7.md)
and the answers to Q77–Q83 (PR #8). Where they differ from round 7, round 8 wins.

## Corrections to round 7 "Noted while applying"

### Missed nightly run (corrects note 3): catch-up restored

Three cases:
1. **The scheduled job didn't run**, but every prerequisite was already **recorded and valid by
   the scheduled TG start**: the next run catches up automatically, with the `system` actor and
   the original TG start as effective date. Recorded as a distinct audit detail
   (`scheduled_entry_catchup`). This is reliability recovery, not "automatic late entry".
2. **Evidence is recorded later** but proves the requirements already existed on the TG start
   date: the PL performs an audited **reconciliation**.
3. **A prerequisite actually arose after the planned start:** no backdating; the PL records a new
   contractually valid start date.

The catch-up window and `job_run` are restored. A scheduler outage must not create manual work
when all evidence was already recorded and valid.

### Free-text reasons (note 4): confirmed

- Slice 1 stores reason codes only.
- The domain defines and classifies health-related codes, but the status function refuses to
  persist `long_term_illness_reduced_earning_capacity` until encrypted storage exists.
- Profiling-exception, override and break-glass free text is deferred until encrypted storage
  exists.
- Free text is never logged.

### Missing Agentur template (note 5): confirmed, with one qualification

Base defaults contain nationwide rules, the allowed channel values and the official form
requirements. They contain **no default** for an Agentur's submission channel, batch channel,
`originalRequired`, `leadTimeDays` or `rejectsOutdatedFormVersions`.

A temporary setting (while no template exists) must be:
- **scoped to that Agentur within the project**,
- recorded with **source, confirmer and confirmation date**,
- audited.

It must never be a project-wide value that silently applies to every placement Agentur.

### Four-eyes review (corrects note 2)

- **Break-glass:** review after the fact, by the next business day.
- **Reconciliation:** review after the fact, by the next business day.
- **Profiling exception:** **second-person approval before** it can satisfy the TG entry guard.
  It is a planned compliance exception, not break-glass.
- The approver must be a different staff user from the PL who created the exception.

## Q77 🔒 — Replacement for the 90-day grace period (operational part confirmed)

The contractual **entry-wave `latestEntryDate`** replaces the grace period.
- The date is inclusive; return arrows stay available through that date.
- The final admission cutoff starts the following Berlin calendar day; cutoff withdrawals run on
  that day with the existing precedence rules.
- Every active `ta_tg` project needs at least one entry wave with a `latestEntryDate`; without
  one it stays draft and can't be activated.
- Existing incomplete data without a cutoff is flagged; nothing moves or is deleted
  automatically.

Non-signers: the deletion clock starts at **`withdrawnOn`**, manual or automatic withdrawal
alike. Proposed period: **90 calendar days after withdrawal**, provided there was no fully
executed DSV, funded §110 participation, legal hold or other retention duty. Evidence from
funded measures follows the evidence-set rules. **The 90-day period stays `assumed` and `unset`
in executable retention configuration until the DPO confirms it.**

## Q78 — Warning period (confirmed)

- **14 calendar days** before the cutoff, persistent until resolved.
- A **final reminder 3 days** before the cutoff.
- A project or wave activated fewer than 14 days before the cutoff is warned immediately.
- The warning is informational, not an approval guard: at the cutoff the withdrawal runs.

## Q79 — Entry waves (confirmed)

Multiple entry waves are a normal requirement. Each `ta_tg` project has **one or more entry
waves** with name/code, signing deadline, default TG start and end, and `latestEntryDate`.
- Each participation belongs to **exactly one wave before its DSV is offered**.
- Individual contractual dates may override wave defaults, with audit.
- Cutoffs, warnings and withdrawals are evaluated against the participation's wave.
- The project's final entry date is derived (the latest wave cutoff) and used only for
  project-level reporting.
- Reflected in Slice 1's domain model now, with a minimal `project_entry_wave` table rather than
  cutoff semantics on `project`.

## Q80 🔒 — Regional operations management (assumed until DPO confirmation)

A new org role **`regional_operations_manager`**, region-scoped, without ordinary participant
access. It may:
- approve profiling exceptions before entry;
- review reconciliations and break-glass events;
- see audit metadata, structured reason codes and necessary dates;
- request clarification from the PL.

It may not browse case files, section C, health fields or signed documents through this role.
Four-eyes means actor and reviewer are different staff users. The DPO gets oversight reports but
is not the operational reviewer.

## Q81 — Profiling-exception reason codes (confirmed)

`participant_prevented_documented`, `agentur_scheduling_unavailable`, `force_majeure`,
`ba_confirmed_other`.
- Every code requires supporting evidence or a BA reference.
- `ba_confirmed_other` requires who at the BA confirmed it, and when.
- Detailed evidence is stored separately and encrypted once that exists.
- `participant_prevented_documented` deliberately doesn't reveal illness in the status record.
- No `late_joiner` (being late isn't a justified exception), no `profiler_capacity` (provider
  capacity isn't an acceptable default basis), no unrestricted `other` without BA confirmation.

## Q82 🔒 — Transfer-KuG exclusion (verify until the BA process owner / legal confirm)

Entry under an approved profiling exception:
- Employment may begin on the contractual TG entry date.
- The period from TG entry through the profiling completion date is **excluded**.
- Eligibility begins no earlier than the day after profiling is completed.
- If profiling is refused before completion, the exclusion stays anchored at the **TG entry
  date**, not the refusal date.
- If the one-month deadline is missed, the status becomes **`ba_review_required`**; later
  completion doesn't clear the excluded period automatically.
- Only a recorded BA/legal determination may clear or alter an excluded period after a deadline
  miss.
- Employment isn't ended automatically by a refusal or a deadline miss.

Three outcomes, not a boolean: **`eligible`**, **`excluded`**, **`ba_review_required`**.
Affected periods are blocked from any future Transfer-KuG export. The application reports facts
and decisions; it doesn't issue a legal benefit determination.

## Q83 — `ta_completed` and profiling (confirmed)

Not universally: §110 allows different kinds of Transfermaßnahmen. `profiling_done` is required
only when profiling is part of the approved measure plan, assigned to the participant, or
required by the resolved project configuration. The general `ta_completed` guard:
- every assigned required §110 activity is completed or formally closed;
- required evidence is present;
- the PL confirms closure.

Slice 1 evaluates a generic **`taMeasuresComplete`** fact instead of hard-coding
`profiling_done`.

## Noted while applying (for review)

> Note 1 was corrected and note 5 (Q84) answered in [round 9](2026-10-16-answers-round-9.md).

1. **Catch-up window:** the nightly run on day D evaluates TG starts from the date of the last
   completed run through D (that day is looked at once more). So evidence recorded later on the
   start day itself, after that night's run, is still caught up the next night. Automatic entry
   needs every prerequisite **valid on** the TG start (`validFrom ≤ tgStart`) **and recorded
   by** the end of that Berlin day (`recordedOn ≤ tgStart`); otherwise it's case 2 or 3.
2. **The profiling exception counts for automatic entry only if its approval was recorded by the
   TG start date** too. An approval after the start date makes the prerequisite one that arose
   later (case 3), not a reconciliation.
3. **Requesting an exception needs its evidence or BA reference** (Q81). There is no evidence
   storage in Slice 1, so the request guard fails closed until Slice 4b (D4); the domain tests
   cover it with explicit facts.
4. The Slice 0 project date columns (`signing_deadline`, `default_tg_start`, `default_tg_end`)
   are carried into one entry wave per existing project by the Slice 1 migration. The domain uses
   wave dates only; Slice 2 moves the project form to waves and drops the old columns.
5. **New gap, Q84:** participations not yet assigned to a wave (wave assignment is required only
   before the DSV offer) have no cutoff of their own, so the Q70 withdrawals (`never_contacted`,
   `not_informed`, `no_response`) have no date to run against. Until answered, they are flagged
   and not withdrawn.
