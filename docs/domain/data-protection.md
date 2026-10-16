# Data protection (DSGVO / social data) — engineering rules

> This is an engineering guideline, not legal advice. Have it reviewed by the company's data
> protection officer before go-live.
>
> Status: updated 2026-10-15 from the decisions log, and 2026-10-16 from round 7 (roles per
> project, break-glass scope, evidence-set phase, write permissions, classification additions)
> and round 8 (regional operations manager, approval of profiling exceptions, deletion clock). Most answers here are still **`assumed`**
> (rows marked 🔒 in `open-questions.md`). Build on them, but **nothing in this file may be
> `assumed` or `verify` at the pre-pilot gate.** Items marked *(Qnn)* point to the question.

## Roles under the GDPR *(assumed, Q14)*

- The **TG is an independent controller**, also in phase 1. It is neither a processor for the
  customer nor a joint controller.
- The **customer** is a separate controller for its own HR data and for transferring the import
  file to us.
- Consequences:
  - The customer contract needs a **data-sharing clause** (what is transferred, for which
    purpose), not an AVV.
  - The customer cannot order deletion. Deletion follows our retention rules only. There is no
    "customer deletion request" feature.
  - We need an **AVV with every processor**: the cluster operator chain (owned by the product owner, Q32; blocking for the
    pilot), SMS/mail providers, Gotenberg/storage if run by a third party.

## Classification *(assumed, Q29, Q43)*

| Class | Data | Handling |
|---|---|---|
| **Special category** | health restrictions, Schwerbehinderung/Gleichstellung, GdB | field-level encryption; never in list payloads; separate endpoint; every read logged |
| **Highly confidential** | RV/SV-Nummer, Steuer-ID, IBAN, BA-Kundennummer; Bürgergeld (yes/no only, concerns the spouse too); nationality, date of entry, residence status (incl. Duldung); profiling results (TL 407 section C ratings, Gesamteinschätzung, weiteres Vorgehen) | field-level encryption; never in list payloads; every read logged |
| **Confidential** | name, address, contact, date of birth, CV, qualifications, job wishes | role × project access |
| **Internal** | project, dates, statuses | role × project access |
| **Aggregated** | counts, rates per project | may go to the customer, with suppression |

- **Signed documents** (TL 407, Kug 200b, DSV) take the class of their most sensitive content
  and are stored encrypted.
- **TG sub-status periods** (sickness, parental leave) are payroll records: type and dates only,
  never diagnoses, never AU scans (Q51).
- Free text in section C is **never** included in exports.
- **Additions (round 7, assumed, Q66):**
  - Familienstand, gender, Personalnummer, end of the old employment, knowledge date, work
    email, language skills, driving licence: **confidential**.
  - End reason `long_term_illness_reduced_earning_capacity`: **special category**, never in
    ordinary lists. End reason `deceased`: confidential.
  - Profiling-exception reasons: **structured reason codes** where possible (Q81); a free-text
    reason is **special category**, because it may disclose illness.
  - Override and break-glass free text: **highly confidential**, encrypted, excluded from lists
    and logs, visible only to the actor and the authorised reviewer.
  - UI copy tells staff not to enter diagnoses or unnecessary personal details in free text.

## Access matrix *(assumed, Q28, Q49, Q51)*

| Data | Profiler/Berater (assigned) | PL (assigned project) | Back office | Regional admin / Admin | Participant |
|---|---|---|---|---|---|
| Confidential data | yes | yes | yes, as needed | no case data | own |
| Health, Schwerbehinderung (structured) | yes | no; except in assisted mode (`onBehalfOf`) or break-glass with reason | Schwerbehinderung/Gleichstellung + GdB only (payroll) | never | own |
| Highly confidential identifiers (RV-Nr., IBAN, Steuer-ID) | as needed for forms | no | yes (payroll) | never | own |
| Nationality, residence status, Bürgergeld | yes | no | yes | never | own |
| Section C ratings, Gesamteinschätzung, weiteres Vorgehen | yes | **no** | no | never | not in the portal |
| Signed TL 407 PDF | yes | yes, opening is an explicit logged action; normal UI shows metadata only | **no** | never | — |
| Signed Kug 200b PDF | yes | yes, logged as above | **no** | never | — |
| Sub-status periods | "abwesend" + dates | "abwesend" + dates | type + dates | never | own |
| Evidence set after exit | break-glass with reason (audits) | break-glass with reason | break-glass with reason | never | — |

