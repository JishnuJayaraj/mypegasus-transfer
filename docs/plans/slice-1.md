# Slice 1 — Domain core: plan

- Status: **Approved** (rounds 7–9, 2026-10-16). No domain question is open; the remaining DPO
  and legal confirmations are pre-pilot gates.
- Date: 2026-10-15, revised 2026-10-16
- Roadmap: [Slice 1](../roadmap.md#slice-1--domain-core)
- Builds on: [Slice 0](slice-0.md) (merged, PRs 0a–0d)
- Decisions: [round 7](../decisions/2026-10-16-answers-round-7.md),
  [round 8](../decisions/2026-10-16-answers-round-8.md),
  [round 9](../decisions/2026-10-16-answers-round-9.md)
- Relevant ADRs: 0002 (status writes enforced in the DB, append-only audit, `project_id`), 0004
  (fixed lifecycle core, regional templates, base defaults, completeness rules), 0006 (adapters,
  `Clock`), 0007 (access model in Slice 1), 0008 (retention per item), 0011 (pg-boss, `system`
  actor, injected `Clock`)
- Domain docs: [process-and-lifecycle.md](../domain/process-and-lifecycle.md),
  [data-protection.md](../domain/data-protection.md) (access matrix, write permissions),
  [regional-variation.md](../domain/regional-variation.md), [glossary.md](../domain/glossary.md)

## 0. Decisions and open items

### Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | PR shape | **8 PRs, 1a–1h** (section 4), tests first, each green on its own. |
| D2 | Status writes | Only narrowly scoped **`SECURITY DEFINER` functions** write statuses and audit events. `transfer_app` has no direct participation or audit writes. Fixed `search_path`, `EXECUTE` revoked from `PUBLIC`, no dynamic SQL, grants tested. |
| D3 | Tables | Only minimal participation, lifecycle, audit and job tables, plus `project_entry_wave` (Q79). Personal data and memberships come later. |
| D4 | Missing evidence | Missing DSV, ASU, profiling and exception evidence **fails closed** in Slice 1. A temporary implementation state, **not** a rule letting the app decide whether employment legally exists. |
| D5 | JSON Schema engine | Restricted **`z.fromJSONSchema`** profile, subject to spike S1; fallback **`ajv@8.20.0` server-only**. |
| D6 | Roles | Project-specific roles, **zero or more per person and project**; permissions are the **union**; profiler access still needs the participant assignment. Plus the org role **`regional_operations_manager`** (Q80). |
| D7 | Jobs | pg-boss **in the API process**; a separate worker is a Slice 9 scaling decision. |
| D8 | Sample templates | Fictional Agenturen only; never invented rules for a real Agentur. |
| D9 | Adapters | Only **`Clock`** now. |
| D10 | Docs gaps | **Fail safe:** unknown access is denied, unknown automatic transitions don't run, operational exceptions are flagged. |

Dependencies: `pg-boss@12.38.0` and its peer **`@opentelemetry/api@1.9.1` added explicitly**;
`ajv@8.20.0` only on the S1 fallback; exact versions, pg-boss upgraded only in deliberate PRs.

### What rounds 7–9 settled (summary)

- **Deadlines are contractual and live on entry waves** (Q69, Q77, Q79): each `ta_tg` project
  has one or more waves (signing deadline, default TG start/end, `latestEntryDate`); a
  participation joins exactly one wave before its DSV is offered; re-offers need an explicit
  `offerDeadline`. The **final admission cutoff** (the Berlin day after the wave's
  `latestEntryDate`) replaces the 90-day grace period. Cutoff withdrawals add `never_contacted`
  and `not_informed`, with a 14-day warning and a 3-day final reminder (Q70, Q78).
  Participations without a wave use the project's final entry date (Q84).
- **TG entry after the planned date** has three cases (Q68, rounds 8–9): automatic **catch-up**
  of a genuinely missed run when every prerequisite was valid and recorded before that day's
  originally scheduled run time; audited **reconciliation** by the PL when evidence recorded
  later proves it; otherwise a **new start date**. Automatic entry uses a snapshot as of the
  scheduled run: a completed run whose guard failed is never reconsidered automatically. Guard
  facts carry a validity date and a `recordedAt` timestamp.
- **No guard is overridable** (Q71). A **profiling exception** needs evidence, one of four
  reason codes (Q81) and **approval by a different user** (`regional_operations_manager`)
  before it satisfies the TG entry guard.
- **Employment and Transfer-KuG eligibility are separate**, with three outcomes per period:
  `eligible`, `excluded`, `ba_review_required` (Q74, Q82, *verify*).
- `ta_completed` checks a generic **`taMeasuresComplete`** fact, not `profiling_done` (Q83).
- **Reason codes only** until encrypted storage exists; the health-related end reason is
  refused by the status function until then; free text is never logged (Q66).
- **Config:** rule bases (`statutory` / `ba_form` / `operational_default`) with locking (Q75);
  no default for Agentur submission settings; temporary settings **scoped to one Agentur**,
  with source, confirmer and date (Q76, round 8).
- **Access:** union of project roles, strict assignment, write rules, break-glass scope,
  evidence-set phase, the regional operations manager (Q61–Q65, Q80).

### Open

No domain question is open. Still `assumed` (DPO): Q61–Q67, the retention part of Q77, Q80.
Still `verify` (legal/BA): Q74, Q82. They are **pre-pilot gates**: a confirmation should
normally change policy tables, configuration and tests; if a reviewer requires a design change,
real data stays blocked until it is built (round 9, ADR-0005 gate).

## 1. Goal

Freeze the domain core so that every later slice builds on tested rules instead of re-deciding them:

```
packages/domain   lifecycle (main status + profiling track + DSV track, canTransition, guards,
                  entry waves, profiling exceptions, system planner), Transfer-KuG eligibility,
                  audit event model, completeness engine, field catalog, access matrix
                                                                      — pure, no I/O, 100 % covered
packages/config   regional template model (JSON Schema), resolver, base defaults, 2 samples
packages/adapters Clock
packages/db       project_entry_wave, participation, audit_event, lifecycle_edge, job_run,
                  the status functions, grants
apps/api          status service (the only TypeScript caller of the status functions),
                  pg-boss with the nightly lifecycle job
```

**Done when** (roadmap): tests document every allowed and forbidden transition and every access
rule. Acceptance criteria are in section 7. There is no new UI; the "demo" is the two generated
tables (transitions and access matrix, section 5.10) and a nightly run on seed data
(`pnpm jobs:lifecycle --today …`).

## 2. Facts checked

### Fresh session start (2026-10-15)

Run in a cloud session (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 pre-installed):

| Step | Result |
|---|---|
| `scripts/session-start.sh` (hook, then re-run by hand) | **OK**, exit 0 in ~4 s on the second run: Postgres started, `pnpm install --frozen-lockfile`, `db:setup`, `db:migrate`. Only output: pnpm's "Ignored build scripts" notice (expected, ADR-0003). |
| `pnpm db:seed` | **OK** (silent, idempotent). |
| `pnpm dev` | **OK.** API `:3001` (`/api/v1/health` 200), web `:5173` (200, `/api` proxied), portal `:5174/portal/` (200). Without a session `/api/v1/projects` is a 401 problem; with the dev PL session it returns the three seeded projects from Postgres. |
| `pnpm verify` | **OK** in ~26 s: typecheck, lint, 19 test files / 186 tests, no API client drift. |

### Dependencies (checked against npm on 2026-10-15, approved)

| Package | Pin | Released | Notes |
|---|---|---|---|
| `pg-boss` | **`12.38.0`** | 2026-10-13 | MIT. `engines.node >=22.12.0`. Depends on `pg ^8.23.1` (we pin `pg@8.23.1`), `cron-parser`, `rrule-temporal`, `serialize-error`. Frequent releases: pinned, upgraded only in deliberate PRs. In `@transfer/api` (runtime) and `@transfer/db` (schema install). |
| `@opentelemetry/api` | **`1.9.1`** | 2026-10 | Apache-2.0. Non-optional peer of pg-boss; **added explicitly** next to pg-boss. |
| `ajv` | `8.20.0` *(S1 fallback only)* | 2026-04-24 | MIT. |

No other new dependency (exhaustive tests instead of `fast-check`; coverage uses the existing
`@vitest/coverage-v8@5.0.5`). Re-check the latest patch versions when PR 1a is opened.

### Other facts

- **`zod@4.6.7` ships `z.fromJSONSchema()`** (marked experimental upstream), hence spike S1.
- **Zod 4 probes `new Function`** for fast parsing; under our CSP the probe alone can raise a
  violation, which fails the Playwright suite. The SPAs set `z.config({ jitless: true })`
  before using config-driven schemas (Slice 4a); S1 checks it.
- **`SELECT … FOR UPDATE` needs `UPDATE` privilege** on some column, which `transfer_app` won't
  have on `participation` (D2). Row locking goes through a function too (5.4).
- `ta_only` projects have no entry waves and no cutoff; they end through the PL (Q73).

## 3. Spike (first part of PR 1a)

**Timebox:** half a working session. Results go into an ADR note (S1 → ADR-0004, S2 → ADR-0011).

| # | Check | Fallback |
|---|---|---|
| S1 | `z.fromJSONSchema` (zod 4.6.7) compiles the field-schema profile (5.7) and behaves like hand-written Zod for every allowed keyword; `format: date` rejects `2027-02-31` and `2027-02-29`; with `z.config({ jitless: true })` a Vite build validating a compiled schema in the browser raises **no CSP violation** under the API's CSP. | `format: date` compiled to our own `isoDate` if only that keyword differs; otherwise **`ajv@8.20.0` server-only** (`ajv/dist/2020`, strict mode). |
| S2 | `pg-boss@12.38.0` with `@opentelemetry/api@1.9.1`: (a) its schema is created/migrated by `db:migrate` as `transfer_owner`; (b) it then starts as `transfer_app` with schema migration off and only explicit grants; (c) a cron schedule with `tz: "Europe/Berlin"` registers and fires; (d) Node 22.22 and 24; (e) `--frozen-lockfile` install without peer warnings; (f) `pnpm deploy --legacy` puts both into the image and the smoke test passes. | (b) fails → a dedicated **`transfer_jobs`** role owns the `pgboss` schema with its own `DATABASE_JOBS_URL`; app tables unaffected. |

## 4. PR series

Tests first in every PR. Generated files (Drizzle snapshots, `openapi.json`, `schema.d.ts`, the
generated JSON Schema and docs tables) don't count towards ~400 lines; a PR well over ~500
hand-written lines is split (1b is the likeliest candidate: edges/guards vs. operations).

| PR | Content | Depends on | Ends with |
|---|---|---|---|
| **1a** `feat: domain vocabulary, dates and the Clock adapter` | Spikes S1/S2. `packages/adapters` with `Clock` (5.8). Domain enums (5.2). Date helpers (`addDays`, `addMonths` with month-end clamp, `asuDueDate`, *verify Q1*). Field catalog (5.6). Docs: ADR notes for S1/S2, CLAUDE.md layout. | — | vocabulary + Clock tested |
| **1b** `feat(domain): lifecycle transitions, guards and operations` | Entry waves and effective dates, edge table, track activity, `canTransition` with dated facts (valid/recorded), offer deadlines, the three TG entry kinds, profiling exception request/decide/revoke, wave assignment, end-reason correction, derived overall status, generated transitions table, 100 % coverage thresholds. | 1a | every (track, from, to) and operation documented |
| **1c** `feat(domain): system planner and Transfer-KuG eligibility` | `planSystemTransitions` (`dsv_expired`, scheduled entry + catch-up window, wave cutoff withdrawals, warnings), lifecycle and compliance flags, `transferKugEligibility` with three outcomes. | 1b | every cutoff and eligibility combination documented |
| **1d** `feat(domain): field-level access matrix` | `decideAccess` (multi-role union × assignment × category × mode × phase × action incl. `write`), the regional operations manager, transition and approval permissions (Q60, Q80), list-payload rule, break-glass scope, generated access table. | 1a | every access rule documented |
| **1e** `feat(domain): completeness engine` | Rule types with basis, presence semantics, `evaluateCompleteness`, rule validation against the field catalog. | 1a | truth tables pass |
| **1f** `feat(config): template model, resolver and base defaults` | `packages/config`: Zod model → committed JSON Schema (+ drift), field-schema profile, nationwide vs. regional settings, Agentur-scoped temporary settings, locked and relaxable rules, two-level resolver with provenance and blockers, `base-defaults.json`, two sample templates, pinned-version loading. | 1e | resolution 100 % covered |
| **1g** `feat(db): waves, participation, audit and the status functions` | `project_entry_wave` (+ migration of the Slice 0 project dates), `participation`, `audit_event`, `lifecycle_edge`, the nine functions, grants, drift test, data catalog, seed, `apps/api` status service with the fail-closed facts provider; the service enforces `mayPerformTransition` and the operation permissions, and supersedes stale exception requests in the same transaction (round 10). | 1b, 1c, 1d | grant and atomicity tests pass |
| **1h** `feat(api): pg-boss and the nightly lifecycle job` | pg-boss setup (schema install, grants, in-process start), `job_run`, schedule, sweep + per-project job with the catch-up window, `pnpm jobs:lifecycle`, idempotency tests with a manual clock, image smoke. Docs: CLAUDE.md commands, `.env.example`, overview, ADR-0011 note, settings allowlist. | 1c, 1g | **slice done** |

1b/1d/1e can run in parallel after 1a.

**1b is split** by the rule above: **1b-1** edges, track activity, `canTransition`, guards,
waves and effective dates, offer deadlines, the three TG entry kinds, `pnpm test:coverage`;
**1b-2** the operations (wave assignment, profiling exception request/decide/revoke, end-reason
correction), the derived overall status and the generated transitions table.

**1c is split** the same way: **1c-1** `planSystemTransitions`, `lifecycleFlags` and
`projectFlags`; **1c-2** `transferKugEligibility`.

## 5. Design

### 5.1 Repo layout after Slice 1

```
packages/
  domain/
    config/base-defaults.json        nationwide defaults (ADR-0004), validated by packages/config
    src/lifecycle/                   enums, waves, edges, canTransition, guards, operations,
                                     planner, derived status
    src/eligibility/                 transferKugEligibility
    src/audit/                       audit event schemas (Zod, discriminated by type)
    src/completeness/                rules and engine
    src/fields/                      field catalog
    src/access/                      decideAccess, transition and approval permissions
    src/dates.ts                     date arithmetic on ISO dates (no Date.now)
  config/                            NEW @transfer/config (depends on @transfer/domain)
    schema/regional-template.schema.json   generated from the Zod model, committed
    templates/beispielstadt-nord/1.json    sample (D8)
    templates/beispielstadt-sued/1.json    sample (D8)
    src/model.ts · field-schema.ts · resolve.ts · load.ts
  adapters/                          NEW @transfer/adapters: src/clock/ (D9)
  db/                                + waves, participation, audit, edges, job_run, functions, grants
apps/api/src/
  participations/status-service.ts   the only TypeScript caller of the status functions
  participations/guard-facts.ts      facts provider (fail closed in Slice 1, D4)
  jobs/                              pg-boss setup, schedules, lifecycle sweep
docs/domain/generated/               lifecycle-transitions.md, access-matrix.md (generated)
```

`packages/domain` stays I/O-free: it receives `today` as an ISO date and facts as plain data.

### 5.2 Vocabulary (`snake_case` values, from the docs)

| Enum | Values |
|---|---|
| `MainStatus` | `self_registered`, `imported`, `contacted`, `unreachable`, `informed`, `active_in_tg`; terminal `withdrawn`, `rejected`, `ta_completed`, `exited` |
| `ProfilingStatus` | `not_started`, `profiling_accepted`, `profiling_in_progress`, `profiling_done`, `profiling_declined` |
| `DsvStatus` | `not_offered`, `dsv_offered`, `dsv_signed`, `dsv_declined`, `dsv_expired` |
| `Track` | `main`, `profiling`, `dsv` (columns `status`, `profiling_status`, `dsv_status`) |
| `Step` | `asu_registration`, `data_collection`, `profiling`, `agentur_submission`, `dsv` (participant scope); `project_checklist` (project scope) |
| `EndReason` (one enum, `phase`, Q34) | `pre_tg`: `declined_profiling`, `declined_dsv`, `no_response`, `never_contacted`, `not_informed`, `placed_direct`, `self_employed`, `retirement`, `other_measure`, `deceased`, `other`; `tg`: `placed_permanent`, `placed_fixed_term`, `self_employed`, `retirement`, `apprenticeship_or_study`, `max_duration_reached`, `own_termination_without_job`, `terminated_by_tg`, `long_term_illness_reduced_earning_capacity` (**special category**, not storable until encryption), `deceased`, `other`. The planner derives only `declined_dsv`, `declined_profiling`, `no_response`, `never_contacted`, `not_informed`. |
| `TgEntryKind` | `scheduled_entry`, `scheduled_entry_catchup` (system), `reconciliation` (PL) |
| `ProfilingExceptionReason` (Q81) | `participant_prevented_documented`, `agentur_scheduling_unavailable`, `force_majeure`, `ba_confirmed_other` |
| `ProfilingExceptionStatus` | `none`, `requested`, `approved`, `rejected`, `revoked`, `superseded` (round 10) |
| `ProfilingExceptionSupersededReason` (round 10) | `participation_closed`, `project_ta_only`, `profiling_closed` |
| `KugOutcome` (Q82) | `eligible`, `excluded`, `ba_review_required` |
| `ActorType` | `user`, `participant`, `system` |
| `OrgRole` / `ProjectRole` | `admin`, `regional_admin`, **`regional_operations_manager`** / `project_lead`, `consultant`, `back_office` — sets, not single values (D6) |

### 5.3 Lifecycle (`packages/domain/src/lifecycle`)

#### Entry waves and effective dates

| Date | Where | Meaning |
|---|---|---|
| `signingDeadline` | wave | deadline of the **first** DSV offer |
| `defaultTgStart`, `defaultTgEnd` | wave | planned TG period for the wave's participants |
| `latestEntryDate` | wave | last possible beE entry, inclusive; **cutoff** = the next Berlin day (Q77) |
| `tgStart`, `tgEnd` | participation, optional | individual contractual override of the wave defaults (set with audit in Slice 2) |
| `offerDeadline` | participation | deadline of a **re-offer**; required for a re-offer; ≤ wave `latestEntryDate` and ≤ effective `tgStart` (Q69) |
| `tgEntryDate`, `exitDate`, `withdrawnOn`, `profilingDoneOn` | participation | effective dates, set by the status function |

- Effective `tgStart = participation.tgStart ?? wave.defaultTgStart` (same for `tgEnd`);
  effective offer deadline `= offerDeadline ?? wave.signingDeadline`. If neither exists, no offer
  can be recorded (the system never invents a deadline).
- A participation belongs to **exactly one wave before its DSV is offered** (Q79). In Slice 1 the
  wave can be (re)assigned only while the DSV is `not_offered` (D10; later reassignment is not
  covered by the answers).
- The project's final entry date (latest wave `latestEntryDate`) is derived, for reporting and
  for Q84.
- All deadlines are **inclusive**; expiry happens the next Berlin day.

#### Dated guard facts

`GuardFacts` carry, per fact, the date it became **valid** (e.g. DSV fully executed on, ASU
registered on, TL 407 signed on, exception approved on) and the instant it was **recorded** in
the system (`recordedAt`, a timestamp). Each day `d` has an originally **scheduled run time**
`scheduledAt(d)` = `d` at `JOBS_LIFECYCLE_TIME` (Europe/Berlin). This separates the three
TG-entry cases (Q68, rounds 8–9):

| Kind | Actor | When | Facts must be |
|---|---|---|---|
| `scheduled_entry` | system | the run for `tgStart` (`tgStart = today`) | valid on/before `tgStart` **and** `recordedAt ≤ scheduledAt(tgStart)` |
| `scheduled_entry_catchup` | system | `tgStart` is a **missed** run day (inside the catch-up window), `tgStart < today` | valid on/before `tgStart` **and** `recordedAt ≤ scheduledAt(tgStart)` |
| `reconciliation` | PL | `today > tgStart`, or the scheduled run failed the guard | valid on/before `tgStart` (recorded any time); reviewed after the fact (Q80) |
| — (case 3) | — | a fact valid only after `tgStart` | no entry; the PL records a new start date (Slice 2) |

Automatic entry is a **snapshot as of `scheduledAt(tgStart)`**: if the run for that day
completed and the guard failed, no later run reconsiders it (round 9).

#### Edges

Encoded as data (`edges: Edge[]`, each `{ track, from, to, actors, kinds }`): the arrows of
process-and-lifecycle.md plus manual withdrawal. Everything else is `no_edge`.

| Track | From → to | Actors | Guards / notes |
|---|---|---|---|
| main | *(create)* → `imported` | user | import / manual (Slice 2) |
| main | *(create)* → `self_registered` | participant | QR registration (Slice 4c) |
| main | `self_registered` → `imported` / `rejected` | user (+ system for `rejected`) | Slice 4c |
| main | `imported` → `contacted`; `contacted` → `informed` / `unreachable` | user | |
| main | `unreachable` → `contacted` | user | `before_cutoff` |
| main | `informed` → `active_in_tg` | system (`scheduled_entry`, `scheduled_entry_catchup`), user (`reconciliation`) | TG entry guards |
| main | `informed` → `ta_completed` | user | `ta_completion` |
| main | `active_in_tg` → `exited` | user | `tg` reason + exit date |
| main | `imported` / `contacted` / `unreachable` / `informed` → `withdrawn` | user | manual, `pre_tg` reason; `withdrawal_after_dsv_signed` |
| main | `imported` / `contacted` / `unreachable` / `informed` → `withdrawn` | system | cutoff withdrawal (planner) |
| profiling | `not_started` → `profiling_accepted` / `profiling_declined` | user | |
| profiling | `profiling_accepted` → `profiling_in_progress` / `profiling_declined` | user | |
| profiling | `profiling_in_progress` → `profiling_done` | user | `tl407_signed` |
| profiling | `profiling_in_progress` → `profiling_declined` | user | |
| profiling | `profiling_declined` → `profiling_accepted` | user | `before_cutoff` |
| dsv | `not_offered` → `dsv_offered` | user | `entry_wave_assigned`, `dsv_generated`, `offer_deadline_valid` |
| dsv | `dsv_offered` → `dsv_signed` | user | `dsv_scan_received` |
| dsv | `dsv_offered` → `dsv_declined` | user | |
| dsv | `dsv_offered` → `dsv_expired` | **system** | today > effective offer deadline |
| dsv | `dsv_declined` / `dsv_expired` → `dsv_offered` | user | `before_cutoff`, `offer_deadline_valid` (explicit `offerDeadline`) |

"user" means staff; *which* roles may take which edge is `mayPerformTransition` (5.6).

#### Track activity

- Tracks move only while the main status is `informed`; the DSV track exists only in `ta_tg`.
- **After TG entry with an approved exception** (Q74): forward profiling moves and a refusal
  (`→ profiling_declined` from any open state) can be recorded while `active_in_tg`.
- After a terminal main status, nothing moves.

#### `canTransition(track, from, to, context)`

```ts
type TransitionContext = {
  projectType: ProjectType;
  current: { status: MainStatus; profilingStatus: ProfilingStatus; dsvStatus: DsvStatus };
  actor: { type: "user"; staffUserId: string } | { type: "participant" } | { type: "system" };
  entryKind?: TgEntryKind;             // only for informed → active_in_tg
  today: IsoDate;                      // from the Clock, Europe/Berlin
  scheduledAt?: Instant;               // scheduled run time of tgStart's day (system kinds)
  wave: EntryWave | null;              // the participation's wave
  participation: { tgStart: IsoDate | null; offerDeadline: IsoDate | null;
                   profilingException: ProfilingExceptionState };
  facts: GuardFacts;                   // dated facts; absent facts are false (D4)
  newOfferDeadline?: IsoDate;          // for → dsv_offered
  endReason?: EndReason;               // for → withdrawn / → exited
  confirmed?: boolean;                 // explicit PL confirmation where a rule needs one
};

type TransitionCheck =
  | { ok: true; flagForReview: boolean }
  | { ok: false; code: "no_edge" | "track_inactive" | "actor_not_allowed" | "reason_required"
                      | "reason_wrong_phase" | "reason_not_storable" | "guard_failed";
      failedGuards: GuardId[] };
```

Evaluation order: edge exists → track active → actor type and entry kind allowed → end reason
present, of the right phase and storable (`long_term_illness_reduced_earning_capacity` refused
until encrypted storage, Slice 8) → guards. **There is no override parameter** (Q71).

#### Guards (none overridable, Q71)

A test asserts this list exactly.

| Guard | Transition | Passes when | Source |
|---|---|---|---|
| `dsv_fully_executed` | TG entry | all three signature dates set, the last valid on/before `tgStart` (system kinds: recorded by `scheduledAt(tgStart)`) | §623 BGB |
| `asu_registered_with_proof` | TG entry | ASU with proof, any channel, valid on/before `tgStart` (system kinds: recorded by `scheduledAt`) | §111(4) Nr. 4 |
| `profiling_done_or_approved_exception` | TG entry | `profilingDoneOn ≤ tgStart`, or an exception **approved** on/before `tgStart` (system kinds: recorded by `scheduledAt`) | Q17, Q74, Q80 |
| `tg_start_date` | TG entry | per entry kind (table above) | Q68 |
| `ta_completion` | `→ ta_completed` | `ta_only`, fact `taMeasuresComplete` (assigned required §110 activities completed or closed, evidence present; includes profiling only where the plan or configuration requires it), PL confirms | Q73, Q83 |
| `withdrawal_after_dsv_signed` | `→ withdrawn` with `dsv_signed` | three-party cancellation present **and** PL confirms | *verify* Q46, Q71 |
| `before_cutoff` | the four return arrows | no wave or no `latestEntryDate`, or `today ≤ wave.latestEntryDate` | Q77 |
| `entry_wave_assigned` | `not_offered → dsv_offered` | the participation has a wave | Q79 |
| `offer_deadline_valid` | `→ dsv_offered` | effective deadline exists, `≥ today`, `≤ latestEntryDate` and `≤ tgStart`; re-offers need an explicit `offerDeadline` | Q69 |
| `tl407_signed` | `→ profiling_done` | signed TL 407 (participant and profiler) present | docs |
| `dsv_generated` | `not_offered → dsv_offered` | a DSV document was generated | docs |
| `dsv_scan_received` | `→ dsv_signed` | scan stored and receiver recorded | PRD F8 |

The facts behind the document guards and `taMeasuresComplete` are absent in Slice 1 (D4); the
domain tests cover every outcome with explicit facts.

Readings taken in PR 1b-1 (fail safe, D10; correct them if wrong):
- A fact counts only from its `validOn`: one dated after `today` doesn't satisfy a guard.
- `offer_deadline_valid` fails when the wave has no `latestEntryDate` or there is no effective
  `tgStart`: the bounds can't be checked.
- A system kind without `scheduledAt` fails every dated TG entry guard (nothing to snapshot
  against). Reconciliation on `tgStart` itself needs that day's run to have completed
  (`scheduledRunCompleted`); otherwise from the next day.
- The confirmation in `withdrawal_after_dsv_signed` and `ta_completion` is a staff action, so
  a system withdrawal from `dsv_signed` never passes.
- TG entry exists only in `ta_tg` and `ta_completed` only in `ta_only` (`no_edge` otherwise);
  the DSV track in `ta_only` is `track_inactive`.

#### Operations without a status change

| Operation | Who | Rule |
|---|---|---|
| **Assign entry wave** | PL | `ta_tg`, wave of the same project, DSV still `not_offered` |
| **Request profiling exception** | PL | `ta_tg`; main `informed`; profiling neither `profiling_done` nor `profiling_declined`; an effective TG start after today; no request or approval open; a Q81 reason code; evidence or BA reference present (fact with a reference); `ba_confirmed_other` also needs who at the BA confirmed it and when (fact). After a rejected, revoked or superseded request: a **new record** with changed evidence (round 10). Fails closed in Slice 1 (no evidence storage until 4b). |
| **Approve / reject profiling exception** | `regional_operations_manager` of the project's region | status `requested`; **the decider differs from the requester** (checked in the domain and in the DB function); main `informed`, profiling open, an effective TG start after today (round 10); an approval counts only from its date (case 3) |
| **Revoke profiling exception** | PL | `requested` or `approved`, still applicable, only before TG entry; after entry it is closed by `profiling_done` |
| **Supersede a stale request** | system (status functions) | a `requested` one, when profiling is done or declined, the participation closes or the project becomes `ta_only`; a passed start alone doesn't close it, and it can't authorise the missed date (round 10) |
| **Correct end reason** (Q72) | PL | on `withdrawn`/`exited`; same phase; not the same reason; a system-derived previous reason moves to the secondary list, a previous PL reason only when the PL confirms it still applies (round 10); the terminal status is not reopened |

The readings taken in PR 1b-2 were answered in
[round 10](../decisions/2026-10-16-answers-round-10.md) and are reflected in the table above.
Two readings of its wording remain (fail safe, D10; correct them if wrong):
- "An applicable future start date" means an effective TG start exists and lies after today; it
  is checked on every request (the first included) and on approval and rejection.
- Revoking a request that no longer applies is refused (`no_longer_applicable`): it is
  superseded instead.

Role checks (PL, `regional_operations_manager` of the region) are the access matrix (PR 1d);
the operations check the actor type and the four-eyes rule. **By the end of the slice no
externally callable operation bypasses `mayPerformTransition` or the matching operation
permission:** the status service (PR 1g) enforces both the lifecycle and the role decision; the
DB functions provide integrity (round 10).

#### System planner (`planSystemTransitions`, PR 1c)

A pure function: `(participation, wave, project, facts, window, config) → { changes[], flags[] }`
where `window = { days, today }` lists the run days this run covers: the days **after the last
completed run** up to `today` (normally just `today`; after an outage every missed day; first
run: `today`). A completed day is **never evaluated again** (round 9). Each day carries its
`scheduledAt`. Rules apply in order on the updated snapshot; a second run on the same day plans
nothing.

1. **`dsv_expired`:** `dsv_offered` and `today >` effective offer deadline. Effective date =
   deadline + 1.
2. **TG entry:** `informed`, effective `tgStart` is one of the window's days, all TG guards pass
   with facts valid by `tgStart` **and recorded by `scheduledAt(tgStart)`** → `active_in_tg`,
   effective date and `tgEntryDate` = `tgStart`, entry kind `scheduled_entry` (`tgStart = today`)
   or `scheduled_entry_catchup` (a missed day), with `scheduledAt` in the audit details. Still
   `informed` with `tgStart < today` after this step → flag **`tg_start_missed`** (the PL
   reconciles or records a new start date). DSV expiry and cutoff withdrawals are state-based
   and catch up normally after an outage.
3. **Cutoff withdrawals** (`ta_tg`, wave with `latestEntryDate`, `today > latestEntryDate`),
   effective date and `withdrawnOn` = `latestEntryDate + 1`:

   | Precedence | Situation | Reason |
   |---|---|---|
   | 1 | `dsv_declined` | `declined_dsv` |
   | 2 | `profiling_declined` and DSV not signed | `declined_profiling` |
   | 3 | `dsv_expired`, or main `unreachable` | `no_response` |
   | — | main `imported` | `never_contacted` |
   | — | main `contacted` | `not_informed` |

   - Primary reason by precedence; all other applicable reasons go to the secondary list.
   - Flags instead of withdrawal: `dsv_signed` + `profiling_declined` →
     `conflict_dsv_signed_profiling_declined`; `informed` + `not_offered` → `dsv_never_offered`.
4. **Warnings** (Q78) for every participation that the cutoff would withdraw or flag:
   `cutoff_warning` from 14 calendar days before the cutoff, `cutoff_final_reminder` from 3 days
   before. Both persist while the condition holds; a wave activated late is warned at once.
   Informational only.
5. **Participations without a wave** (Q84): the cutoff is the project's **final entry date**
   (latest `latestEntryDate` across the waves), derived only when **every** wave has one (round
   9, note 2). On the next Berlin day `imported` → `never_contacted`, `contacted` →
   `not_informed`, `unreachable` → `no_response` (effective date and `withdrawnOn` = final entry
   date + 1), with the same 14-day warning and 3-day reminder. `informed` without a wave →
   flag `informed_without_wave_at_cutoff`, never withdrawn automatically. Once assigned, the
   wave's cutoff applies.
6. **Missing dates:** a `ta_tg` project with no wave, or a wave without `latestEntryDate` →
   project flag `latest_entry_date_missing`; participations without a wave are then not
   withdrawn. Nothing moves or is deleted.
7. **Compliance flags** after entry (Q74, Q82): `profiling_exception_deadline_missed`
   (approved exception, not done, `today > addMonths(tgEntryDate, 1)`),
   `profiling_declined_after_entry`. Immediate escalations, never a status change.

Flags are **derived, not stored** (`lifecycleFlags(snapshot, project, today)`; the project flag
from `projectFlags(project)`); the PL dashboard (Slice 5) calls them.

Readings taken in PR 1c-1 (fail safe, D10; correct them if wrong):
- No `config` parameter: nothing in these rules is configurable in Slice 1 (Q78 fixes 14 and 3
  days).
- The planner plans only what `canTransition` allows the `system` actor, so a participation with
  a signed DSV is never withdrawn by the system, and an impossible state moves nothing.
- Warnings judge the participation as it will be at the cutoff: an open offer counts as expired
  (its deadline is no later than `latestEntryDate`, Q69).
- `informed` with `not_offered` is flagged (`dsv_never_offered`), not withdrawn, even with
  `profiling_declined`; without a wave every `informed` participation is flagged.
- An offer without any effective deadline never expires automatically (the offer guard keeps it
  from arising).
- Compliance flags are raised only while `active_in_tg`; the exception deadline is missed from
  the day after `addMonths(tgEntryDate, 1)`.

#### Transfer-KuG eligibility (`packages/domain/src/eligibility`, PR 1c; *verify* Q74/Q82)

`transferKugEligibility(participation, determinations = []) → { employment, periods[] }`,
derived, never stored. `employment = { from: tgEntryDate, to: exitDate | null }`, independent of
the periods. Each period is `{ from, to | null, outcome: KugOutcome }`:

| Situation | Periods |
|---|---|
| not entered | none |
| profiling done on/before entry | `eligible` from `tgEntryDate` |
| approved exception, profiling completed within 1 month (`profilingDoneOn ≤ addMonths(tgEntryDate, 1)`) | `excluded` `tgEntryDate` … `profilingDoneOn`; `eligible` from the day after |
| approved exception, not yet completed, deadline running | `excluded` from `tgEntryDate`, open |
| profiling refused before completion | `excluded` from **`tgEntryDate`** (not the refusal date), open |
| one-month deadline missed (completed later or not at all) | `ba_review_required` from `tgEntryDate`, open; later completion doesn't clear it |

Only a recorded BA/legal determination (`determinations`: period, outcome, reference) may clear
or alter a period after a deadline miss; the type is defined now, its table comes with the KuG
export (Slice 8). Periods other than `eligible` are blocked from any Transfer-KuG export. The
application reports facts and decisions; it doesn't issue a benefit determination.

#### Derived overall status

`deriveOverallStatus(main, profiling, dsv)` returns one i18n key per *consistent* combination;
`isConsistentState` rejects impossible ones (e.g. `imported` with `profiling_in_progress`,
`ta_only` with a DSV status other than `not_offered`, `dsv_offered` without a wave).

### 5.4 Audit events and the status functions

#### Audit event model (`packages/domain/src/audit`, table `audit_event`)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | `gen_random_uuid()` |
| `seq` | `bigint generated always as identity` | strict ordering |
| `project_id` | `uuid not null` FK `project` | data catalog rule (ADR-0002) |
| `participation_id` | `uuid null`, **no FK** | so retention can delete the participation and pseudonymise the trail |
| `event_type` | enum | see below |
| `actor_type` | `user` / `participant` / `system` | |
| `actor_staff_user_id` | `uuid null` FK `staff_user` | staff are never hard-deleted (Q59) |
| `actor_participation_id` | `uuid null` | participant actor |
| `system_job` | `text null` | job name for `system` (`lifecycle.evaluate-project`, `seed`) |
| `on_behalf_of_participation_id` | `uuid null` | assisted mode; only with `actor_type = user` |
| `field` | `status` / `profiling_status` / `dsv_status` / null | |
| `from_value`, `to_value` | `text null` | |
| `reason_code` | `text null` | end reason, exception reason, … |
| `effective_date` | `date null` | business date (TG entry, deadline + 1, …) |
| `occurred_at` | `timestamptz not null default now()` | DB time, not settable by the app |
| `request_id`, `job_id` | `text null` | correlation |
| `details` | `jsonb not null default '{}'` | IDs and codes only, shape per type in Zod: `entryKind` (`scheduled_entry`, `scheduled_entry_catchup`, `reconciliation`), secondary reasons, previous reason, wave id, … |
| `flagged_for_review` | `boolean not null default false` | reconciliations now; break-glass from Slice 3 |

- **No free-text column in Slice 1** (Q66, round 8): override, break-glass and exception free
  text waits for encrypted storage. Free text is never logged.
- `CHECK`s keep the actor consistent (user ⇒ staff id; participant ⇒ participation id; system ⇒
  `system_job`; `on_behalf_of` ⇒ user).
- **Reviews and clarification requests are new events** (`review_recorded`,
  `clarification_requested` → the reviewed `id`), never updates.
- Event types (enum created now): `participation_created`, `status_changed`,
  `entry_wave_assigned`, `profiling_exception_requested`, `profiling_exception_approved`,
  `profiling_exception_rejected`, `profiling_exception_revoked`, `end_reason_corrected`
  (Slice 1); `sensitive_read`, `break_glass_access`, `document_opened`, `warning_confirmed`,
  `export_created`, `config_override_changed`, `review_recorded`, `clarification_requested`
  (Slices 3–9).
- Audit entries without a project (logins, template publication) get their own table in
  Slice 3.

#### Functions (hand-written migration, owner `transfer_owner`)

All `SECURITY DEFINER`, `SET search_path = pg_catalog, public`, no dynamic SQL (explicit branches
per field), `REVOKE EXECUTE … FROM PUBLIC`, `GRANT EXECUTE … TO transfer_app`.

| Function | Does |
|---|---|
| `create_participation(project_id, entry_wave_id?, actor…)` | inserts with `imported`, `not_started`, `not_offered`; writes `participation_created` |
| `lock_participation(id)` | `SELECT … FOR UPDATE`; the lock lasts until the caller's transaction ends |
| `change_participation_status(id, field, expected_from, to, actor…, entry_kind, end_reason, secondary_reasons, offer_deadline, effective_date, request_id, job_id, details)` | checks `expected_from` (`stale_status`), the edge in `lifecycle_edge` (`invalid_transition`), `ta_only` ⇒ DSV unchanged, a wave before `dsv_offered`, refuses the special-category end reason; sets the column and its dependants (`end_reason*`, `tg_entry_date`, `exit_date`, `withdrawn_on`, `profiling_done_on`, `offer_deadline`); bumps `status_version`; inserts **one** `status_changed` |
| `assign_entry_wave(id, wave_id, actor…)` | same project, DSV `not_offered`; writes `entry_wave_assigned` |
| `request_profiling_exception(id, reason_code, actor…)` | writes `profiling_exception_requested` |
| `decide_profiling_exception(id, approve, actor…)` | only `requested`; **refuses when the decider is the requester**; writes `…_approved` or `…_rejected` |
| `revoke_profiling_exception(id, actor…)` | only before entry; writes `profiling_exception_revoked` |
| `correct_end_reason(id, new_reason, actor…)` | only on `withdrawn`/`exited`, same phase; moves a system-derived previous reason to the secondary list; writes `end_reason_corrected` |
| `record_audit_event(type, …)` | every other event type; **refuses** the lifecycle and exception types above |

Errors use SQLSTATE `P0001` with a stable message code (`stale_status` → 409,
`invalid_transition` → 422, `same_person_approval` → 422 later).

#### Status service (`apps/api/src/participations/status-service.ts`)

The only TypeScript caller of the functions. One transaction: `lock_participation` → load the
wave, project and dated guard facts (`GuardFactsProvider`; fail closed in Slice 1) →
`canTransition` / the operation's domain check (failure: domain error, **nothing written**) →
the function → commit. Later slices that write facts (DSV, ASU) take the same lock. The nightly
job uses the same service as `system`.

#### Grants (custom migration, Slice 0 pattern)

| Object | `transfer_app` |
|---|---|
| `participation` | `SELECT` only |
| `project_entry_wave` | `SELECT` (creation and edits with project setup, Slice 2) |
| `audit_event` | nothing in Slice 1 (`SELECT` with the first feature that reads it) |
| `lifecycle_edge` | nothing (read by the functions as owner) |
| `job_run` | `SELECT`, `INSERT` (one row per job and day, never updated) |
| the nine functions | `EXECUTE` |
| `pgboss` schema | `USAGE` + DML on its tables and sequences (spike S2) |

The pseudonymisation role comes with the retention job (Slice 7, ADR-0002).

### 5.5 Completeness engine (`packages/domain/src/completeness`)

Minimal rule language (ADR-0004), no scripting; rules are data validated by a closed schema.

```ts
type RuleBasis = "statutory" | "ba_form" | "operational_default";   // Q75
type CompletenessRule = { id: string; basis?: RuleBasis } & (
  | { kind: "required"; field: FieldKey }
  | { kind: "requiredIf"; field: FieldKey;
      when: { field: FieldKey; equals: string | number | boolean } | { field: FieldKey; exists: true } }
  | { kind: "documentPresent"; documentType: DocumentType; accepted?: boolean });

evaluateCompleteness(rulesByStep, facts) → { byStep: Record<Step, { complete: boolean; missing: MissingItem[] }> }
type MissingItem = { step: Step; ruleId: string; kind: "field" | "document"; key: string;
                     reason: "missing" | "not_accepted" };
```

- **Presence:** `null`, `undefined`, `""` (after trim) and `[]` are absent; `false` and `0` are
  present. Completeness checks presence; value validity is checked on write.
- `equals` is strict equality on scalars. `documentPresent` + `accepted: true` needs an
  `accepted` document; `uploaded`/`rejected` give `not_accepted`.
- **Output carries keys, never values.**
- Rule validation: fields exist in the catalog or as declared custom fields, document types
  exist, ids are unique. A rule without `basis` counts as **locked** (Q75).
- Document types in Slice 1: `dsv_signed_scan`, `tl407_signed_scan`, `kug200b_signed_scan`,
  `asu_proof`, `dsv_cancellation`, `profiling_exception_evidence`.

### 5.6 Field catalog and the access matrix

#### Field catalog (`packages/domain/src/fields`)

One entry per participant field the docs name: `{ key, dataClass, accessCategory, listable,
customerVisible, selfService, storage }`. Classes follow data-protection.md including Q66:
Familienstand, gender, Personalnummer, end of the old employment, knowledge date, work email,
language skills, driving licence are confidential.

- `listable` is `false` for every special-category and highly confidential field.
- `customerVisible` is `true` for exactly the whitelist *(provisional, Q13)*.
- `selfService` marks what the participant may write (Q65); reviewed in PR 1d.
- **End reasons are classified per value:** `long_term_illness_reduced_earning_capacity` is
  special category and never in ordinary lists; `deceased` and the rest are confidential.
- **Exception reason codes** are confidential; `participant_prevented_documented` deliberately
  reveals no illness (Q81).

#### Access categories

| Category | Matrix row (data-protection.md) | Data class |
|---|---|---|
| `case_internal` | statuses, dates | internal |
| `confidential` | Confidential data | confidential |
| `health` | Health (structured), health-related end reason | special category |
| `disability` | Schwerbehinderung/Gleichstellung, GdB | special category |
| `identifiers` | RV-Nr., IBAN, Steuer-ID, BA-Kundennummer | highly confidential |
| `residence_social` | Nationality, residence status, Bürgergeld | highly confidential |
| `profiling_assessment` | Section C, Gesamteinschätzung, weiteres Vorgehen | highly confidential |
| `signed_tl407`, `signed_kug200b` | Signed TL 407 / Kug 200b PDF | most sensitive content |
| `absence` | Sub-status periods | payroll records |
| `audit_metadata` | event type, actor, dates, reason codes — no participant details (Q80) | internal |
| `aggregated` | counts, workload | aggregated |

#### `decideAccess(subject, resource, action, mode)`

```ts
type Subject =
  | { kind: "staff"; staffUserId: string;
      orgRoles: ReadonlyMap<OrgRole, { regionIds: ReadonlySet<string> | "all" }>;
      projectRoles: Record<ProjectId, ReadonlySet<ProjectRole>>;   // D6: zero or more
      assignedParticipationIds: ReadonlySet<string> }              // as profiler/consultant
  | { kind: "participant"; participationId: string; knowledgeCheckPassed: boolean };
type Resource = { projectId: string; regionId: string | null; participationId: string | null;
                  category: AccessCategory; phase: "active" | "evidence_set" };
type Action = "read" | "list" | "open_document" | "write";
type Mode = { kind: "normal" } | { kind: "assisted"; onBehalfOf: string }
          | { kind: "break_glass"; reasonCode: string };

type Decision =
  | { effect: "allow"; view: "full" | "metadata_only" | "absence_only" | "type_and_dates";
      audit: null | "sensitive_read" | "document_opened" | "break_glass_access";
      flagForReview: boolean;
      grant?: { participationId: string; category: AccessCategory; action: Action } } // break-glass scope
  | { effect: "deny"; because: "not_member" | "not_assigned" | "never" | "needs_break_glass"
      | "needs_assisted_mode" | "needs_knowledge_check" | "not_in_list_payloads"
      | "immutable" | "out_of_region" | "undecided" };   // undecided = docs gap (D10)
```

**Role union (D6/Q61):** computed per role the subject holds in the project; the most
permissive *allow* wins; sensitive categories reached through the consultant role still require
the assignment. A PL who is also a profiler sees section C only for participants assigned to
them.

**Reading** (*assumed*, Q28/Q49/Q51/Q62/Q80):

- **Admin, regional admin:** every participant-level category `never`; `aggregated` only.
- **Regional operations manager** (own region only): `audit_metadata` and `aggregated`; every
  participant-level category `never` (no case files, section C, health or signed documents).
- **Consultant/profiler:** person-level data **only for assigned participations**; for others
  only `aggregated` workload counts. Assigned: everything including section C and health;
  signed forms with `open_document` audited; absence "abwesend" + dates.
- **PL:** confidential and internal yes; health/disability only in assisted mode or
  break-glass; identifiers, residence/social, section C **no**; signed forms: `read` metadata
  only, `open_document` audited; absence "abwesend" + dates.
- **Back office:** confidential, identifiers, residence/social, disability yes; health,
  section C, signed forms **no**; absence type + dates.
- **Participant (own):** all own categories, special category only after the birth-date check;
  section C and signed forms denied (Q67).
- Every allowed read of special-category/highly confidential data → `sensitive_read`; every
  `open_document` → `document_opened`.
- **Lists:** `list` is denied for every special-category and highly confidential category.
- **Break-glass** (Q63): only where the docs allow it (PL on health/disability; consultant, PL
  and back office on the evidence set), needs a reason code, returns a **grant scoped to one
  participant, one category and one action**, audit `break_glass_access`, flagged for the
  after-the-fact review. On the evidence set it never grants more than the role has in the
  active phase; the phase starts after the first deletion stage (Q64).

**Writing** (*assumed*, Q65):

| Category | Participant (own) | Consultant (assigned) | PL | Back office | Org roles |
|---|---|---|---|---|---|
| `case_internal` | never | via status functions (Q60 edges) | via status functions and operations | via status functions (DSV edges) | never |
| `confidential` | `selfService` fields | case data: yes | assisted mode; otherwise `undecided` | `undecided` | never |
| `health` | `selfService`, after knowledge check | yes | assisted mode only | never | never |
| `disability` | `selfService`, after knowledge check | yes | assisted mode only | yes (payroll facts) | never |
| `identifiers` | `selfService` | `undecided` (TL 407 needs RV-Nr.) | never (ordinary editing) | yes | never |
| `residence_social` | `selfService` | `undecided` (TL 407 section B) | never | `undecided` | never |
| `profiling_assessment` | never | yes | never | never | never |
| `signed_*` | never | `immutable` (a correction is a new version, Slice 4b) | `immutable` | `immutable` | never |
| `absence` | never | never | never | yes | never |

Assisted writes carry actor + `onBehalfOf`; every sensitive write is audited. The `undecided`
cells go back to the DPO/PL review of Q65 with the generated table.

**Permissions for transitions and operations** (Q60, Q80):
- `mayPerformTransition(subject, edge, participation)`: PL all manual edges of their project;
  assigned consultant/profiler `contacted`, `unreachable`, `informed`, the profiling track and
  `→ exited`; back office `→ dsv_offered`, `→ dsv_signed`, `→ dsv_declined`; participants none;
  expiry, scheduled entry and catch-up system only; reconciliation PL only.
- `mayPerformOperation`: PL assigns waves, requests and revokes exceptions, corrects end
  reasons; the regional operations manager of the project's region decides exceptions (never
  their own request) and reviews reconciliations and break-glass.

