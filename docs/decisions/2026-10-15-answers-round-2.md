# Answers to open questions — 2026-10-15, round 2

These answers follow up on [round 1](2026-10-15-answers.md). Where they differ, round 2 wins.
[Round 3](2026-10-15-answers-round-3.md) corrects some of them: back office has no access to signed forms (Q49), the explanation of the §38 formula, and retention per item.
The status of each question is in `open-questions.md`. Review notes are marked **Note**.

## Q14 — Controller or processor (assumed)
- The TG is an **independent controller** in phase 1, not a processor and not a joint
  controller. It decides how participants are informed, profiled and contracted, and it has its
  own duties as Träger of §110/§111 measures. The customer is a separate controller for its HR
  data and for the transfer of the import file.
- Consequences: the customer cannot order deletion. The customer contract needs a
  **data-sharing clause** (what is transferred, for which purpose), not an AVV.
- Build: no "customer deletion request" feature. Retention jobs follow our rules only.
- **Note:** data-protection.md rule 7 ("AVV with the customer") must be changed accordingly.

## Q24 / Q40 / Q3 — Retention, revised (verify)
Two-stage deletion:
1. **Full deletion** of everything not needed as evidence, on the normal schedule.
2. **Evidence set**, kept until the funding audit period ends. It applies to anyone who took
   part in a BA-funded §110 measure or received Transfer-KuG, and contains: identity, measure,
   dates/times of participation, signed participation pages, proof of submission, and the
   matching audit entries. Default retention: end of the calendar year of the Agentur's final
   settlement + 4 years. Configurable; **must be verified**.

| Data | Retention |
|---|---|
| Structured health fields in the DB | deleted 3 months after beE exit, or with non-signer deletion |
| Schwerbehinderung status for payroll | kept with payroll records as long as payroll needs it |
| Signed TL 407 and Kug 200b documents | evidence set; encrypted; profiler and back office only |
| Non-signers without BA-funded measures | full deletion 90 days after the signing deadline |
| Non-signers with BA-funded §110 measures | full deletion after 90 days, except the evidence set |
| Accounting vouchers (Buchungsbelege) | 8 years (since BEG IV, 2025); books/annual statements 10 years |
| Lohnkonto | until the end of the 6th calendar year after the last entry (§41 EStG) |
| Entgeltunterlagen | until the end of the calendar year after the last social-security audit (§28f SGB IV) |

- Build: `retentionClass` per data category and document type. Two-stage job. Audit entries
  for deleted subjects are pseudonymised, while audit entries belonging to an evidence set
  follow the evidence set. All periods are configurable and must be confirmed by the tax
  advisor/back office before the pilot.
- **Note:** state the rule "**the longest applicable retention wins**" explicitly. A TG
  participant falls under several rows at once (profiling 3 years, evidence set, payroll).
- **Note:** the evidence-set clock needs the Agentur's final-settlement date. There is no such
  field yet (Q52).
- **Note:** sickness periods (TG sub-status `sick_*`) are health data but also payroll data
  (Q51).

## Q28 — Access to special-category data (assumed)
| Role | Health / Schwerbehinderung |
|---|---|
| Profiler/Berater (assigned) | full access for their participants |
| PL | none by default. Exception: in assisted mode while entering data (`onBehalfOf`). Optional break-glass with a mandatory reason, audited and flagged for review. |
| Back office | Schwerbehinderung/Gleichstellung status and GdB only (payroll, e.g. extra leave) |
| Regional admin, Admin | never |
| Customer | never |

- Build: special-category fields are never in list payloads. A separate endpoint returns them,
  and every read is logged.
- **Note:** this conflicts with two other places (Q49):
  - Signed TL 407 PDFs are "profiler and back office" (Q40), but they contain section C, which
    is "profiler only" (Q43).
  - The PRD lets the PL do the Agentur submission, which means handling these PDFs.

  Options: back office does the submission, or the PL submits without being able to open the
  file, or section C/health gets its own access rule for documents.

## Q32 — Cluster operator / AVV chain (open)
- If the TG holds the Hetzner account: one AVV with Hetzner Online GmbH.
- If a group company runs it: an AVV between the TG and that company, with Hetzner as its
  sub-processor (there is no group privilege under the GDPR).
- Build: blocking item on the pre-pilot checklist: "AVV chain signed" for
  `<CLUSTER_OPERATOR_ENTITY>`.

