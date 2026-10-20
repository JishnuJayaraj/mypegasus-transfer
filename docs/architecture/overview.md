# Architecture overview

## Shape

**Modular monolith** (ADR-0001): one deployable API, two SPAs (staff, participant portal), one
PostgreSQL database.
Modules are separated by package boundaries, not by network calls.

**One image** (Slice 0): a Node 24 container runs the API bundle, which serves `/api/v1`,
the built staff SPA at `/` and the built portal at `/portal/` (SPA fallback to each
`index.html`; hashed assets `immutable`, `index.html` `no-cache`; unknown `/api/*` paths stay a
404 problem). Migrations are a separate command in the same image (`node dist/migrate.js`).
Separate hostnames for web and portal are revisited in Slice 3/9.

```
    ┌──── apps/web (React SPA) ─────┐    ┌──── apps/portal (React SPA) ────┐
    │ staff: PL, Berater/Profiler,  │    │ participants: mobile-first,     │
    │ back office, admins           │    │ SMS/email login, RTL-ready      │
    └───────────────┬───────────────┘    └────────────────┬────────────────┘
                    └──────────────────┬──────────────────┘
                                    │ JSON over HTTPS, /api/v1 (OpenAPI, typed clients — ADR-0010)
            ┌───────────────────────▼──────────────────────────────┐
            │ apps/api (Hono)                                      │
            │  modules: projects · participants · import · forms   │
            │           dsv · tg · reporting · admin/config        │
            │  cross-cutting: auth, permissions, audit, jobs       │
            └───────┬───────────────┬──────────────────┬───────────┘
                    │               │                  │
          packages/domain   packages/config    packages/adapters (interfaces)
          (pure logic)      (template resolver)   pdf · mail · sms · storage · virus · export · clock
                            packages/forms (BA form registry)
                    │                                  │
              packages/db (Drizzle) ──► PostgreSQL     └─► mock impl (MVP) / real impl later
```

## Key decisions

| Topic | Decision | ADR |
|---|---|---|
| Structure | Modular monolith, monorepo | 0001 |
| Database | PostgreSQL 16, Drizzle; core fields as columns, config-driven fields as jsonb | 0002 |
| Stack | TS 6 (`tsc -b`), Vite 8, Vitest, Oxlint/Oxfmt, React, TanStack, Carbon, Hono, Node 24 | 0003 |
| Regional variation | Fixed lifecycle core + versioned regional templates | 0004 |
| Hosting | Local (synthetic data); pilot + production on company Hetzner cluster (k3s, containers); one Node 24 image serves the API and both SPAs | 0005 |
| External services | Ports & adapters with mocks; real impls added later | 0006 |
| Auth | Staff: Entra ID via OIDC + MFA (dev stub first); participants: SMS/email link + birth-date check | 0007 |
| Retention | Per data item, two-stage deletion with evidence set | 0008 |
| Official forms | Versioned BA form registry, AcroForm filling | 0009 |
| API contract | OpenAPI via `@hono/zod-openapi`, RFC 9457 errors, cursor pagination, `/api/v1` | 0010 |
| Background jobs | pg-boss, idempotent, `system` actor, injected `Clock`, ID-only payloads | 0011 |

## Packages

- `packages/domain`: entities, lifecycle vocabulary and state machine, date helpers, field
  catalog, Zod schemas (incl. the audit event model), completeness rules. No I/O, no system time.
  Base defaults live in `packages/domain/config/base-defaults.json`.
- `packages/db`: Drizzle schema, migrations (the SECURITY DEFINER status functions and grants
  are hand-written), seed (synthetic only: a base seed, then participations through the status
  service), data catalog. `pnpm db:migrate` also creates pg-boss's `pgboss` schema and its
  `transfer_app` grants.
- `packages/api-client`: the generated OpenAPI document + types and the typed client both SPAs
  use.
- `packages/ui`: thin wrappers around Carbon components, layout, tokens, i18n helpers.
- `packages/config`: regional configuration: the Zod-authored layer model (base defaults,
  Agentur templates, project overrides) exported as JSON Schema, the custom-field profile, the
  two-level resolver with provenance and blockers, pinned template loading
  (`@transfer/config/load`, Node only, from `CONFIG_DIR` in the image), the canonical template
  hash, the fictional sample templates in `templates/<agenturKey>/<version>.json` (immutable once
  merged; `pnpm lint` checks against `origin/main`, in CI the PR's base) and their generated
  `manifest.json`.
- `packages/adapters`: interfaces + implementations behind them (ADR-0006). Only `Clock` so far
  (system, manual, Berlin dates and run times); pdf, mail, sms, storage, virus scan and export
  come with the slices that need them.
- `packages/forms` (Slice 4b): official BA form templates (blank PDF, field map, manifest),
  ADR-0009.
- `fixtures/`: synthetic test files only (e.g. filled test forms, `imports/` for the Excel/CSV
  import).

Commands in more detail: `pnpm test:e2e` runs on the `transfer_e2e` database;
`pnpm jobs:lifecycle` exits 1 with `run_not_due` when the run is not due by database time (Q96), and is refused
with `NODE_ENV=production`; `scripts/image-smoke.sh` runs the migration and checks
`/api/v1/health/ready`, `/`, `/portal/` and the template catalog. Image builds in cloud sessions
need the proxy CA (`/root/.ccr/README.md`).

## Module boundaries

- `packages/domain` has **no I/O**: no DB, no HTTP. Pure functions + types: lifecycle (main
  status + profiling and DSV tracks), guards, completeness, and the field-level access matrix.
- `apps/portal` must not import staff-only modules: Oxlint `no-restricted-imports` forbids
  `@transfer/web`, paths into `apps/web` and the `@transfer/staff-*` namespace (the naming
  convention for staff-only packages); a fixture test proves the rule fires.
- API modules may depend on `domain`, `config`, `db`, `adapters` — never on each other's
  internals (talk through exported service functions).
- UI talks only to the API. No business rules in the UI beyond display validation (shared Zod).

## Background jobs

Reminders, deadline checks, system lifecycle transitions (`dsv_expired`, `withdrawn` at the
admission cutoff, `active_in_tg`), two-stage retention/deletion, PDF batch generation. All jobs are
idempotent, run with the `system` actor, take time from the `Clock` adapter, and carry only IDs
in their payloads. Queue: **pg-boss** on the existing Postgres (ADR-0011).

- **Where:** in the API process, started before the server listens when `JOBS_ENABLED=true`
  (default); a separate worker is a Slice 9 scaling decision.
- **Schema and roles:** `db:migrate` / `node dist/migrate.js` install or upgrade the `pgboss`
  schema as `transfer_owner` and re-apply `transfer_app`'s DML grants; the API runs pg-boss as
  `transfer_app` with its migration off.
- **Schedule:** the nightly lifecycle sweep is a cron at `JOBS_LIFECYCLE_TIME` in
  `Europe/Berlin` (default 04:15). It catches up the days after the last completed run recorded in
  `job_run` and evaluates each project in its own `lifecycle.evaluate-project` job through the
  status service as `system`. A run counts as due only by database time (Q96).
  `pnpm jobs:lifecycle [--today YYYY-MM-DD]` runs it once in its own process (dev, CI).

## Performance approach (frontend)

- Route-level code splitting + TanStack Router preloading on hover/intent.
- TanStack Query cache with sensible stale times; optimistic updates for simple edits.
- Virtualised tables for large participant lists.
- Keep Carbon imports per-component to keep bundles small.