### 5.7 `packages/config`

#### Template model

Authored in Zod (`src/model.ts`), exported by `pnpm generate` to
`schema/regional-template.schema.json` (2020-12, committed, drift-checked).
`base-defaults.json`, templates and project overrides are **layers** of one schema:

```jsonc
{
  "$schema": "../../config/schema/regional-template.schema.json",
  "schemaVersion": 1,
  "kind": "regional_template",          // base_defaults | regional_template | project_override
  "id": "beispielstadt-nord", "version": 1, "agenturKey": "beispielstadt-nord",
  "sample": true, "label": { "de": "Agentur für Arbeit Beispielstadt Nord (Beispiel)" },
  "settings": {
    "asu_registration":   { "defaultChannel": "kug_200b", "batchSubmissionChannel": "scan_email" },
    "agentur_submission": { "submissionChannel": "upload", "originalRequired": false,
                            "leadTimeDays": 10, "rejectsOutdatedFormVersions": true }
  },
  "fields": { "custom.beispiel_zusatznachweis_nr": { "type": "string", "maxLength": 40,
              "x-dataClass": "confidential", "x-retentionClass": "participation_record",
              "x-label": { "de": "…" } } },
  "rules":  { "data_collection": [ { "id": "nord-1", "kind": "required",
              "basis": "operational_default", "field": "custom.beispiel_zusatznachweis_nr" } ] },
  "helpTexts": { "de": { "asu_registration.intro": "…" } }
}
```