## Q34 / Q19 — Exit reasons (assumed; replaces the Q19 list)
One enum with a `phase` attribute.

| Phase | Reasons |
|---|---|
| Before TG (from any pre-TG state) | `declined_dsv`, `no_response`, `placed_direct`, `self_employed`, `retirement`, `other_measure`, `deceased`, `other` |
| During TG | `placed_permanent`, `placed_fixed_term`, `self_employed`, `retirement`, `apprenticeship_or_study`, `max_duration_reached`, `own_termination_without_job`, `terminated_by_tg`, `long_term_illness_reduced_earning_capacity`, `deceased`, `other` |

- Placement details: `contractType` (full/part time), `fixedTermMonths`, `tempAgency`,
  `backToFormerGroup` (legally sensitive, reported separately), `startDate`.
- Integration rate = placed (permanent + fixed-term + self-employed) ÷ all exits. Which reasons
  count is configurable. Customer reporting is aggregated with n < 5 suppression.
- **Note:** `declined_dsv` and `no_response` overlap with the lifecycle states `dsv_declined`,
  `dsv_expired` and `unreachable`. Decide whether those stay as states (Q50).

## Q1 / Q45 — Kug 200b (assumed)
- The ASU in the transfer context is form **Kug 200b**, the second BA form: AcroForm fill, wet
  signature, scan + original tracking, same classification and access rules as TL 407.
- The consent to TG access to the BA profile is a separate purpose, stored as its own consent
  record (date, form version, `revokedAt`).
- Batch at the info event: the TG collects the signed forms and submits them in a batch. The
  channel (paper by courier/post, scan by email, upload) is set per Agentur in the regional
  template.

## §38 SGB III deadline (verify; a PL must confirm before reminders go live)
- Register at least 3 months before the employment ends. Only if the person learns of the end
  less than 3 months in advance: within 3 days of learning about it.
- Build: `asuDueDate = max(endDate − 3 months, knowledgeDate + 3 days)`, as `date` columns.
- **Note:** the formula is right, but the explanation given with it was not. `max` means the
  **later** of the two dates applies, not the earlier. Example: end 31.12., knowledge 01.12. →
  max(30.09., 04.12.) = 04.12.
- **Note:** month arithmetic needs §188 BGB-style end-of-month handling (31.05. − 3 months =
  28./29.02.). Add test cases.

## Q43 — Additional classification (assumed)
| Field | Class | Rule |
|---|---|---|
| Bürgergeld (participant or spouse/partner) | highly confidential | yes/no only (concerns a third person) |
| Nationality, date of entry, residence status (incl. Duldung) | highly confidential | encrypted; profiler and back office only |
| Profiler ratings (intellectual capacity, work and social behaviour), Gesamteinschätzung, weiteres Vorgehen | highly confidential | profiler only; never customer or PL; free text never exported |

## Q41 — TL 407 row overflow (assumed; a PL must confirm Agenturen accept attachments)
The data model has no row limits. When filling the form:

| Table | Rows on form | Order / filter | Overflow |
|---|---|---|---|
| Profiling sessions | 4 | chronological | attachment |
| Education | 5 | highest school qualification first, then vocational/university, most recent first | attachment |
| Jobs | 7 | last 3 years only, most recent first | attachment |
| Languages | 4 besides Deutsch | — | attachment |

The overflow goes onto a generated "Anlage zum Profilingbogen" page (name, birth date, table
continuation) appended to the PDF. The last row on the form reads "weitere siehe Anlage".

## Date validation (decided)
- Strict parsing of `TT.MM.JJJJ`. Reject impossible dates (month 14, 31.02.).
- Plausibility checks: age 15–67 at TG start, entry date not before birth date, "von" ≤ "bis".
- Validate on import, in forms, and again before PDF rendering. `03.14.1998` is a test case.
- **Note:** impossible dates should be hard errors. Plausibility checks should be warnings
  that staff can confirm, so that genuine edge cases are still possible.

## Decisions log (decided)
`open-questions.md` now has the statuses `assumed` / `verify` / `confirmed` / `open` and a
"Confirmed by / date" column. Before the pilot, nothing in data protection, retention or legal
deadlines may remain assumed (rows marked 🔒).

## Q48 — Test PDFs (open)
Round 2 contained a suggested text with the placeholder *"[You need to fill this in. Only you
know.]"*, not an actual confirmation. The PDFs are not committed until the product owner
confirms they are synthetic.
