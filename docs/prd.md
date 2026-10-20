# Product requirements — MVP

## Goal

Make transfer projects easier for everyone involved: less manual chasing and Excel for
Projektleiter, less data entry for Berater, a simple self-service experience for participants,
and transparent progress for customers — while staying compliant with BA requirements that
vary by region.

## Success measures (MVP)

- PL can see in under 10 seconds who is missing what in a project.
- ≥ 70 % of participants complete their data via self-service (rest via assisted mode).
- Generating the Agentur forms for a participant takes < 1 minute after profiling.
- Zero hard-coded regional rules: a new Agentur's requirements are added via configuration.

## Users & roles

| Role | Core needs | Access |
|---|---|---|
| Projektleiter (PL) | setup, import, overview, reminders, Agentur submission, customer report | own projects; no health data or section C (assisted mode / break-glass only) |
| Berater / Profiler / Coach | consultation, profiling (TL 407 incl. section C), assisted data entry, TG coaching | assigned projects/participants; special-category data only for assigned participants |
| Back office | DSV handling, payroll fields, exports, settlement dates, form versions | assigned projects; no signed TL 407/Kug 200b |
| Participant | register, fill data, upload docs, book appointments, see status & tasks | own data only |
| Customer / Works council | monthly report from the PL (whitelisted person fields + aggregates) | **no login in the MVP** (v2) |
| Regional admin | users and configuration of their region (Niederlassung) | no case data |
| Admin | users, regional templates, settings | global; no case data |

Field-level access rules: `docs/domain/data-protection.md` (access matrix).

## User flows (MVP)

### F1 Project setup
- Create project: name, customer, type (`ta_only` / `ta_tg`); then the Project Agentur (the
  KuG-Agentur for `ta_tg`, Q90), pinned Agentur templates and overrides. The project carries no
  contractual dates: in `ta_tg` they live on its entry waves (signing deadline, default TG
  start/end, `latestEntryDate`).
- Project checklist: Agentur consultation of the Betriebsparteien, Anzeige über Arbeitsausfall,
  later the settlement dates (`kugFinalSettlementDate`, `measure110SettlementDate`).
- Acceptance: a project stays `draft` until activated; activation needs a pinned Project-Agentur
  template and, in `ta_tg`, a wave with a `latestEntryDate` (Q98). Rules:
  process-and-lifecycle.md, "Dates".

### F2 Import participants from Excel/CSV
- Upload (`.xlsx` or CSV) → column mapping (suggested from saved mappings of the project and of
  projects with the same customer, then synonyms; confirmed by the PL) → validation → preview
  with errors, warnings and possible duplicates → confirm. Manual creation of one person follows
  the same rules.
- Required: Personalnummer, Nachname, Vorname; Geburtsdatum, Austrittsdatum and Anschrift unless
  the project relaxed their rule. Optional: phone, mobile, private and work email (work email is
  never used for login).
- Acceptance: invalid rows are reported with row number and code; nothing is imported until
  confirmed, and a confirm is all or nothing; re-import updates matched people (exact
  Personalnummer within the project) instead of duplicating; terminal participations are
  skipped. No matching across projects.
- Rules: process-and-lifecycle.md, "Import and manual creation" (Q103, Q104).

### F3 Activation codes ([round 35](decisions/2026-10-20-answers-round-35.md))
- Every participation gets a personal, single-use activation code when it is created. It goes
  out by activation letter to the imported address and as a printed sheet at the info event,
  each with a QR of the personal link. The participant activates with the code and the knowledge
  check, then registers a private email or mobile.
- No anonymous self-registration and no matching. People missing from the employer's list are
  created by the PL and get a code too.
- The PL sees who has activated and can reissue codes.
- Open: Q113–Q119.

### F4 Communication & appointments
- Invitations and reminders via email/SMS (adapter; mock in MVP dev).
- Info events and consultation slots; participants self-book; attendance recorded.
- All messages logged per participant.

### F5 Participant self-service
- Separate participant app (`apps/portal`). First access with the personal activation code (F3); then
  login with a one-time code to the private email or mobile the participant registered; never
  imported work email. Birth date check before special-category data. Mobile-first
  step-by-step wizard, save & resume, progress bar. Consent screen first; consents are
  versioned records.
