# CLAUDE.md — Transfer Platform

Read this file at the start of every session. It tells you what this product is, how the
repo is organised, and the rules you must follow. Details live in `docs/` — follow the links.

## What we are building

A web application for a German **Transfergesellschaft (TG)** that runs transfer projects
for employers who are reducing staff. It supports the whole participant lifecycle:

1. **Phase 1 – Transferagentur / pre-phase:** import affected employees, inform them,
   collect their data (self-service), run profiling, generate BA forms, track the DSV.
2. **Phase 2 – Transfergesellschaft:** participants who signed the DSV are employed by the
   TG for up to 12 months: coaching, qualification planning, applications, exit.

Users: Projektleiter (PL), Berater/Profiler, participants, back office, regional admin, admin.
The customer/works council receives reports but has no login in the MVP.

Start here:
- Domain & vocabulary: `docs/domain/glossary.md` (German terms are used in code — see below)
- Process & lifecycle state machine: `docs/domain/process-and-lifecycle.md`
- Regional variation (BA requirements differ per Agentur): `docs/domain/regional-variation.md`
- Data protection rules: `docs/domain/data-protection.md`
- Official BA forms (TL 407 profiling, Kug 200b Arbeitsuchendmeldung): `docs/domain/ba-forms.md`
- Decisions log and open questions: `docs/open-questions.md`, answers in `docs/decisions/`
- Product scope (MVP): `docs/prd.md`
- Build order: `docs/roadmap.md`
- Architecture: `docs/architecture/overview.md` and decisions in `docs/adr/`

## Non-negotiable rules

Rules marked *(provisional)* rest on answers that are still `assumed` in
`docs/open-questions.md`. Follow them, but don't treat them as confirmed facts. They must be
confirmed before the pilot.

1. **No real personal data. Ever.** Only synthetic seed data in dev, tests, fixtures and
   screenshots. Participant data is social data (Sozialdaten). If you are given a file that
   looks like real employee data, stop and ask.
2. **The lifecycle core is fixed; regional differences are configuration.** Never hard-code
   an Agentur-specific field, document or rule in feature code. See ADR-0004.
3. **External things go behind adapters** (PDF generation, email/SMS, storage, AI, BA/payroll
   exports, e-signature). Features depend on the interface, never on a vendor. See ADR-0006.
4. **The DSV and the official BA forms (TL 407, Kug 200b) are signed on paper (wet ink; §623
   BGB for the DSV).** The app generates, tracks the scan and the paper original. Never build an
   e-signature flow for them. Official forms are versioned in the form registry (ADR-0009).
5. **Every status change is audited** (actor `user`/`participant`/`system`, `onBehalfOf`, when,
   which field, from, to, why). A participation has a main status plus a profiling track and a
   DSV track; all go through the single status function, which writes the change and the audit
   entry in one transaction. The DB role cannot update status columns directly (ADR-0002).
   Guard overrides, break-glass access, document openings and confirmed warnings are audited
   too. Some guards (DSV fully executed, ASU registered) have no override.
6. **Personal data never flows back to the customer (old employer)** at person level, **except a
   fixed whitelist** *(provisional, Q13/Q14)*: name, Personalnummer, DSV signed (yes/no + date),
   beE entry date, beE exit date. Everything else is aggregated with n < 5 suppressed. Enforce
   this in the API/report layer. The customer has no login in the MVP; the PL sends a monthly
   export (Q47).
7. **AI features are suggestions a human approves**, never automatic decisions about a person.
   No AI in the MVP. Later only EU-hosted providers with an AVV *(provisional, Q38)*.
8. **We are an independent controller** *(provisional, Q14)*. The customer contract has a
   data-sharing clause, not an AVV, and the customer cannot order deletions. Every processor
   (cluster operator, SMS/mail providers) needs an AVV. The product owner operates the cluster
   and owns its AVV chain; a signed AVV chain is a pre-pilot gate item (Q32).
9. **Sensitive data stays out of lists and logs.** Special-category and highly confidential
   fields are encrypted, never in list payloads, and served by separate logged endpoints. No
   personal data in logs, errors or job payloads. See the access matrix in
   `docs/domain/data-protection.md`.
10. **Retention is per data item, never per person** (ADR-0008). Every new table or document
    type needs a `retentionClass`.

## How we work (workflow)

- Work in **vertical slices** from `docs/roadmap.md`. One slice = one branch = one PR.
- For each slice: **plan first** (write the plan to `docs/plans/<slice>.md`, wait for approval
  unless told otherwise) → implement with tests → self-review → open PR.
- Write tests first for domain logic (lifecycle transitions, completeness rules, config
  resolution). UI gets component tests for critical flows and Playwright e2e for the happy path.
- Keep PRs small (aim < 400 lines changed excluding generated code).
- If the docs are missing domain knowledge you need, **ask** — do not invent BA rules. Add an
  entry to `docs/open-questions.md` instead of guessing.