A **project override** has no project-wide `settings`. Instead:

```jsonc
{
  "kind": "project_override",
  "agenturSettings": {                   // temporary settings, scoped to ONE Agentur (round 8)
    "beispielstadt-ost": {
      "settings": { "agentur_submission": { "submissionChannel": "email", "originalRequired": true,
                                             "leadTimeDays": 14, "rejectsOutdatedFormVersions": false } },
      "source": "phone_call_agentur", "confirmedBy": "<staff user id>", "confirmedOn": "2027-01-12"
    }
  },
  "rules": { … },                        // additions
  "relax": [ { "ruleId": "…", "reasonCode": "…", "approvedBy": "…", "approvedOn": "…" } ]
}
```

- **Base defaults** contain the nationwide rules, the **allowed channel values** (as enums in
  the schema) and the official form requirements, and the nationwide settings: ASU formula
  parameters (3 months / 3 days, *verify* Q1), profiling-exception deadline (1 month, Q17),
  Kug 200b confirmation follow-up (14 days), TL 407 escalation (14 days after TG start, Q54),
  cutoff warning (14 days) and final reminder (3 days) (Q78). A template or override that sets
  a nationwide setting is invalid.
- **No default** for an Agentur's submission channel, batch channel, `originalRequired`,
  `leadTimeDays` or `rejectsOutdatedFormVersions` (round 8). They come only from that Agentur's
  template or from an Agentur-scoped temporary setting, which must carry source, confirmer and
  confirmation date (and is audited when stored, Slice 2).
