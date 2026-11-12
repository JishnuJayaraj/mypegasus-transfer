# Process & lifecycle: TG entry

### TG entry guard (`informed → active_in_tg`)

A system job checks this **on** the participant's TG start date. Each condition must have
been met **on that date** (the facts carry dates):

| Condition | Override |
|---|---|
| `dsvFullyExecuted` (participant, customer and TG signatures) **and** the DSV track `dsv_signed` (Q97: both must agree; inconsistent data stays `informed` and is never repaired automatically) | **none** — no employment without the written contract (§623 BGB) |
| ASU registered **with proof**, any channel (Q55), required before transfer into the beE by §111(4) Nr. 4 SGB III | **none** — the profiling exception does not extend to the ASU |
| `profilingStatus = profiling_done` (TL 407 signed by participant and profiler) **or** an **approved** profiling exception (Q80) | the approved exception itself is the alternative |

TL 407 **submission** to the Agentur is not part of the guard (Q54).

If the guard fails, the participation stays `informed` and appears in the PL's "what's missing"
list. Guards marked "none" can't be overridden by anyone, and since round 7 (Q71) **no
documentary or contractual guard is overridable at all**.

**Entry after the planned date** (Q68, round 8) — three cases, never backdating on evidence
created later:
1. **The scheduled job didn't run**, but every prerequisite was valid for the TG start and
   already **recorded before that day's originally scheduled run time**: the next run **catches
   up automatically** with the `system` actor and the original TG start as effective date
   (audit detail `scheduled_entry_catchup`). This is reliability recovery, not late entry.
   - Automatic entry always uses a **snapshot as of the scheduled run** (facts store
     `recordedAt` timestamps). If the scheduled run **completed** and the guard failed, the
     start date is never reconsidered automatically, even if evidence arrives later that day
     (round 9).
2. **Evidence was recorded later** but proves that every requirement already existed on the TG
   start date: the PL performs an **audited reconciliation** (reviewed after the fact by
   regional operations management, Q80; as built: "The reconciliation and its review as built
   (7-6)", below).
3. **A prerequisite actually arose after the planned start:** the PL records a new,
   contractually valid start date on the participant's page (see "Changing them" under TG
   sub-status periods): today at the earliest, tomorrow once today's entry run has completed, never after the wave's latest entry
   date; once the DSV is signed with its fully executed amendment; and only as a direct
   transition (the former employment ends exactly the day before, else `ba_review_required` or
   an overlap refused). The derived `tg_start_missed` flag clears, and the next due run may
   enter the participation with valid facts.

The application records the effective employment date; it doesn't create the employment
relationship.

**Profiling exception** *(Q17, Q60, Q74, Q80, Q81)*: if profiling wasn't possible before entry
into the beE, the **PL** requests an exception for a documented, justified case, with one of the
reason codes `participant_prevented_documented`, `agentur_scheduling_unavailable`,
`force_majeure`, `ba_confirmed_other` (the last with who at the BA confirmed it, and when). Every
code needs supporting evidence or a BA reference, stored separately (encrypted once available);
free text is special category (Q66). It can't be requested after `profiling_declined`.
- **Second-person approval before it counts:** a `regional_operations_manager`, who must be a
  different user from the requesting PL, approves it. Only an approved exception satisfies the
  TG entry guard. It is a planned compliance exception, not break-glass.
- It may be revoked before TG entry; after entry it is closed by completing profiling, never
  silently revoked.
- Profiling must reach `profiling_done` within **1 month of TG entry**; a refusal or a miss is
  an immediate compliance escalation and changes the Transfer-KuG outcome (below), but doesn't
  end the employment.

### Employment vs. Transfer-KuG eligibility *(verify, Q74, Q82)*

The domain keeps two things apart:
1. the participant's **employment in the beE/TG** (`active_in_tg` from the TG entry date to the
   exit date), and
2. **eligibility for Transfer-KuG** for a given period.

Each period has one of three outcomes: **`eligible`**, **`excluded`**, **`ba_review_required`**
(Q82):

