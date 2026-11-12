# Data protection: retention

## Retention and deletion *(verify, Q3, Q24, Q40, Q51, Q52)*

**Each data item or document follows its own retention class.** Where one item falls under
several rules, the longest of those rules applies. Retention is **per item, never per person**,
so a long payroll rule never keeps a whole profile.

| Data | Retention (from) |
|---|---|
| Non-signers (`withdrawn` pre-TG) without BA-funded measures | full deletion **90 calendar days after `withdrawnOn`** (manual or automatic withdrawal), if there was no fully executed DSV, funded §110 participation, legal hold or other retention duty. *Assumed (Q77): `unset` in executable configuration until the DPO confirms.* |
| Non-signers with BA-funded §110 measures | Personnel and health retention mappings remain unconfirmed; the 90-day branch does not apply (Q236). The evidence set follows its own settlement-based period. |
| Structured health fields (class `health_record`, Q141) | 3 months after beE exit, or with non-signer deletion |
| Schwerbehinderung status for payroll | with payroll records, as long as payroll needs it |
| TG personnel file, DSV, profiling, placement data | 3 years after the end of the year of exit |
| Sub-status periods (sickness etc.) | payroll retention |
| Lohnkonto | end of the 6th calendar year after the last entry (§41 EStG) |
| Entgeltunterlagen | end of the calendar year after the last social-security audit (§28f SGB IV) |
| Accounting vouchers | 8 years (BEG IV); books and annual statements 10 years |
| ESF-funded projects (later) | per funding notice, configurable |
| Audit log | 3 years; pseudonymise subject references when the subject's data is deleted (also `reminder_queued` and `reminder_delivery`, Q156) |

**Evidence set** (for anyone who took part in a BA-funded §110 measure or received
Transfer-KuG): identity, measure, dates and times of participation, signed participation pages
(TL 407, Kug 200b), proof of submission, and the matching audit entries.
- It expires at the end of the calendar year of the **later** of `kugFinalSettlementDate` and
  `measure110SettlementDate`, plus 4 years (configurable, must be verified).
- It is **not deleted until the required settlement dates are set**. The admin dashboard warns
  when a project ended more than 12 months ago without them.
- Access is break-glass only.

**Retention classes of the tables so far** (`packages/db/src/data-catalog.ts`). The data catalog
keeps every period `unset` until the retention job (Slice 7) implements the accepted rules, so no
deletion job touches any class before then. Round 32 recorded accepted sample-data pilot rules for
`project_master`, `participation_record` and `personnel_file` (Q58, Q105, pilot DPO role); among
them, a legal hold suspends only the affected records, never the whole participant profile:

