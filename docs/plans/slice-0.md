# Slice 0 — Walking skeleton: plan

- Status: **Proposed, awaiting approval**
- Date: 2026-10-15
- Roadmap: [Slice 0](../roadmap.md#slice-0--walking-skeleton)
- Relevant ADRs: 0001 (two SPAs), 0002 (Postgres, `project_id`, DB-enforced writes), 0003 (stack,
  Node 24, Vite+/TS 7 review), 0005 (container image, health endpoints, logs without personal
  data), 0007 (stub auth), 0010 (API contract)

## 1. Goal

Prove the whole path once, thinly, on the stack we intend to keep:

```
apps/web (Carbon shell, TanStack Router + Query)  ─┐
apps/portal (thin shell, de/en)                   ─┤─► /api/v1 (Hono + @hono/zod-openapi, RFC 9457)
                                                     └─► packages/db (Drizzle) ─► PostgreSQL 16
```

with one entity (`Project`: list + create) end to end, tests at every layer, and CI on GitHub
Actions.

**Done when** (roadmap): `pnpm dev` shows the project list from the database, and CI is green.
The detailed acceptance criteria are in section 7.

## 2. Decisions from the planning session (2026-10-15)

The product owner answered these while this plan was being written. They will be recorded in
`docs/decisions/2026-10-15-answers-round-6.md` in PR 0a.

| # | Topic | Decision |
|---|---|---|
| D1 | PR shape | **Short series of 4 PRs** (0a–0d, section 4). Each PR is green on its own. The slice is done after 0d. |
| D2 | Stub auth | **Dev session cookie.** Seeded synthetic staff users (one per role). A dev-only endpoint sets an httpOnly signed cookie. Every `/api/v1` route except health requires a session. **No role checks yet.** Dev routes are not mounted in production. |
| D3 | Portal scope | **Thin shell:** one route, i18n `de` + `en` with a language switcher, CSS logical properties, calls `GET /api/v1/health` through the generated client. Plus the lint rule that forbids staff-only imports, tested with a failing fixture. |
| D4 | Production image | **One Node 24 image.** Hono serves `/api/v1`, the built web SPA at `/` and the built portal at `/portal/`. CI builds and smoke-tests it but doesn't push it. Separate hostnames are revisited in Slice 3/9. |
| D5 | i18n library | **i18next + react-i18next**: runtime only (no compiler plugin, so no risk with Vite 8/Oxc), typed keys, `dir()` for RTL. This settles the open point in ADR-0003. |
| D6 | `Project` fields | **Minimal + type:** `name`, `customerName` (free text for now), `type` (`ta_only` / `ta_tg`), optional `signingDeadline`, `defaultTgStart`, `defaultTgEnd`, plus `createdAt` and `createdBy`. **No project status**, so no status/audit machinery in Slice 0. |
| D7 | DB roles | **Split now:** `transfer_owner` runs migrations and owns the tables. `transfer_app` (runtime) only gets explicit per-table grants, written in migrations. |
| D8 | E2E | **Playwright locally and as a CI job.** The required checks become typecheck, lint, test, e2e (plus the image build, D4). |
| D9 | Retention (rule 10) | **Table-level data catalog + open questions.** Every table gets a `retentionClass` and a data class, and a test fails if one is missing. The new classes `project_master` and `staff_account` have period `unset`. New open questions **Q58/Q59** (🔒) go to the DPO. |
| D10 | Node 22 | **Test matrix 22 + 24.** Typecheck, lint, e2e and the image use Node 24. Unit and integration tests run on 22 and 24. `engines.node: "^22.18.0 \|\| ^24.11.0"`. Drop the 22 leg when cloud sessions move to 24. |
| D11 | Spike timebox | **One working session (~1 day).** If the exit criteria (section 3) aren't met by then, apply the documented fallback **for the failing tool only** and record it in an ADR-0003 amendment. |

### Facts checked on 2026-10-15 that change the docs

- **TypeScript package names have flipped.** On npm, `typescript@7.0.2` *is* the native
  compiler (bin `tsc`). `@typescript/native` doesn't exist. TS 6 is published as
  `@typescript/typescript6@6.0.2` (bin `tsc6`). So we don't alias TS 7 in; we **alias TS 6 in
  for the tools that need the compiler API**. CLAUDE.md and ADR-0003 get corrected in PR 0a.
- **Vite+ is no longer beta:** `vite-plus@1.2.0` (bin `vp`), engines `^22.18.0 || ^24.11.0 ||
  >=26`. Cloud sessions run Node 22.22.0, which is supported.
- **The current `DATABASE_URL` doesn't work in cloud sessions.** `pg_hba` requires
  `scram-sha-256` over TCP, and `postgres` has no password (review finding 3.4). Slice 0 creates
  dev roles with passwords (section 5.3).
- Cloud session: Node 22.22.0, pnpm 10.28.0 (corepack), PostgreSQL 16.15 running, Docker
  available.

## 3. Vite+ / TS 7 spike (first part of PR 0a)

**Timebox:** one working session. The root `package.json` scripts (section 6) are the stable
contract. A fallback changes what is behind them, never their names.

### Vite+ (`vite-plus@1.2.0`) — passes if all of these hold

| # | Criterion |
|---|---|
| V1 | Installs as a pinned devDependency with `pnpm install --frozen-lockfile` through the cloud-session proxy and on `ubuntu-latest`, on Node 22.22 and 24, with no account, login or hosted service. Telemetry can be switched off. The licence is MIT. |
| V2 | `apps/web` dev server with HMR and a production build work with React 19, the TanStack Router Vite plugin (file-based routes, code splitting) and Carbon's Sass styles. |
| V3 | `vp test` runs Vitest with several projects: node (domain, db, api integration) and jsdom (React component tests), plus coverage (v8). |
| V4 | `vp lint` runs Oxlint with the React rules and `no-restricted-imports` per app (the portal boundary). `vp fmt --check` runs Oxfmt. |
| V5 | *(not blocking)* `vp run` can run the three dev servers in parallel. Otherwise `pnpm -r --parallel` does it. |

**Fallback, per failing criterion:** plain pinned `vite@8.3.4`, `vitest@5.0.5`, `oxlint@1.88.0`
and `oxfmt`, plus `pnpm -r --parallel` for V5. We never use VoidZero's hosting (ADR-0005).

### TypeScript 7 (`typescript@7.0.2`) — passes if all of these hold

| # | Criterion |
|---|---|
| T1 | `tsc -b` (project references) type-checks every package and app on Node 22 and 24. The code includes React JSX, Zod 4 inference, Drizzle, `@hono/zod-openapi` and TanStack Router's generated route tree. |
| T2 | No false results: `tsc6 -b` (TS 6.0.2) on the same code gives the same diagnostics. We run this comparison once in the spike, not in CI. |
| T3 | Every tool that imports the compiler API (at least `openapi-typescript`, plus anything `pnpm why typescript` finds, e.g. dts bundling) resolves `typescript` to `npm:@typescript/typescript6@6.0.2` through pnpm `overrides`/`packageExtensions`, and works. The root `typescript` stays 7.0.2. |

**Fallback:** `pnpm typecheck` runs `tsc6 -b` (TS 6). Other tools are unaffected.

### Other things to verify in the spike (not exit criteria)

- `@hono/zod-openapi@1.6.3` reads OpenAPI metadata from Zod 4 schemas defined in
  `packages/domain` **without** `packages/domain` importing Hono (it should use Zod's own
  `.meta()`). Fallback: `apps/api` wraps the domain schemas with `.openapi()`.
- Node's built-in type stripping (unflagged since 22.18) runs `apps/api` in dev with
  `node --watch src/server.ts` (needs `erasableSyntaxOnly`, `.ts` import extensions). Fallback:
  `tsx watch`.
- Pinned `@playwright/test` works with the pre-installed Chromium in cloud sessions (otherwise
  use `executablePath` from `PLAYWRIGHT_CHROMIUM_EXECUTABLE`). CI installs its own Chromium.

**Output:** an amendment to ADR-0003 with the result per criterion and any fallback taken, and
the corrected TypeScript wording in CLAUDE.md.

## 4. PR series

Generated files (lockfile, Drizzle migration snapshots, `openapi.json`, `schema.d.ts`,
`routeTree.gen.ts`) don't count towards the ~400-line guideline. If PR 0b goes well over
~500 hand-written lines, it is split into 0b-1 (db) and 0b-2 (api).

| PR | Branch content | Ends with |
|---|---|---|
| **0a** `chore: toolchain, monorepo skeleton, CI` | Spike (section 3). pnpm workspace, root scripts, `.npmrc` (`save-exact=true`, `engine-strict=true`), base `tsconfig`, Vite+/Oxlint/Oxfmt config. `packages/domain` with the first Zod schemas (`isoDate`, `ProjectType`, `CreateProjectInput`) and their unit tests, written test-first. CI workflow: `typecheck`, `lint`, `test` (Node 22 + 24). `session-start.sh`: `--frozen-lockfile` only, no silent fallback. Docs: decisions round 6, ADR-0003 amendment, CLAUDE.md stack fix. | CI green with real domain tests |
| **0b** `feat: database and API skeleton` | `packages/db` (roles, schema, migrations, grants, seed, data catalog). `apps/api` (Hono, OpenAPI, problem details, logging, dev session, health, projects). `packages/api-client` (generated, drift check). Integration tests against Postgres; the CI `test` job gets a Postgres 16 service. `.env.example`, Q58/Q59 in `open-questions.md`, ADR-0007 note on the stub. | `curl` against `/api/v1/projects` works; CI green |
| **0c** `feat(web): Carbon shell, project list and create` | `packages/ui` (Carbon wrappers, date formatting, i18n helper). `apps/web` (shell, dev user switcher, 2 routes). Component tests. Playwright happy path with an axe check, plus the CI `e2e` job. | **`pnpm dev` shows the project list from the DB** |
| **0d** `feat(portal): portal shell, boundary rule, production image` | `apps/portal`. Boundary lint rule and its test. Static SPA serving in the API. `Dockerfile` (Node 24). CI `image` job with a smoke test. Docs: CLAUDE.md commands + layout, architecture overview, README status, `.claude/settings.json` allowlist. | All acceptance criteria met; slice done |

## 5. Design

### 5.1 Repo layout after Slice 0

```
apps/
  api/          Hono app: createApp(deps) for tests, server.ts (Node entry), migrate.ts (image entry)
                routes/ health · projects · me · dev-session; problem.ts; logger.ts; env.ts; static.ts
  web/          staff SPA: __root (Carbon UI shell), /projects, /projects/new; locales/de
  portal/       participant SPA (base /portal/): one route; locales/de, locales/en
packages/
  domain/       Zod schemas + pure helpers (no I/O): ProjectType, CreateProjectInput, Project,
                isoDate, pagination (cursor) schemas, ProblemDetails, DataClass enum, StaffRole enum
  db/           Drizzle schema, SQL migrations (incl. grants), setup SQL for roles/databases,
                seed (synthetic), data catalog (table → retentionClass, data class)
  api-client/   generated openapi.json + schema.d.ts (openapi-typescript), createApiClient()
                (openapi-fetch) that turns problem+json into typed errors
  ui/           thin Carbon wrappers (AppShell, PageHeader, DataTable, form fields), date
                formatting (TT.MM.JJJJ, Europe/Berlin), i18n init helper
.github/workflows/ci.yml
docker-compose.yml   Postgres 16 only (MinIO and Gotenberg come with their slices)
Dockerfile
```

Package names are `@transfer/<dir>`. Workspace packages export TypeScript source
(`"exports": "./src/index.ts"`). Vite bundles it for the SPAs, and `apps/api` is bundled for the
image. `packages/api-client` is a new package that the CLAUDE.md layout doesn't list yet; it's
added there in 0d.

Not created in Slice 0: `packages/config`, `packages/adapters`, `packages/forms` (section 8).

### 5.2 Domain (`packages/domain`, tests first)

- `isoDate`: a `YYYY-MM-DD` string that must be a real calendar date. `2027-02-29` and
  `2026-14-03` are rejected, `2028-02-29` is accepted. Legal dates travel as ISO strings in the
  API and are stored as `date` columns (Drizzle `mode: "string"`, so no timezone shift).
- `ProjectType = z.enum(["ta_only", "ta_tg"])`.
- `CreateProjectInput`:
  - `name`: trimmed, 1–200 characters
  - `customerName`: trimmed, 1–200 characters
  - `type`
  - optional `signingDeadline`, `defaultTgStart`, `defaultTgEnd` (`isoDate`)
  - Cross-field rules:
    - `defaultTgStart ≤ defaultTgEnd` when both are set.
    - For `ta_only`, `signingDeadline`, `defaultTgStart` and `defaultTgEnd` must be empty. A
      `ta_only` project has no DSV track and no beE (process-and-lifecycle.md). This is derived
      from the docs, not a new BA rule.
  - All of them stay optional at creation. "Cannot be activated without dates" (F1) belongs to
    project activation in Slice 2.
- `Project` (response): `id`, the input fields, `createdAt` (ISO 8601 UTC), `createdBy`
  (staff user id).
- Pagination: `limit` (1–100, default 50), `cursor` (opaque); a response has `items` and
  `nextCursor` (string or null).
- `ProblemDetails` schema (RFC 9457) with an `errors` extension:
  `[{ pointer?, parameter?, code, detail }]`.
- `DataClass = special_category | highly_confidential | confidential | internal | aggregated`
  (data-protection.md).
- `StaffRole = admin | regional_admin | project_lead | consultant | back_office`. This is
  provisional: Slice 1 owns the final role/assignment model.

### 5.3 Database (`packages/db`)

**Roles and databases.** One idempotent setup SQL file serves the cloud session, CI and
Compose. It is run by `pnpm db:setup`, which uses `DATABASE_ADMIN_URL` if set and otherwise
`su postgres -c psql` (cloud session). Compose mounts the same SQL into
`/docker-entrypoint-initdb.d`. It creates:

- `transfer_owner` (LOGIN): owns the databases and tables, runs migrations and seeds.
- `transfer_app` (LOGIN): runtime only. It has `CONNECT` and `USAGE` on `public`, plus only the
  table grants that migrations give it explicitly. No default privileges.
- Databases `transfer` (dev), `transfer_test` (integration tests), `transfer_e2e` (Playwright).

The dev passwords (`transfer_owner_dev`, `transfer_app_dev`) only protect local databases with
synthetic data and appear in `.env.example`. They are not secrets. On the cluster,
CloudNativePG manages roles with the same names, and their credentials live in the cluster
secret store (Slice 9).

**Tables**

| Table | Columns (snake_case) | Notes |
|---|---|---|
| `staff_user` | `id uuid pk`, `display_name text`, `email text unique`, `role staff_role`, `created_at timestamptz` | synthetic users only; emails at `example.org` |
| `project` | `id uuid pk default gen_random_uuid()`, `name text`, `customer_name text`, `type project_type`, `signing_deadline date null`, `default_tg_start date null`, `default_tg_end date null`, `created_at timestamptz default now()`, `created_by uuid fk staff_user` | `CHECK (default_tg_start <= default_tg_end)`; `CHECK` that `ta_only` has no signing deadline or TG dates; index `(created_at desc, id desc)` for keyset pagination |

- `project` is the root of project scoping, so it has no `project_id` itself. No table in
  Slice 0 holds participant data.
- **Grants (migration):** `transfer_app` gets `SELECT, INSERT` on `project` and `SELECT` on
  `staff_user`. Nothing else: no `UPDATE`/`DELETE` until a feature needs it. Slice 1 adds the
  status/audit grants on the same pattern.
- **Migrations:** `pnpm db:generate` (drizzle-kit) writes SQL migrations into
  `packages/db/migrations`. Grants are hand-written custom migrations. `pnpm db:migrate`
  applies them as `transfer_owner`.
- **Data catalog** (`packages/db/src/data-catalog.ts`): for every table, its
  `retentionClass`, `dataClass` and `holdsParticipantData`. A test reads all Drizzle tables and
  fails when:
  - a table is missing from the catalog, or
  - a table with `holdsParticipantData: true` has no `project_id uuid not null` FK to `project`
    (ADR-0002). A fixture table proves that this check fails.

  | Table | `retentionClass` | `dataClass` | Period |
  |---|---|---|---|
  | `project` | `project_master` | `internal` | `unset` → **Q58** |
  | `staff_user` | `staff_account` | `confidential` | `unset` → **Q59** |

  `unset` means "no deletion job may touch this yet". The retention job (Slice 7) must refuse
  to run for classes that are still `unset`.
- **Seed** (`pnpm db:seed`): idempotent, using fixed UUIDs. It creates five staff users (one
  per role, with obviously fictional names) and three projects with fictional customers (e.g.
  "Beispiel Maschinenbau GmbH"). It refuses to run when `NODE_ENV=production`.

### 5.4 API (`apps/api`)

**Routes**, all defined with `@hono/zod-openapi` from the domain schemas:

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/v1/health` | public | liveness: `{ status: "ok", version }` (the portal shell uses it) |
| `GET /api/v1/health/ready` | public | readiness: DB ping; 503 problem if the DB is down |
| `GET /api/v1/me` | session | current staff user (`id`, `displayName`, `role`) |
| `GET /api/v1/projects?limit&cursor` | session | keyset-paginated list, newest first |
| `POST /api/v1/projects` | session | create; `201` with the project |
| `GET /api/v1/projects/{projectId}` | session | one project; `404` problem if not found |
| `GET /api/v1/dev/staff-users` | dev only | synthetic users for the switcher |
| `POST /api/v1/dev/session` | dev only | `{ staffUserId }` → sets the session cookie, `204` |
| `DELETE /api/v1/dev/session` | dev only | clears the cookie, `204` |
| `GET /api/v1/openapi.json` | public, non-production | the generated OpenAPI 3.1 document |

**Contract (ADR-0010)**

- All routes are under `/api/v1`, and the OpenAPI document is generated from the route
  definitions. Dev routes are in the document, tagged `dev` and marked `x-dev-only: true`.
- **Typed client:** `pnpm api:generate` writes `packages/api-client/openapi.json` and
  `src/schema.d.ts` (openapi-typescript). Both are committed. CI regenerates them and fails on
  any diff.
- **Cursor:** base64url of `{ createdAt, id }`, validated with Zod. A malformed cursor gives a
  400 validation problem with `parameter: "cursor"`.
- **Problems (RFC 9457):** every error is `application/problem+json` with a stable `type` URN:

  | `type` | Status | When |
  |---|---|---|
  | `urn:transfer:problem:validation-error` | 400 | Zod validation (the Hono `defaultHook`); `errors[]` carries a JSON pointer or parameter name, a code and a message, **never the submitted values** |
  | `urn:transfer:problem:unauthenticated` | 401 | no or invalid session |
  | `urn:transfer:problem:forbidden` | 403 | CSRF/origin check failed |
  | `urn:transfer:problem:not-found` | 404 | unknown resource or route under `/api` |
  | `urn:transfer:problem:unsupported-media-type` | 415 | a mutation without a JSON body |
  | `urn:transfer:problem:service-unavailable` | 503 | readiness check failed |
  | `urn:transfer:problem:internal-error` | 500 | anything else: no message, no stack, only `instance: urn:request:<id>` |

**Session stub (D2, ADR-0007 dev stub)**

- `AUTH_MODE=dev` is required in Slice 0. `oidc` is reserved, and selecting it fails at startup
  with "not implemented until Slice 3".
- The cookie `tp_staff_session` (httpOnly, `SameSite=Lax`, `Path=/`, `Secure` outside dev) holds
  a staff user id and the issue time, HMAC-signed with `SESSION_SECRET`. If no secret is set in
  dev, a random one is generated at startup.
- This is a **dev stub, not the ADR-0007 session model.** The server-side session store, the
  8-hour lifetime and OIDC arrive in Slice 3. The participant cookie (`tp_participant_session`)
  also comes in Slice 3.
- CSRF: Hono's `csrf()` origin check against `APP_ORIGINS`, and mutations must have
  `Content-Type: application/json`.
- Production guard:
  - The API refuses to start with `NODE_ENV=production` and `AUTH_MODE=dev`.
  - Dev routes are not mounted unless `AUTH_MODE=dev`.
  - Seed and reset scripts refuse to run in production.

**Cross-cutting**

- `env.ts` parses all environment variables with Zod and fails fast with the variable *name*,
  never its value. It loads `.env` with `process.loadEnvFile()` when present.
- Logging: pino JSON lines with `requestId`, method, route pattern, status, duration and
  `staffUserId` (an ID, allowed). **No bodies, query strings, cookies or headers.** Every
  response carries an `X-Request-Id` header.
- `secureHeaders()` everywhere. When serving the SPAs: a CSP with `default-src 'self'`
  (`style-src` may need `'unsafe-inline'` for Carbon; this is checked in 0d and documented if
  so).
- `createApp({ db, env, logger, clock? })` makes everything injectable for tests. There is no
  `Clock` adapter yet (Slice 1); `createdAt` comes from the database.

**Static SPAs (D4, PR 0d):** in production the API serves `apps/web/dist` at `/` and
`apps/portal/dist` at `/portal/`, each with an SPA fallback to its `index.html`. Hashed assets
get `Cache-Control: immutable`, and `index.html` gets `no-cache`. Unknown `/api/*` paths return
a 404 problem, never `index.html`.

### 5.5 Web (`apps/web`)

- Carbon UI shell (`g10` theme) wrapped in `@transfer/ui`:
  - Header: product name and the dev user switcher (a `HeaderGlobalAction` with a menu of
    `/api/v1/dev/staff-users`; it is only rendered when that endpoint returns 200).
  - SideNav: "Projekte".
- TanStack Router (file-based through the Vite plugin, with automatic code splitting and
  `defaultPreload: "intent"`) and TanStack Query. The loaders call
  `queryClient.ensureInfiniteQueryData`.
- Routes:
  - `/` redirects to `/projects`.
  - **`/projects`**: Carbon DataTable with the columns Name, Kunde, Typ, Unterschriftsfrist and
    Angelegt am, an empty state, a "Projekt anlegen" button and "Mehr laden" (cursor
    pagination).
  - **`/projects/new`**: the form. The TG dates and signing deadline only show for `ta_tg`.
    Carbon DatePicker in `TT.MM.JJJJ`. Client-side validation uses the same domain schema.
    Server problems are mapped onto the fields by JSON pointer. On success it invalidates the
    list query, navigates to `/projects` and shows a toast.
- Without a session (a 401 problem), the shell shows "Bitte Entwicklungsbenutzer wählen" next to
  the switcher.
- Dates are shown as `TT.MM.JJJJ`. Timestamps are shown in `Europe/Berlin`
  (`Intl.DateTimeFormat`).
- i18n: `de` only. Catalogs live in `apps/web/src/locales/de/*.json`, and keys are typed through
  i18next's `CustomTypeOptions`. If Oxlint supports `react/jsx-no-literals`, it is turned on for
  `apps/*`. Otherwise "no hard-coded UI text" stays a review checklist item.

### 5.6 Portal (`apps/portal`, PR 0d)

- Vite app with base `/portal/`. TanStack Router with one route `/`, using the `@transfer/ui`
  wrappers.
- Content: a heading, a short welcome text, a language switcher (`de`/`en`, default `de`) and
  the API status from `GET /api/v1/health`. No login and no participant data.
- `<html lang>` and `<html dir>` follow the language (`i18next.dir()`). Styles use CSS logical
  properties only.
- **Boundary rule (ADR-0001):** Oxlint `no-restricted-imports` in `apps/portal` forbids
  `@transfer/web`, any path into `apps/web`, and the `@transfer/staff-*` namespace. By
  convention, staff-only packages are named `@transfer/staff-*`; none exist yet. A test runs the
  linter on a fixture file and expects an error. Fallback if Oxlint can't express the rule: a
  small `scripts/check-boundaries.ts` run by `pnpm lint`.

### 5.7 Production image (`Dockerfile`, PR 0d)

- Multi-stage build on `node:24-bookworm-slim`, pinned by digest. pnpm comes from corepack. It
  runs `pnpm install --frozen-lockfile` and `pnpm build`.
- The final stage holds the API bundle (`dist/server.js`, `dist/migrate.js`), the migrations and
  both SPA builds. It runs as the non-root `node` user, `PORT=8080`, with
  `CMD ["node", "dist/server.js"]`.
- Migrations run as a separate command, `node dist/migrate.js`, with
  `DATABASE_MIGRATION_URL`. On the cluster that's a Job (Slice 9).
- Not in Slice 0: registry push, manifests, `/metrics` (section 8).

### 5.8 CI (`.github/workflows/ci.yml`)

Triggers: `pull_request` and `push` to `main`. `permissions: contents: read`, concurrency
cancels superseded runs, and third-party actions are **pinned by commit SHA**. pnpm caching
comes through `actions/setup-node`. `.node-version` = `24`.

| Job | Node | Steps | From PR |
|---|---|---|---|
| `typecheck` | 24 | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm api:generate` + `git diff --exit-code` (client drift; from 0b) | 0a |
| `lint` | 24 | `pnpm lint` (Oxlint + Oxfmt check + boundary rule) | 0a |
| `test` | **22, 24** (matrix) | Postgres 16 service (from 0b), `pnpm db:setup`, `pnpm test` | 0a |
| `e2e` | 24 | Postgres service, `pnpm build`, `playwright install --with-deps chromium`, `pnpm test:e2e`; the report is uploaded on failure (synthetic data only) | 0c |
| `image` | — | `docker build`; smoke test: run the migration then the server against a Postgres service; `curl` `/api/v1/health/ready`, `/` and `/portal/` | 0d |

After 0d, the product owner marks `typecheck`, `lint`, `test (22)`, `test (24)`, `e2e` and
`image` as required checks on `main` (guide, step A1). This is a manual GitHub setting.

### 5.9 Environment variables (`.env.example`, PR 0b)

| Variable | Dev default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://transfer_app:transfer_app_dev@localhost:5432/transfer` | runtime (app role) |
| `DATABASE_MIGRATION_URL` | `postgres://transfer_owner:transfer_owner_dev@localhost:5432/transfer` | migrations and seed (owner role) |
| `DATABASE_ADMIN_URL` | *(empty; cloud session uses `su postgres`)* | `pnpm db:setup` only (CI: service superuser) |
| `AUTH_MODE` | `dev` | `dev` (stub) or `oidc` (Slice 3) |
| `SESSION_SECRET` | *(empty → random per start in dev)* | cookie signing; required outside dev |
| `APP_ORIGINS` | `http://localhost:5173,http://localhost:5174` | CSRF origin allowlist |
| `API_PORT` / `PORT` | `3001` / `8080` (image) | listen port |
| `LOG_LEVEL` | `info` | pino level |

The existing adapter and OIDC variables stay as they are.

## 6. Commands that will exist

These are root `package.json` scripts. Their names are the contract, whatever the spike
decides.

| Command | What it does | PR |
|---|---|---|
| `pnpm install` | install (CI and session start use `--frozen-lockfile`) | 0a |
| `pnpm dev` | runs `db:migrate`, then api (`:3001`, watch), web (`:5173`) and portal (`:5174/portal/`) in parallel; Vite proxies `/api` to the API | 0b–0d |
| `pnpm build` | builds the SPAs and the API bundle | 0b |
| `pnpm start` | runs the built API, which also serves both SPAs (production-like, on `:3001`) | 0d |
| `pnpm typecheck` | `tsc -b` with TS 7 (fallback `tsc6 -b`) | 0a |
| `pnpm lint` | Oxlint (incl. the boundary rule) + Oxfmt check | 0a |
| `pnpm format` | Oxfmt write | 0a |
| `pnpm test` | all Vitest projects: unit, component, integration (needs Postgres from 0b on) | 0a |
| `pnpm test:e2e` | Playwright against the built app and `transfer_e2e` (reset and seeded first) | 0c |
| `pnpm verify` | what CI runs, minus e2e and image: typecheck, lint, test, api drift | 0b |
| `pnpm db:setup` | dev/CI only: creates the roles and the `transfer`, `transfer_test` and `transfer_e2e` databases (idempotent) | 0b |
| `pnpm db:generate` | drizzle-kit: generates a SQL migration from the schema | 0b |
| `pnpm db:migrate` | applies migrations as `transfer_owner` | 0b |
| `pnpm db:seed` | synthetic seed (idempotent; refuses in production) | 0b |
| `pnpm db:reset` | dev only: empties the schema, migrates, seeds | 0b |
| `pnpm api:generate` | writes `openapi.json` and `schema.d.ts` into `packages/api-client` | 0b |

From a fresh cloud session to the done state: session start (Postgres, install, `db:setup`,
`db:migrate`), then `pnpm db:seed`, then `pnpm dev`, then open `http://localhost:5173`.

`.claude/settings.json` gets allowlist entries for `pnpm format`, `pnpm verify`,
`pnpm db:setup`, `pnpm db:reset`, `pnpm api:generate` and `pnpm start` (PR 0d; `pnpm add`
stays on ask).

## 7. Acceptance criteria

Each item names the test that proves it (U = unit, I = API/DB integration, C = component,
E = Playwright, CI = workflow).

### Done-when (roadmap)
- [ ] **AC-1** In a fresh cloud session, after `pnpm db:seed && pnpm dev`, `localhost:5173`
      shows the Carbon shell. After choosing a dev user, it shows the three seeded projects
      **read from Postgres**. (E, manual check recorded in the 0c PR with a screenshot)
- [ ] **AC-2** CI is green on the final PR with the jobs `typecheck`, `lint`, `test (22)`,
      `test (24)`, `e2e` and `image`. (CI)

### Projects end to end
- [ ] **AC-3** Creating a valid project returns `201`. The project shows at the top of the list
      without a page reload, with dates shown as `TT.MM.JJJJ`. (I, C, E)
- [ ] **AC-4** Invalid input shows field errors in the form and returns a 400
      `validation-error` problem with `errors[].pointer`, and the response doesn't contain the
      submitted values. Covered cases: empty name; impossible date (`31.02.2027` in the UI,
      `2027-02-31` in the API); TG end before TG start; TG dates or a signing deadline on a
      `ta_only` project. (U, I, C)
- [ ] **AC-5** Domain date rules: `2028-02-29` is valid, `2027-02-29` and `2026-14-03` are
      invalid, and the UI parser rejects `03.14.1998`. (U, C)
- [ ] **AC-6** With 120 projects, `limit=50` gives pages of 50, 50 and 20 in a stable order
      with no duplicates or gaps, and `nextCursor` is `null` on the last page. A malformed
      cursor gives a 400 problem with `parameter: "cursor"`. (I)
- [ ] **AC-7** `GET /api/v1/projects/{unknown}` and unknown `/api/*` paths give a 404 problem.
      A thrown error gives a 500 problem with no message or stack, with the same request id as
      the log line. (I)

### Contract
- [ ] **AC-8** Every route is under `/api/v1`. `/api/v1/openapi.json` is valid OpenAPI 3.1.
      The committed client is in sync with it (CI drift check). Both SPAs only call the API
      through `@transfer/api-client`. (I, CI)
- [ ] **AC-9** Every error response has `Content-Type: application/problem+json` and one of the
      `type` URNs in section 5.4. (I)

### Auth stub
- [ ] **AC-10** Without a session, `/api/v1/projects` and `/api/v1/me` return a 401 problem,
      and the web app shows the "choose a dev user" prompt. (I, C)
- [ ] **AC-11** Switching dev users changes `/api/v1/me`, and `createdBy` is the active user.
      (I, E)
- [ ] **AC-12** With `NODE_ENV=production` and `AUTH_MODE=dev`, the API exits at startup. With
      `AUTH_MODE` other than `dev`, the dev routes return 404. Seed and reset refuse to run in
      production. A cross-origin `POST` is rejected with a 403 problem. (I)

### Database and data protection
- [ ] **AC-13** As `transfer_app`, the following work: `SELECT`/`INSERT` on `project`. These
      are rejected: `UPDATE`/`DELETE` on `project`, `CREATE TABLE`, and any write to
      `staff_user`. Migrations run only as `transfer_owner`. (I)
- [ ] **AC-14** The data-catalog test passes for `project` and `staff_user`, and it fails for
      the fixture table that is marked as participant data but has no `project_id`. (U)
- [ ] **AC-15** Integration tests run the migrations from scratch against an empty
      `transfer_test` database. (I)
- [ ] **AC-16** A `POST /api/v1/projects` with a distinctive synthetic name leaves no trace of
      that name in the captured log output. Logs contain no bodies, query strings or cookies.
      (I)
- [ ] **AC-17** The seed, fixtures and screenshots contain only obviously fictional data, and
      emails use `example.org`. (review)

### Portal and boundaries
- [ ] **AC-18** `localhost:5174/portal/` (dev) and `/portal/` (image) render in German by
      default. Switching to English changes the text and `<html lang>`. `i18next.dir("ar")`
      sets `dir="rtl"` (unit test; there is no `ar` catalog). The page shows the API status.
      (C, E)
- [ ] **AC-19** A fixture import of `@transfer/web` (or a path into `apps/web`) from
      `apps/portal` makes the lint fail. (U)
- [ ] **AC-20** The `de` and `en` portal catalogs have identical key sets, and every web key
      exists in the `de` catalog (typed keys + test). (U, typecheck)

### Platform
- [ ] **AC-21** `pnpm dev` and `pnpm test` work in the cloud session on Node 22.22. CI runs the
      tests on Node 22 and 24. (CI, manual)
- [ ] **AC-22** The image is built on Node 24 and runs as non-root. The CI smoke test gets
      `200` from `/api/v1/health/ready`, `/` (web) and `/portal/` (portal) against Postgres.
      (CI)
- [ ] **AC-23** Playwright with axe finds no `serious` or `critical` accessibility violations
      on `/projects`, `/projects/new` and the portal page. (E)
- [ ] **AC-24** The spike result is recorded in the ADR-0003 amendment for each criterion
      (V1–V5, T1–T3), and the CLAUDE.md "Tech stack", "Repo layout" and "Commands" sections
      are updated. (review)

### Definition of done (CLAUDE.md) applied to this slice
- Status changes through the audit helper: **not applicable**, Slice 0 has no status columns.
- No hard-coded regional rules and no vendor calls outside adapters: there are no regional
  rules and no external services in Slice 0.
- New personal data (`staff_user`) has a classification (`confidential`), an access rule (any
  authenticated staff user may see it in Slice 0, revisited in Slice 1) and a `retentionClass`
  (`staff_account`, Q59).

## 8. Deliberately left out

| Not in Slice 0 | Why / where it lands |
|---|---|
| Real login: OIDC/Entra ID, participant SMS/email login, server-side session store, session lifetimes | Slice 3. The signed dev cookie never runs in production. |
| Roles and permissions on routes, the field-level access matrix | Slice 1 (matrix), Slice 3 (wiring). In Slice 0 any authenticated dev user may create projects. |
| Audit table, the single status function, status-column grants | Slice 1. Slice 0 has no status columns. The role split (D7) prepares the grants. |
| Participants, participations, lifecycle, completeness | Slices 1–2. No table holds participant data yet; the catalog test is ready for them. |
| `packages/config`, regional templates, `base-defaults.json`, JSON Schema validation | Slice 1 |
| `packages/adapters` (incl. `Clock`), pg-boss | Slice 1 (ADR-0011) |
| `packages/forms`, PDF generation, Gotenberg, MinIO in Compose | Slices 4b and 6. Compose only runs Postgres. |
| Full project setup (F1): KuG-Agentur, templates, checklist, region, customer entity, settlement dates, activation, editing, deleting | Slice 2 |
| Row-level security | Pre-pilot gate (ADR-0005). The `project_id` convention is enforced by test from now on. |
| Field-level encryption and key management | With the first special-category or highly confidential field (Slice 4a/6) |
| Retention values and the retention job | Q58/Q59 (DPO); job in Slice 7 |
| Deployment manifests (`deploy/`), registry push, `/metrics`, backups | Slice 9. Health and readiness endpoints exist from Slice 0. |
| Separate hostnames and cookies for web and portal | Revisited in Slice 3/9 (D4) |
| Portal features, languages beyond de/en | Slices 3/4a; v1.1 |
| Renovate/Dependabot, release automation, preview deployments | Later. No US edge hosting ever (ADR-0005). |
| Virtualised tables and performance work | Slice 9 (route-level code splitting and preloading are in from Slice 0) |
| Carbon v12 upgrade | Later, contained in `packages/ui` |

## 9. Doc changes made by the implementing PRs

Not in this plan PR. Each lands with the PR named here.

- **0a:** `docs/decisions/2026-10-15-answers-round-6.md` (D1–D11). ADR-0003 amendment: spike
  results, the TypeScript package naming, the i18n choice (i18next), Vite+ 1.x stable.
  CLAUDE.md "Tech stack" line about the TS alias.
- **0b:**
  - `open-questions.md`: **Q58** (retention of project master data, 🔒) and **Q59** (retention
    of staff accounts and their audit references, 🔒), owner DPO, status `open`.
  - ADR-0007: the Slice 0 stub is a signed dev cookie; the server-side store comes in Slice 3.
  - `.env.example`.
- **0d:**
  - CLAUDE.md "Commands" (section 6) and "Repo layout" (`packages/api-client`).
  - `docs/architecture/overview.md`: one image serves the API and both SPAs.
  - README status.
  - `.claude/settings.json` allowlist.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Vite+ or TS 7 problems use up the slice | Timebox plus a per-tool fallback (section 3). Script names don't change. |
| `@hono/zod-openapi` and Zod 4 metadata from a pure domain package | Checked in the spike; fallback is wrapping in `apps/api`. |
| Carbon CSS bundle size and Sass under Vite 8 | Import styles per component. The 0c PR records the bundle size as a baseline. |
| CSP vs. Carbon inline styles | Checked in 0d. Any relaxation is documented in the PR. |
| Integration tests share one database | Serial run with truncation before each test. Revisit when the suite gets slow. |
| Grants reference fixed role names | The same names on the cluster (CloudNativePG managed roles, Slice 9). |
| Pinned Playwright vs. the pre-installed Chromium in cloud sessions | `executablePath` override from the environment. CI installs its own browser. |

## 11. Approval

Approve this plan (or comment on it) in the PR. Implementation starts with PR 0a on a new
branch once it is approved.
