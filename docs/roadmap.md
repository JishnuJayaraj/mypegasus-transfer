# Roadmap — vertical slices

Each slice is one branch and one PR (or a short series). Each ends with something a PL could
click through in a demo. Write a plan in `docs/plans/<slice>.md` before implementing.

## Slice 0 — Walking skeleton
Monorepo (pnpm), Vite+/Vite 8 web app, Hono API, Postgres + Drizzle migration, Carbon shell
(header, side nav), TanStack Router with 2 routes, one entity (`Project`) list + create, end to
end, with tests. CI (GitHub Actions): typecheck, lint, test. Stub auth (dev user switcher).
**Done when:** `pnpm dev` shows the project list from the DB; CI is green.

## Slice 1 — Domain core
`packages/domain`: entities, lifecycle state machine (`canTransition`), audit event model,
completeness engine. `packages/config`: regional template model + resolver + 2 sample
templates. 100 % unit-test coverage on transitions and resolution.
**Done when:** tests document every allowed/forbidden transition.

## Slice 2 — Projects & import (F1, F2)
Project setup with template selection, Excel/CSV import with column mapping, validation report,
duplicate handling, synthetic sample files.

## Slice 3 — Auth & roles
Staff auth via adapter (OIDC later), participant magic link (mock mail adapter), role × project
permissions, audit of logins.

## Slice 4 — Self-service wizard (F5) + registration link (F3)
Config-driven wizard, consent, uploads (storage adapter, mock), assisted mode, QR/link
registration and matching.

## Slice 5 — PL dashboard (F7) + reminders (F4 basics)
Funnel, "what's missing", filters, bulk reminder (mail/SMS adapters, mock), deadlines.

## Slice 6 — Profiling & forms (F6)
Arbeitsuchendmeldung (ASU record, due date, Kug 200b, batch export), profiling screen,
`packages/forms` registry with TL 407 + Kug 200b (ADR-0009), PDF adapter (pdf-lib +
Gotenberg), overflow attachment, scan upload, Agentur submission status.

## Slice 7 — DSV (F8)
DSV generation, three-party signature and original tracking, grace period and system
withdrawal, transition to TG (guards), two-stage retention job (ADR-0008).

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
v1.1: more portal languages (tr, ar, pl, ru, uk, ro), appointments self-booking polish.
v2: customer/works-council portal with login.
v1.x: AI document extraction, CV generation, note summaries (behind AI adapter, EU-hosted model).
v2: job matching, qualification suggestions, profiling drafts (AI Act review first),
payroll/DATEV integration, KuG billing support.