- Channel enums: ASU `kug_200b` / `online_self` / `in_person`; Kug 200b batch `paper_courier` /
  `paper_post` / `scan_email` / `upload`; TL 407 `email` / `upload` / `paper_original`.
- Signing and entry deadlines and the contractual `deadlineRule` are **entry-wave / project
  data**, not configuration (Q69, Q79). Reminder rules are left to Slice 5.

#### Field-schema profile (custom fields, D5)

Allowed: `type` (`string` / `integer` / `number` / `boolean`), `enum`, `const`,
`format: "date"`, `minLength`, `maxLength` (≤ 2000), `pattern` (≤ 200 characters), `minimum`,
`maximum`, `title`, `description`, plus `x-dataClass` (only `confidential` or `internal`;
special and highly confidential data needs encrypted columns, never `jsonb`), `x-retentionClass`
(must exist in the data catalog), `x-label`. Everything else is rejected before compiling.
Keys start with `custom.`. Validators are cached per (template id, version).

#### Merge rules (base defaults → template → project override)

- **Settings:** a template replaces base values for regional keys; an override's
  `agenturSettings[agenturKey]` applies **only** when resolving for that Agentur.
- **Rules** (Q75): merged by `id`. Templates **only add**. A project override may add rules and
  relax a rule only if its basis is `operational_default`; relaxing a `statutory`, `ba_form` or
  unclassified rule is invalid. (Storing approvals and the audit trail of overrides is Slice 2;
  the resolver checks shape and basis.)