- **Roles per project** *(assumed, Q61)*: a person has zero or more project roles per project
  (e.g. PL and profiler in the same project). Permissions are the **union** of those roles,
  but sensitive access still needs the participant assignment: a PL who is also a profiler sees
  section C only for participants assigned to them as profiler.
- **"Assigned" is strict** *(assumed, Q62)*: consultants/profilers get **no person-level data**
  of participants not assigned to them, only aggregate workload counts. The PL assigns. There is
  no project-wide directory of names.
- **Break-glass** *(assumed, Q63)*: mandatory reason, audited, flagged for review. One grant
  covers **one participant, one resource/category and one action**, never a reusable session;
  every action is logged on its own. The **regional operations manager** (Q80) reviews it by
  the next business day from audit metadata, without access to participant details. The DPO
  gets periodic reports and immediate escalation of suspicious access, but is not the
  operational approver.
- **Four-eyes** *(assumed, Q63, Q80)*: actor and reviewer are always different staff users.
  Break-glass and reconciliations of a TG entry are **reviewed after the fact** (next business
  day). A profiling exception needs **approval before** it can satisfy the TG entry guard.
- **Regional operations manager** *(assumed, Q80)*: an org role scoped to a region, with **no
  ordinary participant access**. It approves profiling exceptions, reviews reconciliations and
  break-glass, sees audit metadata, structured reason codes and the necessary dates, and can ask
  the PL for clarification. It never sees case files, section C, health fields or signed
  documents through this role.
- **Evidence-set phase** *(assumed, Q64)*: starts **after the first retention/deletion stage**,
  not at the terminal status. During close-out and the ordinary personnel-file retention,
  normal authorised access applies; once only the evidence set is left, break-glass only.
- **Signed TL 407 / Kug 200b for participants** *(assumed, Q67)*: not in the MVP portal; through
  the data-subject export or a manual request.
- **Regional admins and admins manage configuration, not cases.** They see no participant data.
  Escalations to the regional admin (e.g. TL 407 not submitted 14 days after TG start) show
  only: project, responsible PL, number of overdue items per type (e.g. "3 × TL 407 not
  submitted"), and days overdue for the oldest item. **No participant names.** For details the
  regional admin contacts the PL (Q57).
- **Customer**: no login in the MVP (Q47). See the next section.

### Resources, categories and the generated matrix *(assumed, round 11)*

The rules in this file are code in `packages/domain/src/access` (`decideAccess`), with tests for
every cell. **[The generated access matrix](generated/access-matrix.md)** (`pnpm generate`,
checked in CI) shows every subject × resource × action × mode × phase, and every cell the docs
don't cover yet as `undecided` (denied) with its question (Q65).

Access is decided per **resource kind**: a participant **field** (its category from the field
catalog), a **document** (its type from the document-type catalog), **audit metadata** (a
filtered projection) or an **aggregate**. An action a kind doesn't have (opening a field,
aggregate or audit entry as a document, writing an aggregate) is `not_applicable`.

| Category | Fields / documents | Class |
|---|---|---|
| `case_internal` | statuses, dates | internal |
| `confidential` | confidential data; CVs, uploads, qualification certificates | confidential |
| `health` | health (structured); profiling-exception evidence; the health-related end reason value (not storable before Slice 8, which applies this category to it) | special category |
| `disability` | Schwerbehinderung/Gleichstellung, GdB | special category |
| `identifiers` | RV-Nr., IBAN, Steuer-ID, BA-Kundennummer; ASU proof | highly confidential |
| `residence_social` | nationality, residence status, Bürgergeld | highly confidential |
| `profiling_assessment` | section C, Gesamteinschätzung, weiteres Vorgehen | highly confidential |
| `signed_tl407`, `signed_kug200b` | signed TL 407 / Kug 200b | most sensitive content |
| `employment_contract` | signed DSV and its cancellation | highly confidential, encrypted |
| `absence` | sub-status periods | payroll records; not in lists until Q85 |

