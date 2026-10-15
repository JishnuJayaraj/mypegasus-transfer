# Architecture overview

## Shape

**Modular monolith** (ADR-0001): one deployable API, two SPAs (staff, participant portal), one
PostgreSQL database.
Modules are separated by package boundaries, not by network calls.

```
    ┌──── apps/web (React SPA) ─────┐    ┌──── apps/portal (React SPA) ────┐
    │ staff: PL, Berater/Profiler,  │    │ participants: mobile-first,     │
    │ back office, admins           │    │ SMS/email login, RTL-ready      │
    └───────────────┬───────────────┘    └────────────────┬────────────────┘
                    └──────────────────┬──────────────────┘
                                    │ JSON over HTTPS (typed client from shared Zod schemas)
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
| Stack | TS 7, Vite+/Vite 8, React, TanStack, Carbon, Hono | 0003 |
| Regional variation | Fixed lifecycle core + versioned regional templates | 0004 |
| Hosting | Local (synthetic data); pilot + production on company Hetzner cluster (k3s, containers) | 0005 |
| External services | Ports & adapters with mocks; real impls added later | 0006 |
| Auth | Staff: Entra ID via OIDC + MFA (dev stub first); participants: SMS/email link + birth-date check | 0007 |
| Retention | Per data item, two-stage deletion with evidence set | 0008 |
| Official forms | Versioned BA form registry, AcroForm filling | 0009 |

## Module boundaries

- `packages/domain` has **no I/O**: no DB, no HTTP. Pure functions + types: lifecycle (main
  status + profiling and DSV tracks), guards, completeness, and the field-level access matrix.
- `apps/portal` must not import staff-only modules (lint rule).
- API modules may depend on `domain`, `config`, `db`, `adapters` — never on each other's
  internals (talk through exported service functions).
- UI talks only to the API. No business rules in the UI beyond display validation (shared Zod).

## Background jobs

Reminders, deadline checks, system lifecycle transitions (`dsv_expired`, `withdrawn` after the
grace period, `active_in_tg`), two-stage retention/deletion, PDF batch generation. All jobs are
idempotent, run with the `system` actor, and take time from the `Clock` adapter. MVP:
Postgres-backed job queue (e.g. pg-boss or similar — decide in Slice 5) to avoid extra
infrastructure.

## Performance approach (frontend)

- Route-level code splitting + TanStack Router preloading on hover/intent.
- TanStack Query cache with sensible stale times; optimistic updates for simple edits.
- Virtualised tables for large participant lists.
- Keep Carbon imports per-component to keep bundles small.
