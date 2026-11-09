# Slice 7 — DSV (F8)

Status: **approved by the product owner for implementation on synthetic data** (2026-11-06, as
present at `4063466`: plan PR #104 with its two product reviews; Q210–Q219 as recorded, Q220
open). Existing pilot gates and live-deletion restrictions remain in force.
This revision carries the review's corrections (and the second review's of the same day: holds on
affected records only, the external offer before its scans, corrected facts recorded at approval,
wrong signature dates superseded): per-class deletion with the evidence-only phase only where
it applies and the DSV facts that survive the scans; every subject reference pseudonymised; the
retention job's own database role; the signature dates kept after a quarantine's lift; the deadline
chosen before the paper is generated; an owned clarification for signed DSVs that never entered; the
date corrections the pilot workflow needs. The review's answers to Q210–Q219 are recorded in their
rows; Q220 is new. This is not an external DPO, legal, works-council or Agentur confirmation.

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
"Freigaben" (6-7, 6-8), the work list, the audit history (`audit_event` has no FK to the
participation, ADR-0002) and the data catalog (`retentionPeriods`, every class `unset`).

## Decisions

### The DSV document

- **D1. The DSV PDF is our own versioned template, pinned per project** (ADR-0009: own documents are
  HTML templates rendered by Gotenberg behind `PdfRenderer`; Q210, accepted).
  `packages/forms/templates/own/dsv/v<n>/`, form code `dsv`, in the forms manifest and the
  immutability check; every generation records `formCode` and `formVersion`. It fills only the
  variable parts: the three parties (the participant's name, birth date and address; the customer
  from the project; the Transfergesellschaft from the organisation configuration), the effective TG
  start and end, **the offer deadline**, and three signature blocks with a date line each; every value
  HTML-escaped, the font's printable ranges checked (`character_unsupported`). `dsv:v1` is the
  synthetic development sample, stamped "Muster – nicht zur Verwendung" on every page, and its
  manifest says `approvedForLive: false`. **The project pins one template version**
  (`dsvTemplateVersion`, the PL, while no DSV of the project was generated; immutable from the first
  generation). With `NODE_ENV=production` a template not approved for live use is refused at
  generation and offer (`dsv_template_not_approved`); approved wording is a new version with
  `approvedForLive: true` from a reviewed source (Q210 stays a pilot gate for the wording). The DSV
  is contractual, per project, never an Agentur setting (rule 2).
- **D2. The generated DSV is a working copy bound to what it prints** (`dsv_form`, catalog version 8):
  encrypted, immutable, opened only through the logged opening, class `form_working_copy` with the
  expiry triggers of Q179. Category `employment_contract` (PL and back office). The PL or back office
  generates (Q60), one participation or 1–100 from the work list (all or nothing, synchronous, one
  deadline for all). **The deadline is chosen before generation** (review, spec 2): the request
  carries `{ kind: "wave", shown }` (a first offer: the wave's `signingDeadline`, the date the dialog
  showed) or `{ kind: "explicit", date }` (required for a re-offer, no default), validated then as
  `offer_deadline_valid` (today ≤ deadline ≤ the latest entry date and ≤ the effective TG start).
  `form_generation` stores every printed source value's revision (identity, address, the effective
  dates and wave, the deadline, the pinned template) as its **source token**. Generation needs an
  active `ta_tg` project, a non-terminal participation in a wave, both effective dates, the DSV track
  `not_offered`, `dsv_declined` or `dsv_expired`, and the template's inputs (a blank address goes on
  a handwriting checklist, Q197). An open offer's paper is reopened, not regenerated (`dsv_offer_open`).
- **D3. `dsvGenerated` rests on the current generation.** Valid from the Berlin day it was recorded,
  recorded at its instant; withheld once **stale** (`dsv_generation_stale`): any printed source value
  changed, its deadline passed, or a later offer ended after it. A re-offer therefore always prints
  its own deadline.

### The offer and the signatures

- **D4. The offer is the paper as generated** (Q69): `not_offered → dsv_offered` and the re-offers
  name the generation handed out; the deadline is **the generation's**, never entered again, and the
  server compares the generation's source token with the current values under the lock
  (`409 source_changed`, `dsv_generation_stale`). A `dsv_offer` row (the paper, its deadline, by/at)
  is written in the status transaction (`offer_dsv`, through `apply_status_change`). The PL or back
  office declines an open offer with the offer and status version read. Expiry stays the sweep's.
- **D5. External paper: the offer's metadata first, the scans after** (Q211, accepted; the second
  review, spec 1): a DSV the platform didn't generate (e.g. handed out before the project used the
  app) is recorded without a fabricated generation or a re-signing, in two steps with no circular
  dependency. **First** the PL or back office records the external offer from the paper in hand:
  `origin: external_paper`, the deadline, TG start and end and the parties as printed, and the
  wording's identity as far as known (`external_unknown` when not ours); the printed deadline passes
  `offer_deadline_valid`, the printed dates must equal the effective ones (`terms_mismatch`). For an
  external offer the guard `dsv_generated` reads "the offered paper's metadata is recorded" (the same
  request records it), so `not_offered → dsv_offered` needs no scan. **Then** scans are uploaded
  against that open offer as for a generated paper (D6); their review confirms, by code, that the paper
  matches the recorded metadata (`terms_mismatch` otherwise: the PL records a new offer or a
  contractual amendment) and records the actual signature dates. The signature and full-execution
  facts need accepted scans exactly as D6 and D7 say. Generated-paper staleness doesn't apply; a change
  of the effective dates while the external offer is open is refused as for any open offer
  (`dsv_offer_open`).
- **D6. The participant's signature** (`dsv_offered → dsv_signed`; PRD F8): back office or the PL
  uploads a `dsv_signed_scan` of the open offer's paper (the scan names the offer), with the dates on
  the paper per signature (participant, customer, Transfergesellschaft; each optional, none in the
  future), the staff member who received the paper and `receivedOn` (not before the participant's
  date, not in the future); nothing defaulted. Review (accept once, or reject with `unreadable`,
  `wrong_document`, `incomplete`) by the PL or back office, confirming each signature and its date as
  on the paper. Quarantine and its lift by the PL or back office; the PL deletes before review
  (catalog version 9). `dsvScanReceived` = an accepted, counting scan of the open offer showing the
  participant's signature with its receiver; `dsvSignedOn` = that signature's date. "Als
  unterschrieben erfassen" is its own status action (PL, back office), which the database checks too
  (`dsv_scan_missing`).
- **D7. `dsvFullyExecuted` rests on one reviewed complete packet** (§623 BGB, Q21, Q97; Q212,
  accepted): one accepted, counting `dsv_signed_scan` of the signed offer whose confirmed signatures
  are the participant's, the customer's and the Transfergesellschaft's; usually a second scan of the
  countersigned original, or the first scan when all three signed at once. `validOn` = the latest of
  the three **actual** dates; `recordedAt` = that scan's acceptance. The participant's date on the
  packet must equal `dsvSignedOn` (`signature_date_mismatch`). The guard also needs the track
  `dsv_signed` (Q97); inconsistent data stays `informed` and is never repaired.
