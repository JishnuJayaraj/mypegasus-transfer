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

Start here (read the sections your task needs, not everything):
- Domain & vocabulary: `docs/domain/glossary.md` (German terms are used in code — see below)
- Process & lifecycle state machine: `docs/domain/process-and-lifecycle.md`
- Regional variation (BA requirements differ per Agentur): `docs/domain/regional-variation.md`
- Data protection rules: `docs/domain/data-protection.md`
- Official BA forms (TL 407 profiling, Kug 200b Arbeitsuchendmeldung): `docs/domain/ba-forms.md`
- Questions: unsettled in `docs/open-questions.md`, confirmed in
  `docs/decisions/settled-questions.md` (same `Qnn`); the dated round files only if a row isn't enough
- Product scope (MVP): `docs/prd.md`; build order: `docs/roadmap.md`
- Architecture and packages: `docs/architecture/overview.md`, decisions in `docs/adr/`

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
   too. Documentary and contractual guards (signed DSV and TL 407, fully executed DSV, ASU
   proof, cancellation, TA completion evidence) have no override (Q71).
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

- Work in **vertical slices** from `docs/roadmap.md`. A slice's plan divides it into PRs (e.g.
  2g-1, 2g-2); one planned PR = one branch = one PR.
- For each slice: **plan first** (write the plan to `docs/plans/<slice>.md`, wait for approval
  unless told otherwise) → implement with tests → self-review → open PR.
- **Keep plans lean:** decisions, PR table, design, acceptance criteria. What a PR built goes in
  its description, readings for the owner in `docs/open-questions.md`. A finished slice's plan
  moves to `docs/plans/archive/`: history, don't read it. Its rules live in `docs/domain/`, the
  ADRs and `docs/architecture/`; a rule found only in an archived plan moves there in your PR.
- **Comments cite the doc that holds a rule** (e.g. "process-and-lifecycle.md, BA reporting"),
  never rounds, plan items (R12, AC-40) or plan sections; replace such citations where you touch.
- **One session per planned PR**; the plan and the PR are the handoff.
- Write tests first for domain logic (lifecycle transitions, completeness rules, config
  resolution). UI gets component tests for critical flows and Playwright e2e for the happy path.
- An invariant test is never weakened or removed to get CI green; a timing budget may be reported
  as soft (`PERF_BUDGET`) but is never deleted.
- **PR size:** one PR per unit the plan names. Don't split a planned PR further just for size:
  the product owner reviews at the planning stage and accepts the PRs, so extra stacked PRs only
  add merge overhead. Split only when a PR would mix unrelated concerns or exceed about 1,500
  changed lines excluding generated code and tests, and then say so in the plan. Prefer PRs based
  on `main`; stack one on another only when it needs the unmerged work.
- If the docs are missing domain knowledge you need, **ask** — do not invent BA rules. Add an
  entry to `docs/open-questions.md` instead of guessing.
- When a correction from the human reveals missing knowledge, update the relevant doc in the
  same PR.
- Tasks/issues are tracked as markdown files in `docs/issues/`. For GitHub itself, use the
  GitHub tools available in the session (`gh issue`/`gh pr` GraphQL commands are blocked in
  cloud sessions).

## Tech stack (ADR-0003 has the details and the rules)

- Monorepo, **pnpm** workspaces. Do not use bun (proxy issues in cloud sessions).
- **TypeScript 6** (`typescript@6.0.3`, the only TypeScript in the tree); `pnpm typecheck` =
  `tsc -b`. Never set `ignoreDeprecations` or use options TS 6 deprecates.
- **Vite 8**, **Vitest**, **Oxlint**, **Oxfmt**, each pinned exactly (`save-exact=true`).
- Frontend: **React**, **TanStack Router**, **TanStack Query**, **IBM Carbon** wrapped in
  `packages/ui`.
- Backend: **Node 24 LTS** in production (code must also run on Node 22), **Hono**, **Drizzle
  ORM**, **PostgreSQL 16**. Shared validation: **Zod** schemas in `packages/domain`.
- PDF: **pdf-lib** for official AcroForms, **Gotenberg** for HTML→PDF, both behind `PdfRenderer`.
- Local: Docker Compose (Postgres 16, MinIO, Gotenberg) on synthetic data; pilot and production
  on the company Hetzner cluster (k3s, CloudNativePG) as container images (ADR-0005). Keep
  application code provider-neutral.