| Class | Tables | Rule |
|---|---|---|
| `project_master` | `appointment` (an info event or slot: kind, times, capacity, the generic title and the shared venue, status and closed cancel reason, host and creator staff ids; Slice 5b, Q166), `project` (from Slice 3 with its region), `project_membership` (staff ids and project roles, Slice 2; a removed role's row is deleted, its event stays, PR 3c), `project_entry_wave`, `import_column_mapping` (the keyed hash of a normalised column header and its target, saved by a confirmed import, never header text; Slice 2, PR 2g. **Classed `confidential`, possibly pseudonymised participant data**: if a PL picks a data row as the header row, the hashes are keyed hashes of a person's values, which are pseudonymised, not anonymised (Art. 4(5) GDPR). The confirm saves no mapping when the chosen header row looks like a data row (a date, an `@` or five or more digits in a cell); hashes are never served, logged or exported; rotating the derived key makes every stored hash unlinkable. It stays in this class because it can't be linked to a person or participation. The runtime role writes it directly (SELECT, INSERT, UPDATE; no DELETE; not audited, a cache of hashes): the one project-data table written outside a database function), `project_template_pin` (which template versions a project pinned, by which staff user, Slice 2), `project_config_override` (override versions: Agentur-scoped settings with source codes, the confirming staff id and date, approved relaxations with rule id, reason code, approving staff id and date; project-wide, no participant data; append-only, PR 2d-1), `config_relaxation_request` (relaxation requests: rule id, controlled reason code, status, requesting and deciding staff ids and dates; project-wide, no participant data, PR 2d-2) | accepted in [round 32](../../decisions/2026-10-19-answers-round-32.md) for the pilot (Q58): retained while active or unsettled; after closure until the later of the end of the 3rd calendar year after closure and the end of the 4th calendar year after the later BA/§110 final settlement date; a never-activated draft without participants, never submitted externally: 1 year after its last activity. At expiry membership links and actor references are deleted or pseudonymised per the audit policy and identifying free text deleted; accounting, payroll, contract and tax records keep their own classes |
| `staff_account` | `staff_user` (name, email, `may_create_projects`; from Slice 3 the bound OIDC identity `oidc_issuer`/`oidc_subject` and `deactivated_at`; the flat role is gone, PR 3c), `staff_org_role` (current org-role grants: role, region, who granted it when; `internal`; revocation or account deactivation deletes the row while the event preserves role, region and reason; Slice 3, PR 3c/Q131) | deactivate and pseudonymise the account, never delete it (Q59, assumed); executable period remains `unset` |
| `access_credential` (Slice 3, PR 3b/3d) | `staff_session` (the SHA-256 of a session token, never the token; the staff user, start, expiry, end and end reason; `internal`); `activation_code` (a separately keyed code hash and, only for in-person issuance, a separately keyed destination hash; channel, non-secret state, staff ids and times; never the code or destination; `confidential`, project-scoped); from PR 3e `one_time_code_challenge` (a keyed one-time-code hash, the normalised address it went to, outcome, attempts, times; `confidential`) and `participant_session` (a token's SHA-256, state, steps done, step-up, from Slice 4a the step-up before special-category data and its wrong birth dates, times; `internal`); from Slice 4b `export_link` (an export's link: a token's SHA-256, the project, the kind, the document ids, the staff user and the session's hash, expiry; no file; Slice 6, PR 6-4b; `internal`); `document_link` (an opening's link: a token's SHA-256, the document, the session's kind and hash, expiry; `internal`, no privilege for the runtime role) | deleted, or stripped of hashes and addresses, 30 days after use, expiry, lock, revocation or end; a legal hold never keeps a secret usable (Q122, assumed). The job applies it once its period is set (retention as built, below); the executable period remains `unset` |
| `participation_record` | `participation` (statuses, dates, end reasons and, from Slice 4a, the placement Agentur key and when it was set: `internal`, `case_internal`, listable; written only by `set_placement_agentur`, PR 4a-1), `participant_assignment` (which consultant a participation is assigned to, by whom and when, how it ended; ids and codes, `internal`, closed, never deleted; Slice 3, PR 3c), `participant_identity` (Personalnummer, last and first name, birth date; Slice 2, PR 2f), `participant_identifier_data` (the encrypted RV-Nummer, its presence, key id and times; `highly_confidential`; Slice 4a, PR 4a-4; from Slice 6, PR 6-4a, the encrypted BA-Kundennummer of the ASU attestation and its presence), `participation_dsv_amendment` (DSV amendment metadata: kind, date fully executed, old and new effective dates, the confirming staff id and instant, the controlled original location, an optional document number; no free text; immutable; part of the evidence set, round 32 D3; Slice 2, PR 2h-3), `ba_reporting_task` (BA reporting tasks: kind, the date reported on, status; Slice 2, PR 2h-3), `profiling_session` (the profiling sessions: date and times, who recorded them; evidence-set data, Q88; Slice 6), `profiling_exception_request` (reason codes and an evidence id and fingerprint, never evidence contents; the fingerprint is confidential evidence metadata, never in audit details, logs or responses, round 17), from Slice 6, PR 6-7, `profiling_exception_evidence_record` (the evidence a request rests on: kind, the accepted documents' ids or the normalised BA confirmation, its fingerprint, who recorded it and when; immutable; confidential; the documents themselves are `profiling_exception_evidence`, "Exception evidence"); from Slice 6, PR 6-3b, `signed_declaration` (the declarations of an accepted signed form as marked, immutable; confidential); from PR 6-4a `asu_record` (the ASU route and its version) and `asu_registration` (the registration: route, actual date, proof kind, the proving document's id, the attestation's source, who recorded and linked it and when; `internal`), `kug200b_decline` and `kug200b_withdrawal` (the Kug 200b offer's decline date, a withdrawal's receipt and BA notice with the consent record it ended, staff ids and times; `internal`; Slice 6, PR 6-4b) | accepted in [round 32](../../decisions/2026-10-19-answers-round-32.md) for the pilot (Q77/Q105): non-signer without a fully executed DSV or funded §110 participation 90 calendar days after `withdrawnOn` (unless a legal hold or documented dispute); fully executed DSV without TG entry, end of the 3rd calendar year after cancellation or contractual end; TG participant, end of the 3rd calendar year after exit; BA-funded, the minimum evidence set until the end of the 4th calendar year after the later of `kugFinalSettlementDate`/`measure110SettlementDate`, never while one is missing |
| `audit_log` | `audit_event`, `staff_audit_event` (staff authentication and administration history: staff ids, codes and counts; account, org-role and region changes; removed org roles preserve role, region and reason; never a name, email, claimed identity, token or claim; no `project_id`, `internal`; Slice 3, PR 3b/3c) | 3 years; subject references pseudonymised when the subject's data is deleted; entries of an evidence set follow it (Q3, verify) |
| `personnel_file` (Slice 2, PR 2f; Slice 3, PR 3d) | `participant_details`: street and house number, postal code, city, `addressCountry`, phone, mobile, private and work email, `oldEmploymentEndDate`, from Slice 6 (PR 6-4a) `knowledgeDate`; `privacy_notice_delivery`: immutable Article 14 evidence with version, language, method, staff id, time and optional activation-code id, never notice text or destination (`internal`, project-scoped); from PR 3e `participant_account` (activation time, code id, identity assurance with the staff confirmer of a photo ID, language; `internal`), `participant_channel` (the field `portalChannels`: kind, normalised private address, verification, consent id, notice, suspension and removal dates; `confidential`; the address and its hash erased 30 days after removal, Q122) and `consent_record` (purpose, source, the channel id of a portal contact consent, text version, language, actor and dates, never the address; `confidential`); from Slice 4a (Q141) `participant_profile` (the self-service profile, TL 407 section B: `confidential`), `self_service_notice_acknowledgement` (the purposes notice acknowledged: version, language, actor, time; `internal`, immutable), `participant_residence_social_data` (the encrypted nationality, entry date, residence status and Bürgergeld, their presence, key id and times; `highly_confidential`; PR 4a-4) and, on `participant_details`, which contact fields the participant maintains and when they wrote the address (metadata); from Slice 5 (Q156) `participant_reminder` (the reminder log: ids, kind, text version, language, the channel's id and kind, the consent id, the requester's id, times, status, cancel reason; `internal`, `case_internal`; non-signers with the 90-day deletion, otherwise the end of the 3rd calendar year after exit; a legal hold extends only the affected rows; the channel's address is erased under its own rule, the reminder keeps the value-free channel id); from Slice 5b (Q166) `appointment_booking` (which appointment, origin, status, closed cancel reason, the booking and cancelling staff ids, times, from 5b-2 the attendance with its basis and conflict, from 5b-4 the follow-up link and a missed appointment's closed resolution; `internal`, `case_internal`; its triggers, **mapping awaiting confirmation**: a non-signer without a fully executed DSV, funded §110 participation, legal hold or other duty 90 days after `withdrawnOn`; an executed DSV without TG entry the end of the 3rd calendar year after cancellation or contractual end; a TG participant the end of the 3rd calendar year after exit; proposed: `ta_completed` in a `ta_only` project the end of the 3rd calendar year after that change, withdrawn with a funded participation the end of the 3rd calendar year after `withdrawnOn`; a legal hold suspends only the affected rows; never BA evidence); from Slice 6 (Q192, Q193) `participant_profiling` (the pending declarations to the BA, who recorded them, the record's revision; `confidential`), `participant_profiling_assessment` (section C and p. 7, encrypted, presence and revision; `highly_confidential`) and the unemployment period on `participant_residence_social_data` | accepted in [round 32](../../decisions/2026-10-19-answers-round-32.md) for the pilot (Q105): non-signer without an executed DSV or funded measure 90 days after `withdrawnOn`; TG participant or executed employment arrangement, end of the 3rd calendar year after exit, cancellation or contractual end; then the whole class is deleted unless a field was copied into a separately classified payroll, accounting or legal record; never part of the BA evidence set |
| `health_record` (Q141) | `participant_health_data` (Slice 4a, PR 4a-4): the encrypted health restrictions and Schwerbehinderung/Gleichstellung yes/no answers, their presence, key id and times (`special_category`); from Slice 6 `participant_profiling_health_assessment` (the section C health line's encrypted rating, no text, Q40, Q192) | 3 months after beE exit or with the non-signer deletion; executable period `unset` until Slice 7 |
| `by_document_type` (Slice 4b, PR 4b-2; Q145) | `document`: each row its type's class, held by its policy (`personnel_file` for the CV, other uploads and certificates; `evidence_set` for the signed TL 407 and Kug 200b scans; `personnel_file` for the DSV scan and cancellation; `participation_record` for the ASU proof and exception evidence; from Slice 6 `form_working_copy` for the generated TL 407). The metadata of an encrypted file (type, media type, size, the kept file name, who added and reviewed it, the content hash and the wrapped key the runtime role can't select); a deletion's tombstone (type, dates, who by kind, reason code; the file name erased) follows the type's class, its object is purged at once | the type's class; executable periods `unset` until Slice 7 |
| `evidence_set` (Slice 4b) | no table of its own: `document` rows of the signed TL 407 and Kug 200b scans | the BA evidence set (above); `unset` until Slice 7 |
| `form_working_copy` (Slice 6, PR 6-3a; Q179) | `document` rows of the generated forms (`tl407_form`), `form_generation` (their provenance and declaration snapshot; confidential) | the file 30 days after supersession or the accepted signed scan, 90 days after an abandoned generation, 30 days after the terminal status, a legal hold suspending each; the rows stay as the tombstone (generated forms, above); proposed, `unset` until the DPO confirms; the job applies it once set (retention as built, below) |
| `reference_data` | `region` (code and name of a Niederlassung; Slice 3, PR 3c), `retention_run` (a retention run: its day, dry or not, counts per class; no subject; Slice 7), `lifecycle_edge`, `job_run` (job names, run dates and instants, PR 1h-1), `config_template_version` (template contents as released; global, no `project_id`), `document_type_policy` (the document type catalog per version: classes, file names, roles, from version 3 whether the type is generated; Slice 4b, Slice 6) | no personal data; never touched by the retention job |

Implementation:
- `retentionClass` per data category and document type, configured as data.
- A nightly, idempotent, **two-stage job** with the `system` actor: full deletion first, then
  evidence-set deletion.
- **Backups are kept for at most 30 days**, so that deletions take effect.
- All periods are configurable. The round 32 values are accepted for the sample-data pilot and
  should be reviewed again before production or real-personal-data use.

**Retention as built (Slice 7, PR 7-7a; readings Q234).** The rules are data in the domain
(`packages/domain/src/retention/`: per class its triggers, its stage and whether the job applies
it; `retentionDue(item, periods, today)` gives `period_unset`, `never`, `held`, `not_due` or
`due`), the periods configuration (`retentionPeriods` in the data catalog, every one `unset` until
the DPO confirms it, Q3, Q24), and **live deletion is gated** by `retentionActivation`: the periods
confirmed, hold administration confirmed (Q218), evidence-only access built (break-glass) and the
maintenance rules complete (backups at most 30 days, an erasure's restore behaviour). The catalog's
`retentionPrerequisites` are all unmet, so every run is a dry run that computes and counts and
deletes nothing. Nothing reads a period or the activation from the environment.
- **The job** (`pnpm jobs:retention [--dry-run] [--today YYYY-MM-DD]`, ADR-0011) is its own
  process with its own database role `transfer_retention` (ADR-0002, the retention role), never
  the API's. One run is one transaction for the Berlin day of the job's clock (database time
  decides: a later day is `run_not_due`), idempotent; its `retention_run` row keeps the day, dry or
  not and a summary of counts per class and outcome, never a subject; logs carry the same counts.
- **Stage one without a person trigger** applies, once its period is set and activation is on:
  access credentials (above; deleted, a row still referenced waits), generated working copies'
  files at their trigger (the object deleted, the row kept as the tombstone, deleted by `system`
  with its file name erased) and **orphaned objects** (a stored object without a document row, its
  own class `orphaned_object`, never one written in the last 24 hours; `FileStorage.list`,
  ADR-0006). Every other class is reported (`period_unset` or `not_applied`) and never deleted.
- **The immutability triggers** (the audit trail, now append-only for every role by trigger; the
  evidence corrections, BA reporting tasks, the Article 14 and notice evidence, exception evidence,
  the configuration's append-only tables, the request tables) let a delete or update through only
  inside a retention run: the session's role `transfer_retention` and the transaction-local
  `transfer.retention_run` naming an open run the same transaction opened.

**Retention per class, legal holds and the evidence-only phase *(Slice 7, PR 7-7b; readings
Q235)*.**
- **Each class at its own trigger and period, only that class.** Per closed participation
  (`withdrawn`, `ta_completed`, `exited`) the job applies `personnel_file` and `health_record`
  (`retention_delete_class`) when `retentionDue` says so; the triggers are `non_signer_withdrawn`
  (withdrawn before the TG without a fully executed DSV, from `withdrawnOn`), `closed_without_tg`
  (withdrawn with a fully executed DSV, from that day) and `exited` (the exit
  date). A period per trigger is days, calendar months or the end of the n-th calendar year after
  the trigger's year; every one stays `unset` until the DPO confirms it. Deleting the health record
  leaves the personnel file readable and writable. Documents of a class become tombstones (deleted
  by `system`, file name erased, object deleted first). A row another kept row references waits (a
  consent behind a Kug 200b withdrawal). Each deletion is audited `retention_applied` (security
  stream, class and counts only).
- **Funding `unknown` blocks** the participation record of a participation that never entered the
  TG (`funding_unknown`, reported, nothing deleted) and the choice between the evidence-only phase
  and the erasure. For non-signers, it also blocks the personnel file and health record; the
  90-day branch applies only to `known_no`. For `known_yes` neither class has a confirmed mapping.
  `ta_completed` and health after `closed_without_tg` remain unmapped (Q236). The participation
  record itself goes only with the erasure (stage two, Slice 7, PR 7-7c).
- **The retained DSV facts** stay in `dsv_offer` and `dsv_contract` (signature dates,
  `fullyExecutedOn`, acceptance days and role kinds, the original's received and sent dates) when
  the scans, their signature rows and the original's location go with the personnel file.
- **Legal holds** (`legal_hold`, confidential, class `audit_log`): the PL or back office of the
  project places one on selected classes (`personnel_file`, `health_record`, `form_working_copy`,
  `evidence_set`), record kinds (e.g. `dsv_contract`, `participant_reminder`) or documents of one
  participation, never all classes (`hold_scope_too_broad`) and never nothing (`hold_scope_empty`),
  with a reason code (`litigation`, `authority_request`, `documented_dispute`, `dpo_instruction`)
  and the documented basis, against the active holds read (`409 stale_holds`). A regional operations
  manager of the project's region who didn't place it releases it in "Freigaben" with the
  instruction's source; once (`409 hold_released`). Both audited in the security stream without the
  basis or source. The job skips exactly the held rows; the rest of the class goes.
- **The evidence-only phase** (`participation.evidence_set_since`, Q64) starts
  (`retention_enter_evidence_only`) only when the participation has an evidence set (it entered the
  TG or its funding is `known_yes`) and no class outside it holds data. From then the trigger
  `refuse_in_evidence_set_phase` on every table naming a participation (but the audit trail and the
  holds) refuses every write outside a retention run, the API answers `403 evidence_set_phase` to
  every ordinary read of it after visibility, and lists leave it out. Its holds stay readable.
  Break-glass is not built, so live deletion stays off.

**Funding and settlement dates *(Q52, Q217; as built in PR 7-7a)*.** A participation's §110
funding is a recorded fact, `funded110`: `known_yes`, `known_no` or `unknown` (the default), set by
back office with its documented source (`PUT /participations/{id}/funding` against the value and
source read; audited `funding_status_set` with the code, never the source; read by back office and
the PL). **TG entry is a conservative retention trigger, never proof of Transfer-KuG**: nothing
records or claims that Transfer-KuG was claimed, granted or paid. The project's
`kugFinalSettlementDate` and `measure110SettlementDate` are set by back office
(`PUT /projects/{id}/settlement-dates` against both dates read; audited `settlement_dates_set`
with which dates were set); they apply only where needed (the first when any participation entered
the TG, the second when any is funded `known_yes`), and an `unknown` funding blocks stage two.

**7-7b follow-up as built (Q234–Q236).** A non-signer without a fully executed DSV uses the 90-day branch only with funding `known_no`; `unknown` blocks it and `known_yes` has no due day for personnel and health data. The mappings for funded non-signers, `ta_completed`, and health after `closed_without_tg` remain open (Q236). All executable periods remain unset. Only held data outside the evidence set prevents evidence-only access; holds on evidence items and evidence-set documents do not. Ordinary work lists and dashboard counts exclude evidence-only participations; legal-hold administration and the retention job include them. Before activating deletion, `hold_administration_confirmed` requires a completed operational workflow for holds on individual documents. The document picker is deferred.

**Retained dependencies.** The executable list is `retainedDependencies` in the data catalog. Each row waits only while the listed referencing row or document hold exists, then goes when its own period permits:

| Table retained | Why kept | Class | When it goes |
|---|---|---|---|
| `activation_code` | Referenced by `participant_session` | `access_credential` | After the session goes |
| `staff_session` | Referenced by `assisted_mode` | `access_credential` | After assisted mode goes |
| `appointment_booking` | Referenced by `participant_reminder` | `personnel_file` | After the reminder goes |
| `participant_channel` | Referenced by `participant_reminder` | `personnel_file` | After the reminder goes |
| `consent_record` | Referenced by a reminder, channel, or `kug200b_withdrawal` | `personnel_file` | After all referencing rows go |
| `dsv_scan_signature` | Its document is held | `personnel_file` | After the document hold is released |

### Stage-two erasure (Slice 7, PR 7-7c; readings Q237–Q238)

The job erases only after the participation-record period and every remaining stage-one class are
due. For an evidence set it also needs the configured settlement period and every required project
settlement date; an unknown funding anywhere in the project blocks stage two. Synthetic tests set
periods and activation explicitly; the catalog's periods remain `unset` and all live-deletion
prerequisites remain unmet. With a hold, due unheld rows go, the held rows and their transitive
foreign-key parents remain, and a restricted minimal participation anchor stays until the hold is released (Q240). The anchor keeps only its IDs, statuses, funding, and the trigger kind and day plus the TG-entry flag needed to re-evaluate erasure; its creation timestamp is reset to the time the anchor was made. Personal dates, reasons, wave, placement, funding provenance and the current exception pointer are cleared. Ordinary views and writes exclude the anchor; legal-hold administration remains available. A retained
activation code has its hashes replaced and is revoked if still open. A channel kept only as a
dependency has its address erased and is marked removed; an explicitly held channel retains it. The job deletes the unheld
objects in the same run; a storage failure rolls back its database changes for retry.

The retention role locks the affected projects before participation rows and locks matching queued
jobs before deleting them. A matching active or dependency-linked job defers stage two (Q237); stage one
may already have run. Concurrent creation of job dependencies is not yet coordinated and must be
resolved before `maintenance_rules_complete` can be confirmed. Audit subject references and subject-record IDs are pseudonymised, including
references in request and job IDs and both audit streams. An erased subject cannot be opened in
history. A working-copy hold is checked under the participation lock before its object is touched.

The current hold API has no individual identity selector (Q238). A completed, confirmed workflow
for holding identity, as well as for holding individual documents, is part of
`hold_administration_confirmed` before live deletion.

**Additional retained dependencies during erasure.** The catalog's
`erasureRetainedDependencies` lists each reachable foreign-key or documented array dependency; tests compare the list
with the schema graph and inventory document-ID arrays. A row below remains only while a retained row references it; it goes when all
retained referencing rows go and its own period permits. The participation row is the held-data
anchor and goes after the last hold is released. `by_document_type` means the row's own class.

| Table retained | Referenced by retained rows of | Class |
|---|---|---|
| `activation_code` | `participant_account`, `privacy_notice_delivery` | `access_credential` (secret revoked and replaced) |
| `audit_event` | `dsv_offer` status event | `audit_log` |
| `agentur_submission` | `asu_registration`, `agentur_submission` | `participation_record` |
| `appointment_booking` | `participant_reminder`, `appointment_booking` | `personnel_file` |
| `asu_registration` | `evidence_correction` | `participation_record` |
| `ba_reporting_task` | `evidence_correction`, `ba_reporting_task` | `participation_record` |
| `consent_record` | `participant_channel`, `participant_reminder` | `personnel_file` |
| `document` | `asu_registration`, `agentur_submission`, `consent_record`, `dsv_scan_signature`, `evidence_correction`, `form_generation`, `legal_hold` | `by_document_type` |
| `dsv_offer` | `document`, `dsv_contract`, `evidence_correction` | `participation_record` |
| `evidence_correction` | `document`, `dsv_scan_signature`, `asu_registration`, `ba_reporting_task` | `by_document_type` |
| `form_generation` | `document`, `dsv_offer` | `form_working_copy` |
| `participant_channel` | `participant_reminder`, `consent_record` | `personnel_file` (unheld address erased) |
| `participation_dsv_amendment` | `ba_reporting_task` | `participation_record` |