- **Fields:** templates and overrides add custom fields; redefining an existing key is invalid.
- **Help texts:** per language and key, the later layer wins.

#### Resolver (`resolve.ts`, 100 % covered)

```ts
resolveForParticipation({ base, templatesByAgentur, override, placementAgenturKey, kugAgenturKey })
resolveForProject({ base, templatesByAgentur, override, kugAgenturKey })
  → { config: ResolvedConfig; provenance: Record<SettingPath, LayerRef>;
      blockers: Blocker[]; warnings: Warning[] }
```

- **Two levels** *(provisional, Q15)*: participant steps use the placement Agentur, project
  steps the KuG-Agentur.
- **Provenance** for every setting and rule (`base`, `template:<id>@<version>`,
  `override:agentur:<key>` with source, confirmer and date).
- **Blockers** (Q76): no KuG-Agentur template → `project_activation_blocked`; an Agentur
  submission setting that neither the template nor an Agentur-scoped temporary setting supplies
  → `agentur_submission_blocked` for that step, while contact, data collection and profiling
  resolve normally. Both also give a warning for the PL dashboard.
- **Pinned versions** *(provisional, Q36)*: the resolver takes snapshotted template objects;
  `load.ts` reads `templates/<agenturKey>/<version>.json`. Snapshots per project are Slice 2.
