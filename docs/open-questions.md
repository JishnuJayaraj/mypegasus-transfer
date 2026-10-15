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
[round 3](decisions/2026-10-15-answers-round-3.md) · [round 4](decisions/2026-10-15-answers-round-4.md) · [round 5](decisions/2026-10-15-answers-round-5.md) (all 2026-10-15)

| # | Topic | Owner | Status | Answer (short) | Confirmed by / date |
|---|---|---|---|---|---|
| 1 | Arbeitsuchendmeldung / ASU 🔒 | PLs | verify | Registration counts, not the form: channels `kug_200b`, `online_self`, `in_person` with proof (round 5). `asuDueDate = max(end − 3 months, knowledge + 3 days)`, month end clamped. A PL must confirm the deadline before reminders go live. | |
| 2 | Profiling form | PLs | confirmed | TL 407 (08/2025), nationwide | Official form, 2026-10-15 |
| 3 | Retention periods 🔒 | DPO / tax advisor | verify | Per data item (round 3), two-stage with evidence set (ADR-0008); tax/payroll periods configurable | |
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
| 60 | Who may take which manual lifecycle transition (main status and both tracks)? May participants trigger any (e.g. accept/decline profiling, decline the DSV in the portal)? Who may set or revoke the profiling exception? | PLs / Product owner | open | Proposed: PL all manual transitions of their project; Berater/Profiler contact, inform and the profiling track; back office the DSV track; participants none in the MVP. Until answered, Slice 1 allows the PL only ([slice-1 plan](plans/slice-1.md), D10). | |
| 61 | Is a staff member's role global or per project? Can one person be PL in one project and profiler in another, or both in the same project? 🔒 | Product owner / DPO | open | Proposed: project role per membership, one role per person per project (it decides who sees section C and health data). | |
| 62 | May a Berater/Profiler see confidential data of participants in their project who are **not** assigned to them? 🔒 | DPO / PLs | open | Proposed: confidential and internal data yes, everything above confidential only for assigned participants. Until answered: denied. | |
| 63 | Who reviews the break-glass accesses and guard overrides "flagged for review", and how far does one break-glass reach (one record read, or a time box)? 🔒 | DPO | open | Proposed: per resource read; the DPO reviews through an audit export; no reviewer role in the MVP. | |
| 64 | When does "evidence set after exit: break-glass only" start: at the terminal status (`exited`, `withdrawn`, `ta_completed`) or only after the first deletion stage has run? 🔒 | DPO | open | Proposed: after the first deletion stage, so the PL can still close out an exited participation normally. | |
| 65 | Write permissions per data category: who may enter or change which fields (staff roles, participant self-service, edits after submission)? The access matrix only covers reading. 🔒 | DPO / PLs | open | Proposed: decided with Slice 4a; Slice 1 builds read, list and document-opening rules only. | |
| 66 | Classification of fields the classification table doesn't list: Familienstand, gender, Personalnummer, end of the old employment, date of knowledge, work email, language skills, driving licence. Also end reasons that reveal health or death (`long_term_illness_reduced_earning_capacity`, `deceased`) and free-text reasons (overrides, profiling exception). 🔒 | DPO | open | Proposed: confidential; the two health-related end reasons special category (hidden from PL lists); free-text reasons confidential and never logged. Until answered, the more protective class applies. | |
| 67 | May participants see their own signed TL 407 / Kug 200b in the portal (the matrix says "—")? 🔒 | DPO | open | Proposed: not in the portal in the MVP; available through the data-subject export. | |
| 68 | If the TG entry guard fails on the planned TG start date and passes later, does the participant enter the TG later automatically (and which date is the beE entry date), or must the PL set a new start date? | PLs / legal | open | Proposed: no late automatic entry; the PL sets a new planned start date (audited), and the system checks again on that date. A missed nightly run is caught up with the planned date. | |
| 69 | Which signing deadline applies to a DSV re-offered after the project's signing deadline (late joiners)? What do "signing-deadline offset" (ADR-0004) and `dsv.deadlineRule` (regional-variation.md) mean? Are deadline days inclusive (DSV expires the day after the deadline, grace period ends at the end of deadline + 90 days)? | PLs | open | Proposed: re-offers get offer date + N days, capped at the grace-period end (N in base defaults); deadline days inclusive. Until answered: re-offers after the deadline are not expired by the system but flagged. | |
| 70 | What happens at the end of the grace period to participations still `imported` or `contacted` (never informed, not marked unreachable)? | Product owner | open | Proposed: flagged to the PL, not withdrawn automatically. | |
| 71 | Which guards may a PL override with a reason? The docs classify only the TG entry guards. Unclassified: DSV signed needs a scan and who received it; profiling done needs the signed TL 407; `ta_completed` needs profiling done; the return arrows after the grace period (also for participations flagged instead of withdrawn); withdrawal after `dsv_signed` needs the three-party cancellation. | Product owner / PLs | open | Proposed: none of them overridable, except the return arrows after the grace period (override with reason, flagged). Until answered: none overridable. | |
| 72 | "A reason chosen manually by the PL always overrides the derived one" (Q56): may the PL change the primary reason of a participation the system has already withdrawn? | Product owner | open | Proposed: yes, audited like a status change; the derived reason moves to the secondary list. Until answered: not possible. | |
| 73 | `ta_only` projects have no signing deadline, so no grace period: how do participations end that decline profiling, are unreachable or never finish? What exactly is "measures completed" for `ta_completed`, and can that guard be overridden? | PLs | open | Proposed: manual withdrawal by the PL only; "measures completed" is a PL confirmation; no override. | |
| 74 | Profiling after TG entry with the profiling exception: which profiling transitions are allowed while `active_in_tg` (may the person still decline)? What happens when the 1-month deadline passes? May the exception be set when profiling was declined? 🔒 | PLs / legal | open | Proposed: only forward transitions to `profiling_done`; a missed deadline escalates to the PL (no automatic status change); no exception with `profiling_declined`. | |
| 75 | May a regional template or a project override relax a nationwide base-default requirement (remove a required field or document), or only add and change regional settings? | Product owner | open | Proposed: only add; base-default rules are locked. | |
| 76 | What applies when no template exists for a participant's placement Agentur (new region)? | PLs | open | Proposed: base defaults plus project overrides, with a warning on the PL dashboard; nothing is blocked. | |
