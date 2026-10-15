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
| Projektleiter (PL) | setup, import, overview, reminders, Agentur submission | own projects, full |
| Berater / Coach | consultation, profiling, assisted data entry, TG coaching | assigned projects/participants |
| Back office | DSV handling, documents, exports | assigned projects |
| Participant | register, fill data, upload docs, book appointments, see status & tasks | own data only |
| Customer / Works council | progress reporting | aggregated, own project only (v1.1) |
| Admin | users, regional templates, settings | global or per region |

## User flows (MVP)

### F1 Project setup
- Create project: customer, location, Agentur/regional template, dates (TA start, signing
  deadline, TG start/end), modules (TA, TG).
- Acceptance: project cannot be activated without dates and a regional template.

### F2 Import participants from Excel/CSV
- Upload → column mapping (saved per customer for reuse) → validation → preview with errors
  and duplicates → confirm.
- Acceptance: invalid rows are reported with row number and reason; nothing is imported until
  confirmed; re-import updates matched people instead of duplicating.

### F3 Registration link & QR code
- Per project link/QR for info events; self-registration creates `self_registered`;
  PL matches to imported records (suggested matches by name + birth date).

### F4 Communication & appointments
- Invitations and reminders via email/SMS (adapter; mock in MVP dev).
- Info events and consultation slots; participants self-book; attendance recorded.
- All messages logged per participant.

### F5 Participant self-service
- Login via magic link (email or SMS). Mobile-first step-by-step wizard, save & resume,
  progress bar. Consent screen first.
- Steps (driven by regional config): personal data, contact, education, work history,
  certificates/licences, job wishes, mobility, optional sensitive data, document uploads.
- **Assisted mode:** Berater opens the same wizard on behalf of the participant (audited).
- Acceptance: required fields come from resolved config; a participant can't see other data.

### F6 Profiling & Agentur forms
- Berater completes profiling (pre-filled from self-service).
- Generate forms from templates (PDF adapter) with template version recorded.
- Collect signatures (paper → scan upload in MVP), track submission to Agentur per person.

### F7 PL dashboard
- Funnel per project (counts per lifecycle state).
- "What's missing" list: per participant, missing fields/documents/signatures, overdue
  appointments, rejected uploads.
- Filters, search, bulk actions (send reminder, assign Berater, export list).
- Deadline warnings (signing deadline, TG start).

### F8 DSV tracking
- Generate DSV PDF per participant; statuses offered / signed / declined / expired;
  upload scan of signed paper; signing moves participant towards TG.
- Acceptance: no e-signature; signed status requires an uploaded scan + who received it.

### F9 TG module (basic)
- Participant file, coaching appointments & notes, goals/tasks, qualification plan
  (course, provider, cost, status, budget), applications (incl. trial work), exit with reason.
- Attendance/absence capture with export (CSV) for payroll/KuG — no billing logic in MVP.

### F10 Reporting (basic)
- Project report: funnel, placements, active participants, qualification spend.
- Export CSV/PDF. Customer portal = v1.1.

## Out of scope for MVP (v2+)

- AI: job matching, qualification suggestions, profiling drafts (v2). Document extraction
  and CV generation may come in v1.x behind the AI adapter.
- Direct BA system integration, payroll (DATEV) integration, KuG billing calculation.
- Customer/works-council portal (v1.1).
- E-signatures for any form (DSV never).
- Native mobile apps.
- Languages beyond German/English in participant portal (v1.1: TR, PL, RO, AR, UK, RU — confirm).

## Non-functional requirements

- **Performance:** route transitions feel instant (< 100 ms with preloaded data); lists of
  2,000 participants filter client-side without lag; API p95 < 300 ms.
- **Accessibility:** WCAG 2.1 AA (Carbon helps; test with keyboard + screen reader).
- **Security:** see data-protection.md; OWASP ASVS L2 as target.
- **Hosting:** local (Docker Compose) for dev/pilots; production on the company Hetzner cluster (Germany).
- **Browser support:** current Chrome, Edge, Firefox, Safari; participant portal on mobile.
- **Audit:** every status change and every access to special-category data.

## Open questions

See `docs/open-questions.md`.
