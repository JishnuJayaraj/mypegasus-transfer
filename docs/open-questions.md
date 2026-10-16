# Open questions & decisions log

Add questions here instead of guessing. When a question is answered, record the answer in a
dated file in [`decisions/`](decisions/), update the status here, and update the relevant doc.

**Status values**
- `confirmed`: confirmed by the owner (or by a primary source such as the official form or the
  law), with name/source and date in the last column.
- `assumed`: a working answer we build on, **not yet confirmed by the owner**. It must not be
  written into CLAUDE.md or data-protection.md as fact.
- `verify`: assumed, and contains a factual point that must be checked before it goes live.
- `open`: no answer yet.

**Gate:** before the pilot, nothing in the categories data protection, retention or legal
deadlines may be `assumed` or `verify` (rows marked 🔒).

Answers: [round 1](decisions/2026-10-15-answers.md) · [round 2](decisions/2026-10-15-answers-round-2.md) ·
[round 3](decisions/2026-10-15-answers-round-3.md) · [round 4](decisions/2026-10-15-answers-round-4.md) · [round 5](decisions/2026-10-15-answers-round-5.md) (all 2026-10-15) ·
[round 6](decisions/2026-10-15-answers-round-6.md) · [round 7](decisions/2026-10-16-answers-round-7.md) (2026-10-16)

