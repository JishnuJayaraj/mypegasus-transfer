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
- **Hono** on Node 22 for the API; **Zod** schemas shared between API and UI.
- **pnpm** (not bun — proxy issues in cloud sessions).
- Vitest + Playwright.

## Consequences
+ Fast builds and type-checking, one language, typed end-to-end.
- Two early-stage tools (Vite+ beta, TS 7.0 without API); pin versions and keep fallbacks.
