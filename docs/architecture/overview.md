# Architecture overview

## Shape

**Modular monolith** (ADR-0001): one deployable API, one SPA, one PostgreSQL database.
Modules are separated by package boundaries, not by network calls.

```
            ┌──────────────── apps/web (React SPA) ────────────────┐
            │  staff UI (PL, Berater, back office, admin)           │
            │  participant portal (mobile-first, role-gated routes) │
            └───────────────────────┬──────────────────────────────┘
                                    │ JSON over HTTPS (typed client from shared Zod schemas)
            ┌───────────────────────▼──────────────────────────────┐
            │ apps/api (Hono)                                      │
            │  modules: projects · participants · import · forms   │
            │           dsv · tg · reporting · admin/config        │
            │  cross-cutting: auth, permissions, audit, jobs       │
            └───────┬───────────────┬──────────────────┬───────────┘
                    │               │                  │
          packages/domain   packages/config    packages/adapters (interfaces)
          (pure logic)      (template resolver)   pdf · mail · sms · storage · ai · export
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
| Hosting | Local first; production on company Hetzner cluster (containers) | 0005 |
| External services | Ports & adapters with mocks; real impls added later | 0006 |
| Auth | Staff: OIDC via adapter (dev stub first); participants: magic link | 0007 |

## Module boundaries

- `packages/domain` has **no I/O**: no DB, no HTTP. Pure functions + types. Easy to test.
- API modules may depend on `domain`, `config`, `db`, `adapters` — never on each other's
  internals (talk through exported service functions).
- UI talks only to the API. No business rules in the UI beyond display validation (shared Zod).

## Background jobs

Reminders, deadline checks, retention/deletion, PDF batch generation. MVP: Postgres-backed job
queue (e.g. pg-boss or similar — decide in Slice 5) to avoid extra infrastructure.

## Performance approach (frontend)

- Route-level code splitting + TanStack Router preloading on hover/intent.
- TanStack Query cache with sensible stale times; optimistic updates for simple edits.
- Virtualised tables for large participant lists.
- Keep Carbon imports per-component to keep bundles small.