| Situation | Outcome |
|---|---|
| profiling done before entry | `eligible` from the TG entry date |
| approved exception, profiling completed within 1 month | `excluded` from entry through the completion date; `eligible` from the day after (BA Fachliche Weisungen) |
| approved exception, profiling not yet completed, deadline running | `excluded` from entry, open |
| profiling refused before completion | `excluded` from the **TG entry date** (not the refusal date), open |
| one-month deadline missed | `ba_review_required` from entry; later completion doesn't clear it |

Only a recorded BA/legal determination may clear or alter an excluded period after a deadline
miss. Employment is never ended automatically by a refusal or a deadline miss. Affected periods
are blocked from any Transfer-KuG export. The application reports facts and decisions; it
doesn't issue a legal benefit determination. KuG billing itself is outside the MVP.

### The reconciliation and its review as built (7-6)

*(Q68 case 2 confirmed; Q80 assumed; Q216 accepted; readings Q231; Q220 stays open.)*

**Who and when.** "Eintritt nachträglich erfassen" (`GET`/`POST /participations/{id}/tg-entry-reconciliation`)
is the project's PL's, for a `ta_tg` participation still `informed` with a signed DSV, after its
effective TG start, or on it once that day's lifecycle run completed (the guard `tg_start_date`, kind
`reconciliation`, with the injected clock and the day's `job_run`). It is in the page header's actions
and on the entry clarification's card, by its capability.

**The evidence.** Every entry fact valid **on the TG start** though recorded later: the counting
complete packet of the signed offer (the earliest valid), the current ASU registration with a usable
proof, and the TL 407 that supports `profilingDoneOn` or, when that came later, the approved
exception. The dialog lists each with the day it is valid from and when it was recorded, presets
nothing and needs the PL's confirmation; it keeps the evidence and the status version it opened with.
Under the participation's lock the status service checks the permission, the status version (`409
stale_status`), the guards (`422` with the failed guards) and recomputes the evidence: a different
record or day is `409 source_changed`. A fact valid only after the TG start is refused: no entry is
backdated on later evidence and no other day is invented (Q216); the third case (a new start with its
amendment) stays the path for that.

**One transaction.** `reconcile_tg_entry` writes one `tg_entry_reconciliation` row (the evidence's
kinds, record ids, days and recording instants; the confirmation; the PL; the effective date, which is
the TG start) and the status change through `apply_status_change` (entry kind `reconciliation`,
flagged for review), and checks the packet again as 7-3 built it (`source_changed` when the packet
named isn't a counting one of that day; `evidence_after_tg_start`). The status function refuses a
`reconciliation` entry without its row (`reconciliation_missing`), whoever calls it. The audit event
`tg_entry_reconciled` (history stream `case`) carries the effective date and the evidence kinds.

**The review** (Q80, Q216). Each reconciliation is in "Freigaben" for the regional operations
managers of the project's region (`POST /reconciliations/{id}/review`), never the PL who reconciled
(`four_eyes`, also when one person holds both roles), due the next business day (Monday to Friday,
informational, never a deadline). The queue shows the project, the TG start, the evidence's kinds
with their valid and recorded days and the review's steps; no participant name or id, no file.
`requested` takes `no_objection` (closed) or `clarification_requested` with `evidence_unclear`,
`date_unclear` or `other_documented` and a documented source line (Q209's rules). The PL replies on the
tab "DSV" (`POST /reconciliations/{id}/reply`: `evidence_supplemented`, `explained`,
`correction_requested` and a source line; supplementing evidence happens through its own operations).
After a reply the manager records `resolved_no_objection` ("Erledigt"), `escalated_to_dpo` ("An DSB
eskaliert") or asks again; an escalation stays open until the manager records `resolved_no_objection`
on the DPO's documented instruction. Every outcome but `no_objection` names its source. Every step is
kept (`tg_entry_reconciliation_step`); every write compares the revision read under the lock (`409
stale_reconciliation`); the manager's review takes the project's exclusive lock. From the first
request until it is resolved the PL's work list has "Rückfrage zum Eintritt"
(`reconciliation_clarification`). Nothing reverses the entry; a wrong entry is corrected only
through what Q220 and Slice 8 provide. The events `reconciliation_reviewed` and
`reconciliation_replied` are in the `review` stream (never in a history), codes only.
