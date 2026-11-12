# Slice 8 — TG module basic (F9)

Status: **proposed**, waiting for the product owner's approval. No implementation before it.
New questions Q241–Q253, each with a proposed answer; none is an external DPO, legal, payroll or
Agentur confirmation.

Roadmap: participant file, coaching notes, goals/tasks, qualification plan, applications, exit;
from prd.md F9 also the sub-status periods with their payroll CSV.
Builds on: the edge `active_in_tg → exited` with its roles (Q60) and the status service
(`apply_status_change`, effective dates; process-and-lifecycle.md, Rules), the end reasons with
their phase and the correction of the primary reason (`correctEndReason`), the database trigger
that creates the BA reporting task `early_exit`, "BA-Meldungen" and the evidence corrections
(field targets), the consultation slots of Slice 5b (bookable while `active_in_tg`), the documents
with their catalog (version 10; `qualification_certificate` exists), field encryption and the
logged sensitive endpoints (Slice 4a), the export links and `Exporter` (ADR-0006), the work list
with deadlines, case items and `nextStep`, the participant page and the portal home
(ui-patterns.md), the retention rules per class with the evidence-only trigger and the erasure
order (data-protection.md, retention as built).

## What each user does in the TG phase

The slice is one question per user, answered on one screen each. Nothing below adds a role.

