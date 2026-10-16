# Slice 1 — Domain core: plan

- Status: **Approved with changes** (round 7, 2026-10-16). This revision incorporates the
  answers to D1–D10 and Q60–Q76; follow-ups Q77–Q83 are open (section 0).
- Date: 2026-10-15, revised 2026-10-16
- Roadmap: [Slice 1](../roadmap.md#slice-1--domain-core)
- Builds on: [Slice 0](slice-0.md) (merged, PRs 0a–0d)
- Decisions: [round 7](../decisions/2026-10-16-answers-round-7.md)
- Relevant ADRs: 0002 (status writes enforced in the DB, append-only audit, `project_id`), 0004
  (fixed lifecycle core, regional templates, base defaults, completeness rules), 0006 (adapters,
  `Clock`), 0007 (access model in Slice 1), 0008 (retention per item), 0011 (pg-boss, `system`
  actor, injected `Clock`)
- Domain docs: [process-and-lifecycle.md](../domain/process-and-lifecycle.md),
  [data-protection.md](../domain/data-protection.md) (access matrix, write permissions),
  [regional-variation.md](../domain/regional-variation.md), [glossary.md](../domain/glossary.md)

## 0. Decisions and open follow-ups

### Decisions (round 7)

| # | Topic | Decision |
|---|---|---|
| D1 | PR shape | **8 PRs, 1a–1h** (section 4), tests first, each green on its own. |
| D2 | Status writes | Only narrowly scoped **`SECURITY DEFINER` functions** write statuses and audit events. `transfer_app` has no direct participation or audit writes. Fixed `search_path`, `EXECUTE` revoked from `PUBLIC`, no dynamic SQL, grants tested. |
| D3 | Tables | Only minimal participation, lifecycle, audit (and pg-boss) tables. Personal data and memberships come later. |
| D4 | Missing evidence | Missing DSV, ASU and profiling evidence **fails closed** in Slice 1. A temporary implementation state, **not** a rule letting the app decide whether employment legally exists. |
| D5 | JSON Schema engine | Restricted **`z.fromJSONSchema`** profile, subject to spike S1; fallback **`ajv@8.20.0` server-only**. |
| D6 | Roles | **Changed:** project-specific roles, **zero or more per person and project**; permissions are the **union**; profiler access still needs the participant assignment. |
| D7 | Jobs | pg-boss **in the API process**; a separate worker is a Slice 9 scaling decision. |
| D8 | Sample templates | Fictional Agenturen only; never invented rules for a real Agentur. |
| D9 | Adapters | Only **`Clock`** now. |
| D10 | Docs gaps | **Fail safe:** unknown access is denied, unknown automatic transitions don't run, operational exceptions are flagged. Answers replace these defaults as they come in. |

Dependencies: `pg-boss@12.38.0` and its peer **`@opentelemetry/api@1.9.1` added explicitly**;
`ajv@8.20.0` only on the S1 fallback; exact versions, pg-boss upgraded only in deliberate PRs.

### What the answers changed in this plan

- **The fixed "signing deadline + 90 days" grace period is gone.** Deadlines are contractual:
  project `signingDeadline` for the first offer, a participation **`offerDeadline`** for
  re-offers, and a project **`latestEntryDate`**. System withdrawals run at the **final
  admission cutoff** (the day after `latestEntryDate`), only when that date is recorded, and
  now also cover `imported` (`never_contacted`) and `contacted` (`not_informed`) (Q69, Q70).
- **No guard is overridable** any more (Q71); the profiling exception is the only built-in
  alternative. The `with_reason` override class is not built.
- **No automatic late TG entry** (Q68): entry only on the TG start date; afterwards the PL sets a
  new start date or performs an audited **reconciliation**. Guard facts are evaluated **as of
  the TG start date**.
- **Employment and Transfer-KuG eligibility are separate** (Q74, verify): a derived
  `transferKugEligibility` and compliance flags for the profiling exception.
- **Several project roles per person**, union of permissions (D6/Q61); **strict assignment** for
  consultants (Q62); **write rules** are now in scope of the access matrix (Q65, assumed).
- **Free-text reasons need encryption** (Q66), so Slice 1 stores **reason codes only**.
- **Config:** rule classification (`statutory` / `ba_form` / `operational_default`) with
  locking (Q75); **blocking** resolution when an Agentur template is missing (Q76).
- The catch-up window and its `job_run` table are dropped (strict reading of Q68).

### Follow-up questions (in `open-questions.md`) and what Slice 1 builds meanwhile

| Q | Gap | Built in Slice 1 until answered |
|---|---|---|
| Q77 🔒 | What replaces the grace period: do all system withdrawals run the day after `latestEntryDate`; do return arrows close then; are they open without a `latestEntryDate`; from when does non-signer deletion count? | The proposed reading (section 5.3): cutoff = `latestEntryDate + 1`; return arrows close after `latestEntryDate`, stay open (manual) without one. The retention period stays `unset`. |
| Q78 | Warning lead time before cutoff withdrawals | **No automatic cutoff withdrawal**; the would-be withdrawals are flagged `cutoff_withdrawal_pending`. |
| Q79 | Entry waves | One wave per project (dates on the project). |
| Q80 🔒 | Who reviews break-glass and profiling exceptions; review after the fact? | Events are flagged for review in the audit; no reviewer role yet. |
| Q81 | Profiling-exception reason codes | Only the code `other`; no free text. |
| Q82 🔒 | Transfer-KuG exclusion details | Excluded from entry until profiling is completed; after a refusal, excluded from entry with no end. |
| Q83 | Does `ta_completed` still need `profiling_done`? | Yes (current diagram) + PL confirmation. |

Still `assumed` and built as answered: Q61–Q67 (DPO to confirm). Still `verify`: Q74.

## 1. Goal

Freeze the domain core so that every later slice builds on tested rules instead of re-deciding them:

```
packages/domain   lifecycle (main status + profiling track + DSV track, canTransition, guards,
                  system planner), Transfer-KuG eligibility, audit event model, completeness
                  engine, field catalog, access matrix               — pure, no I/O, 100 % covered
packages/config   regional template model (JSON Schema), resolver, base defaults, 2 samples
packages/adapters Clock
packages/db       participation, audit_event, lifecycle_edge, the status functions, grants
apps/api          status service (the only TypeScript caller of the status functions),
                  pg-boss with the nightly lifecycle job
```

**Done when** (roadmap): tests document every allowed and forbidden transition and every access
rule. Detailed acceptance criteria are in section 7. There is no new UI; the "demo" is the two
generated tables (transitions and access matrix, section 5.10) and a nightly run on seed data
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

### Dependencies (checked against npm on 2026-10-15, approved in round 7)

| Package | Pin | Released | Notes |
|---|---|---|---|
| `pg-boss` | **`12.38.0`** | 2026-10-13 | MIT. `engines.node >=22.12.0`. Depends on `pg ^8.23.1` (we pin `pg@8.23.1`), `cron-parser`, `rrule-temporal`, `serialize-error`. Frequent releases: pinned, upgraded only in deliberate PRs. In `@transfer/api` (runtime) and `@transfer/db` (schema install). |
| `@opentelemetry/api` | **`1.9.1`** | 2026-10 | Apache-2.0. Non-optional peer of pg-boss; **added explicitly** next to pg-boss. |
| `ajv` | `8.20.0` *(S1 fallback only)* | 2026-04-24 | MIT. |

No other new dependency (exhaustive tests instead of `fast-check`; coverage uses the existing
`@vitest/coverage-v8@5.0.5`).

### Other facts

- **`zod@4.6.7` ships `z.fromJSONSchema()`** (marked experimental upstream), hence spike S1.
- **Zod 4 probes `new Function`** for fast parsing; under our CSP the probe alone can raise a
  violation, which fails the Playwright suite. The SPAs set `z.config({ jitless: true })`
  before using config-driven schemas (Slice 4a); S1 checks it.
- **`SELECT … FOR UPDATE` needs `UPDATE` privilege** on some column, which `transfer_app` won't
  have on `participation` (D2). Row locking therefore goes through a function too (5.4).
- `ta_only` projects have no signing deadline and no `latestEntryDate`, so no system withdrawal
  applies to them; they end through the PL (Q73).

## 3. Spike (first part of PR 1a)

**Timebox:** half a working session. Results go into an ADR note (S1 → ADR-0004, S2 → ADR-0011).

| # | Check | Fallback |
|---|---|---|
| S1 | `z.fromJSONSchema` (zod 4.6.7) compiles the field-schema profile (5.7) and behaves like hand-written Zod for every allowed keyword; `format: date` rejects `2027-02-31` and `2027-02-29`; with `z.config({ jitless: true })` a Vite build validating a compiled schema in the browser raises **no CSP violation** under the API's CSP. | `format: date` compiled to our own `isoDate` if only that keyword differs; otherwise **`ajv@8.20.0` server-only** (`ajv/dist/2020`, strict mode). |
| S2 | `pg-boss@12.38.0` with `@opentelemetry/api@1.9.1`: (a) its schema is created/migrated by `db:migrate` as `transfer_owner`; (b) it then starts as `transfer_app` with schema migration off and only explicit grants; (c) a cron schedule with `tz: "Europe/Berlin"` registers and fires; (d) Node 22.22 and 24; (e) `--frozen-lockfile` install without peer warnings; (f) `pnpm deploy --legacy` puts both into the image and the smoke test passes. | (b) fails → a dedicated **`transfer_jobs`** role owns the `pgboss` schema with its own `DATABASE_JOBS_URL`; app tables unaffected. |

## 4. PR series

Tests first in every PR. Generated files (Drizzle snapshots, `openapi.json`, `schema.d.ts`, the
generated JSON Schema and docs tables) don't count towards ~400 lines; a PR well over ~500
hand-written lines is split.

| PR | Content | Depends on | Ends with |
|---|---|---|---|
| **1a** `feat: domain vocabulary, dates and the Clock adapter` | Spikes S1/S2. `packages/adapters` with `Clock` (5.8). Domain enums: statuses, `Track`, `Step` (+ scope), `EndReason` (+ phase, + data class per value), `ActorType`, `AuditEventType`, `OrgRole`, `ProjectRole`, `AccessCategory`, `ProfilingExceptionReason`. Date helpers (`addDays`, `addMonths` with month-end clamp, `asuDueDate`, *verify Q1*). Field catalog (5.6). Docs: ADR notes for S1/S2, CLAUDE.md layout. | — | vocabulary + Clock tested |
| **1b** `feat(domain): lifecycle transitions and guards` | Edge table, track activity, `canTransition`, guards with dated facts, offer deadlines, reconciliation, profiling exception set/revoke, end-reason correction, derived overall status, generated transitions table, 100 % coverage thresholds. | 1a | every (track, from, to) documented |
| **1c** `feat(domain): system planner and Transfer-KuG eligibility` | `planSystemTransitions` (`dsv_expired`, TG entry on the start date, cutoff withdrawals), lifecycle and compliance flags, `transferKugEligibility`. | 1b | every cutoff combination documented |
| **1d** `feat(domain): field-level access matrix` | `decideAccess` (multi-role union × assignment × category × mode × phase × action incl. `write`), transition permissions (Q60), list-payload rule, break-glass scope, generated access table. | 1a | every access rule documented |
| **1e** `feat(domain): completeness engine` | Rule types with classification, presence semantics, `evaluateCompleteness`, rule validation against the field catalog. | 1a | truth tables pass |
| **1f** `feat(config): template model, resolver and base defaults` | `packages/config`: Zod model → committed JSON Schema (+ drift), field-schema profile, nationwide vs. regional settings, locked and relaxable rules, two-level resolver with provenance and blockers, `base-defaults.json`, two sample templates, pinned-version loading. | 1e | resolution 100 % covered |
| **1g** `feat(db): participation, audit and the status functions` | Tables, enums, `project.latest_entry_date`, the seven functions, grants, `lifecycle_edge` drift test, data catalog entries, seed, `apps/api` status service with the fail-closed facts provider. | 1b, 1c, 1d | grant and atomicity tests pass |
| **1h** `feat(api): pg-boss and the nightly lifecycle job` | pg-boss setup (schema install, grants, in-process start), schedule, sweep + per-project job, `pnpm jobs:lifecycle`, idempotency tests with a manual clock, image smoke. Docs: CLAUDE.md commands, `.env.example`, overview, ADR-0011 note, settings allowlist. | 1c, 1g | **slice done** |

1b/1d/1e can run in parallel after 1a.

## 5. Design

### 5.1 Repo layout after Slice 1

```
packages/
  domain/
    config/base-defaults.json        nationwide defaults (ADR-0004), validated by packages/config
    src/lifecycle/                   enums, edges, canTransition, guards, planner, derived status
    src/eligibility/                 transferKugEligibility
    src/audit/                       audit event schemas (Zod, discriminated by type)
    src/completeness/                rules and engine
    src/fields/                      field catalog
    src/access/                      decideAccess, transition permissions
    src/dates.ts                     date arithmetic on ISO dates (no Date.now)
  config/                            NEW @transfer/config (depends on @transfer/domain)
    schema/regional-template.schema.json   generated from the Zod model, committed
    templates/beispielstadt-nord/1.json    sample (D8)
    templates/beispielstadt-sued/1.json    sample (D8)
    src/model.ts · field-schema.ts · resolve.ts · load.ts
  adapters/                          NEW @transfer/adapters: src/clock/ (D9)
  db/                                + participation, audit_event, lifecycle_edge, functions, grants
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
| `EndReason` (one enum, `phase`, Q34) | `pre_tg`: `declined_profiling`, `declined_dsv`, `no_response`, **`never_contacted`**, **`not_informed`**, `placed_direct`, `self_employed`, `retirement`, `other_measure`, `deceased`, `other`; `tg`: `placed_permanent`, `placed_fixed_term`, `self_employed`, `retirement`, `apprenticeship_or_study`, `max_duration_reached`, `own_termination_without_job`, `terminated_by_tg`, `long_term_illness_reduced_earning_capacity` (**special category**, Q66), `deceased`, `other`. The planner derives only `declined_dsv`, `declined_profiling`, `no_response`, `never_contacted`, `not_informed`. |
| `ActorType` | `user`, `participant`, `system` |
| `OrgRole` / `ProjectRole` | `admin`, `regional_admin` / `project_lead`, `consultant`, `back_office` — a person holds a **set** of project roles per project (D6) |
| `ProfilingExceptionReason` | `other` until Q81 is answered |

### 5.3 Lifecycle (`packages/domain/src/lifecycle`)

#### Dates the lifecycle uses

| Date | Level | Meaning |
|---|---|---|
| `signingDeadline` | project | deadline of the **first** DSV offer (Sozialplan/DSV) |
| `offerDeadline` | participation | deadline of a **re-offer**; required for a re-offer; ≤ `latestEntryDate` and ≤ `tgStart` (Q69) |
| `latestEntryDate` | project (`ta_tg` only) | last possible beE entry; **cutoff** = the day after *(provisional, Q77)* |
| `tgStart`, `tgEnd` | participation | planned TG period (default from the project, Slice 2) |
| `tgEntryDate`, `exitDate` | participation | effective employment dates, set by the status function |
| `profilingDoneOn` | participation | effective date of `→ profiling_done` |

All deadlines are **inclusive**: expiry happens the following day (Q69). The *effective* offer
deadline is `offerDeadline ?? project.signingDeadline`; if both are missing, no offer can be
recorded (Q69: the system never invents a deadline).

#### Edges

Encoded as data (`edges: Edge[]`, each `{ track, from, to, actors, kind }`): the arrows of
process-and-lifecycle.md plus manual withdrawal and reconciliation. Everything else is `no_edge`.

| Track | From → to | Actors | Guards / notes |
|---|---|---|---|
| main | *(create)* → `imported` | user | import / manual (Slice 2) |
| main | *(create)* → `self_registered` | participant | QR registration (Slice 4c) |
| main | `self_registered` → `imported` / `rejected` | user (+ system for `rejected`) | Slice 4c |
| main | `imported` → `contacted`; `contacted` → `informed` / `unreachable` | user | |
| main | `unreachable` → `contacted` | user | `before_cutoff` |
| main | `informed` → `active_in_tg` | **system** (kind `scheduled_entry`) | TG entry guards; `today = tgStart` |
| main | `informed` → `active_in_tg` | user (kind `reconciliation`, Q68) | TG entry guards **as of `tgStart`**; `today > tgStart`; flagged for review |
| main | `informed` → `ta_completed` | user | `ta_completion` |
| main | `active_in_tg` → `exited` | user | `tg` reason + exit date |
| main | `imported` / `contacted` / `unreachable` / `informed` → `withdrawn` | user | manual, `pre_tg` reason; `withdrawal_after_dsv_signed` |
| main | `imported` / `contacted` / `unreachable` / `informed` → `withdrawn` | system | cutoff withdrawal (planner) |
| profiling | `not_started` → `profiling_accepted` / `profiling_declined` | user | |
| profiling | `profiling_accepted` → `profiling_in_progress` / `profiling_declined` | user | |
| profiling | `profiling_in_progress` → `profiling_done` | user | `tl407_signed` |
| profiling | `profiling_in_progress` → `profiling_declined` | user | |
| profiling | `profiling_declined` → `profiling_accepted` | user | `before_cutoff` |
| dsv | `not_offered` → `dsv_offered` | user | `dsv_generated`, `offer_deadline_valid` |
| dsv | `dsv_offered` → `dsv_signed` | user | `dsv_scan_received` |
| dsv | `dsv_offered` → `dsv_declined` | user | |
| dsv | `dsv_offered` → `dsv_expired` | **system** | today > effective offer deadline |
| dsv | `dsv_declined` / `dsv_expired` → `dsv_offered` | user | `before_cutoff`, `offer_deadline_valid` (explicit `offerDeadline` required) |

Besides status edges, three audited **operations** that don't change a status: set and revoke
the profiling exception, and correct an end reason (below). "user" means staff; *which* roles
may take which edge is `mayPerformTransition` (5.6), not `canTransition`.

#### Track activity

- Tracks move only while the main status is `informed`; the DSV track exists only in `ta_tg`.
- **After TG entry with the profiling exception** (Q74, verify): forward profiling moves
  (`not_started → profiling_accepted → profiling_in_progress → profiling_done`) **and** a
  refusal (`→ profiling_declined` from any open state) can be recorded while `active_in_tg`.
- After a terminal main status, nothing moves.

#### `canTransition(track, from, to, context)`

```ts
type TransitionContext = {
  projectType: ProjectType;
  current: { status: MainStatus; profilingStatus: ProfilingStatus; dsvStatus: DsvStatus };
  actor: { type: "user" } | { type: "participant" } | { type: "system" };
  kind?: "scheduled_entry" | "reconciliation";   // only for informed → active_in_tg
  today: IsoDate;                                  // from the Clock, Europe/Berlin
  project: { signingDeadline: IsoDate | null; latestEntryDate: IsoDate | null };
  participation: { tgStart: IsoDate | null; offerDeadline: IsoDate | null;
                   profilingException: boolean };
  facts: GuardFacts;            // dated facts; absent facts are false (D4)
  newOfferDeadline?: IsoDate;   // for → dsv_offered
  endReason?: EndReason;        // for → withdrawn / → exited
  confirmed?: boolean;          // explicit PL confirmation where a rule needs one
};

type TransitionCheck =
  | { ok: true; flagForReview: boolean }
  | { ok: false; code: "no_edge" | "track_inactive" | "actor_not_allowed" | "reason_required"
                      | "reason_wrong_phase" | "reason_not_storable" | "guard_failed";
      failedGuards: GuardId[] };
```

Evaluation order: edge exists → track active → actor type and kind allowed → end reason
present, of the right phase, and storable (`long_term_illness_reduced_earning_capacity` is
refused until encrypted storage exists, Slice 8) → guards. **No override parameter exists**
(Q71).

#### Guards (none overridable, Q71)

`GuardFacts` carry dates (e.g. `dsvFullyExecutedOn`, `asuRegisteredWithProofOn`,
`tl407SignedOn`), so a guard can be evaluated **as of** a day. A test asserts this list exactly.

| Guard | Transition | Passes when | Source |
|---|---|---|---|
| `dsv_fully_executed` | TG entry | all three signature dates set, the last ≤ `tgStart` | docs (§623 BGB) |
| `asu_registered_with_proof` | TG entry | ASU with proof, any channel, registered ≤ `tgStart` | docs (§111(4) Nr. 4) |
| `profiling_done_or_exception` | TG entry | `profilingDoneOn ≤ tgStart`, or the exception is set (never with `profiling_declined`) | docs (Q17, Q74) |
| `tg_start_date` | TG entry | `scheduled_entry`: `today = tgStart`; `reconciliation`: `today > tgStart` | Q68 |
| `ta_completion` | `→ ta_completed` | `ta_only`, `profiling_done` (Q83), PL confirms; activity evidence once activities exist (Slice 8) | Q73 |
| `withdrawal_after_dsv_signed` | `→ withdrawn` with `dsv_signed` | three-party cancellation present **and** PL confirms | docs (*verify* Q46), Q71 |
| `before_cutoff` | the four return arrows | no `latestEntryDate`, or `today ≤ latestEntryDate` | Q69, *Q77* |
| `offer_deadline_valid` | `→ dsv_offered` | effective deadline exists, `≥ today`, `≤ latestEntryDate` and `≤ tgStart` when set; re-offers need an explicit `offerDeadline` | Q69 |
| `tl407_signed` | `→ profiling_done` | signed TL 407 (participant and profiler) present | docs |
| `dsv_generated` | `not_offered → dsv_offered` | a DSV document was generated | docs |
| `dsv_scan_received` | `→ dsv_signed` | scan stored and receiver recorded | PRD F8 |

The facts behind the document guards are absent in Slice 1 (D4); the domain tests cover both
outcomes with explicit facts. A late admission after the cutoff is never a guard decision: the
PL records a new approved deadline/start date first (Slice 2).

#### Operations without a status change

| Operation | Who (Q60) | Rule |
|---|---|---|
| **Set profiling exception** | PL | main `informed`, profiling not `profiling_done` or `profiling_declined`, reason code (Q81); flagged for the four-eyes review (Q63/Q80) |
| **Revoke profiling exception** | PL | only before TG entry; after entry the exception is closed by `profiling_done` |
| **Correct end reason** (Q72) | PL | on `withdrawn`/`exited`; new primary reason of the same phase; a system-derived previous reason moves to the secondary list; the terminal status is not reopened |

#### System planner (`planSystemTransitions`, PR 1c)

A pure function: `(participation, project, facts, today, config) → { changes[], flags[] }`. It
applies its rules in order on the updated snapshot; a second run on the same day plans nothing.

1. **`dsv_expired`:** `dsv_offered` and `today >` effective offer deadline. Effective date =
   deadline + 1.
2. **TG entry:** `informed`, `today = tgStart`, all TG guards pass as of `tgStart` →
   `active_in_tg`, effective date and `tgEntryDate` = `tgStart`. Still `informed` with
   `today > tgStart` → flag **`tg_start_missed`**: the PL records a new start date or reconciles
   (Q68). There is **no automatic late entry**, not even after a missed nightly run.
3. **Cutoff withdrawals** (`ta_tg`, `latestEntryDate` set, `today > latestEntryDate`):

   | Precedence | Situation | Reason |
   |---|---|---|
   | 1 | `dsv_declined` | `declined_dsv` |
   | 2 | `profiling_declined` and DSV not signed | `declined_profiling` |
   | 3 | `dsv_expired`, or main `unreachable` | `no_response` |
   | — | main `imported` | `never_contacted` |
   | — | main `contacted` | `not_informed` |

   - Primary reason by precedence; all other applicable reasons go to the secondary list.
   - **Until Q78 sets the warning lead time, these don't run**: each would-be withdrawal is the
     flag **`cutoff_withdrawal_pending`** with its derived reason (D10). Once Q78 is answered,
     `cutoff_approaching` is flagged that many days before, and the withdrawals run.
   - Flags instead of withdrawal: `dsv_signed` + `profiling_declined` →
     `conflict_dsv_signed_profiling_declined`; `informed` + `not_offered` → `dsv_never_offered`.
4. **No `latestEntryDate`** on a `ta_tg` project with participations before TG entry → project
   flag **`latest_entry_date_missing`**; nothing moves (Q70).
5. **Compliance flags** after entry (Q74): `profiling_exception_deadline_missed` (exception,
   not done, `today > addMonths(tgEntryDate, 1)`), `profiling_declined_after_entry`. Both are
   immediate escalations, never a status change.

Flags are **derived, not stored** (`lifecycleFlags(snapshot, project, today)`); the PL dashboard
(Slice 5) calls it.

#### Transfer-KuG eligibility (`packages/domain/src/eligibility`, PR 1c; *verify* Q74/Q82)

`transferKugEligibility(participation) → { employment, eligibleFrom, excluded[] }`, derived,
never stored:

| Situation | `eligibleFrom` | Excluded period |
|---|---|---|
| not entered | — | — |
| `profilingDoneOn ≤ tgEntryDate` | `tgEntryDate` | none |
| exception, profiling completed after entry | `profilingDoneOn + 1` | `tgEntryDate` … `profilingDoneOn` |
| exception, profiling not yet completed | — | `tgEntryDate` … open (`profiling_pending`) |
| profiling declined after entry | — | `tgEntryDate` … open (`profiling_declined`, Q82) |

`employment` is `{ from: tgEntryDate, to: exitDate | null }`, independent of eligibility. The
app derives and reports; KuG billing stays outside the MVP.

#### Derived overall status

`deriveOverallStatus(main, profiling, dsv)` returns one i18n key per *consistent* combination;
`isConsistentState` rejects impossible ones (e.g. `imported` with `profiling_in_progress`,
`ta_only` with a DSV status other than `not_offered`).

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
| `reason_code` | `text null` | end reason, exception reason, `reconciliation`, … |
| `effective_date` | `date null` | the business date (TG entry, deadline + 1, …) |
| `occurred_at` | `timestamptz not null default now()` | DB time, not settable by the app |
| `request_id`, `job_id` | `text null` | correlation |
| `details` | `jsonb not null default '{}'` | IDs and codes only, shape per type in Zod (secondary reasons, previous reason, …) |
| `flagged_for_review` | `boolean not null default false` | reconciliations, profiling exceptions, later break-glass |

- **No free-text column in Slice 1.** Override/break-glass text is highly confidential and the
  exception text special category (Q66): both need field-level encryption, which comes with the
  first writer (break-glass, Slice 3). Slice 1 writes codes only.
- `CHECK`s keep the actor consistent (user ⇒ staff id; participant ⇒ participation id; system ⇒
  `system_job`; `on_behalf_of` ⇒ user).
- **Reviews are new events** (`review_recorded` → reviewed `id`), never updates.
- Event types (enum created now): `participation_created`, `status_changed`,
  `profiling_exception_set`, `profiling_exception_revoked`, `end_reason_corrected` (Slice 1);
  `sensitive_read`, `break_glass_access`, `document_opened`, `warning_confirmed`,
  `export_created`, `config_override_changed`, `review_recorded` (Slices 3–9).
- Audit entries without a project (logins, template publication) get their own table in
  Slice 3.

#### Functions (hand-written migration, owner `transfer_owner`)

All `SECURITY DEFINER`, `SET search_path = pg_catalog, public`, no dynamic SQL (explicit branches
per field), `REVOKE EXECUTE … FROM PUBLIC`, `GRANT EXECUTE … TO transfer_app`.

| Function | Does |
|---|---|
| `create_participation(project_id, actor…)` | inserts with `imported`, `not_started`, `not_offered`; writes `participation_created` |
| `lock_participation(id)` | `SELECT … FOR UPDATE`; the lock lasts until the caller's transaction ends |
| `change_participation_status(id, field, expected_from, to, actor…, kind, end_reason, secondary_reasons, offer_deadline, effective_date, request_id, job_id, details)` | checks `expected_from` (`stale_status`), the edge in `lifecycle_edge` (`invalid_transition`), `ta_only` ⇒ DSV unchanged, refuses the special-category end reason; sets the column and its dependants (`end_reason*`, `tg_entry_date`, `exit_date`, `profiling_done_on`, `offer_deadline`); bumps `status_version`; inserts **one** `status_changed` |
| `set_profiling_exception(id, reason_code, set_on, actor…)` | sets it, writes `profiling_exception_set` (flagged) |
| `revoke_profiling_exception(id, actor…)` | only while `informed`; writes `profiling_exception_revoked` |
| `correct_end_reason(id, new_reason, actor…)` | only on `withdrawn`/`exited`, same phase; moves a system-derived previous reason to the secondary list; writes `end_reason_corrected` with the previous reason in `details` |
| `record_audit_event(type, …)` | every other event type; **refuses** the five lifecycle types above |

Errors use SQLSTATE `P0001` with a stable message code (`stale_status` → 409,
`invalid_transition` → 422 later).

#### Status service (`apps/api/src/participations/status-service.ts`)

The only TypeScript caller of the functions. One transaction: `lock_participation` → load the
project and dated guard facts (`GuardFactsProvider`; fail closed in Slice 1) → `canTransition`
(failure: domain error, **nothing written**) → the function → commit. Later slices that write
facts (DSV, ASU) take the same lock. The nightly job uses the same service as `system`.

#### Grants (custom migration, Slice 0 pattern)

| Object | `transfer_app` |
|---|---|
| `participation` | `SELECT` only |
| `audit_event` | nothing in Slice 1 (`SELECT` with the first feature that reads it) |
| `lifecycle_edge` | nothing (read by the functions as owner) |
| the seven functions | `EXECUTE` |
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
  `asu_proof`, `dsv_cancellation`.

### 5.6 Field catalog and the access matrix

#### Field catalog (`packages/domain/src/fields`)

One entry per participant field the docs name: `{ key, dataClass, accessCategory, listable,
customerVisible, selfService, storage }`. Classes follow data-protection.md including the
round 7 additions (Q66): Familienstand, gender, Personalnummer, end of the old employment,
knowledge date, work email, language skills, driving licence are confidential.

- `listable` is `false` for every special-category and highly confidential field.
- `customerVisible` is `true` for exactly the whitelist *(provisional, Q13)*.
- `selfService` marks what the participant may write (Q65); the list is reviewed in PR 1d.
- **End reasons are classified per value:** `long_term_illness_reduced_earning_capacity` is
  special category and never in ordinary lists; `deceased` and all others are confidential.
  List payloads show such a participation as ended without that reason.

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
| `aggregated` | counts, workload | aggregated |

#### `decideAccess(subject, resource, action, mode)`

```ts
type Subject =
  | { kind: "staff"; staffUserId: string; orgRoles: ReadonlySet<OrgRole>;
      projectRoles: Record<ProjectId, ReadonlySet<ProjectRole>>;   // D6: zero or more
      assignedParticipationIds: ReadonlySet<string> }              // as profiler/consultant
  | { kind: "participant"; participationId: string; knowledgeCheckPassed: boolean };
type Resource = { projectId: string; participationId: string | null;
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
      | "immutable" | "undecided" };   // undecided = docs gap (D10), with its question
```

**Role union (D6/Q61):** the decision is computed per role the subject holds in the project, and
the most permissive *allow* wins; sensitive categories reached through the consultant role still
require the assignment. A PL who is also a profiler therefore sees section C only for
participants assigned to them.

**Reading** (*assumed*, Q28/Q49/Q51/Q62):

- **Admin, regional admin:** every participant-level category `never`; `aggregated` only.
- **Consultant/profiler:** person-level data **only for assigned participations** (Q62); for
  unassigned ones only `aggregated` workload counts. Assigned: everything including section C
  and health; signed forms with `open_document` audited; absence "abwesend" + dates.
- **PL:** confidential and internal yes; health/disability only in assisted mode or
  break-glass; identifiers, residence/social, section C **no**; signed forms: `read` metadata
  only, `open_document` audited; absence "abwesend" + dates.
- **Back office:** confidential, identifiers, residence/social, disability yes; health,
  section C, signed forms **no**; absence type + dates.
- **Participant (own):** all own categories, special category only after the birth-date check;
  section C and signed forms denied (Q67).
- Every allowed read of special-category/highly confidential data → `sensitive_read`; every
  `open_document` → `document_opened`.
- **Lists:** `list` is denied for every special-category and highly confidential category,
  whoever asks.
- **Break-glass** (Q63): only where the docs allow it (PL on health/disability; consultant, PL
  and back office on the evidence set), needs a reason code (free text comes with encryption,
  Slice 3), returns a **grant scoped to one participant, one category and one action**, audit
  `break_glass_access`, flagged. On the evidence set it never grants more than the role has in
  the active phase. The phase starts after the first deletion stage (Q64), so nothing sets
  `evidence_set` before Slice 7.

**Writing** (*assumed*, Q65):

| Category | Participant (own) | Consultant (assigned) | PL | Back office | Admins |
|---|---|---|---|---|---|
| `case_internal` | never | via status functions (Q60 edges) | via status functions, operational dates | via status functions (DSV edges) | never |
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

**Transition permissions** (`mayPerformTransition(subject, edge, participation)`, Q60): PL all
manual edges and operations of their project; assigned consultant/profiler `contacted`,
`unreachable`, `informed`, the profiling track and `→ exited`; back office `→ dsv_offered`,
`→ dsv_signed`, `→ dsv_declined`; participants none; expiry and scheduled entry system only.

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
  "relax":  [],                          // project_override only, see merge rules
  "helpTexts": { "de": { "asu_registration.intro": "…" } }
}
```

- **Nationwide settings** live only in base defaults: ASU formula parameters (3 months / 3 days,
  *verify* Q1), profiling-exception deadline (1 month, Q17), Kug 200b confirmation follow-up
  (14 days), TL 407 escalation (14 days after TG start, Q54), and the cutoff warning lead time
  once Q78 is answered. A template or override that sets one is invalid.
- **Regional settings:** the channels, `originalRequired`, `leadTimeDays`,
  `rejectsOutdatedFormVersions`. **Base defaults hold none of the Agentur submission settings**
  (Q76): they come only from a template or a recorded project override.
- Signing and entry deadlines and the contractual `deadlineRule` are **project data**, not
  configuration (Q69); they arrive with project setup in Slice 2.
- Channel enums: ASU `kug_200b` / `online_self` / `in_person`; Kug 200b batch `paper_courier` /
  `paper_post` / `scan_email` / `upload`; TL 407 `email` / `upload` / `paper_original`.
- Reminder rules are left to Slice 5.

#### Field-schema profile (custom fields, D5)

Allowed: `type` (`string` / `integer` / `number` / `boolean`), `enum`, `const`,
`format: "date"`, `minLength`, `maxLength` (≤ 2000), `pattern` (≤ 200 characters), `minimum`,
`maximum`, `title`, `description`, plus `x-dataClass` (only `confidential` or `internal`;
special and highly confidential data needs encrypted columns, never `jsonb`), `x-retentionClass`
(must exist in the data catalog), `x-label`. Everything else is rejected before compiling.
Keys start with `custom.`. Validators are cached per (template id, version).

#### Merge rules (base defaults → template → project override)

- **Settings:** per key, the later layer replaces the earlier (only regional keys in templates
  and overrides).
- **Rules** (Q75): merged by `id`. Templates **only add**. A project override may add rules and
  **relax** a rule only if its basis is `operational_default`, via
  `relax: [{ ruleId, reasonCode, approvedBy, approvedOn }]`; relaxing a `statutory`, `ba_form`
  or unclassified rule is invalid. (Approval and audit of overrides are stored with project
  setup in Slice 2; the resolver checks the shape and the basis.)
- **Fields:** templates and overrides add custom fields; redefining an existing key is invalid.
- **Help texts:** per language and key, the later layer wins.

#### Resolver (`resolve.ts`, 100 % covered)

```ts
resolveForParticipation({ base, templatesByAgentur, override, placementAgenturKey, kugAgenturKey })
resolveForProject({ base, templatesByAgentur, override, kugAgenturKey })
  → { config: ResolvedConfig; provenance: Record<SettingPath, LayerRef>;
      blockers: Blocker[]; warnings: Warning[] }
```

- **Two levels** *(provisional, Q15)*: participant steps use the placement Agentur's template,
  project steps the KuG-Agentur's.
- **Provenance** for every setting and rule (`base`, `template:<id>@<version>`, `override`).
- **Blockers** (Q76): no KuG-Agentur template → `project_activation_blocked`; an Agentur
  submission setting (channel, original requirement, lead time, Kug 200b batch channel) that no
  layer supplies → `agentur_submission_blocked` for that step, while contact, data collection
  and profiling resolve normally. Both also produce a warning for the PL dashboard.
- **Pinned versions** *(provisional, Q36)*: the resolver takes snapshotted template objects;
  `load.ts` reads `templates/<agenturKey>/<version>.json`. Snapshots per project are Slice 2.

#### Base defaults (`packages/domain/config/base-defaults.json`)

Only what the docs state, each rule with its basis:

| Rule | Basis |
|---|---|
| ASU proof document before TG entry | `statutory` (§111(4) Nr. 4) |
| signed DSV scan | `statutory` (§623 BGB) |
| Kug 200b required fields (RV-Nummer, declarations 16 and 17) | `ba_form` |
| import-required fields (Personalnummer, Nachname, Vorname, Geburtsdatum, Austrittsdatum, Anschrift; PRD F2, provisional) | `operational_default` |

TL 407's required fields come with the form registry in Slice 6 (`ba_form`, read from the blank
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
- **Schedule:** `lifecycle.sweep`, cron `JOBS_LIFECYCLE_CRON` (default `15 2 * * *`),
  `tz: Europe/Berlin`. It enqueues one `lifecycle.evaluate-project` job per project with
  `singletonKey = <projectId>:<today>`.
- **Per-project job:** runs `planSystemTransitions` per participation with `clock.today()` and
  applies each change through the status service as `system` (`system_job`, `job_id`).
  Idempotent: the planner plans nothing for moved participations, and compare-and-set rejects
  a concurrent duplicate. A night without a run delays `dsv_expired` and cutoff withdrawals
  (effective dates stay correct) and turns a TG entry into `tg_start_missed` for the PL (Q68).
- **Payloads carry IDs only** (Zod payload schema per job; a test checks they contain only
  `uuid`/ISO-date fields). Logs: job name, job id, project id, counts.
- Retries with backoff (`retryLimit: 3`); failures visible in `pgboss` and the log.
- **`pnpm jobs:lifecycle [--today YYYY-MM-DD]`** runs the sweep once (dev, CI, demos; `--today`
  uses a `ManualClock`, refused with `NODE_ENV=production`).
- pg-boss's tables are outside the data catalog test; ADR-0011 excludes them from participant
  retention.

### 5.10 Database, data catalog and seed

| Table | Columns (main) | `retentionClass` | `dataClass` | Participant data |
|---|---|---|---|---|
| `project` (changed) | + `latest_entry_date date null` (`CHECK`: null for `ta_only`, which has no beE entry) | `project_master` | `internal` | no |
| `participation` | `id`, `project_id` (FK, not null), `status`, `profiling_status`, `dsv_status`, `offer_deadline`, `tg_start`, `tg_end`, `tg_entry_date`, `exit_date`, `profiling_done_on` (all `date`), `end_reason`, `end_reason_secondary end_reason[]`, `profiling_exception`, `profiling_exception_reason_code`, `profiling_exception_set_on`, `status_version`, `created_at` | **`participation_record`** (new): the event-driven rules of ADR-0008, *verify* Q3/Q24/Q77; `unset` in code until Slice 7 | `confidential` | yes |
| `audit_event` | section 5.4 | **`audit_log`** (new): 3 years, pseudonymised on deletion of the subject; evidence-set entries follow the evidence set; *verify* Q3; `unset` until Slice 7 | `confidential` | yes |
| `lifecycle_edge` | `track`, `from_value`, `to_value`, `kind` (pk), `actors` | **`reference_data`** (new): no personal data, never touched by the retention job | `internal` | no |

`CHECK`s on `participation`: `tg_start ≤ tg_end`; `offer_deadline ≤ tg_start` when both set;
`end_reason` set exactly for `withdrawn`/`exited`; `tg_entry_date` set for `active_in_tg`/
`exited`; `exit_date` set for `exited`; `profiling_done_on` set exactly for `profiling_done`.

**Seed (synthetic only):** "Restrukturierung Werk Nord" gets a `latest_entry_date`; about 15
participations cover every main status, each track status and every flag case; three in the
`ta_only` project. No names. Created and moved **through the functions** as `system` /
`seed`, so every seeded state has its audit trail. Idempotent by fixed UUIDs.

**Generated tables** (`pnpm generate`, drift-checked in `pnpm verify`):
`docs/domain/generated/lifecycle-transitions.md` (every edge and operation with actors, roles
and guards) and `docs/domain/generated/access-matrix.md` (role × category × mode × phase ×
action → decision, with every `undecided` cell and its question). These are what the DPO and
the PLs review.

## 6. Commands (new or changed)

| Command | What it does | PR |
|---|---|---|
| `pnpm test:coverage` | `vitest run --coverage` with **100 % thresholds** on `packages/domain/src/{lifecycle,eligibility,access,completeness}/**`, `packages/domain/src/dates.ts`, `packages/config/src/resolve.ts`; CI runs it in the Node 24 test leg | 1b |
| `pnpm generate` | all generators: `api:generate`, the config JSON Schema, the two docs tables | 1b, 1d, 1f |
| `pnpm verify` | `typecheck`, `lint`, `test:coverage`, `generate` + `git diff --exit-code` on generated paths | 1b |
| `pnpm jobs:lifecycle [--today YYYY-MM-DD]` | runs the lifecycle sweep once | 1h |
| `pnpm db:migrate` | also installs/migrates the `pgboss` schema and applies its grants | 1h |

New environment variables (`.env.example`, PR 1h): `JOBS_ENABLED` (`true`),
`JOBS_LIFECYCLE_CRON` (`15 2 * * *`), `CLOCK` (`system`); `DATABASE_JOBS_URL` only on the S2
fallback.

## 7. Acceptance criteria

U = unit, I = DB/API integration, CI = workflow, R = review.

### Lifecycle and eligibility (PRs 1b, 1c)
- [ ] **AC-1** Every `(track, from, to)` pair (10² + 5² + 5²) has a listed expected result; the
      allowed set equals the edge table in 5.3; all others are `no_edge`. (U `lifecycle/edges.test.ts`)
- [ ] **AC-2** Tracks move only in `informed`; the DSV track never moves in `ta_only`; with the
      exception, profiling moves forward and can be declined in `active_in_tg`; nothing moves
      after a terminal status. (U `lifecycle/track-activity.test.ts`)
- [ ] **AC-3** System-only edges reject `user`; user-only edges reject `system`;
      `scheduled_entry` and `reconciliation` are distinguished. (U)
- [ ] **AC-4** TG entry: every combination of {DSV fully executed, ASU with proof, profiling
      done, exception} × fact dated before / on / after `tgStart` — entry only when all hold
      **as of `tgStart`**; scheduled entry only on `tgStart`; reconciliation only after it and
      flagged; evidence dated after `tgStart` never allows a reconciliation.
      (U `lifecycle/tg-entry-guard.test.ts`)
- [ ] **AC-5** The guard list equals 5.3; no API accepts an override; the exception can't be set
      with `profiling_declined` and can be revoked only before entry. (U `lifecycle/guards.test.ts`)
- [ ] **AC-6** Manual withdrawal: from `imported`/`contacted`/`unreachable`/`informed` with a
      `pre_tg` reason only; with `dsv_signed` it needs the cancellation **and** PL confirmation;
      `exited` needs a `tg` reason; the special-category end reason is `reason_not_storable`. (U)
- [ ] **AC-7** Offer deadlines: first offer falls back to the project deadline; re-offers need an
      explicit `offerDeadline` ≤ `latestEntryDate` and ≤ `tgStart`; no offer without any
      deadline; expiry the day after. (U `lifecycle/offer-deadline.test.ts`)
- [ ] **AC-8** Cutoff planner: every combination of main ∈ {`imported`, `contacted`,
      `unreachable`, `informed`} × 5 profiling × 5 DSV × project type gives the primary
      reason by precedence, the secondary list, or the right flag; nothing on `latestEntryDate`
      itself; nothing without `latestEntryDate` (project flag instead); nothing in `ta_only`;
      while Q78 is open, `cutoff_withdrawal_pending` instead of a withdrawal.
      (U `lifecycle/planner-cutoff.test.ts`)
- [ ] **AC-9** `tg_start_missed` after a missed `tgStart`, never an automatic late entry; a second
      run on the same day plans nothing. (U `lifecycle/planner.test.ts`)
- [ ] **AC-10** End-reason correction keeps the terminal status, enforces the phase, and moves a
      system-derived reason to the secondary list. (U)
- [ ] **AC-11** `transferKugEligibility` for every row of the table in 5.3, including month-end
      cases of the one-month deadline; compliance flags for a missed deadline and a refusal
      after entry. (U `eligibility/transfer-kug.test.ts`, *verify* Q74)
- [ ] **AC-12** Every consistent `(main, profiling, dsv, projectType)` has a derived-status key;
      `isConsistentState` rejects the rest. (U)
- [ ] **AC-13** `asuDueDate` and `addMonths`: the docs' examples and leap years. (U, *verify* Q1)

### Audit and the status functions (PR 1g)
- [ ] **AC-14** As `transfer_app`: `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on `participation`,
      `audit_event`, `lifecycle_edge` fail with `42501`; `SELECT … FOR UPDATE` on
      `participation` fails; `EXECUTE` on the seven functions works; `PUBLIC` can't execute
      them. (I `db/grants.int.test.ts`)
- [ ] **AC-15** `change_participation_status` writes the column(s) and **exactly one** audit row;
      a rolled-back transaction leaves neither; stale `expected_from` → `stale_status`; an edge
      not in `lifecycle_edge` → `invalid_transition`; `record_audit_event` refuses the five
      lifecycle event types. (I `db/status-function.int.test.ts`)
- [ ] **AC-16** `lifecycle_edge` equals the domain edge list. (I, drift)
- [ ] **AC-17** Audit `CHECK`s reject inconsistent actors; the table has no free-text column. (I)
- [ ] **AC-18** Status service: a failed guard writes nothing; two concurrent changes serialize
      (one wins, the other gets `stale_status`). (I `api/participations/status-service.int.test.ts`)

### Completeness (PR 1e)
- [ ] **AC-19** Truth tables for `required`, `requiredIf` (`equals`, `exists`), `documentPresent`
      (± `accepted`), including `""`, `[]`, `null`, `false`, `0`; output has keys, never
      values. (U `completeness/engine.test.ts`)
- [ ] **AC-20** Rules with unknown fields or documents, duplicate ids or unknown keys are
      rejected; a rule without `basis` is locked. (U)

### Access (PR 1d)
- [ ] **AC-21** Every cell of data-protection.md's read matrix and write table is an explicit
      expectation and passes; the full enumeration (role sets × membership × assignment ×
      category × mode × phase × action) yields exactly one decision per case; every case the
      docs don't cover is `undecided` with its question. (U `access/matrix.test.ts`)
- [ ] **AC-22** Role union: PL + profiler sees section C only for assigned participants;
      consultants get nothing person-level for unassigned participants, only aggregates. (U)
- [ ] **AC-23** `list` never allowed for special-category or highly confidential categories;
      signed documents are `immutable` for writes. (U)
- [ ] **AC-24** Break-glass only where the docs allow it, returns a grant for exactly one
      participant, category and action, audited and flagged; admins never; participant
      special-category reads need the birth-date check. (U)
- [ ] **AC-25** Transition permissions match Q60 for every edge and operation. (U)
- [ ] **AC-26** Field catalog: every field has a class and category; no special/highly
      confidential field is listable; `customerVisible` is exactly the whitelist; the
      health-related end reason is never in list payloads. (U `fields/catalog.test.ts`)
- [ ] **AC-27** The generated transitions and access tables match the code. (U, drift)

### Config (PR 1f)
- [ ] **AC-28** `base-defaults.json` and both samples validate against the committed JSON
      Schema, which matches the Zod model; base defaults contain no Agentur submission
      setting. (U)
- [ ] **AC-29** Resolution order, provenance, two-level resolution, templates only adding rules,
      relaxing only `operational_default` rules in project overrides, nationwide settings
      rejected in templates/overrides. (U `config/resolve.test.ts`, 100 %)
- [ ] **AC-30** Blockers: no KuG-Agentur template → `project_activation_blocked`; no
      placement-Agentur template → `agentur_submission_blocked` while data collection and
      profiling resolve. (U)
- [ ] **AC-31** Field-schema profile: allowed keywords compile like hand-written Zod; anything
      else, special/highly confidential custom fields and unknown retention classes are
      rejected; `format: date` rejects `2027-02-31`. (U)
- [ ] **AC-32** A version 2 template file doesn't change resolution for a project pinned to
      version 1. (U)

### Clock and jobs (PRs 1a, 1h)
- [ ] **AC-33** `today()` is the Berlin date around midnight UTC and across both DST switches; no
      `Date.now()`/`new Date()` in domain, config and jobs (source scan). (U)
- [ ] **AC-34** pg-boss starts as `transfer_app` on the schema installed by `db:migrate`; the
      nightly schedule is registered with `Europe/Berlin`. (I)
- [ ] **AC-35** With a `ManualClock` and fake facts, the job produces `dsv_expired`, scheduled TG
      entries and (with a test lead time) cutoff withdrawals as `system`; running it twice adds
      no status change and no audit row. (I `api/jobs/lifecycle.int.test.ts`)
- [ ] **AC-36** With the Slice 1 facts provider, nobody enters the TG (fail closed). (I)
- [ ] **AC-37** Job payloads contain only IDs and dates; job logs contain no participation data. (U, I)
- [ ] **AC-38** The image smoke test passes with the pg-boss schema installed by
      `node dist/migrate.js`. (CI)

### Platform and data protection
- [ ] **AC-39** Data catalog has `participation`, `audit_event`, `lifecycle_edge`; participant
      tables have `project_id` FKs. (U)
- [ ] **AC-40** Seeded participations exist only through the functions, each with its audit
      trail; synthetic only. (I, R)
- [ ] **AC-41** `pg-boss@12.38.0` and `@opentelemetry/api@1.9.1` pinned exactly, one copy each in
      the lockfile, no peer warnings; tests pass on Node 22 and 24. (CI)
- [ ] **AC-42** `pnpm test:coverage` enforces the 100 % thresholds in CI. (CI)

### Definition of done (CLAUDE.md) applied to this slice
- Status changes through the audit helper: **the core of this slice** (functions + grants).
- No hard-coded regional rules: regional settings only in templates; deadlines are project data.
- No vendor calls outside adapters: pg-boss is infrastructure on our own Postgres (ADR-0011).
- New personal data: `participation` and `audit_event` have a class, access rules (5.6) and a
  retention class.

## 8. Deliberately left out

| Not in Slice 1 | Why / where it lands |
|---|---|
| Person data, import, duplicate handling | Slice 2 |
| Editing project dates (`latestEntryDate`, deadlines, `deadlineRule`), template snapshots, project overrides with approval | Slice 2 (project setup); Slice 1 adds the column and the resolver rules |
| Entry waves | after Q79 |
| Project membership and assignment tables, region on projects, a reviewer role | Slices 2/3; Q80 |
| API routes for status changes, participations or access | Slices 2, 3, 5 |
| Wiring `decideAccess` into requests, sessions, logins and their audit | Slice 3 |
| Free-text reasons (break-glass, profiling exception) and their encryption | Slice 3 (first writer); codes only until then |
| Storing the special-category end reason | Slice 8 (TG exits), with encrypted storage |
| Field-level encryption of participant fields, sensitive endpoints, `sensitive_read` writes | with the first such field (Slices 4a/6) |
| DSV documents, signature dates, ASU records, signed TL 407, cancellation, §110 activities | Slices 6/7/8; guards fail closed (D4) |
| Customer-notification flag after withdrawal from `dsv_signed` | Slice 7 |
| `self_registered` creation and the 30-day rejection job | Slice 4c |
| Reminders, "what's missing" UI, dashboards, escalations | Slice 5 (they call `evaluateCompleteness`, `lifecycleFlags`, the eligibility function) |
| KuG billing, payroll export of excluded periods | outside the MVP / Slice 8 export |
| TL 407 required-field list | Slice 6 (ADR-0009) |
| Retention job, pseudonymisation role, retention periods | Slice 7 |
| Row-level security | pre-pilot gate (ADR-0005) |
| Other adapter interfaces, separate worker, admin UI for templates | their slices (D9), Slice 9 (D7), later (ADR-0004) |

## 9. Doc changes

**In this PR (round 7):** `docs/decisions/2026-10-16-answers-round-7.md`; `open-questions.md`
(Q60–Q76 statuses, Q3 note, new Q77–Q83); process-and-lifecycle.md (deadlines, cutoff
withdrawals with `never_contacted`/`not_informed`, no late entry and reconciliation, profiling
exception rules, employment vs. Transfer-KuG eligibility, no overridable documentary guards,
transition permissions, multiple roles); data-protection.md (classification additions, roles,
assignment, break-glass scope and review, evidence-set phase, participant documents, write
permissions, retention note); regional-variation.md (deadlines are project data, rule bases,
missing templates); glossary (signing/offer deadline, `latestEntryDate`, entry wave,
Transfer-KuG eligibility, profiling exception, break-glass); CLAUDE.md rule 5 (no override of
documentary guards); ADR-0008 note (grace period reopened); PRD F8, roadmap, architecture
overview and ADR-0011 (cutoff instead of grace period).

**In the implementing PRs:**
- **1a:** S1 note in ADR-0004, S2 note in ADR-0011; CLAUDE.md "Repo layout" (`config`,
  `adapters` with `Clock` only).
- **1b/1c:** process-and-lifecycle.md links the generated transitions table.
- **1d:** data-protection.md: access categories and a link to the generated access matrix.
- **1f:** regional-variation.md: the concrete template model replaces the sketch; ADR-0004
  amendment (Zod-authored model exported as JSON Schema, the profile, rule bases, blockers).
- **1g:** ADR-0002 amendment (`SECURITY DEFINER` functions, `lifecycle_edge`, no FK from
  `audit_event` to `participation`, no free text before encryption, grants); retention classes
  `participation_record`, `audit_log`, `reference_data` in data-protection.md / ADR-0008.
- **1h:** ADR-0011 amendment (schema install, runtime role, in-process workers, time zone,
  `singletonKey`, no catch-up entry); architecture overview (jobs); CLAUDE.md "Commands";
  `.env.example`; `.claude/settings.json` allowlist; README status.

## 10. Risks

| Risk | Mitigation |
|---|---|
| The cutoff semantics (Q77) or the Transfer-KuG rules (Q74/Q82, *verify*) change after implementation | Both are isolated pure functions (`planSystemTransitions` step 3, `transferKugEligibility`) with table-driven tests; an answer changes a table, not the design. Until Q78, no automatic withdrawal runs at all. |
| Reading the app as deciding employment or eligibility | D4 wording in the code and docs: the app records effective dates and derives a report; it doesn't create the employment relationship or a KuG claim. |
| `z.fromJSONSchema` is experimental upstream | Restricted profile validated first; spike S1 with the Ajv fallback; contained in `field-schema.ts`. |
| Zod's JIT probe raising CSP violations in the SPAs | `z.config({ jitless: true })` (S1; enforced by the e2e CSP check from Slice 4a). |
| pg-boss needs more than DML at runtime, or a release breaks us | Spike S2 with the `transfer_jobs` fallback; exact pins, deliberate upgrades. |
| Logic duplicated between TypeScript and SQL drifts | SQL checks only the edge list (kept equal by a test) and invariants; guards live only in TypeScript. |
| `SECURITY DEFINER` functions as an attack surface | Fixed `search_path`, no dynamic SQL, `EXECUTE` revoked from `PUBLIC`, inputs checked, grant tests. |
| A missed nightly run blocks a TG entry | Deliberate (Q68): `tg_start_missed` is flagged the next morning and the PL reconciles with dated evidence. Monitoring of failed runs comes with Slice 9. |
| 100 % coverage tempts tests that only touch lines | Table-driven expectations from the docs; generated tables reviewed by people. |
| Free-text reasons leaking sensitive details | None stored in Slice 1; later only encrypted, never in logs, lists or job payloads (Q66). |
| Deadlines off by one day | Inclusive deadlines (Q69) tested at the boundary in AC-7, AC-8, AC-9. |

## 11. Approval

Approved with changes in round 7. Implementation starts with PR 1a on a new branch after this
PR is merged. Answers to Q77–Q83 can come at any time; each one changes data and tests only.