| # | Topic | Owner | Status | Answer (short) | Confirmed by / date |
|---|---|---|---|---|---|
| 1 | Arbeitsuchendmeldung / ASU 🔒 | PLs | verify | Registration counts, not the form: channels `kug_200b`, `online_self`, `in_person` with proof (round 5). `asuDueDate = max(end − 3 months, knowledge + 3 days)`, month end clamped. A PL must confirm the deadline before reminders go live. | |
| 2 | Profiling form | PLs | confirmed | TL 407 (08/2025), nationwide | Official form, 2026-10-15 |
| 3 | Retention periods 🔒 | DPO / tax advisor | verify | Per data item (round 3), two-stage with evidence set (ADR-0008); tax/payroll periods configurable. **Reopened in part (round 7):** non-signer deletion was counted from "signing deadline + 90 days", a grace period that is no longer a fixed rule (Q69, Q77). | |
| 4 | Legal basis per purpose 🔒 | DPO | assumed | Round 1 table | |
| 5 | Suppression threshold 🔒 | DPO | assumed | n < 5 + secondary suppression | |
| 6 | Hosting | Tech lead | confirmed | Local, then company Hetzner cluster. Real data only on the cluster. | Product owner, 2026-10-15 |
| 7 | Staff identity provider | IT | assumed | Entra ID, OIDC, MFA via Conditional Access | |
| 8 | Payroll export | Back office | assumed | DATEV LODAS; versioned CSV in the MVP | |
| 9 | Portal languages | PLs | assumed | de + en; v1.1 tr, ar, pl, ru, uk, ro | |
| 10 | Electronic signatures | PLs / legal | confirmed | Always paper | Forms + §623 BGB, 2026-10-15 |
| 11 | Contact channels 🔒 | PLs | assumed | Mobile primary, never work email, assisted mode, printed code | |
| 12 | Cluster setup | Cluster team | assumed | k3s, CloudNativePG, Object Storage, German locations | |
| 13 | Person-level data for the customer 🔒 | DPO / PLs | assumed | Whitelist: name, Personalnummer, DSV signed + date, beE entry/exit | |
| 14 | Controller vs. processor 🔒 | DPO | assumed | TG is an independent controller. Data-sharing clause, no AVV, no customer deletion orders. | |
| 15 | Which Agentur | PLs | verify | KuG-Agentur per project, placement Agentur per participant | |
| 16 | Project-level BA steps | PLs | assumed | Project checklist (consultation, Anzeige; + final settlement date, see #52) | |
| 17 | Profiling before TG | PLs | confirmed | Legal prerequisite; exception + 1-month deadline. DSV runs in a parallel track (round 4). ASU is a hard guard without exception. | §111(4) SGB III, 2026-10-15 |
| 18 | Individual TG dates | PLs | assumed | Project default + per-participant start/end | |
| 19 | Pre-TG dropouts | PLs | assumed | Terminal state `withdrawn` + reason (round 3, #50); reasons from #34 | |
| 20 | TA-only projects | PLs | assumed | `ta_only`, end state `ta_completed` | |
| 21 | DSV execution, originals | Product owner | confirmed | `dsv_signed` = participant signed; `customerSignedOn` + `tgSignedOn` on the document; TG entry needs `dsvFullyExecuted`; originals tracked per document | Product owner, 2026-10-15 |
| 22 | Periodic Agentur reports | PLs | verify | Half-yearly (30.06/31.12) | |
| 23 | Qualification approval/funding | PLs / back office | assumed | PL proposes, customer budget owner approves | |
| 24 | Audit duties vs. deletion 🔒 | DPO | verify | Two-stage deletion; evidence set until final settlement year + 4 years (configurable) | |
| 25 | DPIA | DPO | confirmed | Required before any real data | Product owner, 2026-10-15 |
| 26 | Pilot location | Tech lead / DPO | confirmed | Nürnberg, one project, cluster, after pre-pilot gate | Product owner, 2026-10-15 |
| 27 | Participant login factors 🔒 | DPO | assumed | Link/SMS code + birth date check | |
| 28 | Access to special-category data 🔒 | DPO / PLs | assumed | Access matrix in data-protection.md (rounds 2 + 3) | |
| 29 | Data classification 🔒 | DPO | assumed | Round 1 + additions in round 2 (#43) | |
| 30 | Person across projects | DPO / PLs | confirmed | No linking in the MVP | Product owner, 2026-10-15 |
| 31 | Self-registration 🔒 | PLs / DPO | assumed | QR 14 days, captcha, delete unmatched after 30 days | |
| 32 | Cluster operator / AVV chain | Product owner | confirmed | The product owner operates the cluster and owns the AVV chain. "AVV chain signed" stays a blocking pre-pilot gate item (ADR-0005). | Product owner, 2026-10-15 |
| 33 | TG sub-statuses | PLs / back office | assumed | Dated periods | |
| 34 | Exit reasons | PLs | assumed | One enum with phase attribute + placement details (round 2) | |
| 35 | Region | PLs / admin | assumed | Niederlassung | |
| 36 | Template upgrades | PLs | assumed | Pinned, explicit migration | |
| 37 | Form rendering | PLs | confirmed | pdf-lib (AcroForm), Gotenberg (HTML) | Product owner, 2026-10-15 |
| 38 | AI providers 🔒 | DPO | assumed | None in the MVP; later EU only | |
| 39 | MVP UI languages | Product owner | confirmed | Staff de, portal de + en | Product owner, 2026-10-15 |
| 40 | Health data vs. signed forms 🔒 | DPO | assumed | Structured fields deleted 3 months after exit; signed forms in the evidence set; back office has no access to signed forms (round 3) | |
| 41 | TL 407 row overflow | PLs | assumed | Generated "Anlage zum Profilingbogen". A PL must confirm that Agenturen accept it. | |
| 42 | Blank form templates, new BA versions | Product owner | confirmed | `packages/forms/templates/ba/…` + monthly check by a back-office form owner (ADR-0009) | Product owner, 2026-10-15 |
| 43 | Classification of Bürgergeld, nationality, residence status, profiler ratings 🔒 | DPO | assumed | All highly confidential (round 2) | |
| 44 | BA consents (Jobbörse, BA contact data, Kug 200b profile access) as consent records? 🔒 | DPO | assumed | Jobbörse choice + BA contact consent stored on the profiling record (declarations to the BA). Kug 200b profile access and portal contact are our own consent records (round 3). | |
| 45 | Kug 200b batch channel | PLs | assumed | TG collects signed forms at the event and submits them in a batch; channel per Agentur | |
| 46 | Withdrawal after `dsv_signed` | Legal / PLs | verify | Only with a cancellation signed by all three parties; PL confirms; customer flag. Depends on our DSV template. | |
| 47 | Customer as MVP user or export only | Product owner | confirmed | Export only; monthly PL report; customer login in v2 | Product owner, 2026-10-15 |
| 48 | Test PDFs synthetic? | Product owner | confirmed | Synthetic; committed under `fixtures/forms/` | Product owner, 2026-10-15 |
| 49 | Who may open signed TL 407 / Kug 200b 🔒 | DPO / PLs | assumed | Profiler + assigned PL (opening logged; normal UI metadata only); back office no; section C fields profiler only; after exit break-glass | |
| 50 | `dsv_declined` etc.: states or reasons? | Product owner | confirmed | Non-terminal states + terminal `withdrawn` with reason; system job after the grace period | Product owner, 2026-10-15 |
| 51 | Sickness periods 🔒 | DPO | assumed | Payroll records: type + dates only, no diagnoses/AU scans, payroll retention | |
| 52 | Final settlement dates 🔒 | Back office | assumed | `kugFinalSettlementDate`, `measure110SettlementDate` on the project; evidence set expires at year end of the later date + 4 years | |
| 53 | Withdrawal reason for `profiling_declined` | Product owner | confirmed | `declined_profiling` (no Transfer-KuG at all). Non-terminal during the grace period; conflict with `dsv_signed` is flagged to the PL, never auto-resolved. | Product owner, 2026-10-15 |
| 54 | TL 407 submission part of the TG entry guard? | Product owner | confirmed | No. "What's missing" item: warning at TG start, escalation to PL + regional admin 14 days after TG start. | Product owner, 2026-10-15 |
| 55 | Does the participant's own ASU registration count? | Product owner | confirmed | Yes, any channel with proof (Kug 200b, BA confirmation, or BA-Kundennummer noted by the PL). Kug 200b still offered for the profile-access consent. | Product owner, 2026-10-15 |
| 56 | Order of withdrawal reasons | Product owner | confirmed | `declined_dsv` → `declined_profiling` → `no_response`; primary + secondary reasons stored; manual PL reason overrides | Product owner, 2026-10-15 |
| 57 | What does an escalation to the regional admin show? | Product owner | confirmed | Project, responsible PL, number of overdue items per type (e.g. "3 × TL 407 not submitted"), days overdue for the oldest. No participant names; details via the PL. | Product owner, 2026-10-15 |
| 58 | Retention of project master data (`project`, retention class `project_master`) 🔒 | DPO | open | No answer yet. The period is `unset` in the data catalog, so no deletion job may touch it. | |
| 59 | Retention of staff accounts (`staff_user`, retention class `staff_account`) and their references in projects and audit entries 🔒 | DPO | assumed | Proposed default: staff accounts are deactivated and later pseudonymised (name, email), never deleted, because `project.created_by` (and from Slice 1 audit entries) reference `staff_user`. Period `unset` until confirmed; columns and flow come with real accounts in Slice 3. | |
| 60 | Who may take which manual lifecycle transition? May participants trigger any? Who may set or revoke the profiling exception? | Product owner | confirmed | PL: all manual transitions in their project, matching, withdrawal, `ta_completed`, end-reason corrections, profiling exceptions. Assigned consultant/profiler: `contacted`/`unreachable`/`informed`, profiling transitions, exits/placements. Back office: DSV offered/signed/declined (expiry system-only). Participants: none; portal declarations are evidence staff record. Exception: PL only, with reason; revocable before TG entry only. | Product owner, 2026-10-16 |
| 61 | Is a staff member's role global or per project? Can one person be PL in one project and profiler in another, or both in the same project? 🔒 | Product owner / DPO | assumed | Zero or more project roles per membership; permissions are the union; sensitive access needs the role plus the participant assignment (e.g. PL + profiler sees section C only for participants assigned to them as profiler). DPO to confirm the access implications. | |
| 62 | May a Berater/Profiler see confidential data of participants in their project who are **not** assigned to them? 🔒 | DPO / PLs | assumed | No person-level data for unassigned participants; aggregate workload counts only. The PL assigns. No project-wide name directory. | |
| 63 | Who reviews break-glass accesses and flagged exceptions, and how far does one break-glass reach? 🔒 | DPO | assumed | One grant = one participant, one resource/category, one action; every action logged with a mandatory reason. Regional operations management reviews by the next business day from audit metadata; the DPO gets periodic reports and immediate escalation. Same four-eyes review for overrides. Reviewer role: Q80. | |
| 64 | When does "evidence set after exit: break-glass only" start? 🔒 | DPO | assumed | After the first retention/deletion stage, not at the terminal status. Normal authorised access during close-out and the ordinary personnel-file retention period. | |
| 65 | Write permissions per data category (staff and participant). 🔒 | DPO / PLs | assumed | Participant: own self-service fields and uploads. Assigned profiler/consultant: case and profiling data; section C and health only for assigned participants. PL: operational dates, assignments, status actions, exceptions, case administration; no ordinary editing of health, section C or payroll identifiers. Back office: DSV administration, payroll identifiers, payroll-relevant disability facts, absences, settlement data. Admins: configuration only. Assisted writes as actor + `onBehalfOf`. Signed/submitted documents immutable (corrections are new versions). Sensitive writes audited. DPO and PL review pending. | |
| 66 | Classification of fields the classification table doesn't list, of health-revealing end reasons and of free-text reasons. 🔒 | DPO | assumed | Familienstand, gender, Personalnummer, end of old employment, knowledge date, work email, language skills, driving licence: confidential. `long_term_illness_reduced_earning_capacity`: special category, never in ordinary lists. `deceased`: confidential. Profiling-exception reasons: structured codes; free text special category. Override/break-glass free text: highly confidential, encrypted, not in lists or logs. | |
| 67 | May participants see their own signed TL 407 / Kug 200b in the portal? 🔒 | DPO | assumed | Not in the MVP portal; through the data-subject export / manual request. Reconsider after stronger participant authentication. | |
| 68 | TG entry after the planned start date. | PLs / legal | confirmed | No automatic late entry. The PL records a new contractually valid start date, or performs an audited reconciliation when documents prove all requirements were met on the original date. Never backdate because evidence was created later. | Product owner, 2026-10-16 |
| 69 | Deadline for re-offered DSVs; meaning of "signing-deadline offset" / `deadlineRule`; inclusive deadline days. | PLs | confirmed | Deadlines come from the Sozialplan/DSV/entry wave: project/wave `latestEntryDate`; re-offers need an explicit participation `offerDeadline` ≤ `latestEntryDate` and ≤ planned entry date; `deadlineRule` is project-specific and contractual, not regional; deadlines inclusive (expiry the next day); without a recorded rule the PL enters the deadline. The fixed 90-day grace period is reopened (Q77). | Product owner, 2026-10-16 |
| 70 | Participations still `imported`/`contacted` at the end of the admission period. | Product owner | confirmed | After advance warning (Q78): `imported` → `withdrawn`/`never_contacted`, `contacted` → `withdrawn`/`not_informed`, `unreachable` → `withdrawn`/`no_response`. Only with an explicit `latestEntryDate`; otherwise flag, no automatic transition. | Product owner, 2026-10-16 |
| 71 | Which guards may a PL override? | Product owner / PLs | confirmed | None of the documentary and contractual guards: signed DSV scan and receiver, signed TL 407, fully executed DSV, ASU proof, cancellation after a signed DSV, TA completion evidence. A late admission after the cutoff needs a new approved deadline/start date or a contractual amendment, not an override. | Product owner, 2026-10-16 |
| 72 | May the PL change the primary end reason after a system withdrawal? | Product owner | confirmed | Yes, through a dedicated audited correction that doesn't reopen the terminal status; previous and derived reasons stay in the history, a system-derived reason moves to the secondary list. | Product owner, 2026-10-16 |
| 73 | How do `ta_only` participations end? What is "measures completed"? | PLs | confirmed | A TA participation needs a planned measure period or final activity date. `ta_completed` = all assigned §110 activities completed or formally closed + required evidence + PL confirmation; profiling alone is not enough. Decline, no response, early termination → `withdrawn`. Until activities exist, PL-driven closure only. Follow-up: Q83. | Product owner, 2026-10-16 |
| 74 | Profiling after TG entry with the profiling exception. 🔒 | PLs / legal | verify | Exception only for a documented, justified case and never after `profiling_declined`. After entry: forward profiling transitions and a later refusal can be recorded. Refusal or a missed one-month deadline → immediate compliance escalation, no automatic end of employment. beE employment is tracked separately from Transfer-KuG eligibility, which starts no earlier than the day after profiling is completed; affected periods are excluded from claims until cleared (BA Fachliche Weisungen, to be verified). Follow-up: Q82. | |
| 75 | May templates or project overrides relax base requirements? | Product owner | confirmed | Statutory and BA-form requirements are locked. Templates only add or change regional settings. A project override may relax only an internal operational default, with reason, approval and audit. Unclassified rules are locked. | Product owner, 2026-10-16 |
| 76 | No template for an Agentur. | PLs | confirmed | Missing KuG-Agentur template blocks project activation. Missing placement-Agentur template allows contact, collection and profiling but blocks Agentur submission until channel, original requirement and lead time are recorded; blocking PL task + warning. Never guess a real Agentur's rules. | Product owner, 2026-10-16 |
| 77 | What replaces the "signing deadline + 90 days" grace period? Does the system withdrawal of `informed` participations (precedence Q56) now happen the day after `latestEntryDate`? Do the late-joiner return arrows close at `latestEntryDate`, and are they open when no `latestEntryDate` is recorded? From when does non-signer deletion count (Q3)? 🔒 | Product owner / DPO | open | Proposed: the final admission cutoff is the day after `latestEntryDate`; all system withdrawals (Q56 precedence and Q70) run then; return arrows close at `latestEntryDate` and stay open (manual only) without one; non-signer deletion counts from `withdrawn`, period for the DPO. | |
| 78 | How long before the cutoff is the PL warned (Q70 "after advance warning")? | Product owner / PLs | open | Proposed: 14 days, an internal operational default in base defaults (relaxable per project, Q75). Until answered, cutoff withdrawals don't run automatically; the cases are flagged. | |
| 79 | Entry waves: can a project have several entry waves, each with its own signing deadline, TG start and `latestEntryDate`? | PLs | open | Proposed: Slice 1 models one wave per project (dates on the project); waves come later as an optional grouping that overrides the project dates per participation. | |
| 80 | Who is "regional operations management" (Q63) in the role model: the regional admin with an audit-metadata-only review view, or a separate reviewer role? Is four-eyes review always after the fact (next business day), including for profiling exceptions? 🔒 | Product owner / DPO | open | Proposed: a separate org role `reviewer` scoped to a region, seeing audit metadata only; review after the fact for break-glass and profiling exceptions. | |
| 81 | Which structured reason codes does a profiling exception use (Q66)? | PLs | open | Proposed: `late_joiner`, `participant_unavailable`, `profiler_capacity`, `other`, with no code naming an illness. Until answered, Slice 1 offers only `other` (free text comes with encryption). | |
| 82 | Transfer-KuG exclusion details: what clears an excluded period; if profiling is refused after entry, is the person ineligible from the entry date or from the refusal; does a missed one-month deadline itself end eligibility? 🔒 | Legal / BA process owners | open | Proposed: eligibility starts the day after profiling completion; the period from entry until then is excluded; after a refusal no eligibility from the entry date until legal says otherwise. The app only derives and reports; payroll/KuG billing is outside the MVP. | |
| 83 | Does `ta_completed` still require `profiling_done` (necessary but not sufficient, Q73), or can a TA participation be completed with other §110 measures only? | PLs | open | Proposed: keep `profiling_done` as required (current diagram) plus PL confirmation in Slice 1; activity evidence is checked once activities exist. | |
