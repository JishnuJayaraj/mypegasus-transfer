# ADR-0003: Tech stack

- Status: Accepted (review Vite+ and TS 7 tooling at Slice 0)
- Date: 2026-10-15

## Decision
- TypeScript everywhere. **TypeScript 7** (native compiler) for type-checking. TS 7.0 has no
  stable programmatic API yet, so tools that import `typescript` use **TypeScript 6** via npm
  alias, as recommended by the TS team.
- **Vite+** (beta, MIT) as toolchain on **Vite 8**; fall back to plain Vite + Vitest + Oxlint if
  Vite+ blocks us. Avoid VoidZero's hosting (Void) for production data (US/Cloudflare edge,
  see ADR-0005).
- **React** SPA, **TanStack Router** + **TanStack Query**.
- **IBM Carbon** (`@carbon/react`) wrapped in `packages/ui`, so the planned Carbon v12 upgrade
  touches one package.
- **Hono** on Node (24 LTS since the 2026-10-15 amendment below) for the API; **Zod** schemas shared between API and UI.
- **pnpm** (not bun — proxy issues in cloud sessions).
- Vitest + Playwright.

## Consequences
+ Fast builds and type-checking, one language, typed end-to-end.
- Two early-stage tools (Vite+ beta, TS 7.0 without API); pin versions and keep fallbacks.

## Amendments 2026-10-15

- **Node 24 LTS** for the production image instead of Node 22, because Node 22 reaches end of
  life in April 2027 *(provisional, from Q12)*. Cloud coding sessions currently ship Node 22.
  Until they are updated, the code must also run on Node 22 (no Node-24-only APIs). CI tests
  with Node 24.
- PDF: **pdf-lib** for AcroForm filling of official BA forms and **Gotenberg** for HTML→PDF,
  both behind `PdfRenderer` (ADR-0006, ADR-0009). pdf-lib has had no release since 2021: pin
  the version and keep contract tests on the real forms, so that a switch to a maintained fork
  is cheap.
- **i18n from day one**, no hard-coded strings. Staff UI: `de`. Portal: `de` + `en` in the
  MVP; v1.1 adds `tr`, `ar` (RTL), `pl`, `ru`, `uk`, `ro`. The layout uses CSS logical
  properties so that RTL works *(provisional, Q9)*. The library is chosen in Slice 0.
