# ADR-0003: Tech stack

- Status: Accepted; toolchain amended for Slice 0 (see "Amendment 2026-10-15: Slice 0 toolchain")
- Date: 2026-10-15

## Decision
- TypeScript everywhere. ~~**TypeScript 7** (native compiler) for type-checking. TS 7.0 has no
  stable programmatic API yet, so tools that import `typescript` use **TypeScript 6** via npm
  alias, as recommended by the TS team.~~ *Superseded: plain TypeScript 6 (Slice 0 amendment).*
- ~~**Vite+** (beta, MIT) as toolchain on **Vite 8**; fall back to plain Vite + Vitest + Oxlint if
  Vite+ blocks us.~~ *Superseded: plain Vite 8 + Vitest + Oxlint + Oxfmt (Slice 0 amendment).* Avoid VoidZero's hosting (Void) for production data (US/Cloudflare edge,
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
  *(Both deferred by the Slice 0 amendment.)*

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

## Amendment 2026-10-15: Slice 0 toolchain

Decided before PR 0a ([round 6](../decisions/2026-10-15-answers-round-6.md)):
build speed doesn't matter yet; avoiding toolchain risk does.

- **TypeScript 6.** Plain `typescript@6.0.3`, pinned, the only TypeScript in the tree: no npm
  aliases, no pnpm overrides. `pnpm typecheck` = `tsc -b` over project references.
  *"TS 7 deferred until after MVP; revisit when TS 7.1 and its API have settled."*
- **Plain Vite 8 + Vitest + Oxlint + Oxfmt**, each pinned exactly. `pnpm lint` runs Oxlint,
  `oxfmt --check` and a guard against `ignoreDeprecations`. Dev servers run with
  `pnpm -r --parallel`. *"Vite+ deferred, revisit after MVP."*
- **`tsx watch`** runs the API in dev, not Node's native type stripping, so there is no
  `erasableSyntaxOnly` requirement.
- **i18n:** i18next + react-i18next, runtime only (no compiler plugin), typed keys, `dir()` for
  RTL.
- All dependencies are pinned exactly (`.npmrc`: `save-exact=true`, `engine-strict=true`).
  `engines.node` is `^22.18.0 || ^24.11.0`; CI runs the tests on Node 22 and 24.

### TypeScript configuration rules

The goal is that moving to TS 7 later is one small PR.

- `tsc -b` reports no deprecation diagnostics, and `ignoreDeprecations` is never set
  (`scripts/check-tsconfig.mjs` fails `pnpm lint` if it appears in any `tsconfig*.json`).
- No options that TS 6 deprecates (`baseUrl`, `moduleResolution` `node`/`node10`/`classic`,
  `target: es5`, `outFile`, AMD/UMD/System, `downlevelIteration`, turning off
  `esModuleInterop`). Workspace imports go through package `exports`, not `paths`.
- Behaviour-relevant options are set explicitly in `tsconfig.base.json`: `strict`, `target`
  (`ES2023`), `module` (`ESNext`), `moduleResolution` (`bundler`), `types`,
  `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`; plus `noUncheckedIndexedAccess`,
  `noImplicitOverride` and `composite`.

### Spike results (PR 0a)

Run on 2026-10-15 in a cloud session (Node 22.22.0, pnpm 10.28.0) in a scratch workspace with
the repo's root configuration and the real `packages/domain`, using the pinned versions.