- Steps (driven by regional config): personal data, contact, education, work history,
  certificates/licences, job wishes, mobility, optional sensitive data, document uploads.
- **Assisted mode:** staff open the same wizard on behalf of the participant (audited as
  `onBehalfOf`).
- Acceptance: required fields come from resolved config; a participant can't see other data.

### F6 Arbeitsuchendmeldung, profiling & Agentur forms
- Arbeitsuchendmeldung per participant: channel, date, placement Agentur, due date
  (§38 SGB III); Kug 200b generated for the TG route and submitted in batches per Agentur;
  Teilnehmerliste export.
- Profiler completes profiling (pre-filled from self-service), incl. profiling sessions and
  section C.
- Generate TL 407 / Kug 200b by filling the official AcroForm (form code + version recorded);
  overflow on a generated "Anlage zum Profilingbogen". Strict date validation before rendering.
- Paper signatures → scan upload + original tracking; submission to the Agentur per person
  (channel from the placement Agentur's template).

### F7 PL dashboard
- Funnel per project (counts per lifecycle state).
- "What's missing" list: per participant, missing fields/documents/signatures, overdue
  appointments, rejected uploads.
- Filters, search, bulk actions (send reminder, assign Berater, export list).
- Deadline warnings (signing deadline, TG start, ASU due date, profiling-exception deadline).
- Lists: DSVs signed by the participant but not fully executed; Kug 200b submitted without
  Agentur confirmation after 14 days; TL 407 not submitted by TG start (escalated to PL and
  regional admin 14 days after TG start); self-registered ASU without Kug 200b profile-access
  consent; conflicts (DSV signed but profiling declined); TG entry
  guards failing.

### F8 DSV tracking
- DSV is often handed out at the info event, in parallel with profiling (separate DSV track).
- Generate DSV PDF per participant; statuses offered / signed / declined / expired;
  upload scan of signed paper; track customer and TG counter-signatures and the original
  (location, received, sent to customer).
- Late joiners can be re-offered with an explicit offer deadline until the final admission
  cutoff (after `latestEntryDate`, Q69/Q77); then the system moves them to `withdrawn`.
- Acceptance: no e-signature; signed status requires an uploaded scan + who received it; TG
  entry requires the DSV signed by all three parties.

### F9 TG module (basic)
- Participant file, coaching appointments & notes, goals/tasks, qualification activities
  (course, provider, cost, funding source, approval by customer budget owner, certificate),
  applications (incl. trial work), exit with reason and placement details.
- Sub-status periods (sick, parental leave, …; type and dates only) with versioned CSV export for
  payroll (DATEV LODAS later) — no billing logic in MVP.
- Profiling exception: reminders until profiling is completed within 1 month of TG entry.

### F10 Reporting (basic)
- Project report: funnel, placements, integration rate, active participants, qualification spend.
- Monthly customer report (PDF + CSV) generated by the PL: whitelisted person fields +
  aggregates with n < 5 suppression. Customer portal = v2.
- Half-yearly report for the Agentur (30.06 / 31.12) *(verify)*.

## Out of scope for MVP (v2+)

- AI: job matching, qualification suggestions, profiling drafts (v2). Document extraction
  and CV generation may come in v1.x behind the AI adapter.
- Direct BA system integration, payroll (DATEV) integration, KuG billing calculation.
- Customer/works-council portal and customer login (v2).
- E-signatures for any form (DSV never).
- Native mobile apps.
- Languages beyond German/English in the participant portal (v1.1: TR, AR, PL, RU, UK, RO).
  Staff UI German only.

## Non-functional requirements

- **Performance:** route transitions feel instant (< 100 ms with preloaded data); lists of
  2,000 participants filter client-side without lag; API p95 < 300 ms.
- **Accessibility:** WCAG 2.1 AA (Carbon helps; test with keyboard + screen reader).
- **Security:** see data-protection.md; OWASP ASVS L2 as target.
- **Hosting:** local (Docker Compose) for development on synthetic data; pilot and production on
  the company Hetzner cluster (German locations only).
- **Browser support:** current Chrome, Edge, Firefox, Safari; participant portal on mobile.
- **Audit:** every status change, every access to special-category and highly confidential
  data, every document opening, export, override and break-glass.

## Open questions

See `docs/open-questions.md`.
