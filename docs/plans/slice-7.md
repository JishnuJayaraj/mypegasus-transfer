# Slice 7 — DSV (F8)

Status: **draft, awaiting the product owner's approval** (plan PR, 2026-11-06). Nothing is built
before approval. New questions Q210–Q219 ([open-questions.md](../open-questions.md)); the plan
items that depend on them are marked. This is not an external DPO, legal, works-council or
Agentur confirmation.

Roadmap: the DSV track (generation, three-party signatures and `dsvFullyExecuted`, original
tracking), the list "participant signed, not fully executed", the admission cutoff and the system
withdrawal with their conflict flags, the TG entry guard on real DSV facts, the two-stage retention
job (ADR-0008); from Slice 2 the reconciliation route (Q68) and its review.
Builds on: the DSV track's edges and guards (`canTransition`, the status service,
`apply_status_change`; the generated [transitions table](../domain/generated/lifecycle-transitions.md)),
the guard-facts provider (`apps/api/src/participations/guard-facts.ts`: the DSV facts fail closed
today and the seed overlays synthetic ones), the planner's cutoff rules and flags
(`packages/domain/src/lifecycle/planner.ts`) and the nightly sweep (ADR-0011), the form registry and
`PdfRenderer` (ADR-0006, ADR-0009; own templates `packages/forms/templates/own/`), the generated
working copies (`form_generation`, `form_working_copy`, `workingCopyExpiry`), the documents of Slice
4b with the signed-scan operations, quarantine and evidence corrections of Slice 6 (the catalog
already lists `dsv_signed_scan` and `dsv_cancellation`, `employment_contract`, PL and back office,
operations `undecided`), the DSV amendments and BA reporting tasks (PR 2h-3, 6-6), the queue
"Freigaben" (6-7, 6-8), the work list, the audit history and the data catalog
(`retentionPeriods`, every class `unset`).

## Decisions

### The DSV document

- **D1. The DSV PDF is our own versioned template** (ADR-0009: own documents are HTML templates
  rendered by Gotenberg behind `PdfRenderer`; regional-variation.md, forms versioned separately).
  `packages/forms/templates/own/dsv/v1/` (`index.html`, `header.html`, `footer.html`), form code
  `dsv`, version `v1`, in the forms manifest and the immutability check like
  `anlage-profilingbogen:v1`; every generation records `formCode` and `formVersion`. It fills only
  the variable parts: the three parties (the participant's name, birth date and address; the
  customer from the project; the Transfergesellschaft from the organisation configuration), the
  effective TG start and end, the offer deadline, and three signature blocks with a date line each;
  every value HTML-escaped, the font's printable ranges checked (`character_unsupported`, as the
  TL 407). **v1's contract text is a synthetic sample**, marked "Muster – nicht zur Verwendung" on
  every page. The real text, and whether it varies per project or Sozialplan, is the owner's and
  legal's (**Q210**, open, blocks the pilot); a real text is a new template version, never an edit.
  The DSV is contractual, per project, never an Agentur setting (rule 2; regional-variation.md,
  "per project").
- **D2. The generated DSV is a working copy** (`dsv_form`, catalog version 8): encrypted, immutable,
  opened only through the logged opening, provenance in `form_generation` (the source revisions:
  identity, details, the participation's dates and wave revision; the template version), class
  `form_working_copy` with the expiry triggers of Q179 (`workingCopyExpiry`: superseded, its signed
  scan accepted, abandoned, the participation closed). Category `employment_contract` (PL and back
  office; data-protection.md, access matrix). The PL or back office generates (Q60: back office
  administers the DSV), one participation or 1–100 from the work list (all or nothing, synchronous,
  as the Kug 200b, Q179). Generation needs a `ta_tg` project that is active, a non-terminal
  participation in a wave, an effective TG start and end, the DSV track `not_offered`, `dsv_declined`
  or `dsv_expired`, and v1's inputs (name, birth date, both dates; a blank address goes on a
  handwriting checklist as on the Kug 200b, Q197). An open offer's paper isn't regenerated: it is
  reopened (`dsv_offer_open`).
- **D3. `dsvGenerated` rests on the current generation.** Valid from the Berlin day it was recorded,
  recorded at its instant; withheld once it is **stale** (`dsv_generation_stale`: the effective dates,
  the wave, the identity or the address changed after it, or a later offer ended after it), so a
  paper with old dates is never offered. A re-offer needs a generation newer than the previous
  offer's end (its paper prints the new deadline).

### The offer and the signatures

- **D4. The offer names its paper and its deadline** (Q69, process-and-lifecycle.md, DSV track):
  `not_offered → dsv_offered` and the re-offers record a `dsv_offer` row (the generation handed out,
  the deadline and its kind, by/at) in the status transaction (`offer_dsv`, through
  `apply_status_change`). A first offer's deadline is the wave's `signingDeadline` (the rule, not a
  default): the dialog shows it and the request carries the date it showed (`409 source_changed`
  when the wave changed); a re-offer needs an explicit `offerDeadline` (no default; the guard
  `offer_deadline_valid`). The PL or back office declines an open offer (`dsv_offered →
  dsv_declined`) with the offer and status version read. Expiry stays the sweep's.