| # | Check | Result |
|---|---|---|
| S1 | `@hono/zod-openapi@1.6.3` reads OpenAPI metadata from Zod 4 `.meta()` in `packages/domain`, without the domain importing Hono | **Passed, no fallback.** Schemas with `.meta({ id })` become `components.schemas` entries and `$ref`s, `description`/`format`/`examples` are carried over, and the route validates with the domain schema (400 on invalid input, trimmed values on success). **Caveat:** if a schema with an `id` is used as `.nullable()` somewhere, the generator makes the shared component nullable everywhere. Rule: schemas that are reused as nullable (e.g. `isoDate`) carry no `id` and are inlined. Also, `.meta()` must be the last call, because Zod methods return new instances. |
| S2 | Pinned `@playwright/test@1.64.1` runs against the pre-installed Chromium (`PLAYWRIGHT_BROWSERS_PATH`) | **Failed, fallback applied.** Playwright 1.64.1 expects browser revision 1248; the cloud session ships revision 1194 (Chromium 141) and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Launching through `executablePath` works. `scripts/session-start.sh` exports `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` in cloud sessions; the Playwright config (PR 0c) passes it as `launchOptions.executablePath` when set. CI always runs `playwright install --with-deps chromium` and never sets the variable. |
| S3 | Carbon's Sass (per-component imports, `sass-embedded@1.105.1`) under Vite 8, dev with HMR and production build | **Passed, no fallback.** `vite build` and the dev server compile `@carbon/react@1.118.0` styles (reset, fonts, `g10` theme, button, data-table, ui-shell, date-picker, notification); an SCSS edit is applied by HMR without a page reload. Notes for PR 0c: Carbon emits non-blocking Sass `if-function` deprecation warnings (silence them for dependencies only, e.g. `quietDeps`); `@ibm/plex` must be a direct dependency of the package that compiles the styles, otherwise pnpm's strict layout leaves the font URLs unresolved; restrict the font families, because the default pulls in every Plex family. Baseline for those five components: 292 kB CSS (29 kB gzip). |
| S4 | `openapi-typescript@7.13.0` (peer `typescript: ^5.x`) generates correct types with TS 6.0.3 | **Passed, no fallback.** pnpm warns `unmet peer typescript@^5.x: found 6.0.3`; `"pnpm": { "peerDependencyRules": { "allowedVersions": { "openapi-typescript>typescript": "6" } } }` in the root `package.json` silences exactly that edge, and the lockfile still contains only `typescript@6.0.3`. The generated `schema.d.ts` has the right shapes (refs, enums, optional and nullable dates), and an `openapi-fetch@0.17.0` client over it type-checks with `tsc -b` 6.0.3, including expected errors for a wrong enum value and an unknown path. The rule is added with `openapi-typescript` in PR 0b; no `tools/codegen` package. |

Also observed: pnpm 10 blocks dependency build scripts by default (esbuild, the Carbon and
IBM Plex packages, `@parcel/watcher`). Nothing in the spike needed them; keep them blocked and
allow one only with a reason (`pnpm.onlyBuiltDependencies`).

### Notes from PR 0c (web shell)

- **jsdom 29.1.1 instead of 30.1.3.** jsdom 30 requires Node `^22.22.2 || ^24.15.0`; cloud
  sessions run 22.22.0, and `engine-strict` rejects the install. 29.1.1 (`^22.13.0 || >=24`) is
  used until cloud sessions move on; then it's a deliberate upgrade.
- **Carbon Sass under Vite** (adds to S3): besides the per-component modules, `packages/ui`
  must load `@carbon/react/scss/layout` and `@carbon/react/scss/layer`, which emit the root
  tokens (component heights and padding, layer colours). Without them, buttons and inputs
  render without size. Carbon's font URLs use webpack's `~@ibm/plex`, which Vite doesn't
  resolve; `apps/web/vite.config.ts` aliases it to its own `@ibm/plex` dependency. Only IBM
  Plex Sans is loaded (`$fonts` map). CSS baseline with 10 components: 287 kB (29 kB gzip).
- **Date fields** use Carbon's `simple` DatePicker (a `TT.MM.JJJJ` text field without the
  calendar). The text is parsed strictly in `packages/ui`, so impossible dates are errors
  rather than whatever the calendar widget's parser makes of them. A calendar can be added
  later if it keeps that behaviour.


### Notes from PR 0d (portal, static serving, image)

- **CSP needs no relaxation for Carbon.** The API sends `default-src 'self'` with `script-src`,
  `style-src`, `img-src`, `font-src` and `connect-src` all `'self'`, `object-src 'none'` and
  `frame-ancestors 'none'`. Vite extracts all CSS into files, the built `index.html` has no
  inline script, and React's `style` props go through the CSSOM, which `style-src` doesn't
  restrict. The Playwright suite fails on any CSP violation in the console (checked by
  temporarily setting `font-src 'none'`, which failed every test).
- **Playwright runs against the API bundle serving both SPAs** (the `pnpm start` and image
  setup), not `vite preview`, so static serving and the CSP are covered end to end.
