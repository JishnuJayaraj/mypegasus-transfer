# Decisions — 2026-10-15, round 6 (Slice 0 planning)

Answers given by the product owner while [the Slice 0 plan](../plans/slice-0.md) was written.
D12–D16 revised the toolchain before PR 0a: **build speed doesn't matter yet; avoiding
toolchain risk does.**

## Slice 0 shape

- **D1 — PR shape:** a short series of 4 PRs (0a–0d). Each PR is green on its own. The slice is
  done after 0d.
- **D2 — Stub auth:** a dev session cookie. Seeded synthetic staff users (one per role). A
  dev-only endpoint sets an httpOnly signed cookie. Every `/api/v1` route except health requires
  a session. No role checks yet. Dev routes are not mounted in production.
- **D3 — Portal scope:** a thin shell: one route, i18n `de` + `en` with a language switcher, CSS
  logical properties, `GET /api/v1/health` through the generated client. Plus the lint rule that
  forbids staff-only imports, tested with a failing fixture.
- **D4 — Production image:** one Node 24 image. Hono serves `/api/v1`, the web SPA at `/` and
  the portal at `/portal/`. CI builds and smoke-tests it but doesn't push it. Separate hostnames
  are revisited in Slice 3/9.
- **D5 — i18n library:** i18next + react-i18next. Runtime only (no compiler plugin), typed
  keys, `dir()` for RTL. Settles the open point in ADR-0003.
- **D6 — `Project` fields:** `name`, `customerName` (free text for now), `type`
  (`ta_only` / `ta_tg`), optional `signingDeadline`, `defaultTgStart`, `defaultTgEnd`, plus
  `createdAt` and `createdBy`. No project status, so no status/audit machinery in Slice 0.
- **D7 — DB roles:** split now. `transfer_owner` runs migrations and owns the tables.
  `transfer_app` (runtime) only gets explicit per-table grants, written in migrations.
- **D8 — E2E:** Playwright locally and as a CI job. Required checks become typecheck, lint,
  test, e2e, plus the image build (D4).
- **D9 — Retention (rule 10):** a table-level data catalog plus open questions. Every table gets
  a `retentionClass` and a data class; a test fails if one is missing. The new classes
  `project_master` and `staff_account` have period `unset`. New open questions Q58/Q59 (🔒) go
  to the DPO; Q59 has a proposed default (D16).
- **D10 — Node 22:** test matrix 22 + 24. Typecheck, lint, e2e and the image use Node 24. Unit
  and integration tests run on 22 and 24. `engines.node: "^22.18.0 || ^24.11.0"`. Drop the 22
  leg when cloud sessions move to 24.
- **D11 — Spike timebox:** one working session (~1 day). If a spike item fails, apply its
  documented fallback and record it in the ADR-0003 amendment.

## Toolchain (revised before PR 0a)

- **D12 — TypeScript:** plain `typescript@6.0.3`, pinned, with no npm aliases and no pnpm
  overrides. `pnpm typecheck` = `tsc -b`. No compiler option that TS 6 deprecates, and
  `ignoreDeprecations` is never set, so moving to TS 7 later is one small PR. TS 7 is deferred
  until after the MVP.
- **D13 — Build/test/lint:** plain Vite 8 + Vitest + Oxlint + Oxfmt, each pinned exactly. Dev
  servers run with `pnpm -r --parallel`. Vite+ is deferred until after the MVP.
- **D14 — API dev runner:** `tsx watch`, not Node's native type stripping. No
  `erasableSyntaxOnly` requirement.
- **D15 — Database versions:** the stable Drizzle line (`drizzle-orm@0.45.4`,
  `drizzle-kit@0.31.11`; not the 1.0 beta/rc). PostgreSQL 16 in Compose, CI and the cloud
  session; the cluster (CloudNativePG) must run the same major version.
- **D16 — Q59 proposed default:** `project.created_by` is a foreign key to `staff_user`, so
  staff accounts are deactivated and pseudonymised, not deleted. Q59 is recorded with this
  proposed default and status `assumed`, for the DPO to confirm (PR 0b).

## Where they land

- ADR-0003 amendment (D5, D12–D14 and the spike results): PR 0a.
- ADR-0005 note (D15), ADR-0007 note (D2), Q58/Q59 in `open-questions.md` (D9, D16): PR 0b.