**Documents** *(assumed, Q87 B)*: a versioned document-type catalog
(`packages/domain/src/documents/catalog.ts`) gives each type its category, class, retention
class, the roles that may use it and participant visibility. Reading a document gives its
metadata; the file only through an explicit, logged opening (`document_opened`). Existing
documents never change: signed ones are immutable, and adding a document or a new version is a
document operation. Signed documents aren't in the MVP portal (Q67).

| Document type | Who may open it |
|---|---|
| Signed TL 407, Kug 200b | assigned profiler, PL |
| Signed DSV, DSV cancellation | PL, back office |
| ASU proof | assigned profiler; PL metadata, the file only through break-glass |
| Profiling-exception evidence | assigned profiler; PL only in assisted mode or through break-glass; regional operations manager "evidence present" (metadata) only |
| CV and general uploads, qualification certificates | the participant (own), assigned consultant, PL; back office for certificates only when funding or settlement needs it (not before Slice 8) |

Generated reports and exports become a resource of their own with the reporting slice; every
generation and download is logged.

**Audit metadata** *(assumed, Q87 A)*: no unrestricted audit stream; read-only filtered
projections. PL: the operational case history of their projects (lifecycle changes, document
status, assignments, corrections). Assigned consultant/profiler: that history for the assigned
participation, plus their own actions. Back office: DSV, payroll, absence and settlement
history. Regional operations manager: only events awaiting or recording their approval or
review. No projection contains sensitive-access or security events (except the break-glass
events the regional operations manager reviews) or a reason code the role couldn't otherwise
read. Participants: no audit-log UI in the MVP (data-subject export). Admins: none. Once only
the evidence set is left, the operational projections need break-glass; the review queue stays
open to the regional operations manager, who reviews those break-glass actions (round 12).

**Evidence set** *(assumed, Q87 C, round 12)*: access is the intersection of the role's
active-phase entitlement (in any mode) and break-glass, with the active view; lists never.
Immutable through field and document writes. Of the raw files, only what the evidence set
lists stays (signed TL 407 / Kug 200b, proof of submission); otherwise only the **minimum
derived evidence facts** remain after stage-one deletion (e.g. ASU proof checked; exception
decision, reason and approval; references and timestamps), not raw health-related exception
evidence.

**Evidence corrections** *(assumed, Q88, round 12)*: never by in-place editing, only through
**`append_evidence_correction`**, targeting a document or a field. Who may request it is an
explicit correction-authority table (`packages/domain/src/access/corrections.ts`), separate from
who may open a document; requesting grants no read access.
- Documents: PL for TL 407, Kug 200b, ASU proof, exception evidence, uploads and certificates;
  PL or back office for the DSV and its cancellation.
- Fields (round 13), only those retained in the evidence set: PL for `firstName`, `lastName`,
  `birthDate`, `personnelNumber`, `profilingSessions` (one session per correction, never the
  whole collection), `withdrawnOn`, `profilingDoneOn`; back office for
  `pensionInsuranceNumber`, `baCustomerNumber`; either for `dsvSignedOn`, `tgStart`, `tgEnd`,
  `tgEntryDate`, `exitDate`. Payroll and personnel fields (address, tax ID, IBAN, absence
  periods) don't join the evidence set to be corrected; while retained, their own active or
  payroll operations correct them. Statuses change only through the status functions.
- Consultants and participants can't alter the evidence set; they raise a task or rectification
  request for the responsible role.
- Append-only, the original kept and linked (corrects/supersedes); a reason code and a
  documented source (BA/legal reference, data-subject rectification request, corrected source
  document or documented internal error); approval by the regional operations manager, four
  eyes; corrected sensitive values encrypted; audit events with IDs, field key, actor and
  timestamps, never the values; the approver sees category, basis and references, no value they
  couldn't otherwise read.