- **API bundle:** `apps/api/vite.config.ts` builds two entries (`server`, `migrate`), inlines
  `@transfer/*` (devDependencies of `@transfer/api`) and keeps npm dependencies external, so
  everything the bundle imports at runtime (including `drizzle-orm` and `pg` for
  `@transfer/db`) must be a dependency of `@transfer/api`. Shared chunks sit next to the
  entries, because modules resolve `.env` and the SPA directories relative to
  `import.meta.url`. The migrations are copied to `dist/migrations`.
- **Image:** `pnpm deploy` needs `--legacy` (pnpm 10 otherwise requires
  `inject-workspace-packages`; the API has no workspace packages in production). `package.json`
  must be copied before `pnpm fetch`, or corepack picks a default pnpm instead of the
  `packageManager` version. In Slice 0 the image can only start with `NODE_ENV=development`
  and `AUTH_MODE=dev` (production refuses the dev stub, OIDC comes in Slice 3); the CI smoke
  test runs it that way.
- **Boundary rule:** `--no-ignore` doesn't override `ignorePatterns` in `.oxlintrc.json`, so the
  boundary fixtures are excluded with `--ignore-pattern` in `pnpm lint` instead.
- **Empty variables are unset.** `.env` copied from `.env.example` has `SESSION_SECRET=`; the
  API treated the empty string as a too-short secret and `pnpm dev` failed in a fresh session.
  `parseEnv` now ignores empty values.

### Notes from Slice 2, PR 2g (import dependencies, spike S1)

- **Two dependencies, exact pins, `@transfer/api` only** (round 22): `read-excel-file@9.3.12`
  (workbooks) and `csv-parse@7.0.3` (CSV, no dependencies). Both are used in one module,
  `apps/api/src/imports/parse-core.ts`, behind `parseSpreadsheet()`; replacing a parser touches
  that file only.
- **Spike S1 passed.** A workbook is never parsed in the API process. After the ZIP
  central-directory check (declared sizes, ratio, entry count; in the API process), a worker thread
  with `resourceLimits` and a 15 s timeout inflates each entry up to its declared size (a zip that
  lies is refused) and reads the sheet. It runs from `tsx` and Vitest (the `.ts` worker is started
  through a bootstrap that registers tsx's loader; `--import` in `execArgv` does not reach a
  worker's module resolution) and from the Vite build (`dist/parse-worker.js`, a build entry
  besides `server` and `migrate`). Heap limits do not bound `ArrayBuffer` memory, which is why the
  declared size is the cap of the real expansion. No fallback (child process, CSV only) was needed.

## Conventions as built (Slices 0–2)

- **Import parsing limits** (`apps/api/src/imports/zip-check.ts`, `parse.ts`, `parse-core.ts`,
  `slots.ts`). The ZIP check runs in the API process before a worker slot is taken and refuses
  (`file_too_complex`) a declared expanded total over 50 MB, an entry with a ratio over 100, more
  than 1,000 entries, ZIP64, encrypted entries, duplicate names and methods other than stored and
  deflate. The worker runs with a 256 MB old-generation heap (young 32 MB, stack 4 MB) and the
  15 s timeout; CSV goes through the same worker, and a CSV with a NUL byte in its first 8 kB is
  `unsupported_file`. Slots: 2 workers running, 8 requests waiting for at most 20 s (ADR-0010); a
  slot is passed on only after its worker has stopped.
- **Coverage:** 100 % lines, functions, branches and statements on the paths listed in
  `vitest.config.ts` (the domain rule folders, `dates.ts`, `project.ts`, `packages/config/src`); a
  new domain-rule path joins the list in its PR. CI's Node 24 leg runs `test:coverage` and
  enforces them.
- **Database tests:** `transfer_test` is emptied (`drop owned by transfer_owner`) and migrated
  once per run (Vitest global setup). The integration projects (`db`, `api`) run serially, one
  file at a time, and truncate every table before each test except `lifecycle_edge` (reference
  data from the migrations); a new table joins the truncate list in
  `packages/db/src/testing/index.ts`. Playwright recreates `transfer_e2e` with the base seed.
- **Test fixtures:** the base seed (`packages/db/src/seed.ts`), used by integration tests and
  Playwright, pins no template, so tests make projects active as the owner (`activateAsOwner`).
  Rows written directly as the owner are only for test states the functions refuse.
- **e2e** fails on any axe violation of impact serious or critical (and on any CSP violation, see
  PR 0d). The portal's `locales.test.ts` checks that `de` and `en` have identical key sets and that
  every key the code uses exists.