- A domain helper `projectActivationBlockers(project, waves, resolution)` also returns
  `no_entry_wave_with_latest_entry_date` for `ta_tg` projects (Q77); activation itself is
  Slice 2.

#### Base defaults (`packages/domain/config/base-defaults.json`)

| Rule | Basis |
|---|---|
| ASU proof document before TG entry | `statutory` (§111(4) Nr. 4) |
| signed DSV scan | `statutory` (§623 BGB) |
| Kug 200b required fields (RV-Nummer, declarations 16 and 17) | `ba_form` |
| import-required fields (Personalnummer, Nachname, Vorname, Geburtsdatum, Austrittsdatum, Anschrift; PRD F2, provisional) | `operational_default` |

TL 407's required fields come with the form registry in Slice 6 (`ba_form`, from the blank
form's `*` markers). The basis of each base rule is reviewed in PR 1f.

### 5.8 `packages/adapters`: `Clock`

```ts
interface Clock { now(): Date; today(): IsoDate }   // today() in Europe/Berlin
class SystemClock implements Clock {}
class ManualClock implements Clock { set(instant: Date): void; advanceDays(n: number): void }
createClock(env)  // CLOCK=system (default) | fixed:<ISO instant> (dev/test only; refused in production)
```

- `today()` uses `Intl.DateTimeFormat` with `Europe/Berlin` (no Temporal on Node 22).
- **No `Date.now()` / `new Date()`** in `packages/domain`, `packages/config` and
  `apps/api/src/jobs` (a test scans the sources).
- `createApp` gets `clock` injected.

### 5.9 Jobs (`apps/api/src/jobs`, pg-boss, ADR-0011)

- **Setup:** `db:migrate` (and `dist/migrate.js`) installs/migrates the `pgboss` schema as
  `transfer_owner` and (re)applies the grants for `transfer_app` (idempotent). The API starts
  pg-boss as `transfer_app` with migration off when `JOBS_ENABLED=true` (default; `false` in
  tests, which start it explicitly).
- **Schedule:** `lifecycle.sweep` daily at `JOBS_LIFECYCLE_TIME` (Berlin local time, default
  `04:15`; times from 02:00 to 02:59 are rejected because of the DST switches), registered as a
  pg-boss cron with `tz: Europe/Berlin`. It enqueues one `lifecycle.evaluate-project` job per
  project with `singletonKey = <projectId>:<today>`.
- **Catch-up window:** the sweep reads the last completed run from `job_run` and passes the
  days after it up to today, each with its `scheduledAt`, to every project job; when all project
  jobs have finished, it inserts today's `job_run` row (with `scheduled_at` and
  `completed_at`). A failed sweep writes no row, so the next run covers the missed days; a
  completed day is never re-evaluated.
- **Per-project job:** runs `planSystemTransitions` per participation and applies each change
  through the status service as `system` (`system_job`, `job_id`, `details.entryKind`).
  Idempotent: the planner plans nothing for moved participations, and compare-and-set rejects a
  concurrent duplicate.
- **Payloads carry IDs and dates only** (Zod payload schema per job; a test checks it). Logs:
  job name, job id, project id, counts. Never free text.
- Retries with backoff (`retryLimit: 3`); failures visible in `pgboss` and the log.
- **`pnpm jobs:lifecycle [--today YYYY-MM-DD]`** runs the sweep once (dev, CI, demos; `--today`
  uses a `ManualClock`, refused with `NODE_ENV=production`).
- pg-boss's tables are outside the data catalog test; ADR-0011 excludes them from participant
  retention.

### 5.10 Database, data catalog and seed

| Table | Columns (main) | `retentionClass` | `dataClass` | Participant data |
|---|---|---|---|---|
| `project_entry_wave` (new) | `id`, `project_id` (FK, not null), `code`, `name`, `signing_deadline`, `default_tg_start`, `default_tg_end`, `latest_entry_date` (all `date`, nullable while draft); unique `(project_id, code)`; `CHECK default_tg_start ≤ default_tg_end`; only for `ta_tg` projects (checked in the functions and the domain) | `project_master` | `internal` | no |
| `participation` (new) | `id`, `project_id` (FK, not null), `entry_wave_id` (FK, null), `status`, `profiling_status`, `dsv_status`, `offer_deadline`, `tg_start`, `tg_end` (overrides, null = wave default), `tg_entry_date`, `exit_date`, `withdrawn_on`, `profiling_done_on` (all `date`), `end_reason`, `end_reason_secondary end_reason[]`, `profiling_exception_status`, `profiling_exception_reason_code`, `profiling_exception_requested_by`, `profiling_exception_requested_on`, `profiling_exception_decided_by`, `profiling_exception_decided_on`, `status_version`, `created_at` | **`participation_record`** (new): ADR-0008 rules; non-signer clock from `withdrawn_on` (90 days *assumed*, Q77); `unset` in code until the DPO confirms (Slice 7) | `confidential` | yes |
| `audit_event` (new) | section 5.4 | **`audit_log`** (new): 3 years, pseudonymised on deletion of the subject; evidence-set entries follow it; *verify* Q3; `unset` until Slice 7 | `confidential` | yes |
| `lifecycle_edge` (new) | `track`, `from_value`, `to_value`, `kind` (pk), `actors` | **`reference_data`** (new): no personal data, never touched by the retention job | `internal` | no |
| `job_run` (new) | `job_name`, `run_date` (pk), `scheduled_at`, `completed_at` | `reference_data` | `internal` | no |

