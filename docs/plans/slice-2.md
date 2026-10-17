# Slice 2 — Projects & import (F1, F2): plan

- Status: **Approved with amendments** ([round 22](../decisions/2026-10-16-answers-round-22.md),
  2026-10-16). Q101 (PL), Q102 (PL, legal, BA process owner; before PR 2h), Q103 (PL; before PRs
  2f/2g) and Q105 (DPO; before the pilot) are still open.
- Roadmap: [Slice 2](../roadmap.md#slice-2--projects--import-f1-f2)
- Builds on: [Slice 1](slice-1.md) (merged, PRs #9–#23)
- PRD: [F1 Project setup, F2 Import](../prd.md)
- Decisions it rests on: rounds 1–23 in [`decisions/`](../decisions/), in particular round 8
  (Agentur-scoped settings), round 10 (waves vs. beE), round 14 (controlled reason codes), round 15
  (Project Agentur, cross-chain invariants, immutable versions, migration review), round 16
  (functions, typed parameters), round 19 (`scheduledRunCompleted`), round 20 (database time)
- Relevant ADRs: 0002 (functions, grants, `project_id`), 0004 (pinned templates, overrides),
  0006 (adapters), 0007 (dev stub until Slice 3), 0008 (retention per item), 0010 (API contract),
  0011 (jobs)

Every reading taken in this plan is marked **(R*n*)** and listed in section 0. Every docs gap is
handled fail safe (Slice 1 D10) and recorded in `open-questions.md` as Q98–Q107. Round 22's
corrections are applied throughout; the readings taken while applying them are R23–R28.

## 0. Decisions, readings and open items

### Decisions (round 22: all approved; D3, D5, D6, D9 as amended)

| # | Topic | Decision |
|---|---|---|
| D1 | PR shape | **12 PRs, 2a–2h** (section 3), tests first, each green on its own, each under ~500 hand-written production lines. |
| D2 | Writes with audit | Every write that must be audited goes through a narrowly scoped **`SECURITY DEFINER` function** that writes the change and its audit event in the caller's transaction, as in Slice 1 (D2, round 16): project creation and edits, activation, waves, participation dates, template pins, override versions, relaxation requests and decisions, person data. `transfer_app` gets `SELECT` on the new tables and no direct DML, except on `import_column_mapping` (no personal data, no audit). Typed parameters; the only `jsonb` parameter is an override's content, validated by the service first (5.9). |
| D3 | Serialising setup and lifecycle | A transaction-scoped **project advisory lock**, **acquired inside the database functions** (round 22), never left to a service: every setup mutation function takes it exclusively itself; `lock_participation` takes it shared before its row lock; `create_participation` takes it shared. Lock order is always **project → template version → participation row**. A service that must read and decide before writing (activation, migration, the import confirm) also calls `lock_project_setup` first; the functions' own acquisition is re-entrant within the transaction. So a wave edit never interleaves with a status change that reads the wave, and two imports of one project never race. |
| D4 | Memberships | A minimal **`project_membership`** table now (project, staff user, project role; zero or more roles, D6 of Slice 1), filled by project creation and the seed. Managing members and participant assignments is Slice 3. |
| D5 | Templates | Template versions are **normalised into `config_template_version`**, keyed by `(agentur_key, version)`, with content and canonical SHA-256; a project's pins reference it, and resolution reads only the stored content (the project snapshot). Cross-project serialisation by the primary key: the first pin of a version registers it, every later pin compares **both the stored `jsonb` content and the hash** (same claimed hash, different content → refused). Existing versions are immutable in the repo too (generated manifest + CI check against the base branch). |
| D6 | Import | **Stateless preview → confirm**: the preview stores nothing; the confirm sends the file again with the mapping and the PL's decisions. Parsing happens before the transaction; **reloading configuration and state, re-planning, comparing the preview token, validating the decisions and every write happen in one transaction under the exclusive project lock** (round 22: no TOCTOU window). No staged personal data on the server. Upload as base64 in JSON (the API keeps refusing non-JSON bodies). A ZIP central-directory check (expanded size and ratio) **always** runs; parsing in a `worker_thread` with resource limits (spike S1). If S1 fails there is **no in-process XLSX parsing**: a child process, or CSV only until isolation works. |
| D7 | Dependencies | **`read-excel-file@9.3.12`** and **`csv-parse@7.0.3`**, exact pins, in `@transfer/api` only (2.2). Nothing else. |
| D8 | Person data | Two tables split by retention class (5.10). **No special-category or highly confidential column in Slice 2**: the import targets are all confidential, so encrypted storage is not needed yet and comes with the first such field (Slices 4a/6, unchanged). The field catalog gains a `retentionClass` for every field a table stores. |
| D9 | Draft gate | A project is `draft` or `active`. Draft projects take setup, import and creation but **no post-creation lifecycle transition**; the nightly job plans nothing for them (R1, Q98). |
| D10 | Reconciliation route | **Deferred to Slice 7** (recommended): with the fail-closed facts provider (Slice 1 D4) it could only refuse, and its after-the-fact review (Q80) belongs with it. The **new start date** (Q68 case 3) is in Slice 2 as part of the individual date overrides (5.7). |
| D11 | Docs gaps | Unchanged: fail safe, unknown access denied, new question in `open-questions.md`. |

**Dependencies approved** (round 22): exact pins `read-excel-file@9.3.12` and `csv-parse@7.0.3`,
subject to S1 and the containment rules of D6; a fresh production audit found no known
vulnerabilities. **D8:** architecture approved; Q105 stays a DPO gate, and no production personal
data exists while retention periods are `unset`.

### Readings (round 22: accepted; R1, R5, R6, R10 as amended)

| # | Reading | Where | Question |
|---|---|---|---|
| R1 | A **draft** project permits setup (project data, Project Agentur, pins, overrides, waves), import, manual creation (the creation edge), wave assignment and date overrides; **no post-creation lifecycle transition**, manual or system. The project job plans nothing for a draft project (like `ta_only` in round 21, reading 3). Activation is one-way in Slice 2; type and Project Agentur are fixed once active; the type changes only while draft and **without participations or entry waves** (Slice 2 can't delete waves), so round 10's "project becomes `ta_only`" supersession can't arise yet. | 5.5 | Q98 ✔ |
| R2 | The **approver of a relaxation** (Q75 "with reason, approval and audit") is the regional operations manager, a different user from the requester, **before** it takes effect, like a profiling exception (Q80). Global scope until Slice 3 (round 18, reading 2). | 5.9 | Q99 ✔ |
| R3 | The **controlled reason codes** for a relaxation are the four proposed in 5.9; the list is the owner's to set. | 5.9 | Q100 ✔ |
| R4 | **Wave edits once in use** follow the rules in 5.6 (ordering derived from the offer and entry guards; no retroactive cutoff; no change of a signing deadline open offers depend on; a passed default TG start stays; dates clear only while unused; no deletion). | 5.6 | Q101 |
| R5 | **Individual TG dates and the new start date** follow 5.7: PL only; the participation's wave must have a `latestEntryDate` (otherwise every override fails); a new `tgStart` is never before today (Q68: no backdating), never after that `latestEntryDate`, never before an open `offerDeadline`, and can't change after TG entry; `tgEnd` may change while not terminal and never precedes the effective start. **Periods longer than twelve months are blocked** (§111 SGB III limits Transfer-KuG to twelve months; whether `tgEnd` is the end of employment or of the funded period is open). Settled before PR 2h. | 5.7 | Q102 (open) |
| R6 | **The import contract** (5.11): address as street with house number, postal code and city (no parsing of a combined column); **German addresses only until Q103 is answered** (R23); `phone` and `mobile` both selectable targets; text dates only `TT.MM.JJJJ`, plus real date cells; **numeric XLSX cells refused for identifiers** (R24); age plausibility (15–67) against the Austrittsdatum; empty cells never clear stored data; terminal participations are not updated; invalid optional contact values are dropped with a warning; Personalnummer is always required (it is the match key) and matched exactly after trimming. Settled before PRs 2f/2g. | 5.11 | Q103 (open) |
| R7 | **Saved column mappings "per customer"** are keyed by the project's customer name (trimmed, case-folded) until a customer entity exists, and store only a keyed hash of each normalised header, never header text (a file without a header row would otherwise store a person's name). | 5.11 | Q104 ✔ |
| R8 | **Retention classes of the person data** 🔒: identity (`firstName`, `lastName`, `birthDate`, `personnelNumber`, the evidence-set identity of round 13) → `participation_record`; address, phone, mobile, private and work email, `oldEmploymentEndDate` → `personnel_file` (never in the evidence set, round 13). Periods stay `unset`. | 5.10 | Q105 |
| R9 | **Project creation and project visibility until Slice 3**: staff with the flat role `project_lead` may create a project and become its PL member; project metadata (not participant data) is visible to the project's members and to global-scope org roles; nobody else. | 5.4 | Q106 ✔ |
| R10 | **Base defaults are not pinned** per project (a nationwide release changes them for every project). **Every audited operation whose result depends on them records the base-defaults version** (R26). Only Agentur templates are pinned (Q36). | 5.8 | Q107 ✔ |
| R11 | The **project snapshot** is the set of pinned template contents per Agentur plus the current override version, not a stored resolved configuration: resolution depends on each participation's placement Agentur and is deterministic from the snapshot (Slice 1 AC-35). | 5.8 | — |
| R12 | The **Project Agentur** is chosen from the Agenturen that have a template in the catalog; a project whose Agentur has none stays without a Project Agentur and therefore blocked (same outcome as Q76/Q90, fail safe). Further Agentur templates (expected placement Agenturen) may be pinned in setup; pinning on a participant's placement assignment comes with that assignment (later slice). | 5.8 | — |
| R13 | In Slice 2 an override is changed only through **Agentur-scoped settings and relaxations**. Override rule, field and help-text additions stay valid in the model and are cross-chain checked, but have no API until the admin UI (ADR-0004). | 5.9 | — |
| R14 | An Agentur-scoped setting's **confirmer is the acting staff user** recording it, and `confirmedOn` is not after today. | 5.9 | — |
| R15 | **A migration's review** (Q93) lists every Agentur-scoped setting of the migrated Agentur key by key, with the old and new template value; the PL must decide keep or remove for every key; removal writes a new override version in the same transaction. A migration that would leave the override invalid is refused with its issues. | 5.8 | — |
| R16 | The cross-chain check (round 15) validates the override against **every pinned template chain and the base-only chain** (a participation without a placement template, round 15 reading 9). | 5.9 | — |
| R17 | **The import is a domain operation** (`importParticipations`, PL, Q60 and PRD F2) that writes the import-sourced fields. It doesn't decide Q65's `undecided` cell for ordinary PL edits of confidential fields; Slice 2 has no generic person-data edit. | 5.4 | — |
| R18 | A confirmed import is **atomic**: every row or none, in one transaction under the exclusive project lock that also reloads, re-plans and compares the preview (round 22). | 5.11 | — |
| R19 | **No personal data in cursors or URLs**: the participant list pages by `(created_at, id)`, not by name or Personalnummer. | 5.12 | — |
| R20 | Removing the Slice 0 date fields from `Project` and `CreateProjectInput` is a breaking change inside `/api/v1`, accepted because no client outside this repo exists before the pilot (ADR-0010). | 5.12 | — |
| R21 | **Problem mapping** of service refusals: `not_found` 404, `forbidden` 403, `stale` 409 (`conflict`), `domain` and `integrity` 422 (`domain-error`, the code and failed guards, never a value). | 5.12 | — |
| R22 | Template content identity is the **SHA-256 of canonical JSON** (sorted keys, no insignificant whitespace), so formatting never counts as a change and any content change does. | 5.8 | — |

### Readings taken while applying round 22 (answered in [round 23](../decisions/2026-10-16-answers-round-23.md))

| # | Reading | Where | Question |
|---|---|---|---|
| R23 | **Foreign addresses — corrected in round 23:** five digits don't prove a German address. Until Q103 is answered, an import must **establish DE explicitly**, through a country column or a country constant the PL selects for the import; it is never inferred from the postal code. Rows of another country are refused (`foreign_address_unsupported`); without a country source the import can't be confirmed (`country_required`). The five-digit postal-code check applies to DE rows. | 5.11 | Q103 |
| R24 | **Numeric identifier cells:** `read-excel-file` returns a numeric cell's stored value, not its displayed text, so a format such as `00000` can't be proven preserved. A numeric XLSX cell is refused for `personnelNumber` and `addressPostalCode` (row error `identifier_cell_numeric`) and dropped with that warning for `phone` and `mobile`. Text cells and CSV values are taken as written. | 5.11 | Q103 ✔ |
| R25 | **Twelve months** means: the effective `tgEnd` is not after `addMonths(effective tgStart, 12) − 1 day` (month-end clamped, the Slice 1 helper); otherwise `period_exceeds_twelve_months`. It applies to individual dates and, because they feed every effective period, to a wave's default TG start and end. A participation without a wave can't take individual dates (`wave_required`). | 5.6, 5.7 | Q102 ✔ (conservative, pending Q102) |
| R26 | **Configuration-dependent audited operations — confirmed with this exact list (round 23):** `project_activated`, `config_template_pinned`, `config_override_changed`, `rule_relaxation_requested`, `rule_relaxation_approved`, `import_confirmed`. Rejection and withdrawal carry none unless they resolve configuration; a later operation that resolves configuration joins the list (a test keeps it). | 5.3 | Q107 ✔ |
| R27 | `config_template_version` is global reference data (no participant data), so it has **no `project_id`**: the owner chose this normalisation in round 22. Retention class `reference_data`, never touched by the retention job; the pins that use it carry `project_id`. | 5.2 | ✔ |
| R28 | **Lock keys:** `pg_advisory_xact_lock(hashtextextended('project:' || id, 0))` (exclusive) and its `_shared` form; a hash collision only serialises two projects more than needed. The template-version identity is serialised by its primary key (the insert of a new version waits for a concurrent one to commit, then compares). | 5.3 | ✔ |

### What the decisions and the Slice 1 plan already settle (not re-decided)

- Project Agentur (Q90), its blocker for both project types; step-scoped submission blockers that
  never block activation (Q91, Q92); per-key precedence base → pinned template → Agentur-scoped
  setting (Q93); temporary settings scoped to one Agentur with source, confirmer, date and audit
  (round 8).
- Relaxing only `operational_default` rules (Q75), a controlled reason-code list before overrides
  can be activated (round 14), the two cross-chain invariants and immutable versions with a
  project snapshot and a migration review (round 15).
- Waves: one or more per `ta_tg` project, none in `ta_only`; individual dates override wave
  defaults with audit; a `ta_tg` project needs a wave with `latestEntryDate` to be activated (Q77,
  Q79, round 15 reading 11).
- Creation through the status service's creation edge, PL only (Q60, Q95); database time
  authoritative (Q96); no free text in audit storage (Q66); fail-closed facts (D4).

### Open

Q98, Q99, Q100, Q104, Q106 and Q107 are confirmed (round 22), Q108 in round 25. Still open, each with its fail-safe
reading in `open-questions.md`:
- **Q101** (PL): wave edits once in use. PR 2b builds the fail-safe rules; an answer changes a table.
- **Q102** (PL, legal, BA process owner): individual dates and the twelve-month limit. **Settled
  before PR 2h.**
- **Q103** (PL): the import contract, incl. foreign addresses and numeric identifiers. **Settled
  before PRs 2f/2g**, since it may change the schema and the target catalog.
- **Q105** 🔒 (DPO): retention classes; a pre-pilot gate.

## 1. Goal

A PL can set up a project end to end and fill it with people:

```
Project setup   create → Project Agentur + pinned template snapshot → waves → overrides
                (Agentur-scoped settings, approved relaxations) → activation (blockers)
                → template version migration with review
Import (F2)     upload Excel/CSV → column mapping → validation report → duplicates →
                confirm → participations through the creation edge + person data
Participations  list and detail (access per decideAccess), manual creation, wave
                assignment, individual TG dates and the new start date (Q68)
```

**Done when** (demo): with the dev PL, create a `ta_tg` project, choose the sample Project
Agentur, add a wave, see the blockers clear, activate, import `fixtures/imports/teilnehmer-
beispiel.csv`, see the participants, re-import the updated file and see updates instead of
duplicates. The Playwright happy path does exactly this (AC-35).

## 2. Facts checked

### 2.1 Session start (2026-10-16, this session)

Cloud session, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16, branch `claude/serene-johnson-e2r1gu`
at `main` (`d42a43f`).

| Step | Result |
|---|---|
| `scripts/session-start.sh` (re-run by hand) | **OK**, exit 0 in ~6.5 s, no output: Postgres started, `pnpm install --frozen-lockfile`, `db:setup`, `db:migrate`. |
| `pnpm db:seed` | **OK** (silent). |
| `pnpm dev` (~45 s) | **OK.** Migrations, then API `:3001` (`/api/v1/health/ready` 200 `{"status":"ok"}`; log "jobs started" with both queues, cron `15 4 * * *` in `Europe/Berlin`), web `:5173` 200, portal `:5174/portal/` 200. |
| `pnpm verify` | **OK**: typecheck, lint (oxlint, oxfmt on 262 files, tsconfig guard), `test:coverage` **67 files / 1670 tests** (68 s, thresholds met), `generate` with no drift. |

Nothing failed. One cosmetic item: the web component tests print jsdom's "Not implemented:
Window's scrollTo()" 17 times (TanStack Router's scroll restoration under jsdom); harmless, but
it buries real output. A one-line stub in `apps/web/src/test-setup.ts` fixes it (PR 2a).

### 2.2 Dependencies (checked against npm on 2026-10-16; approved in round 22)

| Package | Pin | Released | Notes |
|---|---|---|---|
| `read-excel-file` | **`9.3.12`** | 2026-10-07 | MIT, maintained (releases every few weeks in 2026). `read-excel-file/node` reads a `Buffer`. Dependencies: `fflate@0.8.3`, `saxen@11.2.0`, `unzipper-esm@0.13.3` (→ `graceful-fs`, `node-int64`), `worker-f@0.1.20`; ~7.5 MB installed, no install scripts. Single maintainer (risk, section 10). |
| `csv-parse` | **`7.0.3`** | 2026-09-25 | MIT, `node-csv` by Adaltas, **no dependencies**, synchronous API (`csv-parse/sync`). |

Spike in a scratch directory (synthetic workbook made with openpyxl; nothing added to the repo):
`readXlsxFile(buffer, { parseNumber: (s) => s })` lists every sheet (hidden ones too), keeps text
cells as text (`"00123"`), returns numeric cells as their raw string (`"456"`), returns
date-formatted cells as a `Date` at UTC midnight (`1980-02-29`, `2091-12-31`), leaves text dates
(`"31.02.1975"`) as text for our strict parser, and rejects a non-zip input with
`InvalidInputError` `FILE_NOT_SUPPORTED`.

Rejected: `exceljs@4.4.0` (no release since 2023, heavy dependencies: `archiver`, `jszip`, `tmp`,
`unzipper`); `xlsx@0.18.5` on npm (stale, known prototype-pollution and ReDoS advisories; fixed
versions are published only on SheetJS's own CDN, not the registry); `@e965/xlsx` (unofficial
mirror); `papaparse@5.7.0` (fine, but `csv-parse` has no dependencies and stricter options).

No other dependency: worker threads, `TextDecoder` (`windows-1252` needs Node's full ICU, which
official Node 22/24 builds ship), SHA-256/HMAC (`node:crypto`), Hono's `bodyLimit`, Carbon's
`FileUploader` and `DataTable` are already available. Re-check the latest patch versions when PR
2g-1 is opened.

### 2.3 Other facts

- `transfer_app` has `SELECT, INSERT` on `project` (Slice 0) and `SELECT` on
  `project_entry_wave`, `participation`, `profiling_exception_request`; waves are written only by
  the base seed as owner. `record_audit_event` accepts every non-lifecycle event type.
- The status service's `createParticipation` opens its own transaction; an atomic import needs a
  variant inside an outer transaction (5.11).
- `audit_event.details` keys must match `^[a-z][A-Za-z0-9]{0,62}$` and string values
  `^[A-Za-z0-9_.:+-]{1,100}$`: step names go into details as camelCase (`agenturSubmission`), and
  no free text (wave names, project names) ever does.
- The request logger logs the route pattern, never query strings or bodies; problem bodies carry
  codes only.
- `@transfer/config/load` resolves the templates directory relative to its source and
  `loadBaseDefaults()` has no directory parameter: the image needs both (5.8).
- Projects created with the Slice 0 form **after** migration `0003` kept their dates only in the
  project columns (no W1 was made for them); dropping the columns must copy them first (AC-3).
- Kug 200b fields 3–8 take name and address as separate fields (`…_Ort`), so the address is stored
  structured (R6).
- Slice 1 integration fixtures insert projects as owner; with a `status` column defaulting to
  `draft` they must create `active` projects (PR 2e-1).

### 2.4 Spikes (first part of the PR that needs them)

| # | PR | Check | Fallback |
|---|---|---|---|
| S1 | 2g-1 | Parsing in a `worker_thread` with `resourceLimits` (old generation 256 MB) and a 15 s timeout, in `tsx` (dev), Vitest and the Vite-built `dist/` (an extra build entry); a synthetic zip bomb (small `.xlsx`, huge `sheet1.xml`, declared sizes lying) is stopped by the limit without affecting the API process. The ZIP central-directory check runs before the worker in every case. | **Never in-process XLSX parsing** (round 22): a child process (`child_process.fork` with `--max-old-space-size` and a kill timeout); if that also fails, Slice 2 ships **CSV only** and XLSX waits until isolation works. Recorded in an ADR-0003 note. |
| S2 | 2c-1 | The Vite build copies `packages/config/templates` and `packages/domain/config/base-defaults.json` into `dist/config/`, and the API loads them from there in the image (`CONFIG_DIR`). | Bundle them as JSON imports through a generated index module. |

## 3. PR series

Tests first in every PR. Generated files (Drizzle snapshots, `openapi.json`, `schema.d.ts`, the
generated docs tables, the template manifest) and binary fixtures don't count. Estimates are
hand-written production lines (SQL included, tests excluded).

| PR | Content | Est. | Depends on | Ends with |
|---|---|---|---|---|
| **2a** `feat: memberships, project status and the project form without dates` | `project_membership`; `project.status`, `project_agentur_key`, `activated_at/by`; the copy of late Slice 0 dates into W1, then dropping the three project date columns and their checks; `create_project` / `update_project` functions and grants (no `INSERT` on `project` any more); new audit event types (5.3); the project lock inside the functions: `lock_project_setup`, exclusive in every setup function, shared in `lock_participation` (before the row lock) and `create_participation` (D3), with concurrency tests; the staff subject from memberships (5.4); project routes scoped by membership; `Project`/`CreateProjectInput` without dates; the web form without dates; base seed memberships; `scrollTo` stub. | ~420 | — | projects are membership-scoped, dates live only on waves |
| **2b** `feat: entry waves` | Domain `checkWaveChange` (5.6, 100 %); `create_entry_wave` / `update_entry_wave`; wave routes; the project detail page with the wave list and form. | ~450 | 2a | a PL creates and edits waves |
| **2c-1** `feat(config): template manifest, immutability and the config in the image` | Canonical hash; generated `templates/manifest.json` (drift-checked); `scripts/check-template-immutability.mjs` in `pnpm lint` and CI; `loadBaseDefaults(dir)`, `CONFIG_DIR`; the build copies the config (S2); `GET /config/templates`; image smoke. | ~250 | 2a | versions are immutable in the repo |
| **2c-2** `feat: Project Agentur and pinned template snapshots` | `config_template_version` (content + hash, keyed by Agentur and version) and `project_template_pin` (append-only); `pin_agentur_template` with the content and hash comparison and the concurrent-pin test; choosing the Project Agentur; pinning further Agenturen; `GET /projects/{id}/config` (pins, resolution, blockers per Agentur and step, activation blockers); the setup section of the project page. | ~420 | 2c-1 | a project has a snapshot and shows its blockers |
| **2d-1** `feat(config): project overrides and Agentur-scoped settings` | `validateProjectOverride` (cross-chain, 5.9, 100 %); `project_config_override` (versioned, append-only); `write_project_override`; set/remove an Agentur-scoped setting; UI. | ~430 | 2c-2 | temporary settings with source, confirmer, audit |
| **2d-2** `feat: rule relaxations with approval` | Controlled reason codes (Q100); `config_relaxation_request`; request / decide (four eyes) / withdraw / remove; the approved relaxation enters a new override version; UI for the PL and the regional operations manager; new operation permissions. | ~420 | 2d-1 | relaxations need an approval by another user |
| **2e-1** `feat: project activation and the draft gate` | `activateProject` (domain blockers + `activate_project` re-checks); the draft gate in the status service, in `change_participation_status` and in the project job; Slice 1 fixtures create active projects; the API seed pins and activates through the services. | ~300 | 2c-2 | only active projects move |
| **2e-2** `feat(config): template version migration with review` | `migrationPreview` (pure, 100 %); migrate route and function (pin + optional override version, one transaction); review UI. | ~380 | 2d-1, 2e-1 | a pinned project migrates explicitly |
| **2f** `feat: participant person data and the import rules` | `participant_identity`, `participant_details`, `write_participant_data` (audit with changed keys computed in SQL); `retentionClass` in the field catalog and the column-to-field test; data catalog; domain `import/` (mapping, row validation, duplicate and update plan; 100 %); synthetic identities for the seeded participations. | ~480 | 2a | person data exists with its classes |
| **2g-1** `feat(api): Excel/CSV import` | Spike S1; the parse worker (`read-excel-file`, `csv-parse`, encoding and delimiter detection, limits); preview and confirm routes; the atomic confirm through the creation edge; saved mappings (`import_column_mapping`); body limits; synthetic fixtures. | ~480 | 2d-1, 2f | the API imports |
| **2g-2** `feat(web): import wizard` | Upload → sheet → mapping → report (errors, warnings, duplicates, updates) → confirm; the participant list (first version); Playwright happy path. | ~420 | 2g-1 | **demo path works** |
| **2h** `feat: participations — detail, manual creation, waves and dates` | Participant list/detail with field projection by `decideAccess`; manual creation (one row through the import rules); wave assignment route; `checkParticipationDates` (5.7, 100 %), `set_participation_dates`, the dates route and UI (new start date). | ~470 | 2g-2 | **slice done** |

**Gates** (round 22): PRs 2f and 2g wait for Q103; PR 2h waits for Q102. 2b and 2c-1 can run in
parallel after 2a; 2d-1 and 2e-1 in parallel after 2c-2. Between 2a
and 2b the web app has no way to enter contractual dates; nothing depends on them in that gap.

### Built in PR 2a, with the readings taken (for confirmation)

Built: `ProjectStatus`, `CreateProjectInput` without dates, `UpdateProjectInput`,
`checkProjectUpdate` and `mayCreateProject` (`packages/domain/src/project.ts`, now under the 100 %
threshold); the operation `editProject` (PL); the audit types `project_created` and
`project_changed` with `setupEventTypes` / `reservedEventTypes`; migrations `0010_project_setup`
(generated: `project_status`, `project_role`, the project columns, `project_membership`, the
two event types), `0011_project_setup_functions` (hand-written: the W1 copy, `project_lock_key`,
`lock_project_setup`, the shared lock in `lock_participation` and `create_participation`,
`create_project`, `update_project`, `record_audit_event` refusing the new types, the grants) and
`0012_drop_project_dates` (generated); the seed's memberships; `apps/api/src/access.ts`
(`staffSubjectOf`, project visibility); the project routes scoped by membership with `PATCH`; the
`domain-error` problem type; the web form and list without dates (with the status); the jsdom
`scrollTo` stub.

1. **Event types join with their PRs:** only `project_created` and `project_changed` now; the
   others (activation, waves, pins, …) come with the functions that write them.
2. **`project_agentur_key` exists but is set only in PR 2c-2**, together with the pin;
   `update_project` takes name, customer and type only.
3. **`create_project` re-checks the flat role in SQL** (defence in depth for Q106), and both
   functions refuse assisted mode and non-staff actors.
4. **A change to the current values is refused** (`project_unchanged`, 422, no write), like
   `wave_unchanged` in Slice 1.
5. **A project the user can't see is 404**, not 403, so its existence isn't revealed; a visible
   project the user may not edit (a consultant, an admin) is 403.
6. **The W1 copy** runs only for `ta_tg` projects with at least one Slice 0 date and no wave at
   all; a project with waves already has its dates there (migration 0003 or the seed).
7. **Seed memberships:** the seeded projects are created through `create_project` by the seeded PL
   (round 23), which makes the PL a member; the consultant and back office hold their role in all
   three projects as **direct seed fixtures**, because member management (with its own audited
   function) is Slice 3. Org roles have none.
8. **`conflict` (409)** joins the problem types with the first route that returns it.
9. **No behaviour change for lifecycle work yet:** every project is `draft`, and the draft gate
   comes with activation (PR 2e-1).

Round 23 ([review of PR 2a](../decisions/2026-10-16-answers-round-23.md)) added: the PL backfill
for existing projects with a failing check (no silent elevation); the new project's exclusive lock
first in `create_project` and the project lock first in `update_project`; the seed through
`create_project`; one `P0001` decoder (`apps/api/src/database-errors.ts`) for the status service
and the routes, with the project route allowlisting `project_unchanged`, `project_not_draft`,
`project_has_participations` and `project_has_waves` (422), mapping `project_not_found` to 404
and rethrowing everything else; strict create and update inputs, whose unknown fields are listed
one by one (`unrecognized_keys`).

### Built in PR 2b, with the readings taken (confirmed in round 24)

Split in [round 24](../decisions/2026-10-17-answers-round-24.md): **2b-1** (domain, database, API,
docs; about 600 lines, accepted as one cohesive domain → database → API unit) and **2b-2** (the
web page, its component tests and the Playwright step). All readings below are confirmed.

Built in 2b-1: `checkWaveChange`, `CreateEntryWaveInput`, `UpdateEntryWaveInput`, `EntryWaveRecord`
(`packages/domain/src/projects/waves.ts`, under the 100 % threshold); the operation
`editEntryWaves` (PL); the audit types `entry_wave_created` and `entry_wave_changed` in
`setupEventTypes`; migrations `0013_entry_waves` (generated: the two event types,
`project_entry_wave.updated_at`, three ordering `CHECK`s) and `0014_entry_wave_functions`
(hand-written: `entry_wave_text_valid`, `create_entry_wave`, `update_entry_wave`,
`record_audit_event` refusing the wave types, the grants); the seed's waves through the
functions; `GET/POST /projects/{projectId}/entry-waves` and `PATCH …/entry-waves/{waveId}`;
domain errors with a field pointer; the shared route helpers in `apps/api/src/sql.ts`,
`context.ts` (`json`) and `access.ts` (`projectAccess`). Built in 2b-2: the project page
`/projects/$projectId` (project data, wave list, one create/edit form) linked from the project
list; the Playwright project spec adds a wave.

Round 24 added: `update_entry_wave` refuses a wave of a project that isn't `ta_tg` itself
(`not_ta_tg`, with a database test), and `checkWaveChange` counts the name in code points, as
PostgreSQL's `length()` does (astral characters tested at 100/101). The hand-written migration
schema-qualifies its built-ins.

1. **R29 — a "passed" default TG start means reached** (`defaultTgStart ≤ today`): on the start
   day the contractual date has begun, even before the nightly run, so it doesn't change from that
   day on (`default_start_passed`). The cutoff keeps its own wording (`today > latestEntryDate`).
   Recorded in Q101.
2. **Ordering in the table, usage in the domain:** the three new ordering rules are table `CHECK`s
   next to the existing `start ≤ end` (structure, round 16); the twelve-month rule (pending Q102)
   and the usage rules (pending Q101) live only in `checkWaveChange`. A legacy wave that breaks
   the order fails migration 0013 instead of being changed silently (synthetic data only; fixed by
   hand, like the PL backfill of round 23).
3. **Audit details:** `entry_wave_created` carries the wave id and the dates that are set;
   `entry_wave_changed` the wave id, the changed keys (`code`, `name`, dates) and `{ from, to }`
   for each changed date. **Neither the name nor the code** enters the trail: the code is typed by
   the PL too, so it is treated like free text; the wave id identifies the wave.
4. **Usage**, read under the lock: `participations` of the wave; `openFirstOffers` = `dsv_offered`
   without an own `offerDeadline`; `reliesOnDefaultStart` = no own `tgStart`, not entered
   (`tg_entry_date` null) and not withdrawn.
5. **Codes** are compared exactly, like the unique constraint; a code may change (participations
   reference the wave id). Code and name are trimmed by the input schema; their rules
   (`invalid_code`, `invalid_name`) are `checkWaveChange`'s, so the form shows them at the field.
6. **`update_entry_wave` takes the complete new row** (typed dates, `null` clears); `PATCH`
   merges the given fields into the row read under the lock. A change to the current values is
   refused without a write (`wave_unchanged`, 422), like `project_unchanged`. The route allowlists
   `not_ta_tg` and `wave_unchanged` (422), maps `project_not_found` and `wave_not_found` to 404 and
   rethrows everything else (round 23).
7. **Access:** members and global org roles read the waves; a project the user can't see is 404;
   only its PL creates or edits (403 otherwise). As in `update_project`, the functions check the
   actor (a user, not assisted) and leave the role to the service.
8. **`today`** comes from the injected `Clock`, as in the status service whose guards the wave
   rules protect.
9. **The list** is in creation order, paged by `(created_at, id)` ascending (ADR-0010); the web
   page reads every page (a project has a handful of waves).
10. **Domain errors point at their field:** `domainProblem` takes `{ code, field }` and sets
    `pointer` to `/<field>` (or `""` for the whole wave, e.g. `not_ta_tg`), so the form shows each
    rule at its field (AC-8).
11. **AC-7's second half** ("two concurrent imports of one project serialize") is tested with the
    import confirm in PR 2g-1; it takes the same exclusive lock tested here.
12. **The seed** creates its waves through `create_entry_wave` by the seeded PL (round 23's
    standard for projects, applied to waves); a legacy W1 gets the seed's dates through
    `update_entry_wave`.
13. **Size:** about 850 non-blank, non-comment production lines together, so split (round 24).
14. **The web form sends only the changed fields** on an edit (2b-2), so the lock-scoped merge of
    item 6 can't overwrite another PL's edit of another field; the same field is still last write
    wins until optimistic versioning comes (round 24).

### Built in PR 2c-1, with the readings taken (for confirmation)

Round 25 ([review of PR 2c-1](../decisions/2026-10-17-answers-round-25.md)) added: the manifest
schema requires strictly ordered entries, startup refuses duplicates and reordering (item 3); the
cursor wording (item 8); Q108 confirmed (item 7).

Built: `canonicalJson` and `canonicalHash` (`packages/config/src/hash.ts`, under the 100 %
threshold, R22); the `TemplateManifest` schema and `compareTemplateVersions`
(`manifest.ts`); `buildManifest`, `renderManifest`, `loadManifest`, `configDirs` and
`loadBaseDefaults(dir)` in `@transfer/config/load`; `pnpm generate` writes
`packages/config/templates/manifest.json`, and `verify` and CI's drift step check it;
`scripts/check-template-immutability.mjs` in `pnpm lint` (tested against a scratch git
repository); the API build copies the templates and the base defaults to `dist/config/`;
`CONFIG_DIR`; `GET /api/v1/config/templates`; the image smoke test calls it (AC-12); ADR-0004,
`regional-variation.md`, `.env.example`, the Dockerfile and CLAUDE.md's commands.

**Spike S2 passed** (no fallback): the Vite build copies the files with a `writeBundle` step like
the migrations; the bundle, copied outside the repo in the image's layout with `CONFIG_DIR` set,
served the catalog, and without `CONFIG_DIR` it refused to start. The image itself is built and
smoke-tested by CI's `image` job (the cloud session's Docker daemon isn't running).

1. **What is hashed:** the whole file as parsed JSON, `$schema` included, so a changed `$schema`
   path also counts as a changed version. `loadTemplate` returns the same object (no defaults or
   transforms), so the manifest hash equals the hash of the content PR 2c-2 stores (tested).
2. **Canonical form:** object keys sorted by UTF-16 code units at every level (the key order of
   RFC 8785), arrays in order, strings and numbers as `JSON.stringify` writes them, no whitespace;
   anything that isn't JSON (undefined, `NaN`, a class instance, an array hole) is refused. It
   doesn't claim full RFC 8785 conformance; it only has to be stable for our files.
3. **The manifest** lists per version `agenturKey`, `version`, `label` (`de`, optional `en`),
   `sample` (`false` when the template doesn't say) and the full `sha256`, ordered by key, then
   version. Generation validates every file through `loadTemplate`; a file in a key directory
   that isn't `<version>.json` fails `pnpm generate`. The API validates the manifest with a
   strict schema when it loads it, which also requires the entries to be strictly increasing by
   `compareTemplateVersions` (no duplicate `(agenturKey, version)`, no reordering;
   `manifest_not_strictly_ordered`), because pagination relies on that order (round 25).
4. **The immutability base ref:** CI's lint job checks out the full history and passes
   `TEMPLATE_BASE_REF` (the PR's base SHA, or `github.event.before` on `main`); the script also
   takes the ref as its argument. Under CI (`CI` set) a missing base ref fails; a ref that isn't a
   commit fails everywhere. A renamed version counts as deleted. `manifest.json` isn't checked by
   it (generated and drift-checked).
5. **`CONFIG_DIR`** is one directory holding `templates/` (with the manifest) and
   `base-defaults.json`, the layout of `dist/config/`; a relative path is resolved against the
   working directory; unset means the repo paths. The bundle has no working default (its
   repo-relative URLs point outside `dist/`), so the image (`ENV`), `pnpm start`
   (`CONFIG_DIR=dist/config`) and Playwright set it; e2e therefore runs on the copied files too.
6. **The catalog is read once when the API starts**, not per request: it is part of the release,
   and a missing or invalid catalog fails the start (and the smoke test), never a request.
7. **Access (Q108, confirmed in round 25):** the flat role `project_lead`, anyone holding the
   `project_lead` membership in any project and the global org roles read the catalog;
   consultants and back office without a PL membership get 403; without a session 401.
8. **Pagination** as for every list (ADR-0010): keyset on `(agenturKey, version)` with an opaque
   cursor; strict query (an unknown parameter is `unrecognized_keys`, a malformed or
   schema-invalid cursor `invalid_cursor`). The cursor is opaque but not authenticated: a caller
   can build a schema-valid one, which is harmless for this read-only catalog, so it isn't signed
   (round 25).
9. **No "latest" flag** in the catalog: the latest version of a key is its highest `version`,
   derived where it is used (PR 2c-2, R12).
10. **The smoke test's PL** is a synthetic staff user the script inserts as the owner and deletes
    on exit: staff users have no audited write function before Slice 3, and the smoke database
    isn't seeded.
11. **Nothing loads the base defaults in the API yet**; `loadBaseDefaults(dir)` with
    `configDirs(env.configDir).baseDefaults` is what PRs 2c-2 and 2e-1 call.
12. **Size:** about 270 non-blank, non-comment production lines (scripts, CI and build changes
    included; tests and generated files excluded).

## 4. Design overview

```
packages/domain/src/
  projects/        ProjectStatus, project setup schemas, checkWaveChange, activation (extends
                   lifecycle/activation.ts), checkParticipationDates
  import/          mapping targets, cell normalisation, row validation, duplicate/update plan
  fields/catalog   + retentionClass per stored field
  access/          + operations: editProject, activateProject, editEntryWaves, pinTemplate,
                   migrateTemplate, changeOverride, requestRelaxation, decideRelaxation,
                   withdrawRelaxation, importParticipations, setParticipationDates
  audit/           + event types and their details schemas
packages/config/src/
  hash.ts          canonical JSON + SHA-256
  override.ts      validateProjectOverride (cross-chain), relaxation reason codes
  migration.ts     migrationPreview
  load.ts          + directory parameters; manifest
packages/db/       membership, pins, overrides, relaxation requests, person data, mappings,
                   the new functions and grants
apps/api/src/
  projects/        project, wave, config, activation and migration routes + services
  imports/         parse worker, preview/confirm service, routes
  participations/  list/detail/manual creation/wave/dates routes; subject from memberships
apps/web/src/      project detail (setup, waves, configuration, import, participants),
                   participation detail
fixtures/imports/  synthetic sample files
```

`packages/domain` and `packages/config` stay free of I/O and system time (`today` comes from the
`Clock`); the existing source scan covers the new folders.

## 5. Design

### 5.1 Vocabulary

| Enum | Values |
|---|---|
| `ProjectStatus` | `draft`, `active` (R1; closing a project is later) |
| `RelaxationReasonCode` (Q100, proposal) | see 5.9 |
| `RelaxationRequestStatus` | `requested`, `approved`, `rejected`, `withdrawn` |
| `ImportTarget` | `personnelNumber`, `lastName`, `firstName`, `birthDate`, `oldEmploymentEndDate`, `addressStreet`, `addressPostalCode`, `addressCity`, `phone`, `mobile`, `privateEmail`, `workEmail` |
| `ImportRowOutcome` | `create`, `update`, `unchanged`, `skip`, `error` |
| `ImportIssueCode` | errors: `required_missing`, `invalid_date`, `date_has_time`, `birth_date_in_future`, `end_before_birth`, `too_long`, `control_characters`, `duplicate_in_file`, `identifier_cell_numeric`, `postal_code_invalid`, `foreign_address_unsupported`, `country_required`; warnings: `age_implausible`, `value_invalid_dropped`, `possible_duplicate`, `terminal_not_updated`, `kept_existing` |

### 5.2 Data model

| Table | Columns (main) | `retentionClass` | `dataClass` | Participant data |
|---|---|---|---|---|
| `project` (changed) | − `signing_deadline`, `default_tg_start`, `default_tg_end` and their checks; + `status project_status not null default 'draft'`, `project_agentur_key text null` (Agentur key pattern), `activated_at timestamptz null`, `activated_by uuid null` FK `staff_user`; `CHECK` activated ⇔ both set | `project_master` | `internal` | no |
| `project_membership` (new) | `project_id` FK, `staff_user_id` FK, `role project_role`, `created_at`; pk `(project_id, staff_user_id, role)` | `project_master` | `internal` | no |
| `config_template_version` (new, append-only, global) | pk `(agentur_key, version)`, `content jsonb`, `content_sha256 text` (`^[0-9a-f]{64}$`), `registered_at` (database time); no `project_id` (R27) | `reference_data` | `internal` | no |
| `project_template_pin` (new, append-only) | `id`, `seq` identity, `project_id` FK, FK `(agentur_key, version)` → `config_template_version`, `pinned_by` FK, `pinned_at` (database time); current pin per Agentur = highest `seq` | `project_master` | `internal` | no |
| `project_config_override` (new, append-only) | `project_id` FK, `version int` (pk with project), `content jsonb` (a `ProjectOverride` layer), `created_by` FK, `created_at` | `project_master` | `internal` | no |
| `config_relaxation_request` (new) | `id`, `project_id` FK, `rule_id`, `reason_code`, `status`, `requested_by`, `requested_on`, `requested_at`, `decided_by`, `decided_on`, `decided_at`; four-eyes and decision `CHECK`s like `profiling_exception_request`; one open (`requested`) request per project and rule | `project_master` | `internal` | no |
| `participant_identity` (new) | `participation_id` pk, `project_id` FK; composite FK `(participation_id, project_id)` → `participation`; `personnel_number`, `last_name`, `first_name` (text, not null), `birth_date date null`, `created_at`, `updated_at`; unique `(project_id, personnel_number)` | `participation_record` (R8) | `confidential` | yes |
| `participant_details` (new) | same keys; `address_street`, `address_postal_code`, `address_city`, `phone`, `mobile`, `private_email`, `work_email` (text null), `old_employment_end_date date null`, `created_at`, `updated_at` | `personnel_file` (new class in the data catalog, `unset`; R8) | `confidential` | yes |
| `import_column_mapping` (new) | `project_id` FK, `header_hmac text`, `target import_target`, `updated_by`, `updated_at`; pk `(project_id, header_hmac)`; the customer comes from the project | `project_master` | `internal` | no |

- Every new table has a data-catalog entry and, except the global `config_template_version`
  (R27), a `project_id` FK; the catalog test enforces both.
- `participant_identity` and `participant_details` are written only by `write_participant_data`;
  their rows are never deleted by the app (deletion is the retention job's, Slice 7).
- Template versions, pins and override versions are never updated or deleted (no grant, and a trigger refuses
  `UPDATE`/`DELETE` even for the owner, so immutability is testable).
- `project_entry_wave` is unchanged in shape; it gains `updated_at` and is written only by its
  functions.
- `participation` is unchanged: `tg_start`/`tg_end` exist since Slice 1; the placement Agentur
  comes with the slice that assigns it (R12).

**Field catalog → columns (D8, R8).** `FieldEntry` gains `retentionClass?:
ParticipantRetentionClass`, set for every field a table stores. A test maps each person-data
column to its field key (`address_*` → `address`) and requires: the field exists; its
`storage` is `column` (no special/highly confidential field without encryption); the table's
catalog `dataClass` is the field's class; the table's `retentionClass` equals the field's. So a
table can only hold fields of one retention class, which is how "per data item" (ADR-0008) is
enforced at table level.

### 5.3 Functions, audit and grants (D2, D3)

All `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, schema-qualified, no
dynamic SQL, `EXECUTE` only for `transfer_app`, refusals as `P0001` with a stable code (Slice 1
pattern). The service checks permissions and domain rules first; the functions check structure.

**Locks (D3, round 22).** Every function in this table that mutates setup state acquires the
exclusive project lock itself as its first statement; `lock_participation` and
`create_participation` acquire the shared project lock before touching a row. Order: project →
template version → participation row, everywhere. Integration tests prove that a setup function
waits for a concurrent status change of the project and vice versa, and that a transaction holding
the exclusive lock can still create and lock participations (re-entrant).

| Function | Does | Audit event (new type unless noted) |
|---|---|---|
| `lock_project_setup(project_id)` | `pg_advisory_xact_lock` on the project (R28); also called by every setup function below | — |
| `lock_participation` (replaced) | `pg_advisory_xact_lock_shared` on its project, then the row lock | — |
| `create_participation` (replaced) | + the shared project lock first | (unchanged) |
| `create_project(name, customer, type, context)` | project + creator's `project_lead` membership | `project_created` |
| `update_project(id, name?, customer?, type?, agentur_key?, context)` | type only while draft without participations or waves; Agentur key only while draft | `project_changed` (changed keys) |
| `activate_project(id, base_defaults_version, context)` | draft → active; re-checks: Project Agentur pinned; `ta_tg` has a wave with `latest_entry_date` | `project_activated` |
| `create_entry_wave` / `update_entry_wave(… typed dates …, context)` | `ta_tg` only, ordering `CHECK`s, `updated_at` | `entry_wave_created` / `entry_wave_changed` (changed keys, old/new dates) |
| `set_participation_dates(id, tg_start, tg_end, expected_version, context)` | compare-and-set on `status_version`, bumps it | `participation_dates_changed` (old/new dates) |
| `pin_agentur_template(project, key, version, content, sha256, context)` | project lock; `INSERT … ON CONFLICT DO NOTHING` into `config_template_version`, then refuses `template_version_changed` unless the stored content **equals the supplied `jsonb`** and the stored hash equals the supplied hash; appends the pin | `config_template_pinned` (key, version, previous version, base-defaults version) |
| `write_project_override(project, expected_version, content, change, context)` | next version or `override_version_stale` | `config_override_changed` (exists; version, change kind, Agentur key or rule id) |
| `request_rule_relaxation` / `decide_rule_relaxation` / `withdraw_rule_relaxation` | four eyes in SQL (decider ≠ requester) | `rule_relaxation_requested` / `…_approved` / `…_rejected` / `…_withdrawn` |
| `write_participant_data(participation, typed columns…, context)` | upsert both rows; a `null` argument keeps the stored value (nothing in Slice 2 clears one); on update computes the changed keys with `IS DISTINCT FROM` | `participant_data_changed` (keys only, never values) |

- `record_audit_event` additionally refuses these types (they are written only by their
  functions), like the lifecycle types; it stays the path for `import_confirmed` (project-level
  counts) and `warning_confirmed` (Slice 1 type; per participation, warning codes).
- Creation of participations stays `create_participation` (Slice 1); the import correlates its
  events by `request_id`.
- Grants: `transfer_app` loses `INSERT` on `project`; gets `SELECT` on the new tables and
  `SELECT, INSERT, UPDATE` on `import_column_mapping`; `EXECUTE` on the new functions. Tested like
  Slice 1 AC-15.
- `audit_event` stays without an app `SELECT`: Slice 2 shows no history UI.
- **Base-defaults version (R26, round 23):** exactly `project_activated`,
  `config_template_pinned`, `config_override_changed`, `rule_relaxation_requested`,
  `rule_relaxation_approved` and `import_confirmed` carry `baseDefaultsVersion` in their details; the functions require the parameter, and an audit-model
  test keeps the list of configuration-dependent event types.

### 5.4 Access (R9, R17)

**Subject.** `staffSubjectFor(staffUser, db)` builds the Slice 1 `Subject`: project roles from
`project_membership`; org roles from the flat `StaffRole` (`admin`, `regional_admin`,
`regional_operations_manager`, each with global scope because projects have no region before
Slice 3, round 18 reading 2); no participant assignments yet (consultants get no person-level
data, Q62). Every new route builds it and calls `decideAccess` / `mayPerformOperation`; the dev
stub stays the only login (ADR-0007).

**New operations** (`mayPerformOperation`, generated transitions table updated):

| Operation | Who |
|---|---|
| `createProject` (no project yet) | flat role `project_lead` (R9) |
| `editProject`, `activateProject`, `editEntryWaves`, `pinTemplate`, `migrateTemplate`, `changeOverride` (Agentur-scoped settings, removing a relaxation), `requestRelaxation`, `withdrawRelaxation`, `importParticipations`, `setParticipationDates` | PL of the project |
| `decideRelaxation` | regional operations manager in scope, never the requester (R2) |

**Reads.** Project metadata, waves and configuration: members of the project and global org
roles (R9). Participant data: `decideAccess` per field (`read`, `list`) with the participation as
the person resource; list payloads contain only fields that are `listable` and allowed for
`list`. Admins, regional admins and the regional operations manager get no participant data
(Slice 1 matrix).

### 5.5 Project setup and activation (R1, Q98)

- **Create:** name, customer, type (no dates). The creator becomes PL.
- **Edit:** name and customer any time; type while draft without participations and without
  waves (a draft `ta_tg` project with waves can't become `ta_only`, round 22); Project Agentur while
  draft.
- **Activation** (`POST /projects/{id}/activation`): under `lock_project_setup`, resolve the
  project level from the snapshot (`resolveForProject`), load the waves, call
  `projectActivationBlockers` (Slice 1). Any blocker → 422 with the codes. Otherwise
  `activate_project`. Agentur-submission blockers never block (Q91, Q92); they are returned as
  warnings with their Agentur and step (round 15 reading 10).
- **Draft gate:** the status service refuses every post-creation transition on a draft project
  (`project_not_active`, `domain`); `change_participation_status` refuses it too (defence in
  depth); the project job plans nothing for a draft project. Creation, wave assignment, person
  data and date overrides are allowed in draft.
- **Seed:** the API seed pins `beispielstadt-nord@1` for Werk Nord (plus `beispielstadt-sued@1`
  as a placement Agentur) and `beispielstadt-sued@1` for the `ta_only` project, then activates
  both through the services before it creates participations; Lager Süd stays a draft with
  blockers (demo).

### 5.6 Entry waves (R4, Q101)

`checkWaveChange({ before | null, after, usage, today, projectType })` → `ok` or every issue
code. `usage` (loaded under the project lock): number of participations of the wave, how many
have an open first offer (`dsv_offered` without their own `offerDeadline`), whether any
participation of the wave relies on the default TG start (no own `tgStart`, not entered).

| Rule | Code |
|---|---|
| only `ta_tg` projects have waves | `not_ta_tg` |
| code `^[A-Za-z0-9_-]{1,20}$`, unique per project; name 1–100 characters, no control characters (it is UI text: no personal data, a hint in the form) | `invalid_code`, `code_taken`, `invalid_name` |
| `signingDeadline ≤ defaultTgStart`, `signingDeadline ≤ latestEntryDate` (the offer guard needs both, Q69) | `signing_after_start`, `signing_after_latest_entry` |
| `defaultTgStart ≤ latestEntryDate` (an entry after the last possible entry can't happen) and `defaultTgStart ≤ defaultTgEnd` (existing check) | `start_after_latest_entry`, `end_before_start` |
| the default period is at most twelve months (R25, Q102) | `period_exceeds_twelve_months` |
| no retroactive cutoff: a new or changed `latestEntryDate` is not before today; once the cutoff has passed (`today > latestEntryDate`) it doesn't change | `latest_entry_in_past`, `cutoff_passed` |
| `signingDeadline` doesn't change while first offers of the wave are open | `signing_deadline_in_use` |
| a `defaultTgStart` that has passed doesn't change (individual new start dates instead, 5.7); a new one is not before today while participations rely on it | `default_start_passed`, `default_start_in_past` |
| a set date is cleared only while the wave has no participation, and never the last `latestEntryDate` of an active project | `date_in_use`, `last_latest_entry_date` |
| no deletion in Slice 2 | — |

Dates are inclusive. Impossible combinations are errors (ADR-0009 style); nothing here is a
confirmable warning. The UI shows the wave list (code, name, four dates, number of
participations) and one form for create and edit.

### 5.7 Individual TG dates and the new start date (R5, Q102)

`checkParticipationDates({ current, wave, change, today, projectType })`:

| Rule | Code |
|---|---|
| `ta_tg` only | `not_ta_tg` |
| the participation has a wave with a `latestEntryDate` (round 22) | `wave_required`, `latest_entry_date_missing` |
| no change on a terminal participation | `participation_closed` |
| `tgStart` doesn't change after TG entry (`active_in_tg`: the entry date is recorded) | `entered` |
| a new `tgStart` is not before today (Q68: never backdated) | `start_in_past` |
| … not after the wave's `latestEntryDate` | `start_after_latest_entry` |
| … not before an open `offerDeadline` (existing table check, as a domain error) | `start_before_offer_deadline` |
| effective `tgEnd` is not before the effective `tgStart` | `end_before_start` |
| the effective period is at most twelve months (R25; blocked until Q102 says what `tgEnd` means) | `period_exceeds_twelve_months` |
| setting a date to `null` returns to the wave default and must satisfy the same rules | — |

- **New start date (Q68 case 3):** an `informed` participation flagged `tg_start_missed` gets a
  new `tgStart ≥ today`; the flag clears and the next due run may enter it with valid facts. A new
  start equal to today after today's run has completed can only be entered by reconciliation
  (Slice 7, D10), which the UI says.
- Through the status service (participation lock, project lock shared), then
  `set_participation_dates`; audit with old and new dates.

### 5.8 Templates: catalog, snapshots, immutability, migration (D5, R10–R12, R15, R22)

- **Catalog:** `pnpm generate` writes `packages/config/templates/manifest.json`: for every
  `templates/<key>/<version>.json` the key, version, labels, `sample` and the canonical SHA-256.
  A test checks it against the files; `verify` checks drift.
- **Immutability in the repo:** `scripts/check-template-immutability.mjs <base-ref>` (in `pnpm
  lint`; CI passes the PR's base, or the previous commit on `main`): every template version present
  at the base must exist unchanged (canonical hash). Adding versions passes; changing or deleting
  one fails. Without a base ref locally it prints a notice and passes; CI never omits it.
- **Snapshot:** pinning reads the file through `loadTemplate` (validated), computes the hash and
  calls `pin_agentur_template`. The first pin of a version anywhere registers it in
  `config_template_version`; every later pin, of any project, must match the stored content
  (`jsonb` equality) and hash, or is refused (`template_version_changed`); two concurrent
  conflicting first pins serialise on the primary key, so exactly one succeeds (AC-10). From then
  on resolution reads only the stored content (validated again, cached per `(key, version,
  hash)`); a later change of the file can't change a pinned project (AC-11).
- **Base defaults** are read from the release, not pinned (R10); their `version` goes into the
  details of every configuration-dependent audit event (R26).
- **Project Agentur (R12):** chosen from the catalog; setting it pins that Agentur's latest
  version (the PL may choose an older one). Further Agentur templates may be pinned the same way.
- **Migration (Q36, Q93, R15):** `migrationPreview(currentPin, target, override, base, otherPins)`
  → the settings that change (key, old, new), the rules added and removed (ids, steps, bases), the
  fields added, the override issues the new version would cause (cross-chain, 5.9), and for every
  Agentur-scoped setting of that key: the key, its value, the old and the new template value. The
  confirm carries the target version, the expected override version and `keep`/`remove` for every
  listed key (missing or extra keys → `review_incomplete`). One transaction under the project
  lock: an override version without the removed keys (if any), the new pin, audit
  (`config_template_pinned` with `previousVersion`, `config_override_changed` with the kept and
  removed keys). Completeness is derived, so it is recomputed automatically; generated documents
  don't exist yet.
- **Image (S2):** the API build copies the templates and the base defaults to `dist/config/`;
  `CONFIG_DIR` (default: the repo paths) tells `load.ts` where they are; the image smoke test
  calls `GET /api/v1/config/templates`.

### 5.9 Overrides, Agentur-scoped settings and relaxations (R2, R3, R13, R14, R16)

- **Storage:** every change writes a new `project_config_override` version (optimistic
  concurrency on the version, `override_version_stale` → 409). The current version is the
  highest. An empty override is version 0 (no row).
- **`validateProjectOverride({ base, pins, override })`** (`packages/config/src/override.ts`,
  100 %): `parseLayer`; then `resolveForParticipation` and `resolveForProject` for **every pinned
  Agentur chain and the base-only chain** (round 15, R16): any `ConfigError` fails with its layer
  and issues; then each relaxation must match a rule in at least one chain
  (`relaxation_unmatched`: a typo never becomes a silent global no-op) and every reason code must
  be on the controlled list (`reason_code_unknown`). Run on every override write, pin and
  migration; an invalid result is refused, never stored.
- **Agentur-scoped settings** (round 8, Q93): set or remove per Agentur key with the settings,
  `source` (the four Slice 1 codes), `confirmedBy` = the acting user and `confirmedOn ≤ today`
  (R14). Allowed for any valid Agentur key (also without a template: the fallback case). Audit
  names the Agentur key, the setting keys and the source, never free text.
- **Relaxations** (Q75, round 14, R2, R3):
  1. the PL requests one for a rule id with a reason code;
  2. the request is checked against the current snapshot: the rule exists in a chain and is
     `operational_default` (`relaxation_locked` otherwise);
  3. a regional operations manager (not the requester) approves or rejects; on approval, in the
     same transaction, a new override version adds `{ ruleId, reasonCode, approvedBy, approvedOn }`
     (`validateProjectOverride` again);
  4. the PL may withdraw a pending request, and may remove an approved relaxation (tightening
     needs no approval; new override version).
- **Proposed reason codes (Q100):** `source_data_not_provided` (the customer's data doesn't
  contain the item), `not_needed_for_project_measures` (the project's measures don't use it),
  `collected_outside_platform` (kept in another file under the project contract),
  `agentur_confirmed_not_required` (the Agentur confirmed in writing; for template
  `operational_default` rules). Codes reveal nothing about a person: relaxations are project-wide.

### 5.10 Person data (D8, R8)

- **Tables** in 5.2; one row each per participation, both optional (a participation created
  before Slice 2 has none: the seed adds synthetic identities).
- **Classification:** every stored field is `confidential` (field catalog: `firstName`,
  `lastName`, `personnelNumber`, `birthDate`, `oldEmploymentEndDate`, `workEmail`, `address`,
  `phone`, `mobile`, `privateEmail`), category `confidential`, `listable` true. So **no encrypted
  storage is needed** for Slice 2. Special-category and highly confidential fields can't be
  stored until encrypted columns and their separate logged endpoints exist (rule 9, ADR-0010);
  the column-to-field test fails for any such column, and the import has no such target, so an
  HR file's Steuer-ID, IBAN, RV-Nummer, GdB or nationality columns are discarded unread (never
  kept in memory beyond parsing, never stored, never echoed in the preview).
- **Access** by category (Slice 1 matrix): PL and back office read; assigned consultants only
  (none before Slice 3); participants not before Slice 3; customer-visible fields stay a reporting
  matter (Slice 9).
- **Writes** only through `write_participant_data` (D2), called by the import and the manual
  creation (R17).

### 5.11 Import (F2; D6, R6, R7, R18, Q103)

**Flow**

```
POST /projects/{id}/imports/preview   { file (base64), fileName?, sheet?, csv: { delimiter?,
                                        encoding? }?, mapping?, waveId? }
  → { sheets, headers, suggestedMapping, missingTargets, report, counts, previewToken }
POST /projects/{id}/imports           { same input, mapping, decisions: { confirmWarnings,
                                        possibleDuplicates: { [row]: "create" | "skip" } },
                                        previewToken }
  → { created, updated, unchanged, skipped }
```

- **Parsing** (`apps/api/src/imports/parse*.ts`, before the transaction): first the ZIP
  central-directory check for `.xlsx` (declared expanded total ≤ 50 MB, ratio ≤ 100 per entry,
  `file_too_complex` otherwise), always; then the worker (S1; never in-process for XLSX). `.xlsx`
  (zip signature) or
  `.csv`/text; anything else → `unsupported_file`. Limits: 5 MB file, 5,000 data rows, 50
  columns, 500 characters per cell. The first row is the header row. CSV: strict UTF-8 (a BOM is
  dropped), otherwise Windows-1252 (the preview names the encoding so the PL can check umlauts);
  delimiter `;`, `,` or tab detected from the header row, overridable. XLSX: the chosen sheet
  (default the first); text cells as text, numeric cells marked as numeric with their stored value
  (R24), date cells as ISO dates (UTC components; a time other than 00:00 → `date_has_time`);
  formulas as their cached values. The worker returns only `string | { number } | { date }`
  cells.
- **Mapping:** one column per target, a target at most once; `personnelNumber`, `lastName`,
  `firstName` always required (the match key and the minimal identity, R6); `birthDate`,
  `oldEmploymentEndDate` and the address targets required unless the matching `base-import-*`
  rule is relaxed by an approved relaxation of the project (the resolution's `relaxed` list);
  unmapped columns are dropped. Suggestions: the project's saved mappings, then those of other
  projects with the same customer name (trimmed, case-folded), then built-in header synonyms (`Personalnummer`, `Pers.-Nr.`,
  `Nachname`, `Name`, `Vorname`, `Geburtsdatum`, `Geb.-Datum`, `Austrittsdatum`, `Straße`, `PLZ`,
  `Ort`, `Telefon`, `Mobil`, `E-Mail privat`, `E-Mail dienstlich`, …). Saved on confirm as
  `HMAC-SHA256(key, normalised header)` with a key derived from `SESSION_SECRET` (HKDF, info
  `import-header-mapping:v1`); losing the key only loses suggestions (R7).
- **Row validation** (`packages/domain/src/import`, pure, 100 %; `today` from the Clock):
  - text: trimmed, no control characters, names ≤ 100, Personalnummer ≤ 50, address parts ≤ 200;
  - dates: real date cells, or text `TT.MM.JJJJ` only, strictly (`31.02.2027`, `03.14.1998`,
    `29.02.2027` are errors; `29.02.2028` is valid); `birthDate` not after today
    (`birth_date_in_future`); `oldEmploymentEndDate` not before `birthDate`
    (`end_before_birth`); age at the Austrittsdatum outside 15–67 → warning `age_implausible`;
  - identifiers (R24): a numeric XLSX cell in `personnelNumber` or `addressPostalCode` →
    `identifier_cell_numeric` (error); in `phone` or `mobile` → dropped with that warning;
  - address (R23, round 23): the country comes from a mapped country column or a constant the
    PL selects, never from the postal code; a row of another country is refused
    (`foreign_address_unsupported`) and an import without a country source can't be confirmed
    (`country_required`); a DE postal code is exactly five digits (`postal_code_invalid`);
  - optional contact values: an invalid email (Zod's email check) or phone (digits, spaces, `+`,
    `/`, `-`, `(`, `)`, 6–30 characters) is dropped with `value_invalid_dropped`;
  - issues carry the row number (as in the file, header = row 1), the target and the code,
    **never the value**.
- **Plan** (pure): per row `create`, `update` (with the changed targets), `unchanged`, `skip` or
  `error`:
  - the same Personalnummer twice in the file → `duplicate_in_file` on both rows;
  - matched by Personalnummer (exact after trim) in the project → `update`/`unchanged`; an empty
    cell never clears a stored value (`kept_existing`); a terminal participation is not updated
    (`terminal_not_updated`, outcome `skip`);
  - no match, but the same last name, first name (case-folded) and birth date as another row or
    an existing participation → `possible_duplicate`, and the PL decides `create` or `skip`;
  - participations of the project missing from the file are counted, never changed.
- **Preview** returns the report (counts, rows with outcome, issues, and for updates the targets
  with old and new value: the PL may read both) and a `previewToken` = HMAC over (project, file
  hash, sheet, CSV options, mapping, wave, the plan's digest). **Nothing is written.**
- **Confirm** (round 22: no TOCTOU window): parse the file again **before** the transaction; then
  **one transaction** (R18) that first takes the exclusive project lock (`lock_project_setup`)
  and then, under it: reloads the project, pins, override and base defaults (the resolution and
  its `relaxed` list), the existing participations and person data; re-plans; compares the plan's
  digest with the preview token (different → 409 `import_preview_stale`, nothing written);
  validates the decisions against this plan (every `possible_duplicate` row decided, no decision
  for another row, warnings confirmed if any → `decisions_invalid` otherwise); then writes: for
  every `create`, the status service's
  creation inside the transaction (`createParticipationIn(tx, …)`, PL, optional wave) and
  `write_participant_data`; for every `update`, `write_participant_data`; per participation with
  confirmed warnings `warning_confirmed` (codes); `import_confirmed` with the counts and the
  base-defaults version (R26); the mapping
  saved. Any failure rolls everything back. Correlation: the request id on every event.
- **Manual creation** (`POST /projects/{id}/participations`): one row object through the same
  validation and plan.
- **Logs** carry the project id, counts and duration; never file names, headers or values. The
  base64 body never reaches a log or an error.
- **Body limits:** 8 MB on the two import routes, 100 kB elsewhere (Hono `bodyLimit`, 413
  `payload-too-large`).

### 5.12 API (ADR-0010; R19–R21)

All under `/api/v1`, `@hono/zod-openapi`, RFC 9457, cursor pagination for lists.

| Route | PR |
|---|---|
| `GET /projects`, `POST /projects`, `GET /projects/{projectId}`, `PATCH /projects/{projectId}` | 2a |
| `GET/POST /projects/{projectId}/entry-waves`, `PATCH /projects/{projectId}/entry-waves/{waveId}` | 2b |
| `GET /config/templates` | 2c-1 |
| `GET /projects/{projectId}/config`, `POST /projects/{projectId}/config/pins` | 2c-2 |
| `PUT/DELETE /projects/{projectId}/config/agentur-settings/{agenturKey}` | 2d-1 |
| `POST /projects/{projectId}/config/relaxations`, `POST /config/relaxations/{requestId}/decision`, `POST /config/relaxations/{requestId}/withdrawal`, `DELETE /projects/{projectId}/config/relaxations/{ruleId}` | 2d-2 |
| `POST /projects/{projectId}/activation` | 2e-1 |
| `POST /projects/{projectId}/config/pins/{agenturKey}/migration-preview`, `…/migration` | 2e-2 |
| `POST /projects/{projectId}/imports/preview`, `POST /projects/{projectId}/imports` | 2g-1 |
| `GET/POST /projects/{projectId}/participations`, `GET /participations/{participationId}`, `PUT /participations/{participationId}/entry-wave`, `PUT /participations/{participationId}/dates` | 2g-2, 2h |

- New problem types: `conflict` (409), `domain-error` (422, `errors[].code`, plus `failedGuards`
  where a guard failed), `payload-too-large` (413). Service refusals map per R21.
- Lists page by `(created_at, id)` (R19). Participant list items: id, statuses, wave id,
  Personalnummer, last and first name (only fields allowed for `list`).
- `GET /projects/{projectId}/config` returns pins (key, version, hash prefix, pinned at/by),
  the current override (version, Agentur-scoped settings, relaxations), open relaxation requests,
  the project-level blockers, per pinned Agentur the participant-level blockers and warnings, and
  the activation blockers.

### 5.13 Web (`apps/web`, German only)

- `/projects/new`: name, customer, type.
- `/projects/$projectId`: tabs **Einrichtung** (status, Project Agentur, pinned templates,
  blockers with Agentur and step, activation, migration with review), **Eintrittswellen**,
  **Konfiguration** (Agentur-scoped settings, relaxations; approve/reject for the regional
  operations manager), **Import**, **Teilnehmende**.
- `/projects/$projectId/participations/$participationId`: identity, contact, wave, dates (new
  start date), statuses.
- Import wizard: upload (Carbon `FileUploader`, `.xlsx`/`.csv`), sheet, mapping table, report
  (filter: errors, warnings, duplicates, updates), decisions, confirm. Error codes map to i18n
  messages; nothing renders a value the API didn't return.
- UI copy at free-text fields (wave name) says not to enter personal data.

### 5.14 Fixtures and seed (synthetic only)

- `fixtures/imports/`: `teilnehmer-beispiel.csv` (UTF-8, `;`, 12 rows), `teilnehmer-beispiel.xlsx`
  (the same content; a test asserts equality), `teilnehmer-aktualisiert.csv` (the re-import:
  changed address, one new person, one missing), `teilnehmer-fehler.csv` (every error and
  warning code, including `31.02.1975` and `03.14.1998`), `teilnehmer-cp1252.csv`, and a README
  stating they are synthetic. Names are German placeholder names (`Mustermann`, `Musterfrau`,
  `Beispiel`, `Normalverbraucher`, …), Personalnummern `BSP-0001…`, addresses `Musterstraße` in
  `99999 Beispielstadt`, emails at `example.org`, phone numbers from the ranges the
  Bundesnetzagentur reserves for fiction (checked in the PR). The zip-bomb fixture is generated
  in the test, not committed.
- Seed: memberships (PL, consultant, back office in all three projects), pins and activation
  (5.5), synthetic identities for the 18 seeded participations through `write_participant_data`.

## 6. Commands (new or changed)

| Command | Change | PR |
|---|---|---|
| `pnpm generate` | also writes `packages/config/templates/manifest.json` | 2c-1 |
| `pnpm verify` | the manifest joins the drift check | 2c-1 |
| `pnpm lint` | also runs `scripts/check-template-immutability.mjs` (base ref from CI; locally `origin/main` if fetched) | 2c-1 |
| `pnpm db:seed` | memberships, pins, activation, synthetic identities | 2a, 2e-1, 2f |

New environment variable (`.env.example`): `CONFIG_DIR` (optional; the image sets it). No other.

## 7. Acceptance criteria

U = unit, I = DB/API integration, C = component, E = Playwright, CI = workflow, R = review.

### Projects and memberships (2a)
- [ ] **AC-1** Creating a project goes through `create_project`: the project, the creator's PL
      membership and `project_created` in one transaction; `transfer_app` `INSERT` on `project`
      fails with `42501`; only a flat `project_lead` may create (403 otherwise). (I)
- [ ] **AC-2** `GET /projects` lists exactly the projects where the subject holds a project role,
      plus all for global org roles; `GET /projects/{id}` of another project is 404. (I)
- [ ] **AC-3** The migration creates W1 for every `ta_tg` project without a wave that has **at least
      one** legacy date, with those dates (never an empty W1, which would needlessly block a later
      type change), then drops the three columns and their checks; nothing references them
      afterwards (domain, API, seed, web). It also gives every existing project its creator as PL
      member when the creator's flat role is `project_lead`, and fails, changing nothing, if a
      project would be left without a PL (round 23). (I)
- [ ] **AC-4** The type changes only in draft without participations or waves, the Project Agentur
      only in draft; `project_changed` lists the changed keys. (U, I)
- [ ] **AC-4a** Locks live in the functions: each setup function blocks while another transaction
      holds a participation lock of the project (shared) and vice versa, without any service call;
      `create_participation` takes the shared lock; a transaction holding the exclusive lock can
      still create and lock participations of that project. (I)

### Waves (2b)
- [ ] **AC-5** `checkWaveChange`: one expected result per rule of 5.6, at the boundary days. (U)
- [ ] **AC-6** Waves only in `ta_tg`; each create/edit writes the row and exactly one audit event;
      `transfer_app` has no DML on `project_entry_wave`. (I)
- [ ] **AC-7** A wave edit and a status change of a participation of that project serialize (the
      project lock); two concurrent imports of one project serialize. (I)
- [ ] **AC-8** The wave form creates and edits a wave and shows each domain error at its field. (C)

### Templates (2c)
- [ ] **AC-9** The manifest matches the files (canonical hash, drift-checked); the immutability
      check fails for a changed or deleted existing version and passes for a new one; formatting
      alone changes no hash. (U, CI)
- [ ] **AC-10** The first pin registers the version; a later pin of `(key, version)`, of any
      project, with another hash **or** the same claimed hash and different content is refused
      (`template_version_changed`); of two concurrent conflicting pins in two projects exactly one
      succeeds; versions and pins can't be updated or deleted, by the owner either. (I)
- [ ] **AC-11** Resolution of a pinned project uses only the snapshot: changing the template file
      afterwards changes nothing. (I)
- [ ] **AC-12** The image contains the templates and the base defaults; `GET
      /api/v1/config/templates` answers in the smoke test. (CI)

### Overrides and relaxations (2d)
- [ ] **AC-13** `validateProjectOverride` checks the base-only chain and every pinned chain: a rule
      on a custom field from only one template fails; a relaxation that matches no chain fails
      (`relaxation_unmatched`); one of a locked rule fails (`relaxation_locked`); an unknown reason
      code fails. 100 %. (U)
- [ ] **AC-14** An Agentur-scoped setting needs source, the acting user as confirmer and
      `confirmedOn ≤ today`; it applies only to its Agentur and wins per key (Q93); every change is
      a new override version with its audit event; a stale version is 409. (U, I)
- [ ] **AC-15** A relaxation takes effect only after approval by a regional operations manager who
      isn't the requester (domain and SQL); rejection, withdrawal and removal are audited; at most
      one open request per rule. (U, I)
- [ ] **AC-16** No stored override version is invalid for the pins it was stored with; a pin or
      migration that would make the current override invalid is refused with the issues. (I)

### Activation and the draft gate (2e-1)
- [ ] **AC-17** Activation is refused with `project_activation_blocked` and/or
      `no_entry_wave_with_latest_entry_date` exactly as `projectActivationBlockers` says, and by
      the function's re-check; Agentur-submission blockers don't block; `project_activated`
      records the base-defaults version. (U, I)
- [ ] **AC-18** On a draft project every transition is refused (`project_not_active`) by the
      service and by `change_participation_status`; the project job plans nothing; creation, wave
      assignment, person data and dates work. (I)

### Migration (2e-2)
- [ ] **AC-19** The preview lists changed settings, added/removed rules and fields, override
      issues and every Agentur-scoped setting of the key with its old and new template value; the
      confirm needs `keep`/`remove` for exactly those keys (`review_incomplete`). (U)
- [ ] **AC-20** The confirm writes the pin, the override version (if a key is removed) and the
      audit events in one transaction; afterwards resolution uses the new version for that Agentur
      only. (I)

### Person data (2f)
- [ ] **AC-21** Each person-data column maps to a field-catalog key with `storage: column`, the
      table's data class and the table's retention class; a test fails for a special-category or
      highly confidential field, a missing retention class or a mixed table. (U)
- [ ] **AC-22** `transfer_app` may only `SELECT` the person tables; `write_participant_data` writes
      both rows and, on an update, one `participant_data_changed` with exactly the changed keys and
      no values; `(project_id, personnel_number)` is unique. (I)

### Import (2f, 2g)
- [ ] **AC-23** Mapping: required targets (relaxation-aware), one column per target, unmapped
      columns dropped and never returned. (U)
- [ ] **AC-24** Row validation truth tables for every code of 5.1, including `31.02.`,
      `03.14.1998`, both leap-year cases, date cells with and without time, empty and whitespace
      cells, control characters and the length limits; issues carry row, target and code, never a
      value. 100 %. (U)
- [ ] **AC-25** Plan: duplicates in the file, possible duplicates (decision required), update vs.
      unchanged, empty cells keep values, terminal participations skipped, missing participations
      counted. 100 %. (U)
- [ ] **AC-26** The preview writes nothing (row counts of every table and `audit_event`
      unchanged); a confirm whose plan differs from its preview is 409; a confirm racing a
      concurrent change (another import, a relaxation, a re-pin) waits for the lock and then
      re-plans against the committed state (409 if the plan changed); decisions that don't match
      the plan are refused. (I)
- [ ] **AC-27** The confirm is atomic (a failure on the last row leaves nothing); creations go
      through the creation edge with `participation_created` per row; `import_confirmed` has the
      counts; confirmed warnings are audited. (I)
- [ ] **AC-28** Limits: 6 MB → 413; 5,001 rows, 51 columns or a 501-character cell → validation
      error; a non-spreadsheet → `unsupported_file`; the zip bomb is refused by the central-directory
      check, and one with lying sizes is stopped by the isolation (S1); the API keeps serving. (I)
- [ ] **AC-29** CSV in UTF-8 with and without BOM, Windows-1252, `;` and `,`; XLSX sheet choice,
      text/number/date cells; the XLSX fixture parses to the CSV fixture's content. (U, I)
- [ ] **AC-30** Only the project's PL may preview, confirm or create manually; logs of an import
      contain no file name, header or value; problem bodies contain codes only. (I)
- [ ] **AC-31** A saved mapping stores only HMACs; a second file of the same customer gets the
      suggestions; nothing else is stored by a preview. (I)
- [ ] **AC-32** The fixtures are synthetic (fixed fictional name list, `example.org`, reserved
      phone ranges, `99999 Beispielstadt`) and documented in their README. (R, U)

### Participations (2g-2, 2h)
- [ ] **AC-33** The list pages by `(created_at, id)` and returns only fields allowed for `list`;
      the consultant (no assignments) and the org roles get no participant data. (I)
- [ ] **AC-34** The detail returns the fields `decideAccess` allows for `read`. (I)
- [ ] **AC-35** Playwright: the PL creates a `ta_tg` project, chooses the sample Project Agentur,
      adds a wave, activates, imports the sample CSV, sees the participants; the re-import updates
      instead of duplicating. (E)
- [ ] **AC-36** `checkParticipationDates`: one expected result per rule of 5.7 at the boundaries,
      including no wave, a wave without `latestEntryDate` and a period of twelve months exactly
      vs. one day more (month-end cases). 100 %. (U)
- [ ] **AC-37** The dates route writes through `set_participation_dates` with
      `participation_dates_changed` (old/new dates) and refuses a stale version (409); a new start
      date clears `tg_start_missed`. (U, I)
- [ ] **AC-38** Wave assignment and manual creation reuse the Slice 1 service and the import rules;
      refusals map per R21. (I)

### Platform and data protection
- [ ] **AC-39** The data catalog lists every new table with a known retention class and a
      `project_id` FK; `personnel_file` is in the catalog with period `unset`. (U)
- [ ] **AC-40** The grant tests cover every new table and function (Slice 1 AC-15 style); the
      new reserved event types are refused by `record_audit_event`. (I)
- [ ] **AC-41** No `Date.now()`/`new Date()` in domain, config and jobs, the new folders included
      (existing scan). (U)
- [ ] **AC-42** `read-excel-file@9.3.12` and `csv-parse@7.0.3` pinned exactly, one copy each, in
      `@transfer/api` only; frozen-lockfile install; tests on Node 22 and 24; image smoke. (CI)
- [ ] **AC-43** The 100 % thresholds cover `packages/domain/src/{projects,import}/**` and
      `packages/config/src/{override,migration,hash}.ts`. (CI)
- [ ] **AC-44** The generated transitions/permissions table shows the new operations; OpenAPI and
      the client have no drift. (U, CI)
- [ ] **AC-45** Every configuration-dependent audit event (R26) carries `baseDefaultsVersion`; a
      test fails for a listed type without it. (U, I)
- [ ] **AC-46** Import identifiers and addresses: a numeric XLSX cell for Personalnummer or postal
      code is `identifier_cell_numeric`, for a phone it is dropped with that warning; a postal code
      that isn't five digits is `postal_code_invalid`. (U)

### Definition of done (CLAUDE.md) applied to this slice
- Status changes through the audit helper: unchanged; setup writes get the same treatment (D2).
- No hard-coded regional rules: regional values only in templates and Agentur-scoped settings;
  the import's required targets come from the base rules and approved relaxations.
- No vendor calls outside adapters: the parsers are libraries in one module, not services.
- New personal data: two tables with class, access category and retention class (5.10, Q105).

## 8. Deliberately left out

| Not in Slice 2 | Why / where it lands |
|---|---|
| The reconciliation route and its review | Slice 7, with the DSV facts that can satisfy it (D10) |
| Membership management, participant assignments, regions on projects, real login | Slice 3 |
| Placement Agentur on participations and the automatic pin on assignment | the slice that assigns it (4a/6) (R12) |
| Override rule/field/help-text additions through the API; template publication and admin UI | later (ADR-0004) (R13) |
| Generic editing of person data (Q65 `undecided` for the PL), self-service | Slices 3/4a; does an HR re-import overwrite participant-maintained contact data? — to raise in Slice 4a |
| Special-category and highly confidential fields, encryption, separate logged endpoints | with the first such field (Slices 4a/6) |
| Deleting waves, closing projects, returning to draft, changing the type of a project with participations or waves (and round 10's supersession on a change to `ta_only`) | Q98, Q101 |
| Foreign addresses (a country target) | Q103 (R23) |
| A customer entity | Q104 |
| Wave assignment in bulk, filters, "what's missing" and dashboards | Slice 5 |
| Audit history UI (`audit_event` stays unreadable for the app) | Slice 5 |
| `.xls` (binary Excel), multi-row headers, header row selection | not needed so far; added on demand |
| Retention job and periods | Slice 7 (Q3, Q58, Q77, Q105) |

## 9. Doc changes

**In this PR:** `docs/plans/slice-2.md`; `docs/decisions/2026-10-16-answers-round-22.md`;
`open-questions.md` Q98–Q107:

| # | Topic | Status |
|---|---|---|
| Q98 | What a draft project permits; changes after activation | confirmed (R1, round 22) |
| Q99 | Who approves a relaxation | confirmed (R2) |
| Q100 | The controlled relaxation reason codes | confirmed (R3) |
| Q101 | Editing entry waves once in use | open, PL (R4) |
| Q102 | Individual TG dates, the new start date, twelve months | open, PL/legal/BA; before PR 2h (R5, R25) |
| Q103 | The import contract | open, PL; before PRs 2f/2g (R6, R23, R24) |
| Q104 | Saved column mappings without a customer entity | confirmed (R7) |
| Q105 🔒 | Retention classes of the person data | open, DPO; pre-pilot gate (R8) |
| Q106 | Project creation and visibility until Slice 3 | confirmed (R9) |
| Q107 | Pinning the base defaults | confirmed with audit provenance (R10, R26) |

**In the implementing PRs:**
- **2a:** ADR-0002 amendment (setup functions, project lock, memberships); data-protection.md
  (new tables in the retention-class table); process-and-lifecycle.md (project dates live on
  waves; draft/active); CLAUDE.md layout (`fixtures/imports` later in 2g).
- **2b:** process-and-lifecycle.md (wave editing rules); glossary (project status).
- **2c:** ADR-0004 amendment (snapshots, manifest, immutability, `CONFIG_DIR`);
  regional-variation.md (snapshot, immutability); `.env.example`; Dockerfile comment.
- **2d:** regional-variation.md (relaxation approval and reason codes, cross-chain checks).
- **2e:** regional-variation.md (migration review); ADR-0011 note (draft projects plan nothing).
- **2f:** data-protection.md (person-data tables, `personnel_file`); ADR-0008 note.
- **2g:** ADR-0003 note (the two dependencies, spike S1); ADR-0010 note (base64 upload, body
  limits, new problem types); CLAUDE.md (`fixtures/imports`, commands); README status.
- **2h:** process-and-lifecycle.md (new start date in Q68 case 3).

## 10. Risks

| Risk | Mitigation |
|---|---|
| `read-excel-file` has one maintainer and frequent releases | Exact pin, deliberate upgrades; parsing isolated in one module behind `parseSpreadsheet()`, so a replacement touches one file; the worker limits contain a parser bug. |
| Zip bombs and pathological files exhaust the API | 5 MB cap, the central-directory check (always), row/column/cell limits, worker resource limits and timeout (S1); never in-process XLSX parsing (child process or CSV only). |
| Personal data leaks through the import (logs, problem bodies, stored previews, saved headers) | Stateless preview; issues carry codes and row numbers only; HMAC'd headers; log fields fixed; tests (AC-26, AC-30, AC-31). |
| A re-import silently overwrites or deletes data | Empty cells never clear; terminal participations untouched; missing people only counted; updates listed with old/new values before confirm; audit with changed keys. |
| Duplicates through concurrent imports or case/zero differences in Personalnummer | Project lock and unique index; exact matching is a stated reading (Q103), so a PL sees "new" rather than a wrong merge. |
| A template file changes after projects pinned it, or two projects pin different contents for one version | One registry row per version (primary key), content and hash compared on every pin, CI immutability check (AC-9, AC-10). |
| A service forgets a lock | The locks are acquired inside the functions (D3, AC-4a). |
| An import confirmed against stale state | Reload, re-plan, token comparison and writes in one transaction under the exclusive project lock (AC-26). |
| An override valid for one Agentur breaks another | Cross-chain validation on every override write, pin and migration (AC-13, AC-16). |
| The draft gate blocks real work in a way the PLs don't expect | Q98 asks; the gate is one check in the service, one in the function and one in the job, easy to relax. |
| Wave edits change who is withdrawn or offered | No retroactive cutoff, no change of a deadline open offers use, the project lock (5.6, AC-7). |
| Two sources of truth for project dates during the change | One migration copies then drops; the domain already reads waves only (AC-3). |
| Breaking `/api/v1` changes | Only the repo's own clients; the generated client and the drift check catch every use (R20). |
| More SQL functions to keep correct | Same hardening and grant tests as Slice 1; structure in SQL, rules in TypeScript (round 16). |
| Large PRs | 12 PRs with estimates; any PR over ~500 hand-written lines is split before review. |

## 11. Approval

Approved in [round 22](../decisions/2026-10-16-answers-round-22.md) with the amendments applied
above. R23–R28 are readings taken while applying it, for confirmation in the PR 2a review.
Implementation starts with PR 2a after this PR is merged; PRs 2f/2g wait for Q103 and PR 2h for
Q102.