## Repo layout (`docs/architecture/overview.md` describes each package)

```
apps/web          React SPA for staff
apps/portal       React SPA for participants (mobile-first, own login, ADR-0001); must not import
                  staff code (lint rule: no @transfer/web, apps/web or @transfer/staff-*)
apps/api          Hono API; in production also serves both built SPAs (/ and /portal/)
packages/domain   entities, lifecycle state machine, field catalog, Zod schemas, completeness
                  rules (no I/O, no system time)
packages/db       Drizzle schema, migrations (SECURITY DEFINER status functions and grants are
                  hand-written), synthetic seed, data catalog
packages/api-client  generated OpenAPI document + types and the typed client
packages/ui       Carbon wrappers, layout, tokens, i18n helpers
packages/self-service-ui  the self-service wizard, shared by both SPAs (no staff code)
packages/config   regional configuration: layer model, resolver, pinned templates
packages/forms    the BA form registry: blank PDFs, field maps, manifests, own HTML templates, font
packages/adapters interfaces + implementations (ADR-0006)
fixtures/         synthetic test files only
docs/             product + domain + architecture docs (source of truth)
scripts/          session start, tsconfig guard, image smoke test
Dockerfile        the production image (Node 24): API bundle + both SPAs
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
  The deny rules for `.env` etc. in `.claude/settings.json` are a **guardrail, not a security
  boundary**. Real secrets live in the cluster's secret store, never in the repo or a local file
  an agent can read.
- Every table holding participant data has a `project_id` column (RLS is added before the
  pilot, ADR-0002/0005).
- API: OpenAPI via `@hono/zod-openapi`, RFC 9457 errors, cursor pagination, `/api/v1`
  (ADR-0010). Jobs: pg-boss, idempotent, `system` actor, injected `Clock`, ID-only payloads
  (ADR-0011).
- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Commands

```
pnpm install          # CI and session start: --frozen-lockfile
pnpm dev              # db:migrate, then api :3001, web :5173, portal :5174/portal/
pnpm build            # both SPAs + the API bundle (apps/api/dist)
pnpm start            # the built API serving both SPAs on :3001
pnpm test             # vitest: unit, component, integration (needs Postgres)
pnpm test:coverage    # the same with coverage; 100 % thresholds on the domain rules
pnpm test:e2e         # playwright against the built app (pnpm build first)
pnpm lint             # oxlint + oxfmt --check + tsconfig guard + template immutability
pnpm format           # oxfmt write
pnpm typecheck        # tsc -b
pnpm verify           # what CI runs minus e2e and image: typecheck, lint, test:coverage, drift
pnpm db:setup         # dev/CI only: roles + transfer, transfer_test, transfer_e2e databases
pnpm db:generate      # drizzle-kit: SQL migration from the schema
pnpm db:migrate       # app migrations, then pg-boss's schema and its grants
pnpm db:seed          # synthetic data only
pnpm db:reset         # dev only: empty schema, migrate, seed
pnpm jobs:lifecycle [--today YYYY-MM-DD]   # the nightly lifecycle sweep once (dev/CI only)
pnpm generate         # all generators (API client, docs/domain/generated, config schema,
                      # template manifest, forms manifest); the output is committed
docker build -t transfer .          # the production image (CI builds and smoke-tests it)
scripts/image-smoke.sh transfer     # smoke test of the image
```

In cloud sessions PostgreSQL is pre-installed but not running: start it with
`service postgresql start`. The session start hook (`scripts/session-start.sh`) does that,
installs, and runs `db:setup` and `db:migrate`; then `pnpm db:seed && pnpm dev`. Docker's daemon
isn't running in cloud sessions; CI is the reference for the image.

## Definition of done (every PR)

- [ ] Typecheck, lint and tests pass locally and in CI
- [ ] New domain logic has tests; lifecycle transitions covered
- [ ] No hard-coded regional rules; no vendor calls outside adapters
- [ ] Status changes go through the audit helper
- [ ] No real personal data anywhere
- [ ] New personal data has a classification, access rule and `retentionClass`
- [ ] Docs updated if behaviour or knowledge changed
- [ ] PR description: what, why, how tested, screenshots for UI