- **D8. Facts withheld while their evidence doesn't count; dates stay the signatures'** (the 6-8
  review; review, spec 1): a quarantined, invalidated or deleted scan supplies nothing (every facts
  reader skips it). After a quarantine's lift the fact counts again with **its `validOn` unchanged**
  (the actual signature dates) and **`recordedAt` advanced to the lift**: a contract signed before the
  TG start but lifted after the scheduled run fails the scheduled entry (the snapshot rule) and still
  qualifies for the reconciliation. "Nachweis ungültig" for an invalidated DSV scan clears only when a
  counting scan of the **same offer**, accepted after the approval, again supports each fact the
  invalidated one supported **with its date** (the replacement of a wrong file). A wrong **date** on a
  correct paper is D8a's. The status stays; nothing restores an invalidation; an entry already made is
  never repaired.
- **D8a. A wrong signature date is superseded, never edited** (the second review, spec 3; Q88's
  document target, `dsv_signed_scan` and `dsv_cancellation`, PL or back office): the confirmed
  signatures of a scan are rows of their own (`dsv_scan_signature`: scan, kind, actual date, recorded
  at). The PL or back office (who reads the scan) requests a correction of one signature's date on an
  accepted scan, giving the truthful date as the paper shows it, a reason code and the documented
  source (Q209's rules); the regional operations manager of the region approves (four eyes, never the
  requester). The approval appends a **linked replacement row** for that signature on **every**
  accepted scan of the same offer that shows it (so `dsvSignedOn` and the packet keep agreeing,
  `signature_date_mismatch` never arises from a correction), with the corrected date as its actual date
  and the approval instant as its recording instant (`correction_id`); the original row stays,
  `superseded_by`, and the history shows the correction without dates. The facts read the current rows:
  `validOn` the corrected actual date, `recordedAt` the later of the scan's acceptance and the approval,
  so no scheduled run before the approval ever counts the corrected date. The corrected date isn't in
  the future and keeps the paper's own order (`receivedOn` not before the participant's corrected date).
  Past snapshots, statuses and an entry made stay; when the corrected dates no longer support a status
  already recorded (e.g. a packet now completed after the TG start), the PL sees "Nachweis ungültig"
  and resolves it through the reconciliation rules or the entry clarification, never a repair. No
  general field editor: `dsvSignedOn` has no field target.
- **D9. The original is tracked on the contract** (`dsv_contract`, one per signed offer; PRD F8):
  `originalLocation` (controlled, `paper_personnel_file`, Q110), `originalReceivedOn`,
  `sentToCustomerOn`; by the PL or back office, audited, changed only against the value read
  (`409 stale_value`), dates not in the future. Not a guard (Q71).

### Cancellation, withdrawal, the cutoff and never-entered contracts

