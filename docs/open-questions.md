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
[round 3](decisions/2026-10-15-answers-round-3.md) (all 2026-10-15)

| # | Topic | Owner | Status | Answer (short) | Confirmed by / date |
|---|---|---|---|---|---|
| 1 | Arbeitsuchendmeldung / ASU 🔒 | PLs | verify | Form **Kug 200b** (TG route). `asuDueDate = max(end − 3 months, knowledge + 3 days)`, month end clamped (round 3). A PL must confirm before reminders go live. | |
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
| 17 | Profiling before TG | PLs | confirmed | Legal prerequisite; exception + 1-month deadline | §111(4) SGB III, 2026-10-15 |
| 18 | Individual TG dates | PLs | assumed | Project default + per-participant start/end | |
| 19 | Pre-TG dropouts | PLs | assumed | Terminal state `withdrawn` + reason (round 3, #50); reasons from #34 | |
| 20 | TA-only projects | PLs | assumed | `ta_only`, end state `ta_completed` | |
| 21 | DSV execution, originals | Back office / legal | assumed | All three signatures; originals tracked per document | |
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
| 32 | Cluster operator / AVV chain 🔒 | Cluster team | open | Blocking item on the pre-pilot checklist: `<CLUSTER_OPERATOR_ENTITY>` | |
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
| 53 | `profiling_declined` is provisionally non-terminal like `dsv_declined` and auto-withdrawn after the grace period. Which withdrawal reason: a new `declined_profiling`, or `declined_dsv`? | Product owner | open | | |
