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

Users: Projektleiter (PL), Berater/Coach, participants, back office, customer/works council
(read-only reporting), admin.

Start here:
- Domain & vocabulary: `docs/domain/glossary.md` (German terms are used in code — see below)
- Process & lifecycle state machine: `docs/domain/process-and-lifecycle.md`
- Regional variation (BA requirements differ per Agentur): `docs/domain/regional-variation.md`
- Data protection rules: `docs/domain/data-protection.md`
- Product scope (MVP): `docs/prd.md`
- Build order: `docs/roadmap.md`
- Architecture: `docs/architecture/overview.md` and decisions in `docs/adr/`

## Non-negotiable rules

1. **No real personal data. Ever.** Only synthetic seed data in dev, tests, fixtures and
   screenshots. Participant data is social data (Sozialdaten). If you are given a file that
   looks like real employee data, stop and ask.
2. **The lifecycle core is fixed; regional differences are configuration.** Never hard-code
   an Agentur-specific field, document or rule in feature code. See ADR-0004.
3. **External things go behind adapters** (PDF generation, email/SMS, storage, AI, BA/payroll
   exports, e-signature). Features depend on the interface, never on a vendor. See ADR-0006.
4. **The DSV is signed on paper (wet ink, §623 BGB).** The app generates, tracks and stores the
   scan. Never build an e-signature flow for the DSV.
5. **Every status change is audited** (who, when, from, to, why). Use the audit helper; do not
   write status fields directly.
6. **Personal data never flows back to the customer (old employer)** at person level.
   Customer/works-council views are aggregated only.
7. **AI features are suggestions a human approves**, never automatic decisions about a person.
   (Most AI is v2 — do not build it in the MVP unless the roadmap says so.)

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
- Tasks/issues are tracked as markdown files in `docs/issues/` (GitHub issue/PR commands that
  use GraphQL, like `gh issue` and `gh pr`, are blocked in cloud sessions; use `gh api` REST
  calls if you need GitHub).

## Tech stack (see ADR-0003)

- Monorepo, **pnpm** workspaces. Do not use bun (proxy issues in cloud sessions).
- **TypeScript 7** (`tsc` native) for type-checking; tools that need the TS API use TypeScript 6
  via npm alias (`typescript` → `@typescript/typescript6`, `@typescript/native` → TS 7).
- **Vite+ / Vite 8**, Vitest, Oxlint/Oxfmt (via Vite+).
- Frontend: **React**, **TanStack Router** (type-safe routes, preloading), **TanStack Query**,
  **IBM Carbon** (`@carbon/react`) wrapped in our own `packages/ui` layer.
- Backend: **Node 22**, **Hono**, **Drizzle ORM**, **PostgreSQL 16**.
- Shared validation: **Zod** schemas in `packages/domain` (used by API and UI).
- Tests: Vitest (unit/integration), Playwright (e2e).
- Runs locally via Docker Compose; production target is the company Hetzner cluster as
  container images (ADR-0005). Keep application code provider-neutral.

## Repo layout (target)

```
apps/
  web/            React SPA (staff + participant portal, role-based)
  api/            Hono API
packages/
  domain/         entities, lifecycle state machine, Zod schemas, completeness rules (no I/O)
  config/         regional/project configuration model + resolver
  db/             Drizzle schema, migrations, seed (synthetic only)
  adapters/       interfaces + mock implementations (pdf, mail, sms, storage, ai, export)
  ui/             thin wrappers around Carbon components, layout, tokens
docs/             product + domain + architecture docs (source of truth)
```

## Conventions

- Language: code, comments, commits in **English**. Domain terms that have no clean English
  equivalent stay **German** in code, exactly as in the glossary: `dsv`, `transferKug`,
  `profiling`, `arbeitsuchendmeldung`, `agentur`. UI text is German (i18n keys, `de` default,
  `en` later; participant portal will need more languages).
- Names: `camelCase` for code, `snake_case` for DB columns, `kebab-case` for files.
- Dates: store UTC, display Europe/Berlin.
- Never commit secrets. Config via environment variables; document new ones in `.env.example`.
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
- [ ] Docs updated if behaviour or knowledge changed
- [ ] PR description: what, why, how tested, screenshots for UI
