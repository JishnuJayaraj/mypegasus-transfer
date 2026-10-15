# Answers to open questions — 2026-10-15, round 3

These follow [round 1](2026-10-15-answers.md) and [round 2](2026-10-15-answers-round-2.md).
Where they differ, round 3 wins. The status of each question is in `open-questions.md`. These
answers have been carried into the domain docs, ADRs and `CLAUDE.md`.

## Corrections to round 2
- **§38 deadline:** `asuDueDate = max(endDate − 3 months, knowledgeDate + 3 days)`, so the
  later date applies. To subtract 3 months, clamp to the last day of the target month
  (31.05. → 28./29.02., 31.12. → 30.09.). Stays `verify` until a PL confirms.
- **Date validation:**
  - Impossible dates (month 14, 31.02.) are hard errors.
  - Plausibility checks (age 15–67 at TG start, entry date after birth date, von ≤ bis) are
    warnings that staff can confirm. Who confirmed a warning, and when, goes into the audit log.
- **"Longest retention wins"** applies **per data item or document, not per person**. Each item
  follows its own retention class. Where one item falls under several rules, the longest of
  those rules applies.

## Q49 — Access to the signed TL 407
- **Signed TL 407 PDF:** the profiler and the PL assigned to the project. Opening the PDF is an
  explicit, logged action. The PL's normal UI shows only metadata: signed yes/no, date,
  submitted, original location.
- **Structured section C fields** (ratings, Gesamteinschätzung, weiteres Vorgehen): profiler only.
- **Back office:** no access to signed TL 407 or Kug 200b. It gets the structured fields it needs
  (Schwerbehinderung status, RV-Nummer) from the participant record. This corrects round 2 (Q40).
- **After exit (evidence set):** break-glass only, with a reason, for audits.

## Q50 — Exit reasons vs. lifecycle states
- `dsv_declined`, `dsv_expired` and `unreachable` stay as **non-terminal** states, so late
  joiners can come back.
- A new terminal state `withdrawn` carries a reason.
- A system job moves people to `withdrawn` when the grace period ends (90 days after the signing
  deadline), with these derived reasons:
  - `dsv_declined` → `declined_dsv`
  - `dsv_expired` → `no_response`
  - `unreachable` → `no_response`
- Manual withdrawal is possible from any pre-TG state, with a reason chosen by the PL.
- `declined_dsv` and `no_response` exist only as reasons, never as states.
- This settles review finding C3: deletion counts from `withdrawn`, so the grace period is part
  of the lifecycle.

## Q51 — Sickness periods
- Treated as payroll records, stored minimally: period type and dates only (`sick_paid`,
  `sick_krankengeld`, `parental_leave`, …).
- Never diagnoses. No AU scans: with the eAU, the employer retrieves sick notes electronically,
  so we store only "AU confirmed: yes, dates".
- Retention: payroll retention (Lohnkonto / Entgeltunterlagen), not the health-data rule.
- Access: back office sees the type. The PL sees only "abwesend" with dates, no reason. The
  profiler sees nothing beyond the PL view.

## Q52 — Final settlement dates
- Two project-level dates, entered by back office:
  - `kugFinalSettlementDate`: the Agentur's final check of Transfer-KuG.
  - `measure110SettlementDate`: settlement of the §110 grant, only if one exists.
- Evidence-set expiry = end of the calendar year of the **later** of the two dates + 4 years.
- Until the required dates are set, the evidence set is not deleted.
- If a project ended more than 12 months ago and still has no settlement date, the admin
  dashboard shows a warning.

## Q42 — Blank form templates and new BA versions
- **Storage:** `packages/forms/templates/ba/<form_code>/<version>/` holds the blank PDF, a
  field map (our field → AcroForm field name), and a manifest (code, version, `valid_from`,
  `valid_until`, SHA-256). Blank forms are official, non-personal documents and belong in the
  repo.
- **Who notices new versions:** one named form owner in back office, with a monthly reminder to
  check the BA download pages. A rejection that mentions the form version also triggers a
  check. When a new version is added, the old one gets `valid_until`.
- **Effect on documents:** forms that are not yet signed are regenerated with the new version.
  Signed forms keep theirs. Every generated PDF records `form_code` and `form_version`.

## Q44 — Jobbörse choice and BA contact consent
- Both are declarations to the BA, not consents to us. We record what was ticked and pass it
  on.
- Jobbörse (TL 407 field 50): enum on the profiling record (`full`, `anonymous_callme`,
  `anonymous_no_contact`, `none`), plus date and form version.
- BA contact/research consent (fields 27–29): a boolean on the profiling record, plus date.
  Revocation goes to the BA. We note it only if the participant tells us.
- Our own consents (portal contact, Kug 200b profile access) remain separate consent records.

## Q46 — Withdrawal after the DSV is signed (verify, legal)
- **Before TG start:** `dsv_signed → withdrawn` is allowed only with an uploaded cancellation
  document signed by all three parties. The PL must confirm the transition, and the customer
  gets a notification flag. The legal mechanism depends on our DSV template.
- **After TG start:** a normal TG exit with an exit reason, not a withdrawal.

## Q47 — Customer as an MVP user
- No. Export only in the MVP. The PL generates a monthly report (PDF + CSV) with the
  whitelisted person-level fields (Q13/14) and aggregates with n < 5 suppression, and sends it
  to the customer.
- A customer login is deferred to v2.

## Q32 — Cluster operator and AVV chain
Still open (cluster team). It is a blocking item on the pre-pilot checklist. It does not block
the demo, which runs locally on synthetic data.

## Q48 — Test PDFs
Confirmed synthetic by the product owner. Committed under `fixtures/forms/`.

## Decided by the docs PR, for review
These are design choices made while carrying the answers into the docs. They need review in
the PR:
- **Profiling-exception path:** `dsv_offered` can be reached from `informed` onwards when
  `profilingException` is set (Q17). The profiling record then completes after TG entry.
- **ASU as a guard:** a registered ASU is a guard for `active_in_tg`, because §111(4) Nr. 4
  SGB III requires it (the law Kug 200b cites).
- **DSV signatures:** `dsv_signed` means the participant's signed paper has been received.
  `active_in_tg` additionally requires the DSV to be fully executed (customer + TG signatures).
- **Renamed `profiling_consented` → `profiling_accepted`:** under Q4 the legal basis for
  profiling is not consent, and the old name invited confusion with GDPR consent.
- **Terminal states:** `withdrawn`, `rejected`, `ta_completed`, `exited`. The old `closed` and
  `closed_tg` are removed, because retention now runs per data item from these states.
- **`profiling_declined`:** handled provisionally like `dsv_declined` (non-terminal,
  auto-withdrawn after the grace period). The withdrawal reason is open (Q53).