- `CHECK`s on `participation`: `tg_start ≤ tg_end`; `offer_deadline ≤ tg_start` when both set;
  `dsv_status <> 'not_offered'` ⇒ `entry_wave_id` set; `end_reason` set exactly for
  `withdrawn`/`exited`; `withdrawn_on` exactly for `withdrawn`; `tg_entry_date` for
  `active_in_tg`/`exited`; `exit_date` for `exited`; `profiling_done_on` exactly for
  `profiling_done`; the exception decider differs from the requester.
- **Migration of Slice 0 data:** one wave `W1` per existing `ta_tg` project from its
  `signing_deadline`, `default_tg_start`, `default_tg_end` (`latest_entry_date` null, so it is
  flagged). The domain reads wave dates only; Slice 2 moves the project form to waves and drops
  the old project columns.
- **Seed (synthetic only):** "Restrukturierung Werk Nord" gets two waves with
  `latest_entry_date`; about 15 participations cover every main status, each track status, the
  exception states and every flag case; three in the `ta_only` project. No names. Created and
  moved **through the functions** as `system` / `seed` (exception approvals by a seeded regional
  operations manager), so every seeded state has its audit trail. Idempotent by fixed UUIDs.
  The seed adds one synthetic staff user with the new org role.
- **Generated tables** (`pnpm generate`, drift-checked in `pnpm verify`):
  `docs/domain/generated/lifecycle-transitions.md` (every edge and operation with actors, roles,
  entry kinds and guards) and `docs/domain/generated/access-matrix.md` (role × category × mode ×
  phase × action → decision, with every `undecided` cell and its question).

## 6. Commands (new or changed)

| Command | What it does | PR |
|---|---|---|
| `pnpm test:coverage` | `vitest run --coverage` with **100 % thresholds** on `packages/domain/src/{lifecycle,eligibility,access,completeness}/**`, `packages/domain/src/dates.ts`, `packages/config/src/resolve.ts`; CI runs it in the Node 24 test leg | 1b |
| `pnpm generate` | all generators: `api:generate`, the config JSON Schema, the two docs tables | 1b, 1d, 1f |
| `pnpm verify` | `typecheck`, `lint`, `test:coverage`, `generate` + `git diff --exit-code` on generated paths | 1b |
| `pnpm jobs:lifecycle [--today YYYY-MM-DD]` | runs the lifecycle sweep once | 1h |
| `pnpm db:migrate` | also installs/migrates the `pgboss` schema and applies its grants | 1h |

New environment variables (`.env.example`, PR 1h): `JOBS_ENABLED` (`true`),
`JOBS_LIFECYCLE_TIME` (`04:15`, Berlin), `CLOCK` (`system`); `DATABASE_JOBS_URL` only on the S2
fallback.

## 7. Acceptance criteria

U = unit, I = DB/API integration, CI = workflow, R = review.

### Lifecycle and eligibility (PRs 1b, 1c)
- [ ] **AC-1** Every `(track, from, to)` pair (10² + 5² + 5²) has a listed expected result; the
      allowed set equals the edge table in 5.3; all others are `no_edge`. (U `lifecycle/edges.test.ts`)
- [ ] **AC-2** Tracks move only in `informed`; the DSV track never moves in `ta_only`; with an
      approved exception, profiling moves forward and can be declined in `active_in_tg`; nothing
      moves after a terminal status. (U `lifecycle/track-activity.test.ts`)
- [ ] **AC-3** Actors and entry kinds: scheduled entry and catch-up only `system`, reconciliation
      only `user`; system-only edges reject `user`; user-only edges reject `system`. (U)
- [ ] **AC-4** TG entry, the three cases: every combination of {DSV fully executed, ASU with
      proof, profiling done / approved exception} × fact valid before / on / after `tgStart` ×
      recorded before / after `scheduledAt(tgStart)` × entry kind. Automatic kinds need valid by
      `tgStart` **and** recorded by `scheduledAt`; reconciliation needs valid by `tgStart`; a
      fact valid only after `tgStart` never allows entry. (U `lifecycle/tg-entry.test.ts`)
- [ ] **AC-5** The guard list equals 5.3; there is no override path. (U `lifecycle/guards.test.ts`)
- [ ] **AC-6** Profiling exception: request needs a Q81 code and the evidence fact (and the BA
      confirmation for `ba_confirmed_other`); never after `profiling_declined`; only an
      **approved** exception counts for entry, and only from its approval date; the decider must
      differ from the requester; revocation only before entry. (U `lifecycle/profiling-exception.test.ts`)
- [ ] **AC-7** Waves and offers: no offer without a wave; the wave can't change after the first
      offer; the first offer uses the wave deadline; re-offers need an explicit `offerDeadline` ≤
      `latestEntryDate` and ≤ effective `tgStart`; no offer without any deadline; expiry the day
      after. (U `lifecycle/offer-deadline.test.ts`)
- [ ] **AC-8** Manual withdrawal: `pre_tg` reasons only; with `dsv_signed` it needs the
      cancellation **and** PL confirmation; `exited` needs a `tg` reason; the special-category
      end reason is `reason_not_storable`; `ta_completed` needs `taMeasuresComplete` and PL
      confirmation, not `profiling_done`. (U)
- [ ] **AC-9** Cutoff planner: every combination of main ∈ {`imported`, `contacted`,
      `unreachable`, `informed`} × 5 profiling × 5 DSV × project type × wave/no wave gives the
      primary reason, the secondary list or the right flag; nothing on `latestEntryDate` itself;
      `withdrawnOn = latestEntryDate + 1`; warnings from 14 and 3 days before; participations
      without a wave use the project's final entry date (Q84), `informed` ones are only
      flagged; a wave without `latestEntryDate` → flags only. (U `lifecycle/planner-cutoff.test.ts`)
- [ ] **AC-10** Catch-up: with a window covering N missed days, entries happen with
      `scheduled_entry_catchup` and effective date `tgStart` exactly when facts were valid by
      `tgStart` and recorded by `scheduledAt(tgStart)`; evidence recorded after a **completed**
      run (even on the same day) never causes an automatic entry, only `tg_start_missed`; a
      completed day is not re-evaluated; a second run plans nothing; DSV expiry and cutoff
      withdrawals catch up after an outage. (U `lifecycle/planner-catchup.test.ts`)
- [ ] **AC-11** End-reason correction keeps the terminal status, enforces the phase, and moves a
      system-derived reason to the secondary list. (U)
- [ ] **AC-12** `transferKugEligibility` for every row of the table in 5.3, including the deadline
      day itself, month-end cases, a refusal before completion (anchored at entry), a deadline
      miss followed by completion (still `ba_review_required`) and a recorded determination that
      alters a period. (U `eligibility/transfer-kug.test.ts`, *verify* Q74/Q82)
- [ ] **AC-13** Every consistent state has a derived-status key; `isConsistentState` rejects the
      rest. (U)
- [ ] **AC-14** `asuDueDate` and `addMonths`: the docs' examples and leap years. (U, *verify* Q1)