| User | Day-to-day job in the TG | Where |
|---|---|---|
| Berater / Coach (assigned) | prepares a session ("what did we agree, what is open"), writes the note, sets goals and tasks, follows applications, plans qualification, records the exit | participant page: tabs "Coaching", "Bewerbungen", "Qualifizierung"; "Aktionen → Austritt erfassen"; the work list's quick view "Meine TG-Aufgaben" |
| PL | sees who is in the TG, whose contract ends soon, which approvals and exits are open; requests and records qualification approvals; records exits; watches BA reports | dashboard group "Transfergesellschaft", work list quick views, the same tabs (without note texts) |
| Back office (the user's "Verwaltungskraft", Q253) | records absences, issues the monthly payroll CSV, records actual qualification cost, files the termination paper, closes BA reports | card "Abwesenheiten", project page "Abrechnung → Lohnexport", "Qualifizierung" (cost), tab "DSV" (termination paper), "BA-Meldungen" |
| Participant | sees and ticks own tasks, sees goals and planned courses, keeps the list of own applications, books coaching appointments | portal: "Meine Aufgaben", "Meine Bewerbungen", "Qualifizierung", "Termine" (as built) |
| Regional operations manager | approves a corrected exit date (four eyes), from metadata | "Freigaben" (as built) |
| Regional admin / admin | nothing: no case data | — |

## Decisions

### Scope

- **D1. In Slice 8:** exit and early termination (8-1, 8-2); absences and the payroll CSV (8-3);
  goals and tasks (8-4); coaching notes (8-5); applications with interviews and trial work (8-6);
  qualification activities with approval, cost and certificate (8-7); the TG view of the
  participant page, the work list and the dashboard, and the timeline's stage 2 (8-8). Only
  `ta_tg` participations from `active_in_tg` on have any of it; `exited` ones read-only (D5).
- **D2. Not in Slice 8:** payroll, the Lohnkonto, payroll master data exports and KuG billing
  (outside the MVP; prd.md, out of scope); showing Transfer-KuG eligibility periods or recording
  BA determinations (Q74, Q82 `verify`, Q86 `open`; no KuG export exists); AI of any kind (CLAUDE.md
  rule 7), so no note summaries, CV generation or job matching; the customer's monthly export with
  the beE exit date, placements and the integration rate (Slice 9; Slice 8 only stores what it
  reads); a qualification approval request sent to the customer from the app (Q250); §110 measure
  activity records of `ta_only` projects and funded-measure evidence (Q169 `verify`); narrative
  health detail and its explicit consent; break-glass (so a PL never reads a note's text);
  absences and note-derived data in work-list rows (Q85 `open`); absences in the portal;
  automatic messages to participants about tasks or courses (Q152: one reminder policy, manual);
  a reversal of an exit (Q243); new roles (Q253); an e-signature for any termination paper
  (rule 4).

### Exit and early termination (8-1, 8-2)

- **D3. One route, the single status function** (process-and-lifecycle.md, Rules; rule 5):
  `POST /participations/{id}/exit` by the PL or the assigned consultant (Q60), never back office.
  `record_exit` locks the participation, calls the internal `apply_status_change`
  (`active_in_tg → exited`, actor `user`) and writes the placement details in the same transaction;
  the audit event is the status change's. The request carries the reason, `exitDate`, the placement
  details where they apply, the `statusVersion` read and the confirmation of a dialog that names the
  participant; nothing is defaulted. Rules, in the service after the lock and in the database:
  `exitDate` is the last day of employment (Q111 f), not in the future, not before `tgEntryDate`
  (both as built) and **not after the effective `tgEnd`** (`effective_date_after_tg_end`: the
  contract has ended by then); `max_duration_reached` only with `exitDate` = the effective `tgEnd`
  (`reason_date_mismatch`; Q244). A terminal status revokes codes, ends sessions and cancels live
  bookings as built.
- **D4. No new guard is invented.** The transitions table has no guard on the exit, and the docs
  don't say which paper ends the TG employment per reason (Q241). Slice 8 therefore records and
  tracks the paper and never blocks a true exit on it: a document type `tg_termination` (kind
  `termination_agreement`, `participant_notice`, `tg_notice`; category `employment_contract`, PL and
  back office add, review and open, as the DSV cancellation; wet ink, a scan and the original's
  location, never an e-signature), and for an exit before the effective `tgEnd` with a reason other
  than `deceased` the case item "Beendigungsnachweis fehlt" until an accepted one exists. If Q241's
  answer makes it a documentary guard, it becomes one in the status function without override
  (Q71) in a follow-up PR.
- **D5. After the exit the TG records are read-only**, except: the placement details and the
  reason through their correction (D8), the termination paper, a qualification's actual cost,
  outcome and certificate (invoices and certificates arrive later), absences by back office (the
  last payroll month), and the BA reporting tasks as built. Open tasks and goals stay as they are
  (no fabricated outcome). Everything ends with the evidence-only phase (its trigger refuses).
- **D6. The BA reporting task `early_exit`** is created by the existing trigger for an exit before
  the effective `tgEnd` or without one, with the exit date, `pending`; an exit on the `tgEnd`
  creates none (process-and-lifecycle.md, BA reporting). Slice 8 adds no channel, form or due date
  (Q207); the exit dialog says "Erzeugt eine BA-Meldung (vorzeitiger Austritt)" before saving.
- **D7. Placement details** (process-and-lifecycle.md, exit and withdrawal reasons): `contractType`
  (`full_time`, `part_time`), `fixedTermMonths`, `tempAgency`, `backToFormerGroup`, `startDate`, an
  optional new employer (one line, no contact person). Required for `placed_permanent` and
  `placed_fixed_term` (`fixedTermMonths` only for the latter); `startDate` alone optional for
  `self_employed` and `apprenticeship_or_study`; refused for every other reason (Q244). Never in a
  list, never customer-visible (`customerVisible` stays the whitelist: of the exit only `exitDate`;
  rule 6; a test holds it).
- **D8. Corrections, never edits.** The primary reason of an `exited` participation through the
  existing correction (`PUT /participations/{id}/end-reason`, the PL; the previous reason in the
  history), which now also takes the placement details of the new reason. A wrong `exitDate`
  through the evidence correction's field target (Q88: PL or back office requests, the region's
  manager approves, four eyes; data-protection.md, evidence corrections), with D3's date rules; an
  approved correction that moves the date across the effective `tgEnd` creates the missing
  `early_exit` task or leaves a closed one to its own correction, never deletes one. A terminal
  status is final: no edge reopens an exit recorded for the wrong person (Q243, blocks the pilot).
- **D9. The health-related reason becomes storable, protected**
  (`long_term_illness_reduced_earning_capacity`: special category, category `health`, never in
  ordinary lists; data-protection.md, classification): the participation row stores no reason but
  `end_reason_protected = true`; the value is field-encrypted in `protected_end_reason`, served
  only by its own logged endpoint (`sensitive_read`) to whoever reads `health` (the assigned
  consultant). Everyone else who reads the reason sees "Geschützter Grund"; the status event's
  reason is empty with the flag, and no log, list, export or audit detail carries the value. Who
  records it is Q242; fail-safe until answered: the assigned consultant only. Its secondary-reason
  use stays refused.
- **D10. A planned exit is a note to self, not a status** ("Austritt vormerken", PL or assigned
  consultant): `exit_plan` holds the planned last day (in the future, not after the effective
  `tgEnd`), the planned reason (never the protected one) and placement details; changed or
  withdrawn against the revision read. It changes no status, creates no BA task and is not
  evidence. From the planned day the row shows "Austritt erfassen" with the dialog prefilled for
  confirmation; the exit itself is D3's, with every rule checked again.
- **D11. The contract's end is a deadline, never an automatic exit.** `DeadlineKind` gains `tg_end`
  (while `active_in_tg`: the effective `tgEnd`, the 14-day horizon as every deadline; overdue reads
  "Austritt erfassen") and `planned_exit` (the planned day). The system never exits a participation:
  the reason on the last day is staff's knowledge (Q243). The PRD's reminder before
  `max_duration_reached` is this deadline; the profiling exception's reminder is the existing
  `profiling_exception` deadline.

### Absences and the payroll CSV (8-3)

- **D12. Absence periods are payroll records: type and dates only** (process-and-lifecycle.md, TG
  sub-status periods; Q33, Q51): `absence_period` with `sick_paid`, `sick_krankengeld`,
  `parental_leave`, `qualification`, `temp_employment_elsewhere`; `active` is the absence of a
  period and never stored. `from` ≥ `tgEntryDate`, `to` open or ≥ `from` and ≤ the exit date or the
  effective `tgEnd`, no overlap per participation (exclusion constraint), and "AU bestätigt"
  (yes/no) for the two sickness types (eAU). No diagnosis, no free text, no document. Back office
  alone writes (data-protection.md, write permissions), against the revision read; a wrong period
  is voided with a reason code (`entered_in_error`, `wrong_person`), never deleted.
- **D13. Who sees what** (data-protection.md, access matrix): back office the type and dates; the
  PL and the assigned consultant "abwesend" with dates through their own projection (the type
  never leaves the API for them); nobody in a list (Q85); the audit detail names the operation,
  never the type or a date.
- **D14. The payroll CSV** (prd.md F9; Q8): export kind `payroll_absences`, by back office of the
  project, for one calendar month, through the logged export link (`POST /exports/{kind}`, 60
  seconds, `export_created`) and `Exporter` with a versioned column set `payroll-absences:v1`:
  Personalnummer, last name, first name, type, from and to clipped to the month, AU bestätigt. No
  amount, no KuG outcome, no billing logic. The columns and cadence payroll needs are Q246; a
  change is a new version.

### Coaching: goals, tasks and notes (8-4, 8-5)

- **D15. Goals and tasks are the participant's and the coach's shared list**: `coaching_goal`
  (title, optional target date, `open` / `achieved` / `dropped`) and `coaching_task` (title, due
  date, owner `participant` or `consultant`, optional goal, `open` / `done` / `dropped`). Titles are
  one line (200 characters); the form says "Für Teilnehmer·in sichtbar – keine Diagnosen". The
  assigned consultant and the PL write them; the participant reads all and marks an own task done
  or open again in the portal (not a lifecycle transition; Q248). Back office none.
- **D16. Coaching notes: metadata apart from the text** (rule 9). `coaching_note`: the date, the
  contact kind (`in_person`, `phone`, `video`, `written`), topic codes (`orientation`,
  `application_documents`, `job_search`, `interview_preparation`, `qualification`,
  `personal_situation`, `other`), an optional consultation booking, the author. The text is
  field-encrypted in `coaching_note_content` and treated as **special category** because free text
  may disclose illness (the rule for free-text reasons, Q66): never in a list payload, log, audit
  detail, export or job payload; one logged endpoint per note. The assigned consultant writes and
  reads notes (the current assignee reads the earlier ones); the PL reads the metadata only; back
  office, org roles and the participant nothing (Q247). The author changes an own note while the
  participation is `active_in_tg` (revision compared, `coaching_note_changed` without content, no
  old text kept); the author or the PL voids one with a reason code. The form repeats: no
  diagnoses, no details of third persons.
- **D17. Coaching appointments are the consultation slots as built** (Slice 5b); a note may name
  the booking it documents. No second appointment model.

### Applications (8-6)

- **D18. One list both sides keep** (`job_application`: employer, position, applied on, state
  `planned`, `sent`, `interview`, `trial_work`, `offer`, `accepted`, `rejected`,
  `withdrawn_by_participant`; `job_application_step`: `interview`, `trial_work`, `offer` with its
  date or period and an outcome code). The participant adds and updates own applications in the
  portal; the assigned consultant and the PL add and update as themselves (each row keeps who
  created and last changed it). No file on an application: a CV stays a document. Back office
  none. **Trial work is a record, nothing more** (Q251): no absence period, BA task or payroll
  consequence is derived. An `accepted` application offers "Austritt vormerken" prefilled with its
  employer and start date; nothing happens by itself.

### Qualification (8-7)

- **D19. Activities** (`qualification_activity`; process-and-lifecycle.md, phase 2 detail; Q23):
  title, provider (name, AZAV `yes` / `no` / `unknown`), planned start and end, planned cost,
  `fundingSource`, the approval, later the actual cost with an invoice reference, the outcome
  (`completed`, `not_completed`, `cancelled`) and the linked `qualification_certificate` document.
  The displayed state is derived (geplant, Genehmigung angefragt, genehmigt, abgelehnt, läuft,
  abgeschlossen, abgebrochen, abgesagt). `fundingSource` is a controlled list whose values are
  Q249 (proposed: `customer_budget`, `agentur`, `esf`, `participant`, `other`); a nationwide enum,
  not an Agentur rule (rule 2).
- **D20. Approval is recorded, in writing, outside the app** (Q23): the assigned consultant or the
  PL plans; the PL alone records `requested` and the decision (`approved` / `rejected` with the
  decision date and the approver kind `customer_budget_owner` or `agentur`), with the written
  approval as a `qualification_approval` document (PL and back office; required for `approved`
  when a cost is planned, Q249). `not_required` only without cost. Not a lifecycle guard: an
  activity that starts unapproved shows the case item "Genehmigung fehlt" from its start day. The
  app sends nothing to the customer and prints no request naming a person (rule 6; Q250, blocks
  the pilot).
- **D21. Cost is back office's and the PL's**: the consultant sees the activity without amounts;
  the participant sees title, provider, dates and state in the portal, never cost, funding or
  approval. Back office records the actual cost and invoice reference; the certificate stays
  `personnel_file` with its participant-owned operations, and back office reads its metadata, not
  the file (Q252).

### Cross-cutting

- **D22. Access: visibility, then permission, then state**, in `decideAccess` with new categories
  and a generated-matrix column each: `coaching` (goals, tasks, applications, note metadata),
  `coaching_note` (the text), `qualification`, and `absence` decided for its projections.

  | Data | Consultant (assigned) | PL | Back office | Participant (portal) |
  |---|---|---|---|---|
  | Exit: date, reason, placement | records, reads | records, reads, corrects | reads date and reason; requests a date correction | — (sessions end) |
  | Protected reason | reads (logged); records | "Geschützter Grund" (Q242) | "Geschützter Grund" | — |
  | Termination paper | — | add, review, open | add, review, open | — |
  | Planned exit | read, write | read, write | read | — |
  | Absences | "abwesend" + dates | "abwesend" + dates | type + dates, writes | — |
  | Payroll CSV | — | — | issues | — |
  | Goals, tasks | read, write | read, write | — | reads; marks own tasks |
  | Note metadata / text | read, write / read (logged), write | read / — | — / — | — / — |
  | Applications | read, write | read, write | — | read, write own |
  | Qualification | plans, without amounts | plans, approval, amounts | reads, actual cost | title, provider, dates, state |

  An unassigned consultant and the org roles get nothing; a hidden participation or record is
  `404`, a visible one without the permission `403`, then the state (`participation_closed`,
  `evidence_set_phase`). Assisted mode and break-glass grant none of the new operations.
- **D23. Retention: classes mapped to the settled triggers, no period invented** (rule 10;
  ADR-0008; every period stays `unset`, activation off). A TG record exists only after entry, so
  its trigger is `exited`. Proposed mapping, to verify as Q252:

  | Class | Tables and document types | Settled rule it follows |
  |---|---|---|
  | `personnel_file` | `exit_placement`, `exit_plan`, `coaching_goal`, `coaching_task`, `coaching_note` (metadata), `job_application`, `job_application_step`, `qualification_activity`; documents `tg_termination`, `qualification_approval` | TG personnel file and placement data: the end of the 3rd calendar year after exit (Q105) |
  | `health_record` | `protected_end_reason`, `coaching_note_content` | structured health fields: 3 months after beE exit (Q141), as the fail-safe for special category |
  | `payroll_record` (new) | `absence_period` | "payroll retention" (Q51) names no trigger or period: `unset`, not applied by the job, reported |

  Each PR adds its tables to the evidence-only trigger, the class deletions, the erasure order and
  `erasureRetainedDependencies`, and classifies its audit detail keys (data-protection.md,
  stage-two erasure); the existing schema tests fail otherwise. `payroll_record` data outside the
  evidence set keeps a participation out of the evidence-only phase until it is deleted.
- **D24. Regional differences and adapters** (rules 2, 3): Slice 8 adds no Agentur setting; the
  exit rules, absence types and funding sources are the fixed core. If an answer (Q241, Q249,
  Q251) turns out Agentur-specific, it becomes template configuration in its own PR, never an
  `if` on an Agentur. External effects go only through `Exporter` (the CSV) and `FileStorage` (the
  documents); no mail or SMS is added.
- **D25. Writes go through SECURITY DEFINER functions** (ADR-0002) with their audit event in the
  transaction; `transfer_app` selects the new tables and writes none; `record_audit_event` refuses
  the new types. Lock order: the project's advisory lock (shared through `lock_participation`),
  the participation, document rows, then the slice's rows in this order: `exit_plan` →
  `exit_placement` → `protected_end_reason` → `absence_period` → `coaching_goal` → `coaching_task` →
  `coaching_note` → `job_application` → `qualification_activity`, then the BA reporting task and
  the correction row as built.
- **D26. Required scenarios**, each an integration test in its PR (agent-workflow.md §3):
  - an exit with a status version read before another change is `409`; the dialog's date and
    reason are what is stored (8-1);
  - an exit the day after the effective `tgEnd`, and `max_duration_reached` a day early, are
    refused in the service and the database; an exit before the `tgEnd` creates exactly one
    `early_exit` task, one on it none (8-1);
  - the assigned consultant exits; an unassigned one gets `404`, back office `403`; a consultant
    whose assignment ended between the dialog and the save is refused (8-1);
  - the protected reason is absent from the participation row, the status event, the work list,
    the detail and the logs, and its endpoint logs each read; the PL gets "Geschützter Grund" (8-2);
  - an approved `exitDate` correction keeps the original, changes the date from the approval on and
    reconciles the `early_exit` task; the requester can't approve (8-2);
  - a second accepted termination paper, a quarantined one and a rejected one: the item clears
    only on a counting accepted one (8-2);
  - overlapping absences, one before entry and one after the exit date are refused; the PL's and
    the consultant's payloads contain no type; the CSV for a month clips a period spanning it and
    has an explicit empty `to` for an open one (8-3);
  - a participant marks another participation's task: `404`; a task of owner `consultant`: `403`;
    after exit: session ended (8-4);
  - a note's text is in no list, history, log or error; the PL's read of the text is `403`, an
    unassigned consultant's `404`; a reassigned consultant reads the earlier notes and the former
    one nothing; a change against a stale revision is `409` (8-5);
  - the participant and the consultant change the same application: the second save is `409`
    (8-6);
  - `approved` with a planned cost and no approval document is refused; the consultant's payload
    has no amount; the portal's none of cost, funding or approval (8-7);
  - with synthetic periods and test activation: `coaching_note_content` and `protected_end_reason`
    go with `health_record` while goals and applications stay; `absence_period` is reported
    `period_unset` and blocks the evidence-only phase; an erasure leaves no row of any new table
    (each PR for its tables).

## PRs

One planned PR = one branch = one PR, each based on `main` after the PRs it needs have merged
(none stacked). Estimates count changed lines without tests, generated code and docs, and already
include the retention lists every PR with a new table touches (Slice 7's PRs with redefined
functions came in at up to twice their estimate). A PR that changes the document-type catalog
takes its next version when it merges. If a PR passes about 1,500 lines while building, it says so
and the owner decides on a split. 8-8 archives this plan.

| PR | Scope | Needs | Est. lines | SQL functions redefined |
|---|---|---|---|---|
| 8-1 | Exit (D3, D5–D7, D11): the route and `record_exit`, the date and reason rules, placement details, the deadline `tg_end` with its quick view and tile, the exit dialog and the card "Austritt" | — | ~1,400 | `apply_status_change`, `record_audit_event`, the retention table lists |
| 8-2 | Exit follow-ups (D4, D8–D10): the protected reason and its endpoint, the reason correction with placement details, the `exitDate` correction, `tg_termination` (catalog 11) with "Beendigungsnachweis fehlt", the planned exit with `planned_exit` | 8-1 | ~1,500 | `apply_status_change`, `correct_end_reason`, `request_evidence_correction`, `decide_evidence_correction` (DROP/CREATE where a parameter is added), `add_document`, `review_document`, `current_document_policy`, `audit_history`, `record_audit_event`, the retention table lists |
| 8-3 | Absences and the payroll CSV (D12–D14): `absence_period`, the two projections, the card "Abwesenheiten", the export kind, the class `payroll_record` | — | ~1,300 | `create_export_link`, `record_audit_event`, the retention table lists |
| 8-4 | Goals and tasks (D15): staff tab "Coaching", the portal's "Meine Aufgaben", the item `coaching_task_overdue` | — | ~1,400 | `record_audit_event`, the retention table lists |
| 8-5 | Coaching notes (D16, D17): metadata and encrypted text, the logged endpoint, the notes in "Coaching", the link to a booking | 8-4 | ~1,200 | `record_audit_event`, the retention table lists |
| 8-6 | Applications (D18): staff tab "Bewerbungen", the portal's "Meine Bewerbungen", the prefill of "Austritt vormerken" | 8-2 | ~1,400 | `record_audit_event`, the retention table lists |
| 8-7 | Qualification (D19–D21): activities, approval with `qualification_approval` (catalog 12), cost, certificate link, staff tab, the portal's read view, "Genehmigung fehlt" | — | ~1,500 | `add_document`, `review_document`, `current_document_policy`, `record_audit_event`, the retention table lists |
| 8-8 | The TG file: the overview's "Transfergesellschaft" summary, timeline stage 2, the quick views and the dashboard group, the journey e2e, docs, this plan archived | 8-1 to 8-7 | ~1,000 | — |

8-3, 8-4 and 8-7 can be built beside the exit PRs. "The retention table lists" are
`retention_delete_class`, `retention_classes_left`, `retention_erase_participation` and the
migration that attaches `refuse_in_evidence_set_phase`.

## Design

### Domain (`packages/domain`, no I/O, no system time)

- 8-1, `src/exit/`: `exitProblem(state, input, today)` (the date and reason rules, placement
  details per reason), `placementDetailsFor(reason)`; `DeadlineKind` gains `tg_end`; `nextStep`
  ranks it as any deadline. 8-2: `protectedEndReason`, `exitPlanProblem`, `planned_exit`,
  `terminationEvidenceMissing(state, documents)`; the correction targets gain the field `exitDate`.
- 8-3, `src/absence/`: `AbsenceType`, `absenceProblem(periods, input, bounds)`,
  `absenceView(periods, viewer)` (type or "abwesend"), `payrollAbsenceRows(periods, month)`.
- 8-4 to 8-7, `src/coaching/`, `src/applications/`, `src/qualification/`: the enums, the state
  rules (`taskTransition`, `applicationTransition`, `qualificationState(activity, today)`,
  `approvalProblem`), the portal projections (what a participant gets), the work-list items.
- Access: the new categories in the field and document catalogs, `decideAccess` cells with tests
  for every cell; the generated access matrix and transitions table regenerate. 100 % coverage on
  the rules with their boundary days.

### Data model (`project_id` on every table, composite FKs to `participation`; data catalog)

| Table / change | PR | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|---|
| `participation` | 8-1, 8-2 | `exit_date ≤ tg_end` check; `end_reason_protected`; the end-reason checks admit the flag (upgrade test) | internal / `case_internal` | `participation_record` |
| `exit_placement` | 8-1 | one per exit with a placement reason: contract type, fixed-term months, temp agency, back to former group, start date, new employer | confidential / `confidential`, not listable, not customer-visible | `personnel_file` |
| `protected_end_reason` | 8-2 | the encrypted reason, key id, by/at | special category / `health` | `health_record` |
| `exit_plan` | 8-2 | planned day, reason, placement details, revision, withdrawn at | confidential / `confidential` | `personnel_file` |
| `document` (`tg_termination`) | 8-2 | the kind, the confirmed signatures and dates, the original's location (as the DSV cancellation) | highly confidential / `employment_contract` | `personnel_file` |
| `evidence_correction` | 8-2 | the field target `exitDate` | internal / `case_internal` | `participation_record` |
| `absence_period` | 8-3 | type, from, to, AU confirmed, revision, voided with reason, by/at | confidential / `absence`, not listable (Q85) | `payroll_record` (`unset`) |
| `coaching_goal`, `coaching_task` | 8-4 | D15's fields, who created and changed, the participant's own completion | confidential / `coaching` | `personnel_file` |
| `coaching_note` | 8-5 | D16's metadata, revision, voided with reason | confidential / `coaching` | `personnel_file` |
| `coaching_note_content` | 8-5 | the encrypted text, key id | special category / `coaching_note` | `health_record` |
| `job_application`, `job_application_step` | 8-6 | D18's fields, creator and last editor by kind | confidential / `coaching` | `personnel_file` |
| `qualification_activity` | 8-7 | D19's fields; the approval's status, date, approver kind and document; actual cost, invoice reference; the certificate document | confidential / `qualification` (amounts: PL and back office) | `personnel_file` |
| `document` (`qualification_approval`) | 8-7 | the written approval | confidential / `qualification` | `personnel_file` |

Amounts are integer cents. Enum values are added in their PR's generated migration and compared
as text in that migration run.

### Functions (hand-written, SECURITY DEFINER, audit in the transaction, D25's lock order)

- 8-1: `record_exit(p_context, p_participation_id, p_reason, p_exit_date, p_placement jsonb,
  p_expected_status_version)`; `apply_status_change` checks the exit's date against the effective
  `tgEnd` and the reason's date rule.
- 8-2: `record_exit` and `apply_status_change` take the protected reason's ciphertext;
  `correct_end_reason` takes placement details; the correction functions take `exitDate` and
  reconcile the `early_exit` task; `add_document` / `review_document` learn `tg_termination`;
  `set_exit_plan`, `withdraw_exit_plan`.
- 8-3: `record_absence_period`, `change_absence_period`, `void_absence_period`;
  `create_export_link` learns `payroll_absences`.
- 8-4: `save_coaching_goal`, `save_coaching_task`, `set_own_task_done` (the participant's session).
- 8-5: `save_coaching_note` (metadata and ciphertext together), `void_coaching_note`.
- 8-6: `save_job_application`, `save_job_application_step` (staff or the participant's session).
- 8-7: `save_qualification_activity`, `record_qualification_approval`,
  `record_qualification_result`.

### API (`/api/v1`, OpenAPI, RFC 9457, capabilities on every item)

- 8-1: `POST /participations/{id}/exit`; `ParticipationDetail` gains `exit { date, reason |
  protected, placement?, capabilities }`; the work list's deadline and filter.
- 8-2: `GET /participations/{id}/exit/protected-reason` (logged); `PUT .../end-reason` with
  placement; `POST .../evidence-corrections` with `correct_field { field: "exitDate" }`;
  `POST .../termination-documents`, `POST /documents/{id}/termination-review`;
  `PUT`/`DELETE .../exit-plan`.
- 8-3: `GET`/`POST /participations/{id}/absences`, `PUT`/`DELETE .../absences/{absenceId}`
  (the response shape by viewer: `type` only for back office); `POST /exports/payroll_absences`.
- 8-4: `GET /participations/{id}/coaching` (goals, tasks, note metadata), `POST`/`PUT` goals and
  tasks; portal `GET /portal/tasks`, `POST /portal/tasks/{id}/done`.
- 8-5: `POST`/`PUT .../coaching/notes`, `GET .../coaching/notes/{noteId}/content` (logged,
  `no-store`), `POST .../coaching/notes/{noteId}/void`.
- 8-6: `GET`/`POST`/`PUT /participations/{id}/applications` and steps; portal
  `GET`/`POST`/`PUT /portal/applications`.
- 8-7: `GET`/`POST`/`PUT /participations/{id}/qualifications`, `POST .../approval`,
  `POST .../result`; portal `GET /portal/qualifications`.
- 8-8: `GET /projects/{id}/dashboard` and the work list gain the TG counts and filters, one
  snapshot. Logs carry ids and codes, never a title, employer, text, amount, type or date of a
  person.

### History (projection rows, `audit_event_lifecycle_has_participation`, the refused list, a German label, each detail key's subject class)

| Event | PR | Stream | Shows |
|---|---|---|---|
| `status_changed` (`exited`) | 8-1 | `case` | date, reason or "Geschützter Grund" |
| `end_reason_corrected`, `evidence_correction_requested` / `_decided` (`exitDate`) | 8-2 | `case` | as built; the field key, never a value |
| `document_added`, `document_reviewed` (`tg_termination`) | 8-2 | `dsv` | type, kind, decision |
| `exit_plan_set`, `exit_plan_withdrawn` | 8-2 | `case` | the planned day |
| `sensitive_read` (protected reason, note content) | 8-2, 8-5 | `security` | — (never in a history) |
| `absence_recorded`, `_changed`, `_voided` | 8-3 | `payroll` (back office) | the operation only |
| `coaching_goal_saved`, `coaching_task_saved`, `coaching_task_done` | 8-4 | `case` | the state code, never a title |
| `coaching_note_saved`, `_changed`, `_voided` | 8-5 | `case` | contact kind, void reason |
| `job_application_saved` | 8-6 | `case` | the state code, never the employer |
| `qualification_saved`, `qualification_approval_recorded`, `qualification_result_recorded` | 8-7 | `case` | state, decision, outcome; never an amount |

### Web UI (`apps/web`, German; every button by its capability; ui-patterns.md)

- **Participant page**, from `active_in_tg`: the tags as built; *Stand* gains the card
  "Transfergesellschaft" (Eintritt, Vertragsende, "abwesend bis …", next coaching appointment,
  open tasks; no "Restanspruch", no KuG wording). "Aktionen": "Austritt erfassen", "Austritt
  vormerken", "Grund korrigieren". Cards: "Austritt" (after exit, with "Geschützter Grund –
  anzeigen" for whoever may), "Abwesenheiten" (back office edits in the side panel).
- **Tab "Coaching"**: "Ziele & Aufgaben" first (open tasks by due date, each goal with its
  tasks), then "Gesprächsnotizen" as a list of date, contact kind, topics and author; a text opens
  on request ("Notiz anzeigen", logged) and a new note is a side panel with the last agreements
  beside it.
- **Tab "Bewerbungen"**: a table (employer, position, state, last step, who entered it), the steps
  in the side panel; on `accepted` the hint with "Austritt vormerken".
- **Tab "Qualifizierung"**: activities with state, dates and, for the PL and back office, planned
  and actual cost with the sum; "Genehmigung erfassen", "Ergebnis erfassen", the certificate.
- **Tab "DSV"**: "Beendigungsnachweis" beside the cancellation (8-2).
- **Work list and dashboard** (8-1, 8-8): quick views "In der TG", "Vertragsende in 14 Tagen",
  "Austritt zu erfassen", "Meine TG-Aufgaben" (overdue tasks, missing approvals, missing
  termination papers); the dashboard group "Transfergesellschaft" with the same counts in one
  snapshot. Items join `nextStep`'s tiers: overdue `tg_end`, `planned_exit` and
  `coaching_task_overdue` tier 1; "Beendigungsnachweis fehlt" and "Genehmigung fehlt" tier 2.
- **Project page "Abrechnung"**: "Lohnexport (Abwesenheiten)" with the month (back office).
- **Timeline stage 2** (8-8): absences ("abwesend"; the type only for back office), qualification
  activities and coaching appointments as bars with shape and label, the list below as the
  accessible equivalent.
- **Portal** (`apps/portal`, de + en, 320px first): the home card "Meine Aufgaben" (tick, due
  date, the goal as its heading) beside "Das fehlt noch", whose count it doesn't change (C5);
  "Meine Bewerbungen" (add, change state, steps); "Qualifizierung" (read). Dialogs capture their
  target; drafts follow C4.

## Lessons (carried from Slices 5b to 7, with Slice 7's own)

- Visibility before permission before state: a hidden participation or record is `404`, never a
  `403` or `422` that reveals it. A projection that hides a value hides it in the API's schema, not
  in the UI.
- Every write compares what the user reviewed (ids, revisions, the status version) under the lock
  (`409`); dialogs capture their target; no default dates, reasons or sources; a restriction of
  the UI is enforced by the service, and a status rule by the database too.
- Every status change goes through the status function with its audit; every new audit event needs
  its projection rows, `audit_event_lifecycle_has_participation`, `record_audit_event`'s refused
  list, a history label when a history shows it, and its detail keys' subject classification.
- Every new table naming a participation joins the evidence-only trigger, its class's deletion,
  the erasure order and the retained-dependency catalog in the same PR; a row a kept row references
  is a catalogued retained dependency. Ordinary lists and counts leave out evidence-only
  participations and erasure anchors.
- A new FK, NOT NULL or check on an existing table needs a tested upgrade path from the previous
  migration. A new parameter on a SECURITY DEFINER function means DROP (the old signature),
  CREATE, the grants again. A merged migration is never edited.
- Estimates: count every redefined function and the UI texts; say so in the PR when the estimate
  is passed instead of splitting silently.
- Carbon modals render at a section's root, never inside a table cell. e2e specs use their own
  fixture participants; screenshots go to `docs/screenshots/<pr>/`. Drizzle renders unqualified
  columns in single-table selects, so a correlated subquery names its tables.
- plpgsql `text[] || 'x'::text`; enum values compared as text in their migration run; boolean
  helpers never null; no `new Date(` in the domain; Zod enums used nullable get their own schema;
  no `.default()` in inputs; `pnpm verify:changed` while working, `pnpm verify`, `pnpm build` and
  `pnpm test:e2e` before a push; `pnpm generate` after API, registry or domain-table changes;
  `pnpm format` before committing.

## User flows

1. **Monday, the coach:** "Meine TG-Aufgaben" shows two overdue tasks. On the first participant's
   "Coaching" the last agreements are on top; after the session the coach writes the note
   (in person, "Bewerbungsunterlagen"), ticks "Lebenslauf überarbeiten", adds a task for the
   participant due Friday and books the next consultation.
2. **The participant** opens the portal on the phone: "Meine Aufgaben" shows the new task; they
   add an application under "Meine Bewerbungen" and later set it to "Vorstellungsgespräch" with
   its date, and mark the task done.
3. **Qualification:** the coach plans a forklift course (provider, dates) without amounts; the PL
   adds the planned cost and "Kundenbudget", records "angefragt", later "genehmigt" with the
   decision date and the scanned approval. After the course back office records the actual cost
   and invoice reference, the coach the outcome and the certificate the participant uploaded.
4. **Sickness:** the participant calls in sick; back office records "krank (Entgeltfortzahlung)"
   from today, open-ended, later the end date and "AU bestätigt". The PL and the coach see
   "abwesend seit 03.02.". On the 1st back office issues the payroll CSV for the past month.
5. **Placement:** an application is `accepted`; the coach uses "Austritt vormerken" (last day
   31.03., `placed_permanent`, full time). Back office uploads the termination agreement, the PL
   accepts it. On 01.04. the row shows "Austritt erfassen"; the coach confirms, the BA task
   "vorzeitiger Austritt" appears for back office, who later records "Gemeldet am".
6. **Contract end:** 14 days before the `tgEnd` the PL's tile "Vertragsende in 14 Tagen" counts
   three people; on the day after, "Austritt zu erfassen": the PL records `max_duration_reached`
   with the `tgEnd` as the date; no BA task.
7. **Mistake:** the exit was recorded with 30.03. instead of 31.03.: back office requests the
   correction with the termination agreement as its source, the region's manager approves in
   "Freigaben"; the history shows the correction, the BA task stays one. A wrong reason is
   corrected by the PL.
8. **Protected reason:** the coach records an exit for long-term illness; the PL and back office
   see "Geschützter Grund", the work list nothing.

## Acceptance criteria

**8-1** The exit by the PL and the assigned consultant only, through the status function with its
audit; D3's date and reason rules at their boundaries in the service and the database; placement
details exactly for the reasons of D7; `early_exit` as D6; `tg_end` upcoming from 14 days before
and overdue the day after; the tile, the quick view and the list count the same participations;
`exitDate` is the only exit field with `customerVisible`; e2e exit with placement, screenshots
`docs/screenshots/8-1/`.

**8-2** The protected reason as D26's scenario and stored only encrypted; an upgrade test from the
previous migration with existing exited rows; the reason correction keeps the previous reason and
takes placement details; the `exitDate` correction four-eyed with its task reconciliation;
`tg_termination` with the DSV cancellation's operations and "Beendigungsnachweis fehlt" for an
early exit; the planned exit changes no status and prefills the dialog; e2e plan → paper → exit →
date correction.

**8-3** Back office alone writes; the type never in the PL's or consultant's payload, a list, a log
or an audit detail; overlap and bounds refused by the database; a void keeps the row; the CSV's
column set is versioned, issued through a logged link, clipped to the month, synthetic only; the
class `payroll_record` is in the catalog `unset` and reported by the job; e2e record → export.

**8-4** Goals and tasks by the assigned consultant and the PL; the participant reads own and marks
own tasks, nothing else; `coaching_task_overdue` from the day after the due date for whoever reads
the task; the portal's count of "Das fehlt noch" unchanged; e2e staff task → portal done, both in
de and en at 320px.

**8-5** The text only through its logged endpoint to the assigned consultant; metadata to the PL;
D26's scenarios; no text in any list, log, error, history or job payload (a test greps the
responses and logs for a marker text); e2e write → reopen.

**8-6** Both sides write the same list with revisions; states and steps as D18; no derived absence,
BA task or status; the prefill opens the planned-exit dialog and saves nothing by itself; e2e
portal add → staff step → accepted.

**8-7** Planning by the consultant without amounts, approval by the PL only, actual cost by back
office; `approved` with a cost needs the approval document; "Genehmigung fehlt" from the start
day; the portal shows no cost, funding or approval; nothing is sent to the customer; e2e plan →
approve → result.

**8-8** The TG summary, quick views and tiles from one snapshot, evidence-only participations left
out; the timeline's bars pass the same access rules as their fields (a consultant's absence bar
has no type); the journey e2e (flows 1–7 on seeded synthetic data, a mistake and its recovery
included) with screenshots; axe and the 200 % / 400 % zoom check on every new page; the seed
builds its TG records through the functions.

## Docs updated by the PRs

- 8-1, 8-2: process-and-lifecycle.md (the exit as built: rules, placement details, the planned
  exit, the termination paper, corrections, `tg_end`), data-protection.md (the protected reason,
  placement details, the catalog version), the generated transitions table and access matrix,
  ADR-0002, ADR-0010, glossary.md (Beendigungsnachweis, Austritt vormerken).
- 8-3: process-and-lifecycle.md (absences as built), data-protection.md (the two projections,
  the export, `payroll_record`), ADR-0006 (the export kind), ADR-0008, glossary.md.
- 8-4 to 8-7: process-and-lifecycle.md (phase 2 detail as built), data-protection.md (the access
  matrix rows, classification of note text, the portal's part), architecture/overview.md (the
  participant page's tabs, the portal), ui-patterns.md (the TG tabs, the portal cards), ADR-0002,
  ADR-0010, glossary.md.
- 8-8: architecture/overview.md and ui-patterns.md (timeline stage 2, the TG quick views),
  roadmap.md (Slice 8 done), this plan to `docs/plans/archive/`.

## Questions

New: Q241–Q253 (their rows in open-questions.md carry the proposals). Existing ones the slice
rests on: Q8, Q23, Q33, Q34, Q51, Q60, Q66, Q71, Q85, Q88, Q102, Q105, Q111, Q141, Q169, Q207.

**Block the pilot:** the exit's paperwork and whether it is a guard (Q241); who records and reads
the protected reason (Q242); an exit recorded in error (Q243); the classification, readers and
retention of coaching notes (Q247); the customer's qualification approval without person-level
data (Q250); the retention mapping and the payroll class (Q252, with Q3, Q51); Q85 before absences
appear in any list.

**Block part of a PR** (the rest of the PR builds on the proposal or the fail-safe):
Q242 → 8-2 (until answered the assigned consultant alone records the protected reason);
Q244 → 8-1 (which reasons take placement details, the `max_duration_reached` date rule);
Q246 → 8-3 (the CSV's columns: `v1` as proposed, a different set is `v2`);
Q248 → 8-4 and 8-6 (the portal's write part; without it the portal reads only);
Q249 → 8-7 (the `fundingSource` values and whether `approved` needs the document);
Q251 → 8-6 (trial work stays a plain record).
Q245 and Q253 block nothing.