- **D10. Cancellation before the effective TG start** (*verify, Q46*; Q213, accepted provisionally,
  legal verification remaining): a `dsv_cancellation` scan of the signed contract with the three
  parties' signatures confirmed at review (catalog version 10, the operations of D6);
  `dsvCancellation` = the accepted, counting cancellation, valid from its latest actual signature
  (D8's date rule). The PL withdraws (`informed → withdrawn`, user only, the PL's confirmation; the
  guard `withdrawal_after_dsv_signed`), the effective date not before the cancellation's validity
  (`effective_date_before_cancellation`) and **only while today is on or before the effective TG
  start** (`after_planned_start`: after it, D12 applies); the database checks both. The customer
  notice (Q46's flag): a case item "Kunde informieren" until the PL records "Kunde informiert am"
  (once, not in the future, not before the withdrawal).
- **D11. Manual withdrawal and the end-reason correction get their routes** (no main-status route
  exists yet): `→ withdrawn` from `imported`, `contacted`, `unreachable` and `informed` by the PL with
  a `pre_tg` reason (special category refused), an effective date (no default, not in the future)
  and the status version read; the primary end-reason correction after a system withdrawal (Q72,
  `correct_end_reason`, built in Slice 1) with the reason read. The manual contact statuses are their
  own small PR (7-9, Q215, accepted); exits are Slice 8.
- **D12. A signed DSV that hasn't entered after its planned start gets an owned clarification**
  (review, spec 3; Q214, accepted; **Q220**, open): from the day after the effective TG start, a
  `dsv_signed` participation still `informed` (and every case the flag
  `dsv_signed_not_entered_at_cutoff` names, informational, never a withdrawal) has an **entry
  clarification** owned by the project's PL, a case item "Eintritt klären" that stays until the
  participation leaves `informed`. Its actions are the existing legitimate paths only, each offered
  when its guard passes: the reconciliation (D14) when every fact held on the TG start; a new start
  date with its fully executed amendment while the latest entry date allows (process-and-lifecycle.md,
  case 3); the PL's documentation of what is pending (`awaiting_countersignature`,
  `awaiting_asu_proof`, `awaiting_profiling`, `awaiting_legal_advice`, with a documented-source line,
  Q209's rules). The PL may escalate to the regional operations manager of the region, who records
  an instruction (`legal_advice_obtained`, `dpo_instruction`, `authority_or_court_decision`,
  `parties_agreement`, with the documented source) or asks the PL again; the case stays open, since
  neither may enter or end the participation: no edge exists for a cancellation or termination after
  the planned start, and an `informed` participation can't exit. Which legal outcomes exist for such a
  contract (e.g. a termination agreement after the start, an entry deemed to have happened) and their
  edges is Q220, which blocks the pilot; nothing is fabricated meanwhile.
- **D13. The cutoff runs as built; its cases become actionable** (Q50, Q53, Q70, Q77, Q84): the sweep's
  withdrawals and flags don't change, and a signed DSV is never withdrawn by the system. The flags
  `conflict_dsv_signed_profiling_declined`, `dsv_never_offered`, `informed_without_wave_at_cutoff`
  and the new `dsv_signed_not_entered_at_cutoff` link to their actions (the return arrow before the
  cutoff, cancellation and withdrawal before the planned start, manual withdrawal, the entry
  clarification), with a dashboard tile "Klärungsfälle Stichtag".

### The TG entry guard and the reconciliation

- **D14. Real DSV facts** (process-and-lifecycle.md, TG entry guard): `dsv_facts(uuid[])` (as
  `tl407_facts`) gives `dsvGenerated`, `dsvScanReceived`, `dsvFullyExecuted` and `dsvCancellation`
  to `dbGuardFacts`; the status service, the sweep and the work list read them. `apply_status_change`
  checks the documentary ones in the database too: `dsv_offered` a current generation or an accepted
  external paper, `dsv_signed` the open offer's counting scan, `active_in_tg` in `ta_tg` a counting
  complete packet valid by the effective date (and, for a `system` entry, recorded before the run's
  instant), `withdrawn` from `dsv_signed` a counting cancellation before the planned start. The seed
  creates real DSV records through the same functions with synthetic files (Q95); the DSV keys leave
  `seedFacts`, the TL 407 and ASU overlays stay.
- **D15. The reconciliation route** (Q68 case 2, Slice 2 D10): the PL, for a `ta_tg` participation in
  `informed`, after its effective TG start (or on it once that day's run completed), when every entry
  fact was valid **on the TG start** though recorded later. The dialog lists the evidence with its
  actual dates (the complete packet, the current ASU registration, the accepted TL 407 scan or the
  approved exception); the request carries those ids and dates and the PL's confirmation; under the
  lock the server recomputes them (`409 source_changed`). The effective date is the TG start
  (derived). One `tg_entry_reconciliation` row and the status change in one transaction
  (`reconcile_tg_entry`). Never backdated on evidence valid later; no latest day is invented (Q216).
- **D16. The review, the reply and the resolution** (Q80; Q216, accepted): each reconciliation is in
  "Freigaben" for the regional operations manager of the project's region, never the PL who made it,
  due the next business day (informational): project, TG start, the evidence kinds with their valid
  and recorded days; no name, no file. Outcomes: `no_objection` (closed), or `clarification_requested`
  with a reason code (`evidence_unclear`, `date_unclear`, `other_documented`) and the documented
  source line. A clarification raises the PL's case item "Rückfrage zum Eintritt" and stays actionable
  until resolved: the PL replies (a reply code `evidence_supplemented`, `explained`,
  `correction_requested` and the documented-source line; supplementing evidence happens through its
  own operations); the manager then resolves (`resolved_no_objection`) or escalates
  (`escalated_to_dpo`, for the DPO's oversight report; it stays open, and the manager resolves it later
  on the DPO's documented instruction), or asks again. Never an automatic reversal of the entry, never
  a deadline; a wrong entry is corrected only through what Q220 and Slice 8 provide.

### Date corrections the pilot workflow needs

- **D17. `profilingDoneOn` and `withdrawnOn` get field corrections before the workflows that depend on
  them** (review, spec 4; Q88's correction-authority table): Slice 6 has no route for a wrong
  `profilingDoneOn`, which the entry guard and the reconciliation read, and a wrong manual
  `withdrawnOn` would move the non-signer deletion clock. 7-8 adds the field target to
  `request_evidence_correction` / `decide_evidence_correction` for these two fields only (PL requests,
  the region's manager approves, four eyes; reason code and documented source; append-only, the
  original kept and linked; history without values). Rules: a corrected `profilingDoneOn` is not in
  the future and not before the later actual signature date of the accepted TL 407 (Q191); a corrected
  `withdrawnOn` only for a manual withdrawal (a system withdrawal's date is derived, Rules), not in the
  future and not before the cancellation's validity where D10 applies. A correction changes the field
  and the facts read from then on, never a past snapshot, a status or an entry made. It is independent
  of retention and ships before the pilot. **A corrected fact is recorded at its approval** (the second
  review, spec 2): `tl407_facts` (redefined) gives `profilingDone` with `validOn` the corrected date and
  `recordedAt` the later of the original completion's instant, the TL 407 scan's availability and the
  correction's approval; the status service, the sweep and the reconciliation read it there. A
  regression test keeps a historical snapshot unchanged: a scheduled run before the approval still
  sees the original fact (or none), the corrected date counts only for runs after the approval or a
  reconciliation, and no recorded audit event or status changes. **The other field rows stay
  deferred** (proposed: with retention activation, Slice 9): identity by person-data writes and
  re-import, `tgStart`/`tgEnd` by dates and amendments, `tgEntryDate` by the reconciliation rules,
  `dsvSignedOn` by D8a's signature-date supersession, `profilingSessions` by Slice 6's session
  records.

### Retention (ADR-0008; data-protection.md, retention and deletion)

- **D18. Rules in the domain, periods in configuration, activation gated** (Q219, accepted):
  `packages/domain/src/retention/`: per class and item a pure `retentionDue(item, periods, today)` →
  `due { stage, from }`, `held`, `blocked { reason }` or `period_unset`, encoding the accepted rules
  as written. The periods stay `unset` in `retentionPeriods` until the DPO confirms them. Beyond the
  periods, **`retentionActivation`** lists the prerequisites of any live deletion: the periods
  confirmed, hold administration confirmed (Q218), evidence-only access built (break-glass) and the
  maintenance rules complete (backups ≤ 30 days, the erasure's restore behaviour). While any is unmet
  the job runs as a dry run: it computes and counts, and deletes nothing. Integration tests pass
  synthetic periods and an explicit test activation to the job's function; production passes only the
  catalog. Nothing reads a period or the activation from the environment.
- **D19. The job and its own database role** (ADR-0002: pseudonymisation under a separate role used
  only by the retention job; review, standards 3): a role `transfer_retention` (LOGIN, its credential
  `RETENTION_DATABASE_URL` from the secret store; `.env.example` documents a dev value) with **no table
  privilege** and `EXECUTE` only on the `retention_*` functions; `transfer_app` gets no `EXECUTE` on
  them and `transfer_retention` none on the ordinary functions. The `retention_*` functions are
  `SECURITY DEFINER` (owner `transfer_owner`) and refuse unless `session_user` is `transfer_retention`
  (`retention_role_required`). **The path through the immutability triggers** (the audit append-only
  rule, `correction_immutable`, the signed documents' immutability, the evidence-only write refusal):
  each trigger lets a delete or a pseudonymising update through only when `session_user` is
  `transfer_retention` **and** the transaction-local `transfer.retention_run` names an open
  `retention_run` row the same transaction opened; a setting alone, or the role alone, changes nothing.
  The job runs as its own process (`pnpm jobs:retention`; in the cluster a scheduled job with only that
  credential), never inside the API pod or its pg-boss workers, so the API never holds it. The run:
  the `Clock`'s Berlin day, due by database time, per project, idempotent, stage one before stage two,
  per item; a summary of counts per class and outcome, never a subject; `--dry-run` and `--today` as
  `jobs:lifecycle` (refused with `NODE_ENV=production` for `--today`).
- **D20. Stage one without a person trigger** (7-7a): `access_credential` rows (Q122), generated
  working copies' files (Q179; the row stays as the tombstone), stored objects without a document
  row older than a day (`FileStorage.list(prefix)`).
- **D21. Stage one per class, never a freeze** (review, standards 1): each class of a participation is
  deleted when its own trigger and period are due, and only that class: deleting `health_record` 3
  months after exit leaves the `personnel_file` data readable and writable as before for its own
  remaining period. Holds suspend only the records they scope (D23). **The evidence-only phase**
  (`evidence_set_since`, Q64) starts only when it applies: the participation has an evidence set
  (it entered the TG, a conservative trigger, or funding `known_yes`, D22) **and** every class
  outside the evidence set has been deleted; from then a trigger refuses writes to its rows and
  ordinary reads are refused (evidence-only access is break-glass, not built, so activation stays off,
  D18). A participation with funding `known_no` that never entered the TG has no evidence set: when its last
  class is due, it is erased (D24). Funding `unknown` blocks every deletion that depends on it
  (`funding_unknown`): the participation-record items of a non-signer and the decision between the
  evidence-only phase and erasure; `personnel_file` and `health_record` don't depend on it.
- **D22. Funding is a recorded fact** (Q217, accepted): per participation `funded110`: `known_yes`,
  `known_no` or `unknown` (default `unknown`), recorded by back office with the documented source and
  audited. **TG entry is a conservative retention trigger, never proof of Transfer-KuG** (the second
  review): a participation that entered the TG keeps an evidence set because it *may* have received
  Transfer-KuG; nothing in the app records or claims that Transfer-KuG was claimed, granted or paid
  (KuG billing is outside the MVP), so employment entry and actual funding or payment facts stay
  distinct fields, and no view, export or report says "received Transfer-KuG" from the entry. The
  settlement dates (project fields, back office, Q52) are required only where they apply:
  `kugFinalSettlementDate` when any participation entered the TG (the same conservative trigger),
  `measure110SettlementDate` when any has `known_yes`; a project with an `unknown` blocks stage two
  (`funding_unknown`). No fictitious date is asked for.
- **D23. Legal holds on the affected records only** (Q218, accepted provisionally; data-protection.md,
  retention: a hold never keeps the whole profile; the second review): the PL or back office places a
  hold at once on **selected records or classes of one participation** (e.g. the DSV scans and
  `dsv_contract`, the reminder log, one document), never on a participation as a whole
  (`hold_scope_too_broad`: no "all classes" scope), each hold with a reason code (`litigation`,
  `authority_request`, `documented_dispute`, `dpo_instruction`) and the documented basis (the source
  line, required). The job skips exactly the held rows; every other due row of the participation, of
  the same class too where only records are held, is deleted as usual. An erasure (D25) with a hold
  outstanding deletes everything due and keeps only the held rows and the participation row they
  reference (statuses and ids, no identity unless identity itself is held); the erasure completes when
  the last hold is released. A regional
  operations manager of the region who didn't place it releases it against a documented legal or DPO
  instruction (the source line, required). Audited, never a secret kept usable (Q122). Live deletion
  stays off until the hold administration is confirmed (D18).
- **D24. The DSV facts that survive the scans** (review, standards 1; Q219): the DSV scans and the
  cancellation are `personnel_file` and go with that class; their tombstones follow it. What stays in
  `participation_record` (`dsv_offer`, `dsv_contract`; evidence-set data where the participation has
  an evidence set, Q88): the offer's origin (generated or external), the template version, the offer
  deadline, the actual dates of the three signatures and `fullyExecutedOn`, `receivedOn` and the
  receiving role's kind, the day each complete fact was accepted and by which role's kind, the
  original's `originalReceivedOn` and `sentToCustomerOn` (not its location), a cancellation's
  `fullyExecutedOn` and its acceptance day; no document id, file name or staff id once the scans are
  gone (the staff references are pseudonymised as D25 says). After a class is deleted no guard is
  evaluated on it again (the participation is terminal).
- **D25. Stage two and the pseudonymisation of every subject reference** (review, standards 2): the
  evidence set at the end of the calendar year of the later required settlement date + 4 years
  (Q24, Q52), never while one is missing or funding is `unknown`. The erasure deletes the
  participation and every row referencing it in a fixed table order (a test lists every table with a
  participation reference). Its audit events are pseudonymised in the same transaction, every subject
  reference: `participation_id`, `actor_participation_id`, `on_behalf_of_participation_id`, and every
  detail key that names the subject or one of its records. Each audit event type's detail keys are
  classified in the domain's audit model (`subject`, `subject_record`, `staff`, `reference`; a test
  fails for an unclassified key): `subject` and `subject_record` values become one random pseudonym
  per erased subject or a per-record random id (no mapping kept), `reference` (codes, project, wave,
  appointment ids) stays. The same holds for `staff_audit_event` rows naming the participant and for
  queued job payloads (purged first). The history serves no erased subject.

### Cross-cutting

- **D26. Lock order** (Slice 6 D31, extended): the project's advisory lock first (shared through
  `lock_participation` for one participation; exclusive for a bulk generation, a correction's,
  reconciliation's or clarification's decision, and an erasure), then the participation rows (UUID
  order) → document rows (id order) → **`dsv_offer` → `dsv_contract`** → the profiling rows →
  `asu_registration` → the batch → `agentur_submission` rows → consent rows → the sensitive rows → the
  BA reporting task → the correction or request row → **`tg_entry_reconciliation` →
  `entry_clarification` → `legal_hold`**. The retention job takes the same order per participation;
  the audit pseudonymisation comes last, in the erasure's transaction.
- **D27. Writes go through SECURITY DEFINER functions** (ADR-0002); `transfer_app` selects the new
  tables and writes none; each function writes its audit events; `record_audit_event` refuses the new
  types; status changes only through the status function.
- **D28. Required scenarios**, each an integration test in its PR (agent-workflow.md §3):
  - a re-offer's paper prints its own deadline; a generation made before a date, address or deadline
    change is stale and can't be offered; a production generation from `dsv:v1` is refused (7-1, 7-2a);
  - an external offer is recorded from its metadata before any scan exists; its scan is uploaded
    against that offer afterwards, and its review refuses different terms (7-2a, 7-2b);
  - a wrong participant date is superseded on every scan of the offer at once, recorded at the
    approval; a run before the approval keeps the original fact (7-8);
  - a scan of an earlier offer's paper can't sign the open offer; receiver and dates are never
    defaulted (7-2b);
  - a complete packet quarantined and lifted after the TG start's run keeps its signature date:
    the scheduled entry fails, the reconciliation passes (7-3, 7-6);
  - the participant's date differs between the scans: refused (7-3);
  - an invalidated packet keeps "Nachweis ungültig" until a counting packet of the same offer with the
    same dates is accepted after the approval (7-3);
  - a cancellation-based withdrawal the day after the planned start is refused and the entry
    clarification is open (7-4, 7-5);
  - a clarification of a reconciliation stays on the PL's list through a reply until the manager
    resolves it; an escalation stays open (7-6);
  - a corrected `profilingDoneOn` is recorded at the approval by `tl407_facts`: a scheduled run before
    the approval keeps the original snapshot, a later run or a reconciliation uses the corrected date
    (7-8);
  - a hold on the DSV scans keeps them while the rest of the personnel file is deleted when due; a
    whole-participation hold is refused (7-7b);
  - `transfer_app` can't execute a retention function; `transfer_retention` can't execute an ordinary
    one or write a table; with the role but no open run the triggers refuse (7-7a);
  - with every period `unset` or activation off the job deletes nothing; with synthetic periods and
    test activation: `health_record` deleted while the personnel file stays readable; a non-signer's
    personnel file on day 91, not 90; `unknown` funding keeps the participation-record items; a held
    record kept and its neighbours deleted (7-7a, 7-7b);
  - erasure leaves no value equal to the subject's participation id, a record id of the subject or the
    participant's actor id anywhere in `audit_event` (7-7c).
- **D29. Not in this slice:** the other field corrections (D17); exits and early termination after the
  TG start (Slice 8); the legal outcomes of a never-entered signed DSV (Q220); the customer's monthly
  export with `dsvSignedOn` (Slice 9, Q13, Q47); break-glass and so live deletion (D18); the admin
  warning about missing settlement dates (needs project closure); an e-signature for the DSV or its
  cancellation, ever (rule 4).

## PRs

One planned PR = one branch = one PR, each based on `main` after the PRs it needs merged (none
stacked). The estimates count changed lines without generated code and tests and are raised for what
Slice 6 taught (6-7 and 6-8 came in at two to three times their first estimates); the redefinitions
are counted. The review's corrections split the former 7-2 (external paper) and add 7-8 and 7-9. A PR
that changes the document-type catalog takes its next version when it merges. The last PR to merge
archives this plan.

| PR | Scope | Needs | Est. lines | SQL functions redefined |
|---|---|---|---|---|
| 7-1 | DSV PDF (D1–D3): template `dsv:v1` with `approvedForLive`, the project's pin, the domain's input, validation and source token, `dsv_form` (catalog 8), single generation with its deadline, `dsvGenerated`; tab "DSV" with "Erzeugen" and "Öffnen" | — | ~1,500 | `record_form_generation` (DROP/CREATE: the deadline and token), `update_project` (the pin), `current_document_policy`, `record_audit_event` |
| 7-2a | Offers (D4, D5): `dsv_offer` from a generation or an external paper, `offer_dsv`, decline, the guard `dsv_generated` as redefined | 7-1 | ~1,000 | `apply_status_change`, `record_audit_event` |
| 7-2b | The participant's signature (D6, D8): scans with signatures and receiver, review (terms for external paper), quarantine, deletion (catalog 9), `dsvScanReceived`, "Als unterschrieben erfassen", `dsv_facts` | 7-2a | ~1,400 | `apply_status_change`, `add_document`, `review_document`, `quarantine_document`, `lift_document_quarantine`, `delete_document`, `scan_form`, `current_document_policy`, `record_audit_event` (DROP/CREATE where a parameter is added) |
| 7-3 | Full execution and the original (D7–D9, D14): the complete packet, `dsv_contract`, the entry check in the database, "Nachweis ungültig" for DSV scans, the seed on real DSV records | 7-2b | ~1,400 | `apply_status_change`, `dsv_facts`, `record_audit_event` |
| 7-4 | Work list, cutoff and the entry clarification (D2's bulk, D12, D13): "DSV unterschrieben, nicht vollständig", bulk generation, the cutoff cases' actions and tile, `dsv_signed_not_entered_at_cutoff`, `entry_clarification` with escalation and instruction | 7-3 | ~1,500 | `record_form_generation` (1–100), `record_audit_event` |
| 7-5 | Cancellation and withdrawal (D10, D11): cancellation scans (catalog 10), `dsvCancellation`, the withdrawal and end-reason routes, `after_planned_start`, the customer notice | 7-3 | ~1,400 | `apply_status_change`, `add_document`, `review_document`, `current_document_policy`, `record_audit_event` |
| 7-6 | Reconciliation, review, reply and resolution (D15, D16) | 7-3 | ~1,500 | `apply_status_change`, `record_audit_event` |
| 7-8 | Date corrections (D8a, D17): field targets `profilingDoneOn` and `withdrawnOn`, the DSV signature-date supersession, facts recorded at the approval | 7-3, 7-5 | ~1,400 | `request_evidence_correction`, `decide_evidence_correction` (DROP/CREATE: the field, the value, the signature), `tl407_facts`, `dsv_facts`, `record_audit_event` |
| 7-9 | Manual contact statuses (Q215): `imported → contacted`, `contacted ↔ unreachable` with the existing edges, guards and audit | — | ~500 | — (the route calls `change_participation_status`) |
| 7-7a | Retention framework (D18–D20, D22): the domain rules and activation gate, `transfer_retention` and the trigger path, the job process and CLI, access credentials, working copies, orphaned objects, `FileStorage.list`, settlement dates, the funding fact | 7-3 | ~1,500 | `update_project` (settlement dates), every immutability trigger function (the retention path), `record_audit_event` |
| 7-7b | Stage one per class (D21, D23, D24): the class deletions, the retained DSV facts, legal holds (place, release), the evidence-only phase | 7-7a | ~1,500 | `record_audit_event`; one new trigger function on the participant tables instead of redefining each writer |
| 7-7c | Stage two (D25): the erasure order, the detail-key classification and pseudonymisation of every subject reference | 7-7b | ~1,400 | `audit_history`, `record_audit_event`, the audit append-only trigger; `audit_event`'s participation references stay nullable (upgrade test from 7-7b with existing events) |

7-8 merges before any pilot workflow uses the DSV entry; 7-9 and 7-7a can be built beside the DSV
PRs. If a PR passes about 1,500 lines while building, the plan says so and the owner decides on a
split, as in Slice 6.

**7-4 as built:** the plan's functions and routes, with `p_batch_size` as the one parameter added to
`record_form_generation`; the readings the plan left open are Q228 (assumed). The clarification's
closing is derived (no column), the review queue carries the PL's source line for the manager, and the
reconciliation path is named on the card without a button until 7-6.

**7-1 as built** passed the estimate: about 2,800 changed lines without tests, generated code and
docs, of which about 260 are the six document functions recreated unchanged with `document_type`
(0090) and about 220 the template's HTML. Kept as one PR as instructed; the owner decides whether
to split it.

## Design

### Domain (`packages/domain`, no I/O, no system time)

- 7-1, `src/dsv/`: `dsvInput(identity, details, project, organisation, dates, deadline)` → `FormInput`;
  `validateDsvInput` (codes and keys, never values); `dsvSourceToken(values)`;
  `dsvGenerationProblem(generation, current, today)` → `null | "dsv_generation_stale"`;
  `dsvGenerationAllowed(state)`; `dsvTemplateUsable(manifest, production)`.
- 7-2a/b, 7-3: `DsvOfferOrigin` (`generated`, `external_paper`); `DsvSignature` (`participant`,
  `customer`, `transfergesellschaft`); `dsvScanProblem`; `dsvFacts(offer, scans)` → `{ dsvGenerated?,
  dsvScanReceived?, dsvFullyExecuted?, dsvSignedOn? }` with D8's rule (validOn the actual dates,
  recordedAt the acceptance or later lift); `signature_date_mismatch`, `terms_mismatch`;
  `evidenceInvalidatedSince` gains the DSV replacement rule.
- 7-4: `WorklistCaseItem` gains `dsv_not_fully_executed` (date `dsvSignedOn`) and
  `entry_clarification` (the day after the planned start); `LifecycleFlag` gains
  `dsv_signed_not_entered_at_cutoff`; `entryClarificationActions(state, facts, today)` (which
  legitimate path is open now).
- 7-5: `dsvCancellation`; `withdrawalProblem` adds `effective_date_before_cancellation` and
  `after_planned_start`; `WorklistCaseItem` gains `dsv_customer_notice`.
- 7-6: `reconciliationEvidence(facts)`; the review's state machine (`requested → no_objection |
  clarification_requested → replied → resolved_no_objection | escalated_to_dpo | clarification_requested`;
  `escalated_to_dpo → resolved_no_objection`); `WorklistCaseItem` gains `reconciliation_clarification`;
  `reviewReconciliation` gets its failure codes (`actor_not_allowed`, `four_eyes`, `not_awaiting`).
- 7-8: the correction targets gain `field` with `profilingDoneOn`, `withdrawnOn` and their rules.
- 7-7a–c, `src/retention/`: rules as data (class, trigger, period key, stage, depends on funding);
  `retentionDue`, `retentionActivation(prerequisites)`, `evidenceOnlyApplies(classesLeft, funding,
  enteredTg)`, `settlementDatesRequired(project)`; `auditSubjectKeys` per event type; 100 % coverage
  with the boundary days.

### Data model (data catalog; `project_id` on every participant table, composite FKs to `participation`)

| Table / change | PR | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|---|
| `project` | 7-1 | adds `dsv_template_version` | internal / project data | `project_master` |
| `document` (`dsv_form`), `form_generation` | 7-1 | the generated DSV; its source token, the deadline and its kind | highly confidential / `employment_contract` | `form_working_copy` (Q179) |
| `dsv_offer` | 7-2a | participation, origin, the generation (generated) or none (external), the template version or `external_unknown`, `offer_deadline`, offered by/at, the status event; its end (`signed`, `declined`, `expired`, at) | internal / `case_internal` | `participation_record` (Q219, the retained facts of D24) |
| `document` (`dsv_signed_scan`), `dsv_scan_signature` | 7-2b, 7-3 (+7-8) | adds `dsv_offer_id`, `received_by`, `received_on`, the terms confirmation for external paper; one signature row per confirmed signature (kind, actual date, recorded at; from 7-8 `superseded_by`, `correction_id`) | highly confidential / `employment_contract` | `personnel_file` (catalog) |
| `dsv_contract` | 7-3 | the signed offer; the retained facts of D24 (signature dates, `fully_executed_on`, acceptance days and role kinds); the original's location, received and sent dates | internal / `case_internal` | `participation_record` (the location deleted with `personnel_file`) |
| `entry_clarification` | 7-4 | participation, opened (the day after the planned start), the PL's pending code and source, escalation, the manager's instruction code and source, closed when the status left `informed` | internal / `case_internal` (sources as Q209) | `participation_record` |
| `document` (`dsv_cancellation`), `dsv_customer_notice` | 7-5 | the contract cancelled, the confirmed signatures; the notice date, by/at | highly confidential / `employment_contract`; internal / `case_internal` | `personnel_file`; `participation_record` |
| `tg_entry_reconciliation` | 7-6 | participation, effective date, the evidence ids and dates, the confirmation, by/at; the review's states with codes, sources and actors | internal / `case_internal` (the review: `review` stream) | `participation_record` |
| `evidence_correction` | 7-8 | adds the field target (`field_key`, the corrected date, the original) and the signature target (the offer, the signature kind, the corrected date) | internal / `case_internal` | the field's class (`participation_record`) |
| `participation` | 7-7a, 7-7b | adds `funded110` (`known_yes`, `known_no`, `unknown`; source, by/at) and `evidence_set_since` (nullable; an upgrade test from the previous migration) | internal / `case_internal` | `participation_record` |
| `project` | 7-7a | adds `kug_final_settlement_date`, `measure110_settlement_date` | internal / project data | `project_master` |
| `retention_run` | 7-7a | the run, open/closed, counts per class, stage and outcome; no subject | internal | `reference_data` |
| `legal_hold` | 7-7b | participation, the held classes or record ids (never all), reason code, documented basis, placed and released by/at | confidential / `case_internal` for its holders | kept while active, then as `audit_log` (Q219) |
| `audit_event` | 7-7c | pseudonymised references and detail values; no new column needed (the references are uuids without FKs) | internal | `audit_log` |

Enum values are added in their PR's generated migration and compared as text in that migration run.

### Functions (hand-written, SECURITY DEFINER, audit in the same transaction, the lock order of D26)

- 7-1: `record_form_generation` takes the DSV, its deadline and source token (`dsv_offer_open`,
  `dsv_not_generatable`, `offer_deadline_invalid`, `dsv_template_not_approved`, `source_changed`);
  the pin through `update_project`'s `p_dsv_template_version` (`template_pinned`; as built);
  `dsv_source_token` (internal) and `dsv_generation_current`.
- 7-2a: `offer_dsv(p_context, p_participation_id, p_generation_id, p_external jsonb,
  p_expected_status_version)` → the participation, the generation `FOR SHARE`, `apply_status_change`
  (internal), the `dsv_offer` row; `decline_dsv_offer`; `apply_status_change` checks `dsv_offered`.
- 7-2b: `add_document` / `review_document` for the DSV scan; the quarantine, lift and deletion
  functions learn the type; `apply_status_change` checks `dsv_signed`; `dsv_facts(uuid[])`.
- 7-3: `dsv_facts` adds the packet; `apply_status_change` checks `active_in_tg`; `record_dsv_original`.
- 7-4: `record_form_generation` for 1–100; `record_entry_clarification` (the PL's pending code),
  `escalate_entry_clarification`, `record_clarification_instruction` (the region's manager).
- 7-5: `add_document` / `review_document` for the cancellation; `apply_status_change` checks
  `withdrawn` from `dsv_signed`; `record_customer_notice`; the routes call `change_participation_status`
  and `correct_end_reason`.
- 7-6: `reconcile_tg_entry`, `review_reconciliation`, `reply_reconciliation_clarification`.
- 7-8: `request_evidence_correction` / `decide_evidence_correction` with the field and signature
  targets; the decision writes `profiling_done_on` or `withdrawn_on` with its correction's instant (the
  one path besides the status function, refused for any other column), or appends the replacement
  signature rows; `tl407_facts` and `dsv_facts` read the corrected values with the approval as the
  recording instant.
- 7-7a: `retention_open_run`, `retention_close_run`, `retention_purge_credentials`,
  `retention_purge_working_copy`; `set_settlement_dates`, `set_funding_status` (back office); each
  immutability trigger gains the retention path of D19.
- 7-7b: `retention_delete_class(p_run, p_participation_id, p_class)`, `retention_enter_evidence_only`;
  `refuse_in_evidence_set_phase()` on the participant tables; `place_legal_hold` (PL, back office),
  `release_legal_hold` (the region's manager, not the placer).
- 7-7c: `retention_erase_participation(p_run, p_participation_id)` (exclusive project lock, the table
  order, the pseudonymisation of D25 last).

### API (`/api/v1`, OpenAPI, RFC 9457, capabilities on every item; visibility, then permission, then state)

- 7-1: `GET /participations/{id}/dsv` → `DsvView { track, template, generations, offers, scans,
  contract, facts, capabilities }` (PL and back office; anyone else who sees the participation `403`
  without the DSV; a hidden participation `404`); `POST .../dsv/generations` (`{ deadline,
  expectedSourceToken }`) → `201 { documentId, checklist }`; `PUT /projects/{id}/dsv-template`.
- 7-2a: `POST .../dsv/offers` (`{ generationId, statusVersion }` or `{ external: { deadline,
  printedTgStart, printedTgEnd }, statusVersion }`), `POST .../dsv/offers/{offerId}/decline`.
- 7-2b: `POST .../dsv/scans` (`{ offerId, file, signatures, receivedBy, receivedOn }`),
  `POST /documents/{id}/dsv-review` (`{ decision, signatures, termsConfirmed?, reason }`),
  `POST .../dsv/signed` (`{ scanId, statusVersion }`). A document or offer of another participation,
  or one the viewer can't read, is `404`.
- 7-3: `PUT .../dsv/contract/original` (`{ field, value, expected }`); `ParticipationDetail` gains
  `dsvSignedOn` and `dsvFullyExecutedOn`.
- 7-4: `POST /projects/{id}/dsv/generations` (1–100, one deadline); `GET`/`POST
  .../entry-clarification` (pending code, escalation), `POST /entry-clarifications/{id}/instruction`;
  the work list's items and filters, the dashboard counts.
- 7-5: `POST .../dsv/cancellation-scans`, `POST /participations/{id}/withdrawal`,
  `PUT /participations/{id}/end-reason`, `POST .../dsv/customer-notice`.
- 7-6: `GET`/`POST /participations/{id}/tg-entry-reconciliation`, `POST /reconciliations/{id}/review`,
  `POST /reconciliations/{id}/reply`; `GET /reviews` gains `reconciliations` and `clarifications`
  (no participant id or name, by schema).
- 7-8: `POST .../evidence-corrections` gains `correct_field { field, value }` and
  `supersede_dsv_signature { offerId, signature, signedOn }`.
- 7-9: `POST /participations/{id}/contact-status` (`{ to, statusVersion }`).
- 7-7a/b: `PUT /projects/{id}/settlement-dates`, `PUT /participations/{id}/funding`,
  `POST /participations/{id}/legal-holds`, `POST /legal-holds/{id}/release`.
- Logs carry ids and codes, never a name, date of birth, signature, source line or file name.

### History (`auditProjection` + an `audit_event_projection` migration row each; `audit_event_lifecycle_has_participation`; `record_audit_event`'s refused list; a German history label; 7-7c: each detail key's subject classification)

| Event | PR | Stream | Shows |
|---|---|---|---|
| `dsv_form_generated` (as built: its own type, since a projection is per type and `form_generated` is in `case`; Q226), `dsv_template_pinned` (project-level) | 7-1 | `dsv` | template version, deadline kind |
| `status_changed` (DSV track) | 7-2a | `dsv` | as built; the offer's origin |
| `document_added`, `document_reviewed`, `document_quarantined`, `document_quarantine_lifted` (DSV types) | 7-2b, 7-5 | `dsv` | type, decision, reason, the confirmed signature kinds |
| `dsv_original_recorded` | 7-3 | `dsv` | the field, the location code |
| `entry_clarification_recorded`, `_escalated`, `_instructed` | 7-4 | `case` | the codes, never the source |
| `dsv_customer_notified`, `end_reason_corrected` | 7-5 | `dsv`, `case` | the date; as built |
| `tg_entry_reconciled` | 7-6 | `case` | the effective date, the evidence kinds |
| `reconciliation_reviewed`, `reconciliation_replied` | 7-6 | `review` (never in a history) | — |
| `evidence_correction_requested` / `_decided` (field) | 7-8 | `case` | the field key, never a value |
| `settlement_dates_set`, `funding_status_set` | 7-7a | project-level, `case` | the value code |
| `legal_hold_placed`, `legal_hold_released`, `retention_applied` | 7-7b | `security` (never in a history) | — |

### Web UI (`apps/web`, German; every button by its capability)

- **Tab "DSV"** (`ta_tg`, PL and back office): "Vertrag erzeugen" (the deadline first: "Frist:
  Unterschriftsfrist der Welle, 12.03." or "Frist eingeben"; the handwriting checklist), the
  generations ("Öffnen", "veraltet"); "Angebot erfassen" (the paper) and "Papierangebot ohne
  Erzeugung erfassen"; "Abgelehnt erfassen"; "Scan hochladen" (offer, signatures seen with their
  dates, "Entgegengenommen von", "am"; nothing preset), the review dialog (each signature, the terms
  for external paper), "Quarantäne"; "Als unterschrieben erfassen"; the signatures panel ("vollständig
  unterschrieben am"); "Original"; "Aufhebungsvertrag"; "Eintritt klären" with its legitimate
  actions. The page header: "Zurückziehen", "Eintritt nachträglich erfassen", "Grund korrigieren",
  "Kontaktstatus" (7-9). The project's settings: "DSV-Vorlage" (7-1).
- **Work list and dashboard** (7-4): filter "DSV: unterschrieben, nicht vollständig"; items "DSV nicht
  vollständig unterschrieben", "Eintritt klären", "Kunde informieren", "Rückfrage zum Eintritt";
  cutoff flags with their action; bulk "DSV erzeugen"; tiles "DSV nicht vollständig" and
  "Klärungsfälle Stichtag".
- **"Freigaben"** (7-4, 7-6, 7-8, 7-7b): reconciliations ("Ohne Einwand", "Rückfrage", after a reply
  "Erledigt" or "An DSB eskaliert"), escalated entry clarifications ("Weisung erfassen"), field
  corrections, hold releases.
- **Project "Abrechnung"** and the participant's "Förderung" and "Aufbewahrung" (7-7a, 7-7b, back
  office and PL as D22 and D23 say).
- Dialogs capture their target when opened (the offer, the scan, the deadline, the evidence ids) and
  render at the section's root, never inside a table cell.

## Lessons (Slices 6 and 6-8)

- Visibility before permission before state: a hidden participation, document, offer, clarification or
  reconciliation is `404`, never a `403` or `422` that reveals what the viewer can't see.
- Every write compares what the user reviewed (ids, revisions, states, the deadline and the source
  token) under the lock (`409 source_changed` / `stale_status`); dialogs capture their target; no
  default dates, reasons or sources; a choice the UI restricts is enforced server-side, and the
  documentary guards in the database too.
- A fact resting on evidence is withheld while that evidence doesn't count, and cleared only by
  evidence that supports the fact, its linkage (the same offer) and its effective date; a lift moves
  the recording instant, never the actual date.
- Every status change goes through the status function with its audit; every new audit event needs
  its projection rows, `audit_event_lifecycle_has_participation`, `record_audit_event`'s refused list,
  a history label and, from 7-7c, its detail keys' subject classification.
- A new FK or NOT NULL on an existing table needs a tested upgrade path from the previous migration
  (`document.dsv_offer_id`, `participation.funded110` and `evidence_set_since`).
- A new parameter on a hand-written SECURITY DEFINER function means DROP (the old signature), CREATE,
  the grants again; a new role means its grants tested both ways (what it can, what the others can't).
- A migration change to this PR's own unmerged migration may be regenerated in place; a merged one
  never.
- Drizzle renders unqualified columns in single-table selects, so a correlated subquery names its
  tables.
- Carbon modals render at a section's root, never inside a table cell (axe measures the trigger
  through the overlay otherwise).
- e2e specs use their own owner-fixture participants; screenshots go to `docs/screenshots/<pr>/`.
- Carried from Slice 5b: plpgsql `text[] || 'x'::text`; enum values compared as text in their
  migration run; boolean helpers never null; no `new Date(` in the domain; Zod enums used nullable get
  their own schema; no `.default()` in inputs; `pnpm verify:changed` while working, `pnpm verify`,
  `pnpm build` and `pnpm test:e2e` before a push; `pnpm generate` after API, registry or domain-table
  changes; `pnpm format` before committing.

## User flows

1. **Info event:** the PL selects the 30 participants of wave "W1", "DSV erzeugen" with "Frist:
   Unterschriftsfrist der Welle, 12.03." (two blank addresses on the checklist), opens the print file;
   back office records "Angebot erfassen" for each paper. One participant brings a DSV the TG handed
   out on paper last month: "Papierangebot ohne Erzeugung erfassen" with the printed deadline.
2. **Signature:** back office uploads the returned paper ("Teilnehmer·in 14.03.", received by themself
   on 15.03.), the PL accepts it, back office records "Als unterschrieben erfassen". The work list shows
   "DSV nicht vollständig unterschrieben".
3. **Countersignature:** the customer and the TG sign; back office scans the packet, the PL accepts it
   with the three dates ("vollständig unterschrieben am 20.03."), the original "in der Personalakte",
   "an Kunden gesendet am 21.03.". On the TG start the sweep enters the participation.
4. **Late evidence:** a packet signed before the TG start was quarantined by mistake and lifted the
   day after: the entry didn't run; "Eintritt nachträglich erfassen", the region's manager asks
   "Rückfrage: Datum unklar", the PL replies "erläutert" with the source, the manager records
   "Erledigt".
5. **Cancellation:** before the TG start the three parties sign a cancellation; back office uploads it,
   the PL accepts it, withdraws with `placed_direct` and records "Kunde informiert am".
6. **Never entered:** the countersignature is still missing after the planned start: "Eintritt klären"
   ("Gegenzeichnung ausstehend"); with the amendment executed the PL records a new start before the
   latest entry date. Another case after the cutoff is escalated; the manager records "Rechtsrat
   eingeholt"; the case stays open until Q220 provides its outcome.
7. **Mistake:** a wrong `profilingDoneOn` blocks an entry; the PL requests a correction with the
   signature date of the TL 407, the manager approves; the missed start is reconciled (the corrected
   fact is recorded at the approval, after the run). Back office typed the participant's DSV date as
   14.04. instead of 14.03.: a signature-date correction, approved, supersedes it on both scans.
8. **Retention:** `pnpm jobs:retention --dry-run` lists every class `period_unset` and activation off;
   nothing is deleted.

## Acceptance criteria

**7-1**
- The template is in the forms manifest and the immutability check, stamped on every page,
  `approvedForLive: false`; a contract test renders it with Gotenberg and reads the variable parts back
  (`Ł`, `ğ`), the deadline included; HTML in a name is escaped.
- The project's pin by the PL, fixed from the first generation; a production generation from an
  unapproved template refused.
- Generation by the PL and back office (consultant `403`, hidden participation `404`); the deadline
  required, validated and printed; every precondition code at its boundary; the generation stale after
  any printed value or the deadline changes; working-copy expiry as a retention-plan test; e2e
  generate and open, screenshots `docs/screenshots/7-1/`.

**7-2a**
- An offer from a current generation takes its deadline; a stale generation or a changed source value
  `409`; an external offer is recorded from its metadata alone (no scan exists yet), its printed dates
  equal to the effective ones (`terms_mismatch`), and passes `dsv_generated` without a generation; the
  database refuses `dsv_offered` without either; decline as built.

**7-2b**
- The scan names the open offer (another offer's paper refused); dates in the future, `receivedOn`
  before the participant's date and a missing receiver refused; nothing defaulted; the review confirms
  each signature and, for external paper, the terms (`terms_mismatch`).
- `dsv_signed` only with a counting scan of the open offer, in the service and the database; a
  quarantined scan withholds the fact; e2e offer → scan → review → signed.

**7-3**
- `dsvFullyExecuted` from one counting packet with three confirmed signatures; `validOn` the latest
  actual date, `recordedAt` the acceptance or the later lift (D28's quarantine scenario);
  `signature_date_mismatch`.
- The scheduled entry with real facts recorded before the run; the database refuses `active_in_tg`
  without the packet; the original against the value read; "Nachweis ungültig" as D8; the seed builds
  its DSV records through the functions and `seedFacts` has no DSV key.

**7-4**
- The list item, filter and tile count the same participations in one snapshot; bulk generation 1–100
  with one deadline, all or nothing.
- `dsv_signed_not_entered_at_cutoff` from the day after the cutoff, informational; the entry
  clarification opens the day after the planned start, offers only the paths whose guards pass, takes
  the PL's pending code, the escalation and the manager's instruction (not the PL), and closes only
  when the status leaves `informed`.

**7-5**
- A withdrawal of a signed DSV needs a counting cancellation, the PL's confirmation, a date not before
  the cancellation and today on or before the planned start (service and database); the end-reason
  correction as Q72; "Kunde informieren" until recorded; e2e cancellation → withdrawal → notice.

**7-6**
- The reconciliation after the TG start with every fact valid on it, evidence compared under the lock,
  one row and one status change; the review by the region's manager only (`four_eyes`); a clarification
  stays on the PL's list through the reply until resolved; an escalation stays open until resolved;
  no reversal; the queue carries no participant name or id (schema test); e2e reconciliation → review.

**7-8**
- Field corrections of `profilingDoneOn` and `withdrawnOn` only, by the PL, approved by the region's
  manager; the rules of D17 at their boundaries; `tl407_facts` records the corrected fact at the
  approval, with the snapshot regression of D28; the status doesn't change; the history shows the
  field, never a value.
- DSV signature-date supersession (D8a): requested by the PL or back office, approved by the region's
  manager; the replacement rows on every scan of the offer showing the signature, the originals kept
  and linked; facts recorded at the approval; "Nachweis ungültig" when a recorded status loses its
  support.

**7-9**
- The manual contact statuses with the existing edges, guards (`before_cutoff`) and audit; the roles of
  Q60; a stale status version `409`.

**7-7a**
- Grants tested both ways: `transfer_app` can't execute a retention function or delete an audit
  event; `transfer_retention` can't execute an ordinary function or touch a table directly; with the
  role but without an open run the triggers refuse.
- With the catalog or activation off the job deletes nothing and reports every class; with synthetic
  periods and test activation: credentials stripped on day 31, a working copy's file purged at its
  trigger, an orphaned object purged.
- Settlement dates and funding by back office against the values read.

**7-7b**
- `health_record` deleted while `personnel_file` stays readable and writable; a non-signer's personnel
  file on day 91; `unknown` funding keeps the participation-record items; a held record kept, its
  neighbours and the unheld classes deleted; a hold without selected records or classes, or naming the
  whole participation, refused; a hold released only by another regional manager with a source; the
  evidence-only phase only when it applies (then writes refused by the trigger and ordinary reads
  refused); the retained DSV facts of D24 survive the scans' deletion.

**7-7c**
- Stage two blocked without a required settlement date or with `unknown` funding; the erasure covers
  every table referencing a participation; afterwards no subject id, subject record id or participant
  actor id remains anywhere in `audit_event`, `staff_audit_event` or the job queue; every detail key of
  every event type is classified (test).

## Docs updated by the PRs

- 7-1: ba-forms.md and ADR-0009 (the DSV template, `approvedForLive`, the pin), data-protection.md
  (the generated DSV), process-and-lifecycle.md (generation with its deadline), ADR-0002, ADR-0010.
- 7-2a, 7-2b: process-and-lifecycle.md (offers, external paper, the guard `dsv_generated` as
  redefined, the signature), data-protection.md (DSV scans, the catalog versions), ADR-0002, ADR-0010.
- 7-3: process-and-lifecycle.md (full execution, the TG entry guard as built, the original),
  data-protection.md (withheld facts and the lift rule), ADR-0002, ADR-0011.
- 7-4: process-and-lifecycle.md (the list, the cutoff cases, the entry clarification),
  architecture/overview.md.
- 7-5: process-and-lifecycle.md (cancellation, withdrawal, end reason, customer notice).
- 7-6: process-and-lifecycle.md (the reconciliation), data-protection.md (its review and reply).
- 7-8: data-protection.md (evidence corrections: the two field targets).
- 7-9: process-and-lifecycle.md (the manual contact statuses).
- 7-7a: ADR-0002 (`transfer_retention`, its grants and the trigger path), ADR-0008, ADR-0011,
  ADR-0006 (`FileStorage.list`), data-protection.md (retention as built, funding, settlement dates),
  `.env.example` (`RETENTION_DATABASE_URL`).
- 7-7b, 7-7c: data-protection.md (per-class deletion, the evidence-only phase, holds, the retained DSV
  facts, the pseudonymisation of every subject reference), ADR-0008; the last PR: roadmap.md (Slice 7
  done; the other field corrections with retention activation) and this plan to `docs/plans/archive/`.

## Questions

Decided in [the review](../reviews/2026-11-06-pr-104-product-review.md): Q210–Q219 (their rows). New:
Q220. Existing ones the slice rests on: Q3, Q24, Q46 (verify), Q52, Q64, Q68, Q69, Q71, Q72, Q77,
Q80, Q88, Q97, Q110, Q122, Q141, Q145, Q156, Q166, Q179.

**Block the pilot:** approved DSV wording (Q210); the legal outcomes of a never-entered signed DSV
(Q220); the cancellation's legal verification (Q46, Q213); the confirmed retention periods, hold
administration and evidence-only access before any live deletion (Q3, Q24, Q77, Q218, Q219, D18).

**Block part of a PR:** none (the second review keeps Q220 open behind its pilot gate, its clarification flow accepted for development). Every PR builds on an accepted reading or a fail-safe gate; Q220 keeps the
entry clarification open-ended (7-4) and the retention activation stays off (7-7a–c).