### Audit and the status functions (PR 1g)
- [ ] **AC-15** As `transfer_app`: `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on `participation`,
      `project_entry_wave`, `audit_event`, `lifecycle_edge` fail with `42501`; `SELECT … FOR
      UPDATE` on `participation` fails; `EXECUTE` on the nine functions works; `PUBLIC` can't
      execute them. (I `db/grants.int.test.ts`)
- [ ] **AC-16** `change_participation_status` writes the column(s) and **exactly one** audit row;
      a rolled-back transaction leaves neither; stale `expected_from` → `stale_status`; an edge
      not in `lifecycle_edge` → `invalid_transition`; `record_audit_event` refuses the lifecycle
      and exception event types; `decide_profiling_exception` refuses the requester as decider.
      (I `db/status-function.int.test.ts`)
- [ ] **AC-17** `lifecycle_edge` equals the domain edge list. (I, drift)
- [ ] **AC-18** Audit `CHECK`s reject inconsistent actors; the table has no free-text column;
      catch-up entries carry `details.entryKind = scheduled_entry_catchup`. (I)
- [ ] **AC-19** Status service: a failed guard writes nothing; two concurrent changes serialize
      (one wins, the other gets `stale_status`). (I `api/participations/status-service.int.test.ts`)
- [ ] **AC-20** The migration turns each Slice 0 `ta_tg` project into one wave with its dates. (I)

### Completeness (PR 1e)
- [ ] **AC-21** Truth tables for `required`, `requiredIf` (`equals`, `exists`), `documentPresent`
      (± `accepted`), including `""`, `[]`, `null`, `false`, `0`; output has keys, never
      values. (U `completeness/engine.test.ts`)
- [ ] **AC-22** Rules with unknown fields or documents, duplicate ids or unknown keys are
      rejected; a rule without `basis` is locked. (U)

### Access (PR 1d)
- [ ] **AC-23** Every cell of data-protection.md's read matrix and write table is an explicit
      expectation and passes; the full enumeration yields exactly one decision per case; every
      case the docs don't cover is `undecided` with its question. (U `access/matrix.test.ts`)
- [ ] **AC-24** Role union: PL + profiler sees section C only for assigned participants;
      consultants get nothing person-level for unassigned participants, only aggregates. (U)
- [ ] **AC-25** Regional operations manager: `audit_metadata` and `aggregated` in their region
      only, every participant-level category `never`, decides exceptions of their region but
      never their own request. (U)
- [ ] **AC-26** `list` never allowed for special-category or highly confidential categories;
      signed documents are `immutable` for writes. (U)
- [ ] **AC-27** Break-glass only where the docs allow it, a grant for exactly one participant,
      category and action, audited and flagged; admins never; participant special-category reads
      need the birth-date check. (U)
- [ ] **AC-28** Transition and operation permissions match Q60/Q80 for every edge and
      operation. (U)
- [ ] **AC-29** Field catalog: every field has a class and category; no special/highly
      confidential field is listable; `customerVisible` is exactly the whitelist; the
      health-related end reason is never in list payloads. (U `fields/catalog.test.ts`)
- [ ] **AC-30** The generated transitions and access tables match the code. (U, drift)

### Config (PR 1f)
- [ ] **AC-31** `base-defaults.json` and both samples validate against the committed JSON Schema,
      which matches the Zod model; base defaults contain no Agentur submission setting. (U)
- [ ] **AC-32** Resolution order, provenance, two-level resolution, templates only adding rules,
      relaxing only `operational_default` rules in overrides, nationwide settings rejected in
      templates/overrides, project-wide regional settings in an override rejected.
      (U `config/resolve.test.ts`, 100 %)
- [ ] **AC-33** Agentur-scoped temporary settings apply only to their Agentur and need source,
      confirmer and date; blockers `project_activation_blocked` and `agentur_submission_blocked`
      as in 5.7. (U)
- [ ] **AC-34** Field-schema profile: allowed keywords compile like hand-written Zod; anything
      else, special/highly confidential custom fields and unknown retention classes are rejected;
      `format: date` rejects `2027-02-31`. (U)
- [ ] **AC-35** A version 2 template file doesn't change resolution for a project pinned to
      version 1. (U)

### Clock and jobs (PRs 1a, 1h)
- [ ] **AC-36** `today()` is the Berlin date around midnight UTC and across both DST switches;
      `scheduledAt(d)` is correct on both DST days and `JOBS_LIFECYCLE_TIME` in 02:00–02:59 is
      rejected; no `Date.now()`/`new Date()` in domain, config and jobs (source scan). (U)
- [ ] **AC-37** pg-boss starts as `transfer_app` on the schema installed by `db:migrate`; the
      nightly schedule is registered with `Europe/Berlin`. (I)
- [ ] **AC-38** With a `ManualClock` and fake facts, the job produces `dsv_expired`, scheduled
      entries, catch-up entries after skipped days (no `job_run` row), and cutoff withdrawals as
      `system`; running it twice adds no status change and no audit row. (I `api/jobs/lifecycle.int.test.ts`)
- [ ] **AC-39** With the Slice 1 facts provider, nobody enters the TG (fail closed). (I)
- [ ] **AC-40** Job payloads contain only IDs and dates; job logs contain no participation data
      and no free text. (U, I)
- [ ] **AC-41** The image smoke test passes with the pg-boss schema installed by
      `node dist/migrate.js`. (CI)

### Platform and data protection
- [ ] **AC-42** Data catalog has `project_entry_wave`, `participation`, `audit_event`,
      `lifecycle_edge`, `job_run`; participant tables have `project_id` FKs. (U)
- [ ] **AC-43** Seeded participations exist only through the functions, each with its audit
      trail; synthetic only. (I, R)
- [ ] **AC-44** `pg-boss@12.38.0` and `@opentelemetry/api@1.9.1` pinned exactly, one copy each,
      no peer warnings; tests pass on Node 22 and 24. (CI)
- [ ] **AC-45** `pnpm test:coverage` enforces the 100 % thresholds in CI. (CI)

### Definition of done (CLAUDE.md) applied to this slice
- Status changes through the audit helper: **the core of this slice** (functions + grants).
- No hard-coded regional rules: regional settings only in templates or Agentur-scoped
  overrides; deadlines are wave data.
- No vendor calls outside adapters: pg-boss is infrastructure on our own Postgres (ADR-0011).
- New personal data: `participation` and `audit_event` have a class, access rules (5.6) and a
  retention class; the other new tables hold no personal data.

## 8. Deliberately left out

| Not in Slice 1 | Why / where it lands |
|---|---|
| Person data, import, duplicate handling | Slice 2 |
| Creating and editing waves, individual date overrides, template snapshots, overrides with approval, project activation, dropping the old project date columns | Slice 2 (project setup); Slice 1 adds the tables, the domain rules and the resolver checks |
| Project membership and assignment tables, region on projects | Slices 2/3; the access function takes them as input |
| API routes for status changes, operations, participations or access; the review and clarification UI | Slices 2, 3, 5 |
| Wiring `decideAccess` into requests, sessions, logins and their audit | Slice 3 |
| Free text (break-glass, exception evidence, BA confirmer) and its encryption | Slice 3 (first writer) / 4b (evidence documents); codes only until then |
| Storing the special-category end reason | Slice 8 (TG exits), with encrypted storage |
| Field-level encryption of participant fields, sensitive endpoints, `sensitive_read` writes | with the first such field (Slices 4a/6) |
| DSV documents, signature dates, ASU records, signed TL 407, cancellation, §110 activities | Slices 6/7/8; guards fail closed (D4) |
| BA/legal determinations table, Transfer-KuG export blocking | Slice 8 (the domain types exist now) |
| `bee_unit` and the Transfer-KuG case (separate from entry waves; several waves may reference one beE), `ta_only` measure groups | Slice 8 / later (round 10); Slice 1 waves carry dates only |
| Customer-notification flag after withdrawal from `dsv_signed` | Slice 7 |
| `self_registered` creation and the 30-day rejection job | Slice 4c |
| Sending reminders, "what's missing" UI, dashboards, escalations | Slice 5 (they call `evaluateCompleteness`, `lifecycleFlags`, `transferKugEligibility`) |
| TL 407 required-field list | Slice 6 (ADR-0009) |
| Retention job, pseudonymisation role, retention periods in executable config | Slice 7, after the DPO confirms (Q3, Q77) |
| Row-level security | pre-pilot gate (ADR-0005) |
| Other adapter interfaces, separate worker, admin UI for templates | their slices (D9), Slice 9 (D7), later (ADR-0004) |

## 9. Doc changes

**In this PR (rounds 7–9):** `docs/decisions/2026-10-16-answers-round-7.md`, `-round-8.md` and
`-round-9.md`; `open-questions.md` (Q60–Q84 answered with their statuses, Q3 note, gate note);
ADR-0005 (gate item for design changes from confirmations);
process-and-lifecycle.md (entry waves and contractual deadlines, cutoff withdrawals and
warnings, the three TG-entry cases, profiling exceptions with approval, three Transfer-KuG
outcomes, `taMeasuresComplete`, no overridable documentary guards, transition permissions,
roles); data-protection.md (classification additions, roles, assignment, break-glass and
four-eyes, regional operations manager, evidence-set phase, participant documents, write
permissions, deletion clock from `withdrawnOn`); regional-variation.md (deadlines are wave data,
rule bases, missing templates, Agentur-scoped temporary settings); glossary; CLAUDE.md rule 5;
ADR-0008 note; PRD F8, roadmap, architecture overview and ADR-0011 (cutoff instead of grace
period).

**In the implementing PRs:**
- **1a:** S1 note in ADR-0004, S2 note in ADR-0011; CLAUDE.md "Repo layout" (`config`,
  `adapters` with `Clock` only).
- **1b/1c:** process-and-lifecycle.md links the generated transitions table.
- **1d:** data-protection.md: access categories and a link to the generated access matrix.
- **1f:** regional-variation.md: the concrete template model replaces the sketch; ADR-0004
  amendment (Zod-authored model exported as JSON Schema, the profile, rule bases, blockers,
  Agentur-scoped overrides).
- **1g:** ADR-0002 amendment (`SECURITY DEFINER` functions, `lifecycle_edge`, no FK from
  `audit_event` to `participation`, no free text before encryption, grants, entry waves);
  retention classes `participation_record`, `audit_log`, `reference_data` in
  data-protection.md / ADR-0008.
- **1h:** ADR-0011 amendment (schema install, runtime role, in-process workers, time zone,
  `singletonKey`, catch-up window and `job_run`); architecture overview (jobs); CLAUDE.md
  "Commands"; `.env.example`; `.claude/settings.json` allowlist; README status.

## 10. Risks

| Risk | Mitigation |
|---|---|
| The Transfer-KuG rules (Q74/Q82, *verify*) change after implementation | Isolated pure function with table-driven tests; an answer changes a table, not the design. |
| Reading the app as deciding employment or eligibility | D4 wording in code and docs: the app records effective dates and reports outcomes; it doesn't create the employment relationship or decide a benefit. |
| Catch-up enters someone on evidence entered late | Automatic kinds use a snapshot as of the scheduled run time (`recordedAt ≤ scheduledAt`); completed days are never re-evaluated; later evidence goes through the audited, reviewed reconciliation (AC-4, AC-10). |
| A failed sweep looks like success | `job_run` is written only after every project job finished; the next window covers the gap. |
| `z.fromJSONSchema` is experimental upstream | Restricted profile validated first; spike S1 with the Ajv fallback; contained in `field-schema.ts`. |
| Zod's JIT probe raising CSP violations in the SPAs | `z.config({ jitless: true })` (S1; enforced by the e2e CSP check from Slice 4a). |
| pg-boss needs more than DML at runtime, or a release breaks us | Spike S2 with the `transfer_jobs` fallback; exact pins, deliberate upgrades. |
| Logic duplicated between TypeScript and SQL drifts | SQL checks only the edge list (kept equal by a test), invariants and the four-eyes rule; guards live only in TypeScript. |
| `SECURITY DEFINER` functions as an attack surface | Fixed `search_path`, no dynamic SQL, `EXECUTE` revoked from `PUBLIC`, inputs checked, grant tests. |
| Two sources of project dates during the transition (Slice 0 columns vs. waves) | The domain reads waves only; the migration copies the dates; Slice 2 drops the old columns. |
| 100 % coverage tempts tests that only touch lines | Table-driven expectations from the docs; generated tables reviewed by people. |
| Free text leaking sensitive details | None stored in Slice 1; later only encrypted, never in logs, lists or job payloads (Q66). |
| Deadlines off by one day | Inclusive deadlines tested at the boundary (AC-7, AC-9, AC-10, AC-12). |

## 11. Approval

Approved in rounds 7–9. Implementation starts with PR 1a on a new branch after this PR is
merged. The DPO/legal confirmations are pre-pilot gates (section 0).
