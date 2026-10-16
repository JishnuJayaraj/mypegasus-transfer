# Decisions — 2026-10-16, round 9 (Slice 1 planning, last follow-ups)

The product owner's answer to Q84 and a correction to the catch-up reading noted in
[round 8](2026-10-16-answers-round-8.md) (PR #8). Where they differ, round 9 wins.

## Q84 — Participations without an entry wave (confirmed)

The cutoff for them is the **project's final entry date**, derived as the latest
`latestEntryDate` across all entry waves. On the following Berlin calendar day:
- `imported` → `withdrawn` / `never_contacted`
- `contacted` → `withdrawn` / `not_informed`
- `unreachable` → `withdrawn` / `no_response`

Also:
- The PL gets the project-level 14-day warning and 3-day reminder for them.
- Once a participation is assigned to a wave, that wave's cutoff applies instead.
- An `informed` participation without a wave/DSV offer stays a flagged exception and is not
  withdrawn automatically.
- A project without any valid entry-wave cutoff can't be activated (Q77).

The proposed fallback is accepted, and the temporary behaviour changes from flag-only to the
automatic Q70 withdrawals.

## DPO and legal confirmations

Q61–Q67, the retention part of Q77, Q80, Q74 and Q82 remain **pre-pilot gates**. Their
confirmation should normally change policy tables, configuration and tests, not the
architecture. **If a reviewer requires a design change, real data stays blocked until it is
implemented.**

## Correction to the nightly catch-up reading (round 8, note 1)

Evidence entered after a night's **completed** run must not cause an automatic catch-up, even
if it was entered later on the same TG start date.

- Automatic entry uses a **snapshot taken by the scheduled TG-entry run**.
- A prerequisite must be valid for the TG start **and recorded no later than that run's
  originally scheduled execution time**.
- If the scheduled run completed and the guard failed, the start date is **never reconsidered
  automatically**.
- Evidence recorded afterwards goes through **PL reconciliation** when it proves the
  prerequisite already existed.
- A prerequisite that actually arose afterwards requires a **new start date**.
- For a genuinely **missed** run, automatic catch-up is allowed only when all prerequisites were
  already recorded before the original scheduled execution time.

Therefore:
- `job_run` and the catch-up window stay.
- The last completed day is **not** evaluated again with newly entered evidence.
- Facts store **timestamps** (`recordedAt`), not only a recording date.
- Other transitions, such as DSV expiry and cutoff withdrawals, still catch up normally after an
  outage.

## Noted while applying (for review)

1. **Run time:** the check needs each day's *originally scheduled* execution time, so the
   lifecycle run is configured as a Berlin local time (`JOBS_LIFECYCLE_TIME`) instead of a free
   cron expression. The default moves from 02:15 to **04:15**: on the last Sundays of March and
   October, Berlin times between 02:00 and 03:00 don't exist or occur twice. Times in that hour
   are rejected.
2. **Project final entry date:** derived only when **every** wave of the project has a
   `latestEntryDate`. While any wave lacks one, a later date might still come, so the
   participations without a wave are flagged and not withdrawn (project flag
   `latest_entry_date_missing`).