- **D5. The participant's signature** (`dsv_offered → dsv_signed`; PRD F8: "signed status requires
  an uploaded scan + who received it"): back office or the PL uploads a `dsv_signed_scan` **of the
  open offer's generated paper** (the scan names the offer; external paper is refused,
  `external_paper_not_supported`, until **Q211**), with the dates on the paper per signature
  (participant, customer, Transfergesellschaft; each optional, none in the future), the staff member
  who received the paper and `receivedOn` (not before the participant's date, not in the future),
  no default. Review (accept once, or reject with `unreadable`, `wrong_document`, `incomplete`) by
  the PL or back office, never the uploader alone deciding what the paper shows: the reviewer
  confirms each signature and its date as on the paper (codes, nothing preset). Quarantine and its
  lift by the PL or back office; the PL deletes before review (Slice 6's signed-scan operations,
  catalog version 9). `dsvScanReceived` = an accepted, counting scan of the open offer showing the
  participant's signature with its receiver; `dsvSignedOn` = that signature's date. "Als
  unterschrieben erfassen" is its own status action (PL, back office), which the database checks
  too (`dsv_scan_missing`). Readings **Q212** (assumed).
- **D6. `dsvFullyExecuted` rests on one paper showing all three signatures** (§623 BGB, Q21, Q97;
  **Q212**): an accepted, counting `dsv_signed_scan` of the signed offer whose confirmed signatures
  are the participant's, the customer's and the Transfergesellschaft's. Usually the countersigned
  original is scanned again later (a new scan of the same offer); a paper signed by all three at
  once is one scan. `validOn` = the latest of the three dates; `recordedAt` = the acceptance (or a
  quarantine's lift) of that scan, the complete fact's instant (the ASU lesson of 6-4a). The
  participant's date on the full scan must equal `dsvSignedOn` (`signature_date_mismatch`), so two
  papers never disagree silently. The guard also needs the track `dsv_signed` (Q97); inconsistent
  data stays `informed` and is never repaired.
- **D7. The original is tracked on the contract** (`dsv_contract`, one per signed offer; PRD F8):
  `originalLocation` (controlled, `paper_personnel_file` as for amendments, Q110), `originalReceivedOn`
  and `sentToCustomerOn`, each by the PL or back office, audited, changed only against the value
  read (`409 stale_value`), dates not in the future. Not a guard (only full execution is, Q71).
- **D8. Facts withheld while their evidence doesn't count** (the 6-8 review): a quarantined,
  invalidated or deleted scan supplies nothing (every facts reader skips it); after a lift, valid and
  recorded no earlier than the lift. "Nachweis ungültig" for an invalidated DSV scan clears only when a
  counting scan of the **same offer**, accepted after the approval, again supports each fact the
  invalidated one supported **with its date** (`dsvSignedOn`, the full execution's three dates). The
  status stays; nothing restores an invalidation; an entry already made is never repaired.

### Cancellation, withdrawal and the cutoff

- **D9. Cancellation before TG start** (*verify, Q46*; readings **Q213**, assumed): a
  `dsv_cancellation` scan of the signed contract with the three parties' signatures confirmed at
  review (catalog version 10, the same operations as D5); `dsvCancellation` = the accepted, counting
  cancellation, valid from its latest signature. Then the PL withdraws (`informed → withdrawn`,
  user only, the PL's confirmation; the guard `withdrawal_after_dsv_signed`), the effective date not
  before the cancellation's validity (`effective_date_before_cancellation`, as
  `effective_date_before_signature`, Q191); the database checks the cancellation too
  (`cancellation_missing`). The customer notice (Q46's flag): a case item "Kunde informieren" until
  the PL records "Kunde informiert am" (not in the future, not before the withdrawal; once). After the
  TG start it is an exit (Slice 8).
- **D10. Manual withdrawal and the end-reason correction get their routes** (no main-status route
  exists yet): `→ withdrawn` from `imported`, `contacted`, `unreachable` and `informed` by the PL
  with a `pre_tg` reason (special category refused, `reason_not_storable`), an effective date (no
  default; not in the future) and the status version read; the correction of a primary end reason
  after a system withdrawal (Q72, `correct_end_reason`, built in Slice 1) by the PL with the
  reason read. Manual `contacted` / `unreachable` and exits stay out (**Q215**, Slice 8).
- **D11. The cutoff runs as built; Slice 7 makes its cases actionable** (Q50, Q53, Q70, Q77, Q84):
  the sweep's withdrawals and flags don't change. The flags `conflict_dsv_signed_profiling_declined`,
  `dsv_never_offered` and `informed_without_wave_at_cutoff` get their resolution actions on the
  participant page (return arrow before the cutoff, cancellation and withdrawal, manual withdrawal)
  and a dashboard tile "Klärungsfälle Stichtag". A gap: a **signed DSV that hasn't entered by the
  cutoff** (no refusal) is neither withdrawn nor flagged, and no new start can follow; a new flag
  `dsv_signed_not_entered_at_cutoff` names it for cancellation or reconciliation (**Q214**, assumed).

### The TG entry guard and the reconciliation

- **D12. Real DSV facts** (process-and-lifecycle.md, TG entry guard and guards): a facts reader
  `dsv_facts(uuid[])` (as `tl407_facts`) gives `dsvGenerated`, `dsvScanReceived`,
  `dsvFullyExecuted` and `dsvCancellation` to `dbGuardFacts`; the status service, the sweep and the
  work list read them. `apply_status_change` checks the documentary ones in the database too:
  `dsv_offered` a current generation, `dsv_signed` the open offer's counting scan,
  `active_in_tg` in `ta_tg` a fully executed contract valid by the effective date (and, for a
  `system` entry, recorded before the run's instant), `withdrawn` from `dsv_signed` a counting
  cancellation. The seed creates real DSV records (generation, scans, signatures) through the same
  functions with synthetic files (Q95), so the DSV keys leave `seedFacts`; the TL 407 and ASU
  overlays stay as they are.
- **D13. The reconciliation route** (Q68 case 2, Slice 2 D10): the PL, for a `ta_tg` participation
  in `informed`, after its effective TG start (or on it once that day's run completed; the guard
  `tg_start_date`), when every entry fact was valid **on the TG start** though recorded later. The
  dialog lists the evidence with its dates (the fully executing DSV scan, the current ASU
  registration, the accepted TL 407 scan or the approved exception); the request carries those ids
  and dates and the PL's confirmation ("Die Nachweise belegen alle Voraussetzungen am <TG-Start>");
  under the lock the server recomputes them (`409 source_changed`). The effective date is the TG
  start (derived, `effective_date_mismatch`). One `tg_entry_reconciliation` row and the status
  change in one transaction (`reconcile_tg_entry`). Never backdated on evidence valid later.
- **D14. The review after the fact** (Q80; data-protection.md, four eyes): each reconciliation is in
  "Freigaben" for the regional operations manager of the project's region, never the PL who made
  it, with a due day (the next business day, informational): project, TG start, the evidence kinds
  with their valid and recorded days; no name, no file. Outcomes `no_objection` or
  `clarification_requested` (the PL sees a case item "Rückfrage zum Eintritt"). What answers a
  clarification and what follows an objection (the entry has no edge back) is **Q216** (open, blocks
  the pilot): 7-6 builds the two outcomes and the item, nothing after it.

### Corrections

- **D15. Field corrections of the evidence set are not in Slice 7; they belong to the slice that
  lets stage one run** (proposed: Slice 9, with the confirmed retention values). The field rows of
  the correction-authority table (Q88) correct evidence-set fields, which are immutable only in the
  evidence-set phase; that phase starts after stage one (Q64), and stage one can't run while the
  periods are `unset` (D16). Until then each field has its own operation: identity by person-data
  writes and re-import, `tgStart`/`tgEnd` by dates and amendments, `tgEntryDate` by the
  reconciliation rules, `dsvSignedOn` by a document correction of its scan (D8), `profilingDoneOn`
  and `profilingSessions` by Slice 6's records. Slice 7 adds no field target; the DSV documents use
  the existing document target (`dsv_signed_scan`, `dsv_cancellation`, PL or back office).

### Retention (ADR-0008; data-protection.md, retention and deletion)

- **D16. The rules are domain code, the periods configuration, and `unset` refuses.**
  `packages/domain/src/retention/`: per class and item a pure `retentionDue(item, periods, today)` →
  `due { stage, from }`, `held`, `blocked { reason }` or `period_unset`, encoding the accepted rules
  of round 32 and Q122, Q141, Q145, Q156, Q166, Q179 as written. The periods stay `unset` in
  `retentionPeriods` until the DPO confirms them (Q3, Q24, Q77): the job **refuses every unset
  class** (no deletion; counted per class and logged). The job takes its periods as an argument:
  production passes the catalog only; integration tests pass synthetic periods to prove deletion.
  Nothing reads a period from the environment.
- **D17. The job** (`retention.sweep`, ADR-0011's pattern): nightly, the `system` actor, the
  `Clock`'s Berlin day, due by database time, one `retention.evaluate-project` job per project
  (ID-only payloads), idempotent, a `job_run` row; stage one before stage two, per item; a summary
  of counts per class and outcome, never a subject. `pnpm jobs:retention [--today] [--dry-run]`
  (dev and CI; `--dry-run` deletes nothing and prints the counts).
- **D18. Stage one without a person trigger** (7-7a): `access_credential` rows (30 days after use,
  expiry, lock, revocation or end, Q122), generated working copies' files (`workingCopyExpiry`,
  Q179; the row stays as the tombstone) and stored objects without a document row older than a day
  (data-protection.md, uploads: "the retention job reconciles objects without a row"; `FileStorage`
  gains `list(prefix)`).
- **D19. Stage one per participation** (7-7b): the class tables of a participation once their
  trigger and period are due: the non-signer deletion from `withdrawnOn` only without a fully
  executed DSV (D6) or a funded §110 participation; TG participants from the end of the year of
  exit; `health_record` 3 months after exit or with the non-signer deletion. A participation that
  has an evidence set keeps it: until **Q217** says which participations took part in a funded §110
  measure, **every participation counts as funded** (fail safe: the evidence set is kept). Legal holds
  and documented disputes suspend only the affected records (`legal_hold`, **Q218**: until it is
  answered no runtime role may place one; the job honours rows that exist). After stage one the
  participation is in the evidence-set phase (`evidence_set_since`; Q64): a trigger refuses every
  write to its rows, and ordinary reads are refused; the break-glass access the phase allows doesn't
  exist yet, so nobody reads it (**Q219**, fail safe).
- **D20. Stage two** (7-7c): the evidence set at the end of the calendar year of the later of
  `kugFinalSettlementDate` / `measure110SettlementDate` + 4 years (Q24, Q52), **never while a
  required date is missing** (`settlement_dates_missing`; until Q217 both are required). The
  settlement dates are project fields back office records (Q52; 7-7a). The erasure deletes the
  participation and everything referencing it in a fixed table order (a test lists every table with
  a participation reference, so a new one can't be missed) and pseudonymises its audit events (the
  participation reference replaced by a per-subject random pseudonym, no mapping kept; ADR-0008).
  The admin warning about projects ended 12 months ago without settlement dates needs a project end,
  which doesn't exist (project closure, Later).

### Cross-cutting

- **D21. Lock order** (Slice 6 D31, extended): the project's advisory lock first (shared through
  `lock_participation` for one participation; exclusive for a bulk generation, a correction's or a
  reconciliation's decision, and a participation's erasure), then the participation rows (UUID order)
  → document rows (id order) → **`dsv_offer` → `dsv_contract`** → the profiling rows →
  `asu_registration` → the batch → `agentur_submission` rows → consent rows → the sensitive rows →
  the BA reporting task → the correction or request row → **`tg_entry_reconciliation`** →
  **`legal_hold`**. The retention job takes the same order per participation; audit
  pseudonymisation comes last, in the erasure's transaction.
- **D22. Writes go through SECURITY DEFINER functions** (ADR-0002); `transfer_app` selects the new
  tables and writes none; each function writes its audit events; `record_audit_event` refuses the
  new types; status changes only through the status function.
- **D23. Required scenarios**, each an integration test in its PR (agent-workflow.md §3):
  - a generation made before a date change is stale and can't be offered; a re-offer needs a newer
    paper (7-1, 7-2);
  - a scan of an earlier offer's paper can't sign the open offer; the receiver and dates are
    required and never defaulted (7-2);
  - a countersigned scan accepted after the TG start's run gives an entry only through the
    reconciliation; a quarantined full scan withholds `dsvFullyExecuted` and its lift dates it from
    the lift (7-3, 7-6);
  - the participant's date differs between the two scans: refused (7-3);
  - an invalidated full scan keeps "Nachweis ungültig" until a counting scan of the same offer with
    the same dates is accepted after the approval; a scan of another offer doesn't clear it (7-3);
  - a withdrawal of a signed DSV without a counting cancellation, or dated before it, is refused in
    the service and the database (7-5);
  - a reconciliation whose evidence changed between the dialog and the save is `409`; a reviewer who
    made it can't review it (7-6);
  - the job with every period `unset` deletes nothing and reports each class; with synthetic periods
    it deletes a non-signer's personnel file on day 91, not day 90, keeps the evidence set, skips a
    held record, and keeps a fully executed DSV's records (7-7a, 7-7b);
  - stage two stays blocked without settlement dates; with them it erases the participation and
    leaves only pseudonymised audit events (7-7c).
- **D24. Not in this slice:** field corrections of the evidence set (D15); external-paper DSVs
  (Q211); manual `contacted`/`unreachable` (Q215); exits and an early termination after the TG
  start (Slice 8); the customer's monthly export with `dsvSignedOn` (Slice 9, Q13, Q47); break-glass;
  the admin warning about missing settlement dates (needs project closure); an e-signature for the
  DSV or its cancellation, ever (rule 4).

## PRs

One planned PR = one branch = one PR, each based on `main` after the PRs it needs merged (none
stacked). The estimates count changed lines without generated code and tests, and are already
raised for what Slice 6 taught (6-7 and 6-8 came in at two to three times their first estimates):
each signed-scan PR redefines the shared document functions, and the redefinitions are counted.
A PR that changes the document-type catalog takes its next version when it merges. The last PR to
merge archives this plan.

| PR | Scope | Needs | Est. lines | SQL functions redefined |
|---|---|---|---|---|
| 7-1 | DSV PDF (D1–D3): template `dsv:v1` in the registry, the domain's input, validation and staleness, `dsv_form` (catalog 8), single generation, `dsvGenerated`; tab "DSV" with "Erzeugen" and "Öffnen" | — | ~1,400 | `record_form_generation` (DROP/CREATE if it gains a parameter), `current_document_policy`, `record_audit_event` |
| 7-2 | Offer and the participant's signature (D4, D5, D8): `dsv_offer`, `offer_dsv`, decline, scans with signatures and receiver, review, quarantine, deletion (catalog 9), `dsvScanReceived`, "Als unterschrieben erfassen", `dsv_facts` | 7-1 | ~1,500 | `apply_status_change`, `add_document`, `review_document`, `quarantine_document`, `lift_document_quarantine`, `delete_document`, `scan_form`, `current_document_policy`, `record_audit_event` (DROP/CREATE where a parameter is added) |
| 7-3 | Full execution and the original (D6–D8, D12): `dsvFullyExecuted`, `dsv_contract`, the entry check in the database, "Nachweis ungültig" for DSV scans, the seed on real DSV records | 7-2 | ~1,400 | `apply_status_change`, `dsv_facts`, `record_audit_event` |
| 7-4 | Work list and cutoff (D2's bulk, D11): "DSV unterschrieben, nicht vollständig" (item, filter, tile), bulk generation 1–100, the cutoff cases' actions and tile, `dsv_signed_not_entered_at_cutoff` | 7-3 | ~1,100 | `record_form_generation` (1–100), `record_audit_event` |
| 7-5 | Cancellation and withdrawal (D9, D10): cancellation scans (catalog 10), `dsvCancellation`, the withdrawal route, the end-reason route, the customer notice | 7-3 | ~1,400 | `apply_status_change`, `add_document`, `review_document`, `current_document_policy`, `record_audit_event` |
| 7-6 | Reconciliation and its review (D13, D14): `tg_entry_reconciliation`, `reconcile_tg_entry`, `review_reconciliation`, "Freigaben", the clarification item | 7-3 | ~1,300 | `apply_status_change` (the reconciliation's row), `record_audit_event` |
| 7-7a | Retention framework (D16–D18): the domain rules for every class, the job and CLI, refusals of `unset`, access credentials, working copies, orphaned objects, `FileStorage.list`, settlement dates | — | ~1,400 | `update_project` (or a new `set_settlement_dates`), `record_audit_event` |
| 7-7b | Stage one per participation (D19): the class deletions, legal holds, the evidence-set phase (write trigger, read refusal) | 7-3, 7-7a | ~1,500 | `record_audit_event`; one new trigger function on every participant table instead of redefining each writer; the API's detail and list readers refuse the phase |
| 7-7c | Stage two (D20): the erasure order, audit pseudonymisation and its history display | 7-7b | ~1,300 | `audit_history`, `record_audit_event`; `audit_event` gains the pseudonym (upgrade path) |

If a PR's estimate passes about 1,500 lines while building, the plan says so and the owner decides
on a split, as in Slice 6. 7-7a can be built beside 7-1 to 7-6.

## Design

### Domain (`packages/domain`, no I/O, no system time)

- 7-1, `src/dsv/`: `dsvInput(identity, details, project, organisation, dates, offerDeadline)` →
  `FormInput` for `dsv:v1`; `validateDsvInput` (codes and keys, never values: `required_missing`,
  `character_unsupported`, `date_invalid`, the blank address as `required_blank`);
  `dsvGenerationProblem(generation, current)` → `null | "dsv_generation_stale"` (D3);
  `dsvGenerationAllowed(state)` (D2's preconditions, its codes).
- 7-2/7-3: `DsvSignature` (`participant`, `customer`, `transfergesellschaft`), `dsvScanProblem`
  (dates in the future, `receivedOn` before the participant's date, a scan of another offer),
  `dsvFacts(offer, scans, today)` → `{ dsvScanReceived?, dsvFullyExecuted?, dsvSignedOn? }` with the
  withholding and lift rules of D8 (pure; the API's reader feeds it), `signature_date_mismatch`;
  `evidenceInvalidatedSince` gains the DSV replacement rule (D8).
- 7-4: `WorklistCaseItem` gains `dsv_not_fully_executed` (date: `dsvSignedOn`); `LifecycleFlag`
  gains `dsv_signed_not_entered_at_cutoff` (`cutoffOutcome`: `dsv_signed`, not profiling-declined,
  still `informed` after the cutoff; Q214); the filter value and the dashboard counts.
- 7-5: `dsvCancellation` from its scan; `withdrawalProblem` adds `effective_date_before_cancellation`;
  `WorklistCaseItem` gains `dsv_customer_notice` (date: `withdrawnOn`).
- 7-6: `reconciliationEvidence(facts)` → the evidence ids and dates the dialog shows and the server
  compares; `WorklistCaseItem` gains `reconciliation_clarification`; `reviewReconciliation` gets its
  failure codes (`actor_not_allowed`, `four_eyes`, `already_reviewed`) in the transitions table.
- 7-7a–c, `src/retention/`: `RetentionClass` rules as data (trigger kind, period key, stage),
  `retentionDue`, `evidenceSetDue(settlementDates, today)`, `isNonSigner(facts)`; 100 % coverage
  with the boundary days (day 90 and 91 after `withdrawnOn`, 31.12. of the year of exit, the
  settlement year + 4).

### Data model (data catalog; `project_id` on every participant table, composite FKs to `participation`)

| Table / change | PR | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|---|
| `document` (type `dsv_form`) | 7-1 | the generated DSV; provenance in `form_generation` (enum `form_code` gains `dsv`) | highly confidential / `employment_contract` | `form_working_copy` (Q179) |
| `dsv_offer` | 7-2 | participation, the generation document, `offer_deadline`, deadline kind (`wave`, `explicit`), offered by/at, the status event; its end (`signed`, `declined`, `expired`, at) | internal / `case_internal` | `participation_record` (**Q219**) |
| `document` (type `dsv_signed_scan`) | 7-2, 7-3 | adds `dsv_offer_id`, the confirmed signatures with their dates, `received_by`, `received_on`; CHECKs by type | highly confidential / `employment_contract` | `personnel_file` (catalog, unchanged) |
| `dsv_contract` | 7-3 | the signed offer, `original_location`, `original_received_on`, `sent_to_customer_on`, by/at each | internal / `case_internal` | `participation_record` (`dsvSignedOn` is evidence-set data, Q88; **Q219**) |
| `document` (type `dsv_cancellation`) | 7-5 | the contract it cancels, its confirmed signatures and dates | highly confidential / `employment_contract` | `personnel_file` |
| `dsv_customer_notice` | 7-5 | the withdrawal it follows, `notified_on`, by/at | internal / `case_internal` | `participation_record` (**Q219**) |
| `tg_entry_reconciliation` | 7-6 | participation, effective date, the evidence ids and their valid and recorded days, the PL's confirmation, by/at; the review (reviewer, at, outcome) | internal / `case_internal` (the review: the `review` stream) | `participation_record` (`tgEntryDate` is evidence-set data) |
| `project` | 7-7a | adds `kug_final_settlement_date`, `measure110_settlement_date` (nullable dates, Q52) | internal / project data | `project_master` |
| `retention_run` | 7-7a | the run, the class, the stage and the counts per outcome; no subject | internal | `reference_data` |
| `legal_hold` | 7-7b | participation, scope (class or record), reason code, placed and lifted by/at | confidential / no staff category until Q218 | proposed: kept while active, then as `audit_log` (**Q219**) |
| `participation` | 7-7b | adds `evidence_set_since` (timestamptz; nullable, no backfill needed: an upgrade test from the previous migration) | internal / `case_internal` | `participation_record` |
| `audit_event` | 7-7c | adds `subject_pseudonym` (nullable; the participation reference becomes nullable for erased subjects: an upgrade test from 7-7b's migration with existing events) | internal | `audit_log` |

Enum values (`audit_event_type`, `document_type`, `form_code`, the new enums) are added in their PR's
generated migration and compared as text in that migration run.

### Functions (hand-written, SECURITY DEFINER, audit in the same transaction, the lock order of D21)

- 7-1: `record_form_generation` takes the DSV (its source revisions; `dsv_offer_open`,
  `dsv_not_generatable`, `source_changed`); `dsv_generation_current(participation)` (internal, the
  staleness of D3).
- 7-2: `offer_dsv(p_context, p_participation_id, p_generation_id, p_deadline_kind, p_deadline,
  p_expected_status_version)` → `lock_participation`, the participation, the generation `FOR SHARE`,
  then `apply_status_change` (internal) and the `dsv_offer` row; `decline_dsv_offer`; `add_document`
  and `review_document` for the DSV scan (the offer, signatures, receiver; the confirmations);
  `quarantine_document`, `lift_document_quarantine`, `delete_document` learn the type;
  `apply_status_change` checks `dsv_offered` (current generation) and `dsv_signed` (counting scan of
  the open offer, `FOR SHARE`); the reader `dsv_facts(uuid[])`.
- 7-3: `dsv_facts` adds the full execution; `apply_status_change` checks `active_in_tg` (`FOR SHARE`
  the fully executing scan); `record_dsv_original(p_context, p_participation_id, p_field, p_value,
  p_expected)` (`stale_value`).
- 7-4: `record_form_generation` for 1–100 (the exclusive project lock, participations in UUID order).
- 7-5: `add_document`/`review_document` for the cancellation; `apply_status_change` checks
  `withdrawn` from `dsv_signed` (counting cancellation, its date); `record_customer_notice`; the
  routes call the existing `change_participation_status` and `correct_end_reason`.
- 7-6: `reconcile_tg_entry(p_context, p_participation_id, p_evidence jsonb, p_expected_status_version)`
  (rechecks the evidence under the lock, `source_changed`; calls `apply_status_change` with
  `reconciliation`; writes the row); `review_reconciliation(p_context, p_id, p_outcome)` (exclusive
  project lock; the region's manager; `four_eyes`, `already_reviewed`).
- 7-7a: `set_settlement_dates` (back office, `stale_value`); `retention_purge_credentials`,
  `retention_purge_working_copy` (`record_document_purged` as before), `record_retention_run`.
- 7-7b: `retention_stage_one(p_participation_id, p_classes, p_run)` (deletes due rows class by
  class, documents to tombstones with their purge queued, sets `evidence_set_since`);
  `refuse_in_evidence_set_phase()` trigger on every participant table (`evidence_set_phase`);
  `place_legal_hold` / `lift_legal_hold` granted to no runtime role (Q218).
- 7-7c: `retention_erase_participation(p_participation_id, p_run)` (exclusive project lock; the
  fixed table order; audit pseudonymisation last); `audit_history` shows an erased subject's events
  to nobody (the history is per participation).

### API (`/api/v1`, OpenAPI, RFC 9457, capabilities on every item; visibility, then permission, then state)

- 7-1: `GET /participations/{id}/dsv` → `DsvView { track, generations, offers, scans,
  contract, facts, capabilities }` (PL and back office; anyone else who sees the participation `403`
  without the DSV; a hidden participation `404`); `POST /participations/{id}/dsv/generations`
  (`{ expectedSourceToken }`) → `201 { documentId, checklist }`; `422` with the codes of D2.
- 7-2: `POST .../dsv/offers` (`{ generationId, deadline: { kind: "wave", shown } | { kind:
  "explicit", date }, statusVersion }`), `POST .../dsv/offers/{offerId}/decline`
  (`{ statusVersion }`), `POST .../dsv/scans` (`{ offerId, file, signatures, receivedBy,
  receivedOn }`), `POST /documents/{id}/dsv-review` (`{ decision, signatures, reason }`),
  `POST .../dsv/signed` (`{ scanId, statusVersion }`). A document or offer of another participation,
  or one the viewer can't read, is `404`; `409 stale_status` / `source_changed`.
- 7-3: `PUT .../dsv/contract/original` (`{ field, value, expected }`); `DsvView.facts` gains the full
  execution; `ParticipationDetail` gains `dsvSignedOn` and `dsvFullyExecutedOn` (`case_internal`).
- 7-4: `POST /projects/{id}/dsv/generations` (1–100 ids, all or nothing, each refusal with its index
  and code); the work list's `caseItems`, filter `dsv=not_fully_executed`, the dashboard counts.
- 7-5: `POST .../dsv/cancellation-scans`, `POST /participations/{id}/withdrawal` (`{ reason,
  effectiveDate, statusVersion, confirmed? }`; `confirmed` required exactly for a signed DSV),
  `PUT /participations/{id}/end-reason` (`{ reason, previous, confirmPreviousApplies }`),
  `POST .../dsv/customer-notice` (`{ notifiedOn }`).
- 7-6: `GET /participations/{id}/tg-entry-reconciliation` (the evidence or the failing guards),
  `POST` the same (`{ evidence, statusVersion, confirmed: true }`) → `201`;
  `POST /reconciliations/{id}/review` (`{ outcome }`); `GET /reviews` gains `reconciliations` (no
  participant id or name, by schema).
- 7-7a: `PUT /projects/{id}/settlement-dates` (back office; `{ kugFinal, measure110, expected }`).
- Logs carry ids and codes, never a name, date of birth, signature or file name.

### History (`auditProjection` + an `audit_event_projection` migration row each; `audit_event_lifecycle_has_participation`; `record_audit_event`'s refused list; a German history label)

| Event | PR | Stream | Shows |
|---|---|---|---|
| `form_generated` (form `dsv`) | 7-1 | `dsv` | form and version |
| `status_changed` (DSV track) | 7-2 | `dsv` | as built; the offer's generation id and deadline kind in the detail |
| `document_added`, `document_reviewed`, `document_quarantined`, `document_quarantine_lifted` (DSV types) | 7-2, 7-5 | `dsv` | type, decision, reason, the confirmed signature kinds (PL and back office: a consultant has no `dsv` stream) |
| `dsv_original_recorded` | 7-3 | `dsv` | the field, the location code |
| `dsv_customer_notified` | 7-5 | `dsv` | the date |
| `end_reason_corrected` | 7-5 | `case` | as built |
| `tg_entry_reconciled` | 7-6 | `case` | the effective date, the evidence kinds |
| `reconciliation_reviewed` | 7-6 | `review` (never in a history) | — |
| `settlement_dates_set` | 7-7a | project-level | — |
| `retention_applied`, `legal_hold_placed`, `legal_hold_lifted` | 7-7b | `security` (never in a history) | — |

### Web UI (`apps/web`, German; every button by its capability)

- **Tab "DSV"** (7-1 to 7-5; `ta_tg`, PL and back office): "Vertrag erzeugen" (the handwriting
  checklist), the generations ("Öffnen", "veraltet"); "Angebot erfassen" (the paper, "Frist:
  Unterschriftsfrist der Welle, 12.03." or "Frist eingeben"), "Abgelehnt erfassen"; "Scan
  hochladen" (the offer, the signatures seen with their dates, "Entgegengenommen von", "am"; nothing
  preset), the review dialog (each signature confirmed), "Quarantäne"; "Als unterschrieben
  erfassen"; the signatures panel (Teilnehmer·in / Kunde / Transfergesellschaft, "vollständig
  unterschrieben am"); "Original" (Ablageort, "Original erhalten am", "an Kunden gesendet am");
  "Aufhebungsvertrag" (7-5). The participant page's header: "Zurückziehen" (7-5), "Eintritt
  nachträglich erfassen" where `tg_start_missed` and the reconciliation is possible (7-6), "Grund
  korrigieren" on a withdrawn participation (7-5).
- **Work list and dashboard** (7-4): filter "DSV: unterschrieben, nicht vollständig", the case items
  "DSV nicht vollständig unterschrieben", "Kunde informieren", "Rückfrage zum Eintritt", the cutoff
  flags with a link to their action; bulk "DSV erzeugen"; tiles "DSV nicht vollständig" and
  "Klärungsfälle Stichtag".
- **"Freigaben"** (7-6): "Eintritte nachträglich erfasst" with "Ohne Einwand" and "Rückfrage".
- **Project "Abrechnung"** (7-7a, back office): the two settlement dates.
- Dialogs capture their target when opened (the offer, the scan, the evidence ids), render at the
  section's root, never inside a table cell.

## Lessons (Slices 6 and 6-8)

- Visibility before permission before state: a hidden participation, document, offer or
  reconciliation is `404`, never a `403` or `422` that reveals what the viewer can't see.
- Every write compares what the user reviewed (ids, revisions, states, the deadline shown) under the
  lock (`409 source_changed` / `stale_status`); dialogs capture their target; no default dates,
  reasons or sources; a choice the UI restricts is enforced server-side, and the documentary
  guards in the database too.
- A fact resting on evidence is withheld while that evidence doesn't count, and cleared only by
  evidence that supports the fact, its linkage (the same offer) and its effective date.
- Every status change goes through the status function with its audit; every new audit event needs
  its projection rows, `audit_event_lifecycle_has_participation`, `record_audit_event`'s refused
  list and a history label.
- A new FK or NOT NULL on an existing table needs a tested upgrade path from the previous migration
  (`document.dsv_offer_id`, `participation.evidence_set_since`, `audit_event`'s pseudonym).
- A new parameter on a hand-written SECURITY DEFINER function means DROP (the old signature),
  CREATE, the grants again.
- A migration change to this PR's own unmerged migration may be regenerated in place; a merged one
  never.
- Drizzle renders unqualified columns in single-table selects, so a correlated subquery names its
  tables.
- Carbon modals render at a section's root, never inside a table cell (axe measures the trigger
  through the overlay otherwise).
- e2e specs use their own owner-fixture participants; screenshots go to `docs/screenshots/<pr>/`.
- Carried from Slice 5b: plpgsql `text[] || 'x'::text`; enum values compared as text in their
  migration run; boolean helpers never null; no `new Date(` in the domain; Zod enums used nullable
  get their own schema; no `.default()` in inputs; `pnpm verify:changed` while working, `pnpm
  verify`, `pnpm build` and `pnpm test:e2e` before a push; `pnpm generate` after API, registry or
  domain-table changes; `pnpm format` before committing.

## User flows

1. **Info event:** the PL selects the 30 participants of wave "W1" and "DSV erzeugen" (two with a
   blank address on the checklist), opens the print file, hands the papers out with the Kug 200b;
   back office records "Angebot erfassen" for each (Frist: Unterschriftsfrist der Welle).
2. **Signature:** a participant returns the signed paper at reception; back office uploads the scan
   ("Teilnehmer·in 14.03.", received by themself on 15.03.), the PL accepts it, back office records
   "Als unterschrieben erfassen". The work list shows "DSV nicht vollständig unterschrieben".
3. **Countersignature:** the customer and the TG sign the original; back office scans it again, the
   PL accepts it with the three dates: "vollständig unterschrieben am 20.03.", the original "in der
   Personalakte", "an Kunden gesendet am 21.03.". On the TG start the sweep enters the participation.
4. **Late evidence:** the countersigned scan of another participant arrives the day after the TG
   start, though signed before it; "Eintritt nachträglich erfassen" lists the evidence, the PL
   confirms; the next day the regional operations manager records "Ohne Einwand".
5. **Cancellation:** a participant who signed finds a job before the TG start; the three parties sign
   a cancellation; back office uploads it, the PL accepts it, withdraws with `placed_direct` and
   records "Kunde informiert am".
6. **Cutoff:** at the cutoff a participant with a signed DSV and a refused profiling is flagged;
   before the cutoff the profiler records the return to `profiling_accepted`, after it the PL needs a
   cancellation.
7. **Mistake:** a scan of another person's DSV was accepted; the PL quarantines it, requests a
   correction (wrong person), the manager approves; "Nachweis ungültig" until the right scan of the
   same offer with the same dates is accepted.
8. **Retention:** `pnpm jobs:retention --dry-run` lists every class as `period_unset`; nothing is
   deleted.

## Acceptance criteria

**7-1**
- The template is in the forms manifest and the immutability check; "Muster – nicht zur Verwendung"
  on every page; a contract test renders it with Gotenberg in CI and reads the variable parts back,
  `Ł` and `ğ` included; HTML in a name is escaped.
- Generation by the PL and back office; a consultant `403`, a hidden participation `404`; every D2
  precondition and validation code at its boundary; a blank address is on the checklist, not an error.
- The generation is stale after a change of the effective dates, the wave, the identity or the
  address (`dsvGenerated` withheld); the working copy has its expiry triggers (a retention-plan test,
  periods `unset`); opening is logged.
- e2e: generate and open (own fixture participant); screenshots `docs/screenshots/7-1/`.

**7-2**
- Offer: a first offer with the wave's deadline as shown, `409` when the wave changed; a re-offer
  without a deadline refused, with a stale or older paper `dsv_generation_stale`; decline with the
  status version read; the database refuses `dsv_offered` without a current generation.
- Scans: the offer is required and must be the open one (another offer's paper refused); dates in
  the future, `receivedOn` before the participant's date and a missing receiver refused; nothing
  defaulted; review confirms each signature; quarantine, lift and deletion as Slice 6.
- `dsv_signed` only with a counting scan of the open offer, in the service and the database; a
  quarantined scan withholds the fact; the history rows in the `dsv` stream (PL, back office), none
  for a consultant.
- e2e: offer → scan → review → signed; screenshots `docs/screenshots/7-2/`.

**7-3**
- `dsvFullyExecuted` only from one counting scan showing three confirmed signatures; `validOn` the
  latest date, `recordedAt` the acceptance or lift; `signature_date_mismatch` refused.
- The TG entry: the scheduled entry passes with real facts recorded before the run and fails with a
  scan accepted after it (D23); the database refuses `active_in_tg` without the contract.
- The original's fields against the value read (`409 stale_value`), dates not in the future.
- "Nachweis ungültig" for a DSV scan clears only as D8 says (the same offer, the same dates).
- The seed builds its DSV records through the functions; `seedFacts` has no DSV key; the seed test
  and the lifecycle demo pass.

**7-4**
- The item "DSV nicht vollständig unterschrieben" from `dsvSignedOn` while not fully executed, for the
  PL and back office; the filter and the tile count the same participations in one snapshot.
- Bulk generation 1–100, all or nothing, every refused row's index and code.
- The flag `dsv_signed_not_entered_at_cutoff` from the day after the cutoff; the cutoff flags link to
  their actions; the sweep's withdrawals unchanged (its tests pass as before).

**7-5**
- A withdrawal of a signed DSV needs a counting cancellation, the PL's confirmation and a date not
  before the cancellation (service and database); without a signed DSV `confirmed` is refused;
  back office and consultants `403`; no default reason or date.
- The end-reason correction as Q72 (same value refused, the previous reason only with confirmation).
- "Kunde informieren" until recorded; recorded once, not before the withdrawal.
- e2e: cancellation → withdrawal → customer notice.

**7-6**
- The reconciliation only after the TG start (or on it after the run), with every fact valid on the
  TG start; the evidence compared under the lock (`409`); the effective date derived; one row and one
  status change in one transaction.
- The review: the region's manager only, never the PL who reconciled (`four_eyes`), once
  (`already_reviewed`); the queue item carries no name or id of the participant (schema test);
  `clarification_requested` raises the PL's item.
- e2e: reconciliation → review; screenshots `docs/screenshots/7-6/`.

**7-7a**
- With the catalog's periods the job deletes nothing and reports every class `period_unset`; the
  dry run likewise; a run not due exits `run_not_due`; refused with `NODE_ENV=production` for
  `--today`.
- With synthetic periods: credentials stripped on day 31, not 30; a working copy's file purged at its
  trigger, its row kept; an object without a row purged, one with a row kept.
- Settlement dates by back office only, against the values read.

**7-7b**
- With synthetic periods: a non-signer's `personnel_file` and `health_record` rows deleted on day 91
  after `withdrawnOn`, the evidence set kept (Q217's fail safe), a fully executed DSV's records kept,
  a held record kept and its neighbours deleted; the participation in the evidence-set phase refuses
  every write (trigger) and every ordinary read.
- A data-catalog test fails for a participant table without a stage-one rule.

**7-7c**
- Stage two blocked without settlement dates; with them erased at the end of the settlement year + 4;
  a test lists every table referencing a participation and the erasure covers each; audit events
  keep only the pseudonym; an upgrade test from 7-7b's migration with existing events.

## Docs updated by the PRs

- 7-1: ba-forms.md and ADR-0009 (the DSV template in the registry), data-protection.md (the
  generated DSV), process-and-lifecycle.md (DSV track: generation), ADR-0002, ADR-0010.
- 7-2: process-and-lifecycle.md (the offer, the signature), data-protection.md (DSV scans and their
  operations; the catalog versions), ADR-0002, ADR-0010.
- 7-3: process-and-lifecycle.md (full execution, the TG entry guard as built, the original),
  data-protection.md (withheld DSV facts), ADR-0002, ADR-0011 (the sweep on real DSV facts).
- 7-4: process-and-lifecycle.md (the list, the cutoff cases, the new flag), architecture/overview.md.
- 7-5: process-and-lifecycle.md (cancellation, withdrawal, end reason, customer notice), ADR-0002,
  ADR-0010.
- 7-6: process-and-lifecycle.md (the reconciliation as built), data-protection.md (its review),
  ADR-0002, ADR-0010.
- 7-7a: ADR-0008, ADR-0011 (the retention job), ADR-0006 (`FileStorage.list`), data-protection.md
  (retention as built), `.env.example` if the job gets a schedule variable.
- 7-7b, 7-7c: data-protection.md (stage one and two, the evidence-set phase, legal holds,
  pseudonymisation), ADR-0002, ADR-0008; the last PR: roadmap.md (Slice 7 done; field corrections
  to the slice that lets stage one run, D15) and this plan to `docs/plans/archive/`.

## Questions

New rows in [open-questions.md](../open-questions.md); existing ones the slice rests on: Q3, Q24,
Q46 (verify), Q52, Q64, Q68, Q69, Q71, Q72, Q77, Q80, Q88, Q97, Q110, Q122, Q141, Q145, Q156, Q166,
Q179.

**Block the pilot** (real data stays blocked until answered and built): Q210 (the real contract
text), Q216 (what follows a reconciliation review), Q217 (funded §110 participation and the required
settlement dates), Q218 (legal holds), Q219 (retention of the new tables, the evidence-set phase
without break-glass), and the retention periods themselves (Q3, Q24, Q77 and the classes' rows),
which keep every deletion `unset`.

**Block part of a PR** (built on the marked reading or fail safe; the owner may change it at
approval): Q211 (external paper refused in 7-2), Q212 (signatures and their evidence, 7-2 and 7-3),
Q213 (cancellation readings, 7-5), Q214 (the new cutoff flag, 7-4), Q216 (7-6 stops at the two
outcomes), Q217 and Q218 (7-7b and 7-7c fail safe). Q215 (manual `contacted` / `unreachable`) blocks
no PR: it asks where that route belongs.