- A correction alone never bypasses lifecycle guards or changes Transfer-KuG eligibility,
  contractual dates or payments: that takes a reconciliation, contractual amendment or recorded
  BA/legal determination.

**Sensitive writes** are audited as `sensitive_write` with the field or document key, actor,
subject and timestamp, **never the old or new value**.

### Write permissions *(assumed until DPO and PL review, Q65)*

| Who | May write |
|---|---|
| Participant | own self-service fields and uploads; never lifecycle, payroll, audit or derived fields |
| Profiler/Berater (assigned) | the case and profiling data their work needs; section C and health data only for assigned participants |
| PL (project) | operational dates, assignments, status actions, exceptions, case administration; **no ordinary editing** of health data, section C or payroll identifiers |
| Back office | DSV administration, payroll identifiers, payroll-relevant disability facts, absence types and dates, settlement data |
| Regional admin / Admin | configuration only, no case data |

- Assisted writes are recorded as actor + `onBehalfOf`.
- **Signed or submitted documents are immutable**; corrections create a new version or a
  correction record.
- Sensitive writes and corrections are audited.

## Customer reporting *(assumed, Q5, Q13, Q47)*

- **No person-level data to the customer, except a fixed whitelist**: name, Personalnummer,
  DSV signed (yes/no + date), beE entry date, beE exit date. The customer needs these to end
  the old employment relationships and calculate per-head costs and Remanenzkosten. The
  whitelist is enforced in the API/report layer (`customerVisible`), not in the UI.
- Everything else is **aggregated with n < 5 suppressed** ("< 5"), plus **secondary
  suppression** so totals can't be used to back-calculate. The threshold is a global setting
  (default 5), implemented in the reporting layer.
- MVP: the PL generates a **monthly report** (PDF + CSV) and sends it to the customer. A
  customer portal is deferred to v2.
- Withdrawal after `dsv_signed` sets a **customer notification flag** (Q46).

## Legal basis and consent *(assumed, Q4, Q44)*

| Purpose | Legal basis |
|---|---|
| Import from the customer (name, contact, Personalnummer) | Art. 6(1)(f), backed by the Transfersozialplan |
| Information, data collection, DSV preparation | Art. 6(1)(b), pre-contractual |
| beE employment, payroll, Transfer-KuG | Art. 6(1)(b) + (c) (SGB III, SGB IV, AO) |
| Profiling and reporting to the Agentur | Art. 6(1)(c) (§110/§111 SGB III) + signed TL 407 declaration |
| Health / disability | Art. 9(2)(b). Details beyond yes/no only with explicit consent, Art. 9(2)(a) |
| Private email/mobile for portal login | consent, Art. 6(1)(a), revocable |
| TG access to the BA applicant profile (Kug 200b) | own consent record |
| Aggregated customer reporting | Art. 6(1)(f), anonymised |

- Each processing purpose is stored with its legal basis.
- **Our consents** are records: purpose, text version (per language), timestamp, `revokedAt`.
  Revoking consent never blocks contract-based or legally required processing.
- **Declarations to the BA** are not our consents: the Jobbörse choice (TL 407 field 50) is
  stored as an enum on the profiling record, and the BA contact/research consent as a boolean,
  each with a date. Revocation goes to the BA.

## Retention and deletion *(verify, Q3, Q24, Q40, Q51, Q52)*

**Each data item or document follows its own retention class.** Where one item falls under
several rules, the longest of those rules applies. Retention is **per item, never per person**,
so a long payroll rule never keeps a whole profile.

