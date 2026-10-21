# Roadmap — vertical slices

Each slice is one branch and one PR (or a short series). Each ends with something a PL could
click through in a demo. Write a plan in `docs/plans/<slice>.md` before implementing; a finished slice's plan moves to
`docs/plans/archive/`. Slices 0–3 are done.

## Slice 0 — Walking skeleton
Monorepo (pnpm), Vite 8 web app, Hono API, Postgres + Drizzle migration, Carbon shell
(header, side nav), TanStack Router with 2 routes, one entity (`Project`) list + create, end to
end, with tests. API routes via `@hono/zod-openapi` under `/api/v1` (ADR-0010). CI (GitHub Actions): typecheck, lint, test. Stub auth (dev user switcher).
**Done when:** `pnpm dev` shows the project list from the DB; CI is green.

## Slice 1 — Domain core
`packages/domain`: entities, lifecycle (main status + profiling track + DSV track,
`canTransition`), TG entry guard and admission-cutoff withdrawal rules, audit event model,
completeness engine, **field-level access matrix** (role × project × assignment × data class,
from data-protection.md). `packages/config`: regional template model (JSON Schema) + resolver
+ 2 sample templates. 100 % unit-test coverage on transitions, guards, access rules and
resolution.
Base defaults file (`packages/domain/config/base-defaults.json`). pg-boss set up with the
`Clock` adapter for the system transitions (ADR-0011).
**Done when:** tests document every allowed/forbidden transition and every access rule.

## Slice 2 — Projects & import (F1, F2)
Project setup with template selection, Excel/CSV import with column mapping, validation report,
duplicate handling, synthetic sample files. Configuration invariants from round 15: the Project
Agentur (the KuG-Agentur for `ta_tg`) and its pinned template; an override is validated against
every pinned Agentur template and each relaxation must match at least one pinned chain; existing
template versions are immutable; a version migration surfaces Agentur-scoped settings for
review.

## Slice 3 — Auth & roles
Connect login and identity to the Slice 1 access model: staff OIDC (dev stub first) in
`apps/web`; in `apps/portal` personal activation codes, the activation flow (knowledge check,
private email or mobile with consent), one-time-code login (mail/SMS mock adapters), sessions,
audit of logins; the PL's activation status, reissue and printable letter/sheet (round 35,
Q112–Q120). Removal of `self_registered` and `rejected` from the lifecycle core (its own PR).
Deferred here from Slice 2: membership management, participant assignments (Q62) and
regions on projects (until then the org roles have global scope).
**Done** 2026-10-21 (PRs 3a–3f): plan archived in [`plans/archive/slice-3.md`](plans/archive/slice-3.md);
its rules live in ADR-0007, ADR-0002 and `domain/data-protection.md`.

## Slice 4a — Self-service wizard + consent (F5)
Config-driven wizard in `apps/portal`, consent records, assisted mode (from `apps/web`).
Deferred here from Slice 2: the placement Agentur on participations and its automatic pin (Q36).
Special-category and highly confidential storage (encryption, separate logged endpoints) comes
with the first such field (here or Slice 6).
**Plan:** [`plans/slice-4a.md`](plans/slice-4a.md) (PRs 4a-1 to 4a-5; in review).

## Slice 4b — Uploads and documents (F5)
Uploads (storage + virus-scan adapters, mock), file-type allowlist, signed URLs, document
records with retention class.

## ~~Slice 4c — QR registration and matching~~
Dropped in round 35: personal activation codes (Slice 3) replace the project QR, so there is no
self-registration, matching or 30-day cleanup.

## Slice 5 — PL dashboard (F7) + reminders (F4 basics)
Funnel, "what's missing", filters, bulk reminder (mail/SMS adapters, mock), deadlines.
Deferred here from Slice 2: bulk entry-wave assignment; the audit history UI (until then the
runtime role can't read `audit_event`).

## Slice 6 — Profiling & forms (F6)
Arbeitsuchendmeldung (ASU record, due date, Kug 200b, batch export), profiling screen,
`packages/forms` registry with TL 407 + Kug 200b (ADR-0009), PDF adapter (pdf-lib +
Gotenberg), overflow attachment, scan upload, Agentur submission status.
Deferred here from Slice 2: sending BA reports (marking reporting tasks `reported` or
`not_required`); the affected monthly claim and project closure stay blocked while a required
report is pending (process-and-lifecycle.md, BA reporting).

## Slice 7 — DSV (F8)
DSV track: generation, three-party signatures (`dsvFullyExecuted`), original tracking, list of
"participant signed, not fully executed", admission cutoff and system withdrawal (incl. conflict
flags), TG entry guard, two-stage retention job (ADR-0008).
Deferred here from Slice 2: the reconciliation route (Q68) and its review.

## Slice 8 — TG module basic (F9)
Participant file, coaching notes, goals/tasks, qualification plan, applications, exit.

## Slice 9 — Reporting (F10) + hardening
Project report, monthly customer report, exports, accessibility pass, performance pass,
security review, backup/restore, deployment manifests (`deploy/`).

## Pre-pilot gate
Before any real data (pilot: one project in Nürnberg on the Hetzner cluster): all items of the
checklist in ADR-0005 — DPIA, AVV chain (Q32), no `assumed` items in data protection, retention
or legal deadlines, tested backup/restore, security review.

## Later
Deferred from Slice 2: override additions of rules, custom fields and help texts through the
API; template publication and the admin UI; project closure. Excluded (Q98): return to draft
(activation is one-way) and a type change once the project has participations or waves.
v1.1: more portal languages (tr, ar, pl, ru, uk, ro), appointments self-booking polish.
v2: customer/works-council portal with login.
v1.x: AI document extraction, CV generation, note summaries (behind AI adapter, EU-hosted model).
v2: job matching, qualification suggestions, profiling drafts (AI Act review first),
payroll/DATEV integration, KuG billing support.
