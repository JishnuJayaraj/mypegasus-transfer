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
            │  modules: projects · participants · activation       │
            │           import · forms · dsv · tg · reporting      │
            │           admin/config                               │
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
| Auth | Staff: Entra ID via OIDC + MFA, server-side sessions (dev stub in development); participants: SMS/email link + birth-date check | 0007 |
| Retention | Per data item, two-stage deletion with evidence set | 0008 |
| Official forms | Versioned BA form registry, AcroForm filling | 0009 |
| API contract | OpenAPI via `@hono/zod-openapi`, RFC 9457 errors, cursor pagination, `/api/v1` | 0010 |
| Background jobs | pg-boss, idempotent, `system` actor, injected `Clock`, ID-only payloads | 0011 |

## Packages

- `packages/domain`: entities, lifecycle vocabulary and state machine, date helpers, field
  catalog, Zod schemas (incl. the audit event model), completeness rules. No I/O, no system time.
  Base defaults live in `packages/domain/config/base-defaults.json`.
- `packages/db`: Drizzle schema, migrations (the SECURITY DEFINER status functions and grants
  are hand-written), seed, data catalog. `pnpm db:migrate` also creates pg-boss's `pgboss` schema
  and its `transfer_app` grants. The seed is synthetic only: idempotent by fixed UUIDs, fictional
  names, `example.org` emails; `db:seed` and `db:reset` refuse `NODE_ENV=production`. It holds
  two fictional regions (Nord with Werk Nord and Verwaltung, Süd with Lager Süd), the admin's
  global org role, the regional roles for Nord and the PL's `may_create_projects`. After the
  base seed, the API seed pins and activates through the services and creates and moves
  participations only through the status service: each staff step by the seeded user the Q60
  matrix allows, system steps as `system` with job `seed`, no bypass actor (Q95). It runs on a
  manual clock on a fictional 2091–2092 timeline, so a persisted lifecycle-job demo needs a
  separate past-dated fixture (Q96).
- `packages/api-client`: the generated OpenAPI document + types and the typed client both SPAs
  use.
- `packages/ui`: thin wrappers around Carbon components, layout, tokens, i18n helpers.
- `packages/config`: regional configuration: the Zod-authored layer model (base defaults,
  Agentur templates, project overrides) exported as JSON Schema, the custom-field profile, the
  two-level resolver with provenance and blockers, pinned template loading
  (`@transfer/config/load`, Node only, from `CONFIG_DIR` in the image), the canonical template
  hash, the fictional sample templates in `templates/<agenturKey>/<version>.json` (immutable once
  merged; `pnpm lint` checks against `origin/main`, in CI the PR's base) and their generated
  `manifest.json`. It also owns `organisation.json`, the validated controller and DPO details
  interpolated into immutable Article 14 notice templates (synthetic values in the repository).
- `packages/adapters`: interfaces + implementations behind them (ADR-0006). Only `Clock` so far
  (system, manual, Berlin dates and run times), plus `Mailer` and `SmsSender` contracts and their
  idempotent last-100 development outbox. Real mail/SMS providers, pdf, storage, virus scan and
  export come with the slices that need them.
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
  status + profiling and DSV tracks), guards, completeness, and the field-level access matrix
  with its operation permissions, region scope and org administration (`access/`).
- `apps/portal` must not import staff-only modules: Oxlint `no-restricted-imports` forbids
  `@transfer/web`, paths into `apps/web` and the `@transfer/staff-*` namespace (the naming
  convention for staff-only packages); a fixture test proves the rule fires.
- API modules may depend on `domain`, `config`, `db`, `adapters` — never on each other's
  internals (talk through exported service functions).
- UI talks only to the API. No business rules in the UI beyond display validation (shared Zod).

## Activation-code boundary (Slice 3, PR 3d)

- `packages/domain/src/activation` owns the code format, issuance refusals and derived status;
  `packages/domain/src/notices` owns immutable bilingual notice texts; and
  `packages/domain/src/privacy` owns the calendar-month notice deadline. None performs I/O.
- `apps/api/src/routes/activation.ts` is the only HTTP orchestration boundary. Database functions
  lock, decide and write credential/notice state; external mail/SMS sends occur after commit with
  idempotency keys, and a second function records the outcome. Printable responses are no-store.
- `apps/web` has capability-driven status, filtering, print and handover views. Codes live only in
  the issuance mutation result and are dropped with the print view; QR generation is client-side
  with pinned `qrcode@1.5.4`. `apps/portal` serves the public, static, personal-data-free Article 14
  notice page in German and English.
- `ACCESS_CODE_SECRET` is a distinct HKDF root for activation-code, delivery-address and
  one-time-code HMAC keys. `PORTAL_PUBLIC_URL` supplies the public fragment links. Both are required
  outside development; only HTTPS portal URLs are accepted there.

## Portal boundary (Slice 3, PRs 3e and 3f)

- `packages/domain/src/activation/steps.ts` owns the step machine and
  `packages/domain/src/portal` the limits (`limits.ts`, held to the SQL by a drift test), contact
  normalisation and masking, and the portal API schemas. None performs I/O.
- `apps/api/src/routes/portal.ts` is the portal's HTTP boundary (`/api/v1/portal/...`), behind
  `apps/api/src/portal-session.ts` (the `__Host-tp_portal` cookie; `tp_portal` in development)
  and the in-memory per-IP throttle (`apps/api/src/throttle.ts`). The activation functions lock,
  count, decide and write; one-time codes are sent after commit with the challenge id as the
  idempotency key; the completion queues the activation notice in its own transaction.
- `apps/portal` has `/activate` (the code from the link's fragment, the notice, birth date,
  delivery address or channel with consent and one-time code) and `/` (greeting, masked channels,
  logout). Codes and addresses live only in component state.
- `apps/web` shows the account (how the identity was assured) and the channels' kind, states and
  dates; never an address.
- PR 3f: the same router serves the login (`/portal/login/...`) and the channels
  (`/portal/channels`); the login code is sent by a detached task (`apps/api/src/detached.ts`)
  after the `202`, which shutdown awaits. `apps/portal` adds `/login` (address, then the code;
  the email link's fragment fills the code) and `/channels` (masked list, removal with a warning
  for the last one, addition with consent and a one-time code); shared pieces live in
  `apps/portal/src/components` and `problem.ts`. `apps/web` adds the recovery panel
  (`components/recovery.tsx`) to an activated participant's detail.

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
- **Activation notice** (Slice 3 PR 3e): `portal.activation-notice`, queued by the completion in
  its own transaction with the channel id as `singletonKey`, sends the notice to the new channel
  at least once (provider key `activation-notice:<channelId>`) and records `notice_sent_at`.

## Performance approach (frontend)

- Route-level code splitting + TanStack Router preloading on hover/intent.
- TanStack Query cache with sensible stale times; optimistic updates for simple edits.
- Virtualised tables for large participant lists.
- Keep Carbon imports per-component to keep bundles small.