| Data | Retention (from) |
|---|---|
| Unmatched / rejected self-registrations | 30 days |
| Non-signers (`withdrawn` pre-TG) without BA-funded measures | full deletion **90 calendar days after `withdrawnOn`** (manual or automatic withdrawal), if there was no fully executed DSV, funded §110 participation, legal hold or other retention duty. *Assumed (Q77): `unset` in executable configuration until the DPO confirms.* |
| Non-signers with BA-funded §110 measures | full deletion after 90 days, **except the evidence set** |
| Structured health fields | 3 months after beE exit, or with non-signer deletion |
| Schwerbehinderung status for payroll | with payroll records, as long as payroll needs it |
| TG personnel file, DSV, profiling, placement data | 3 years after the end of the year of exit |
| Sub-status periods (sickness etc.) | payroll retention |
| Lohnkonto | end of the 6th calendar year after the last entry (§41 EStG) |
| Entgeltunterlagen | end of the calendar year after the last social-security audit (§28f SGB IV) |
| Accounting vouchers | 8 years (BEG IV); books and annual statements 10 years |
| ESF-funded projects (later) | per funding notice, configurable |
| Audit log | 3 years; pseudonymise subject references when the subject's data is deleted |

**Evidence set** (for anyone who took part in a BA-funded §110 measure or received
Transfer-KuG): identity, measure, dates and times of participation, signed participation pages
(TL 407, Kug 200b), proof of submission, and the matching audit entries.
- It expires at the end of the calendar year of the **later** of `kugFinalSettlementDate` and
  `measure110SettlementDate`, plus 4 years (configurable, must be verified).
- It is **not deleted until the required settlement dates are set**. The admin dashboard warns
  when a project ended more than 12 months ago without them.
- Access is break-glass only.

Implementation:
- `retentionClass` per data category and document type, configured as data.
- A nightly, idempotent, **two-stage job** with the `system` actor: full deletion first, then
  evidence-set deletion.
- **Backups are kept for at most 30 days**, so that deletions take effect.
- All periods are configurable and must be confirmed by the DPO and tax advisor before the
  pilot.

## Authentication *(assumed, Q7, Q11, Q27, Q28)*

- **Staff**: Entra ID via OIDC, MFA enforced by Conditional Access. Roles and assignments are
  managed in the app. Sessions last 8 hours, server-side, in httpOnly SameSite cookies.
- **Participants**:
  - The mobile number is the primary channel (SMS link or code). Private email is secondary.
    **Imported work emails are never used for login.**
  - Links/codes are single-use and expire after 15 minutes, with at most 5 requests per hour
    per phone number or email.
  - Sessions: 30 minutes idle, 12 hours absolute.
  - Before special-category data is shown, the participant must enter their date of birth as a
    knowledge check. A real second factor comes later.
  - Fallbacks: a printable one-time access code (info events), and assisted mode.
- **Assisted mode**: staff act on behalf of the participant, audited as `actor` + `onBehalfOf`.
  No session sharing.
- **Self-registration**: only via a project-specific QR code, valid 14 days, rate-limited, with
  a captcha. Matched manually by the PL.

## Other rules

1. **Purpose limitation per phase.** The UI explains each purpose to the participant.
2. **Audit log** for every read of special-category and highly confidential data, every
   document opening, every export, every break-glass, every guard override, and every confirmed
   plausibility warning.
3. **Hosting**: local for development on synthetic data only. Production and the pilot run on
   the company Hetzner cluster in German locations only (ADR-0005). Real data never goes on
   laptops, into cloud coding sessions or into the repo.
4. **No AI in the MVP.** Later, only EU-hosted providers with an AVV and no training on our
   data. US providers are never used for personal data, even with a contract *(assumed, Q38)*.
   Check the EU AI Act classification before any assessment feature.
5. **No real data in development, tests, cloud coding sessions or screenshots.** Synthetic data
   only (`pnpm db:seed`, `fixtures/`).
6. **Logs, error reports and job payloads contain no personal data.** Use IDs only.
7. **Uploads**: virus scan (adapter), file-type allowlist, size limit, stored outside the web
   root, signed short-lived URLs.
8. **Participant rights**: export of own data and deletion requests (admin workflow in the MVP),
   subject to the retention duties above.
9. **Exports**: no Steuer-ID, SV-Nummer or IBAN in the payroll export unless back office
   explicitly requests it. That request is logged.
10. **DPIA (DSFA)** must be completed before any real data is used (Q25).