- When a correction from the human reveals missing knowledge, update the relevant doc in the
  same PR.
- Tasks/issues are tracked as markdown files in `docs/issues/`. For GitHub itself, use the
  GitHub tools available in the session (`gh issue`/`gh pr` GraphQL commands are blocked in
  cloud sessions).

## Tech stack (see ADR-0003)

- Monorepo, **pnpm** workspaces. Do not use bun (proxy issues in cloud sessions).
- **TypeScript 7** (`tsc` native) for type-checking; tools that need the TS API use TypeScript 6
  via npm alias (`typescript` → `@typescript/typescript6`, `@typescript/native` → TS 7).
- **Vite+ / Vite 8**, Vitest, Oxlint/Oxfmt (via Vite+).
- Frontend: **React**, **TanStack Router** (type-safe routes, preloading), **TanStack Query**,
  **IBM Carbon** (`@carbon/react`) wrapped in our own `packages/ui` layer.
- Backend: **Node 24 LTS** in production (code must also run on Node 22, which cloud sessions
  ship), **Hono**, **Drizzle ORM**, **PostgreSQL 16**.
- Shared validation: **Zod** schemas in `packages/domain` (used by API and UI).
- Tests: Vitest (unit/integration), Playwright (e2e).
- PDF: **pdf-lib** for official AcroForms, **Gotenberg** for HTML→PDF, both behind `PdfRenderer`.
- Runs locally via Docker Compose (Postgres 16, MinIO, Gotenberg) on synthetic data; pilot and
  production on the company Hetzner cluster (k3s, CloudNativePG) as container images
  (ADR-0005). Keep application code provider-neutral.

## Repo layout (target)

```
apps/
  web/            React SPA for staff
  portal/         React SPA for participants (mobile-first, own login flow) — ADR-0001
  api/            Hono API
packages/
  domain/         entities, lifecycle state machine, Zod schemas, completeness rules (no I/O)
  config/         regional/project configuration model + resolver
  db/             Drizzle schema, migrations, seed (synthetic only)
  adapters/       interfaces + mock implementations (pdf, mail, sms, storage, virus scan,
                  export, clock) — see ADR-0006
  forms/          official BA form templates (blank PDF, field map, manifest) — ADR-0009
  ui/             thin wrappers around Carbon components, layout, tokens
fixtures/         synthetic test files only (e.g. filled test forms)
docs/             product + domain + architecture docs (source of truth)
```

## Conventions

- Language: code, comments, commits in **English**. Domain terms that have no clean English
  equivalent stay **German** in code, exactly as in the glossary: `dsv`, `transferKug`,
  `profiling`, `arbeitsuchendmeldung`, `agentur`, `tl407`, `kug200b`. Lifecycle state and enum
  values are `snake_case` strings (e.g. `dsv_signed`).
- Names: `camelCase` for code, `snake_case` for DB columns, `kebab-case` for files.
- Dates: legal/calendar dates (deadlines, TG start/end, exit) as `date`; event times as UTC
  `timestamptz`, displayed in Europe/Berlin. Form dates are `TT.MM.JJJJ`; impossible dates are
  errors, implausible ones are warnings staff confirm.
- UI text through i18n only. Staff UI (`apps/web`) `de`; participant portal (`apps/portal`) `de` +
  `en` in the MVP, RTL-ready (CSS logical properties).
- Never commit secrets. Config via environment variables; document new ones in `.env.example`.
  The deny rules for `.env`, `.env.local` etc. in `.claude/settings.json` are a **guardrail,
  not a security boundary** (they match command text and are easy to get around). Real secrets
  live in the cluster's secret store, never in the repo or a local file an agent can read.
- Every table holding participant data has a `project_id` column (RLS is added before the
  pilot, ADR-0002/0005).
- API: OpenAPI via `@hono/zod-openapi`, RFC 9457 errors, cursor pagination, `/api/v1`
  (ADR-0010). Jobs: pg-boss, idempotent, `system` actor, injected `Clock`, ID-only payloads
  (ADR-0011).
- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Commands (fill in once the skeleton exists)

```
pnpm install
pnpm dev          # web + api
pnpm test         # vitest
pnpm test:e2e     # playwright
pnpm lint
pnpm typecheck
pnpm db:migrate
pnpm db:seed      # synthetic data only
```

In cloud sessions PostgreSQL is pre-installed but not running: start it with
`service postgresql start`.

## Definition of done (every PR)

- [ ] Typecheck, lint and tests pass locally and in CI
- [ ] New domain logic has tests; lifecycle transitions covered
- [ ] No hard-coded regional rules; no vendor calls outside adapters
- [ ] Status changes go through the audit helper
- [ ] No real personal data anywhere
- [ ] New personal data has a classification, access rule and `retentionClass`
- [ ] Docs updated if behaviour or knowledge changed
- [ ] PR description: what, why, how tested, screenshots for UI
