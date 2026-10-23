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
- `packages/self-service-ui` (Slice 4a): the self-service wizard, shared by the portal and (assisted
  mode) the staff app. It renders a page from the API's page definition with Carbon through
  `packages/ui`, brings its own i18n namespace `selfService` (de/en) and reads and writes through a
  `SelfServiceSource` the app supplies, so it holds no route and no staff code; Oxlint forbids it
  Carbon directly, app code and `@transfer/staff-*`. The sensitive groups go through the source's
  own calls (`loadSensitive`, `saveSensitive`) and the portal's step-up (`stepUp`), never through
  the wizard state. The staff app's source (assisted mode, `apps/web/src/components/
  assisted-mode.tsx`) calls the assisted routes with the mode's id and has no `stepUp`; its state
  leaves out the fields the role can't see (`WizardState`), and an ended mode (`403
  assisted_mode_required`) shows the app's "ended" view like an expired portal session.
  From Slice 4b the source has `documents` (a `DocumentSource`: `list`, `upload`, `open`,
  `remove?`) for the page "Unterlagen" (`DocumentsPage`); the assisted one has no `remove`. The
  package also exports the helpers the staff tab "Unterlagen" reuses (`readFileAsBase64`,
  `formatFileSize`, `documentFailureOf`, `DOCUMENT_ACCEPT`).
- `packages/config`: regional configuration: the Zod-authored layer model (base defaults,
  Agentur templates, project overrides) exported as JSON Schema, the custom-field profile, the
  two-level resolver with provenance and blockers, pinned template loading
  (`@transfer/config/load`, Node only, from `CONFIG_DIR` in the image), the canonical template
  hash, the fictional sample templates in `templates/<agenturKey>/<version>.json` (immutable once
  merged; `pnpm lint` checks against `origin/main`, in CI the PR's base) and their generated
  `manifest.json`. It also owns `organisation.json`, the validated controller and DPO details
  interpolated into immutable Article 14 notice templates (synthetic values in the repository).
- `packages/adapters`: interfaces + implementations behind them (ADR-0006). `Clock` (system,
  manual, Berlin dates and run times); `Mailer` and `SmsSender` contracts and their idempotent
  last-100 development outbox; `FileStorage` (memory for tests, filesystem under `STORAGE_DIR`
  for development and e2e, one shared contract test) and `VirusScanner` (a mock: EICAR infected,
  an encrypted PDF unscannable) from Slice 4b. None of the mocks is wired in production. Real
  mail/SMS providers, S3 storage, ClamAV, pdf and export come with the slices that need them.
  The API encrypts document files before they reach the store (`apps/api/src/
  document-encryption.ts`, `DOCUMENT_ENCRYPTION_KEY`).
- `packages/forms` (Slice 6): official BA form templates (blank PDF, field map, manifest),
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
- **Zod runs jitless in both SPAs** (ADR-0004): each `main.tsx` imports only Zod, sets
  `z.config({ jitless: true })` and then loads the app with a dynamic import. A first static import
  would run too late, because a bundle evaluates the shared chunks an entry imports (the domain's
  schemas) before the entry's own code. The e2e suite fails on any CSP violation, including those
  Chromium reports only as a `securitypolicyviolation` event.
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
- PR 5b-3: "Termine" (`apps/portal/src/routes/appointments.tsx`, linked from the start page):
  the four sections of `GET /api/v1/portal/appointments` (`apps/api/src/routes/
  portal-appointments.ts`, the domain's `portalAppointments`): "Einladungen", "Meine Termine",
  "Abgesagt", "Termine buchen", one card per appointment (`.tp-appointment`, logical CSS
  properties, readable at 320 px without horizontal scrolling), "Buchen" and "Absagen" each with
  an inline confirmation (a `fieldset` whose legend asks), "Anderen Termin buchen" as a link to the
  last section. Dates and times in Europe/Berlin, de/en.

## Encrypted fields (Slice 4a, PR 4a-4)

- The highly confidential and special-category self-service fields are encrypted in Postgres with
  `pgcrypto` (in its own schema `crypto`) by `write_sensitive_fields` / `read_sensitive_fields`
  (ADR-0002, field encryption). `apps/api/src/field-encryption.ts` derives the key from
  `FIELD_ENCRYPTION_KEY` (HKDF `field-encryption:v1`, required outside development) and passes it
  per call as a bind parameter; the routes live in `apps/api/src/routes/self-service.ts` (portal
  and staff) and the step-up in `apps/api/src/routes/portal.ts` (ADR-0007, step-up).
- `packages/domain/src/self-service/sensitive.ts` holds their value schemas and groups,
  `packages/domain/src/portal/step-up.ts` the step-up rules; no I/O.

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
- **Reminders** (Slice 5 PR 5-2): `reminders.send`, queued by the request in its own transaction
  with the reminder id as `singletonKey`, claims the dispatch under the participation lock, sends
  the fixed text (provider key `reminder:<reminderId>`) and records the outcome
  (`apps/api/src/reminders/`; ADR-0011).
- **Invitations and organizer notices** (Slice 5b PR 5b-3): invitations go through
  `reminders.send`; the organizer's notices through `appointments.notify`, queued in the
  organizer's own transaction (`apps/api/src/appointments/notices.ts`,
  `apps/api/src/appointments/invitations.ts`); one handler sends every kind's fixed text.

## The project page (Slice 5, PR 5-1)

- The tabs "Übersicht" (the dashboard), "Teilnehmende" (the work list), "Termine" (the
  appointments, PR 5b-1), "Einrichtung" (project setup, Agentur settings, waves, import) and
  "Team"; the tab and the work list's code filters
  are the route's search params (`?tab=participants&status=informed`), never a person's value.
  Each tab loads its data only while shown.
- One snapshot per project (`worklistQuery`, `GET /projects/{id}/worklist`) feeds the work list;
  its query key is the prefix of every participant query of the project, so a change to a
  participation refreshes the list and the dashboard alike. The domain's `WorklistFilter`,
  `matchesWorklistFilter`, `searchKey` and `mostUrgent` run in the browser as on the server.
- From PR 5-2 the work list's bulk "Erinnern" counts the selected rows by their
  `capabilities.remind` before sending, the column "Erinnert" shows the latest reminder, and the
  participant page has the tab "Nachrichten" (`apps/web/src/components/reminders.tsx`).
- From PR 5b-3 the bulk "Zu Termin einladen" (`apps/web/src/components/invitations.tsx`) picks an
  appointment the participant can still book in the portal, counts the selected rows by their
  `capabilities.invite` ("per E-Mail", "per SMS", "nicht zustellbar, im Portal sichtbar"), shows
  the fixed text and then the result with the skips; "Nachrichten" names the new kinds, the
  system as the sender of a notice, and offers "Nachverfolgung erfassen" on an undelivered one.
- **The dashboard** ("Übersicht") shows tiles of distinct participations ("Teilnehmende", "mit
  offenen Angaben oder Unterlagen", "Frist in 14 Tagen", "Frist überschritten", "Hinweise", "nicht
  erreichbar") and tables per status, track, wave, activation and notice state, deadline kind and
  state and flag. Each count is defined as a `WorklistFilter` (`projectFunnel`, `funnelFilters`)
  and links to the work list with that filter, so a count and its drill-down are one predicate
  (a domain test holds `count = items.filter(filter).length`). Tables and tiles, no chart library
  (the CSP forbids inline styles).
- **Loading the work list:** until the snapshot has arrived the list says "Wird geladen…", the
  search field and "Alle Treffer auswählen" are disabled and no empty state is shown; a refetch
  after a bulk action keeps the previous snapshot visible with its time ("Stand 10:42") and keeps
  "Alle Treffer auswählen" disabled until it is complete. The search field has
  `autocomplete="off"`.
- **"Termine"** (PR 5b-1, `apps/web/src/components/appointments.tsx`): upcoming or past
  appointments (Art, Datum, Ort, Gastgeber·in, the API's count view "12 von 40" or "davon Ihre: 3"
  with "Plätze frei / ausgebucht", Status, "Klärung nötig" for the PL), "Infoveranstaltung
  anlegen" and "Beratungstermin anlegen" by the page's capabilities, the form with the hint on
  personal data (Berlin date and times, the public cutoff in days). The appointment page
  (`/projects/$projectId/appointments/$appointmentId`): details, "Ändern" (times, cutoff and
  audience read-only once booked), "Gastgeber·in ändern" (the PL), "Absagen" with a reason and the
  confirmation, the bookings the viewer may list with "Buchung absagen", and "Teilnehmende buchen"
  from the viewer's work list snapshot (the name search stays in the component, as on the work
  list), the API's warning shown with the result.
- **A refused bulk wave assignment** says "Keine Zuweisung vorgenommen" first, then lists the
  refused rows by Personalnummer with their reasons (all or nothing,
  process-and-lifecycle.md).

## The participant page

- The tabs "Übersicht", "Selbstauskunft", "Unterlagen", "Termine", "Nachrichten" and "Verlauf", the tab in
  the route's search param (`?tab=history`); each tab other than the overview loads its data only
  while shown, so opening "Verlauf" (an audited opening, data-protection.md) happens only when the
  user chooses it.
- "Termine" (PR 5b-1, `apps/web/src/components/participation-appointments.tsx`): the
  participation's bookings with "Buchung absagen", and the upcoming appointments in its audience or
  host rule with the seat state, the refusal or the cutoff warning, and "Buchen".
- "Verlauf" (PR 5-3, `apps/web/src/components/history.tsx`): Zeitpunkt (Berlin), Ereignis,
  Änderung (von → nach; the wave codes from the project's waves, field names, document types,
  dates), Grund, Wirksam am, Durch (the name, "Ehemaliges Teammitglied", "Teilnehmer·in",
  "System", "(assistiert)"), "Mehr laden" with the API's opaque cursor. Every event type's label
  is in the i18n catalog (a test holds it to `HistoryEventType`); a code without a label shows as
  the code.

## Performance approach (frontend)

- Route-level code splitting + TanStack Router preloading on hover/intent.
- TanStack Query cache with sensible stale times; optimistic updates for simple edits.
- The work list filters and searches its whole snapshot in memory and renders 25 matching rows
  at a time ("Weitere anzeigen"), so a keystroke over 2,000 participations stays under 100 ms
  without a virtualised table.
- Keep Carbon imports per-component to keep bundles small.
