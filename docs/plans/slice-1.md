# Slice 1 — Domain core: plan

- Status: **Draft, awaiting approval** (decisions D1–D10 below)
- Date: 2026-10-15
- Roadmap: [Slice 1](../roadmap.md#slice-1--domain-core)
- Builds on: [Slice 0](slice-0.md) (merged, PRs 0a–0d)
- Relevant ADRs: 0002 (status writes enforced in the DB, append-only audit, `project_id`), 0004
  (fixed lifecycle core, regional templates, base defaults, completeness rules), 0006 (adapters,
  `Clock`), 0007 (access model in Slice 1), 0008 (retention per item), 0011 (pg-boss, `system`
  actor, injected `Clock`)
- Domain docs: [process-and-lifecycle.md](../domain/process-and-lifecycle.md),
  [data-protection.md](../domain/data-protection.md) (access matrix),
  [regional-variation.md](../domain/regional-variation.md), [glossary.md](../domain/glossary.md)

## 0. Decisions needed from you

Please answer these in the PR. Each has a recommendation; "yes to all" is a valid answer.

| # | Topic | Recommendation | Alternative |
|---|---|---|---|
| D1 | PR shape | **A series of 8 small PRs (1a–1h, section 4)**, tests first, each green on its own. The slice is done after 1h. | Fewer, larger PRs (would break the ~400-line guideline). |
| D2 | How "the DB role cannot update status columns" is enforced | **`SECURITY DEFINER` SQL functions are the only writers** of participation status and of audit events. `transfer_app` gets `SELECT` on `participation` and `EXECUTE` on the functions, and **no** `INSERT`/`UPDATE`/`DELETE` on `participation`, `audit_event` or `lifecycle_edge`. The function also checks the edge against a `lifecycle_edge` table that a test keeps equal to the domain's edge list (defence in depth). Data-dependent guards stay in TypeScript (section 5.4). | A TypeScript-only status function that uses a second, privileged DB connection. Weaker: any code with that connection can write status. |
| D3 | Tables in Slice 1 | **A minimal `participation` table** (project, the three statuses, planned TG dates, entry/exit dates, end reasons, profiling exception) **without any personal fields**, plus `audit_event`, `lifecycle_edge` and a tiny `job_run` (last completed nightly sweep). People, names and import come in Slice 2. Project membership and assignment tables come with Slice 3 (the access function takes them as input). | Also create `person`, `project_member`, `participation_assignment` now (more schema to change before anything uses it). |
| D4 | Guard facts that later slices own (DSV execution dates, ASU proof, signed TL 407, cancellation document, DSV scan) | **Fail closed:** the Slice 1 facts provider reports them as absent, so those guards fail and nobody enters the TG until Slices 6/7 supply the facts. Tests use fake providers to cover every combination. | Add minimal `dsv_document` and `asu_record` tables now (pulls Slice 6/7 scope forward). |
| D5 | JSON Schema engine for config | **Zod 4's built-in `z.fromJSONSchema`** (already pinned `zod@4.6.7`) over a **restricted field-schema profile** (scalar types, `enum`, `format: date`, length/range/pattern). No new dependency, no `eval` (works in the SPAs under our strict CSP), one validator for API and portal. The template model itself is authored in Zod and exported to a committed `regional-template.schema.json` (drift-checked like the API client). Spike S1 checks it; **fallback `ajv@8.20.0`, server only** (Ajv generates code with `new Function`, which our CSP forbids in the browser). | Ajv from the start (mature, full 2020-12, but server-only and one more dependency). |
| D6 | Role model | **Org roles** (`admin`, `regional_admin`) on the staff user, **project roles** (`project_lead`, `consultant`, `back_office`) **per project membership**, one project role per person per project until Q61 is answered. Slice 0's `staff_user.role` stays for the dev stub until Slice 3. | One global role per staff user (cheaper now, a migration later if one person is PL in one project and profiler in another). |
| D7 | Where jobs run | **pg-boss workers inside the API process** (`JOBS_ENABLED`), one image as today. pg-boss's schema is installed by `pnpm db:migrate` / `dist/migrate.js` as `transfer_owner`; at runtime pg-boss runs as `transfer_app` with explicit grants on its schema (spike S2). A separate worker entry in the same image can come in Slice 9 if needed. | A separate worker process now. |
| D8 | Sample templates | **Two fictional Agenturen** ("Agentur für Arbeit Beispielstadt Nord/Süd", `sample: true`) that exercise every override type. No real Agentur gets a template until the PL table in regional-variation.md is filled (do not invent BA rules). | A Nürnberg template now with guessed values. |
| D9 | `packages/adapters` scope | **Only `Clock`** (interface, system and manual implementations, selection by `CLOCK`). The other interfaces (PDF, mail, SMS, storage, virus scan, export) are added with the slices that use them; CLAUDE.md's layout line is adjusted. | All interfaces with mocks now (unused code until Slices 3–6). |
| D10 | What Slice 1 builds where the docs are silent (Q60–Q76) | **Fail safe, never a guessed BA rule:** access is **denied**, no system transition happens, and the case is **flagged to the PL** instead. Each question lists a *proposed* default; it is built only after you accept it (then the question becomes `assumed`). Section 5.11 lists, per question, what is built meanwhile. | Build the proposed defaults now and mark them `assumed`. |

**New open questions:** Q60–Q76 are added to [`open-questions.md`](../open-questions.md) in this PR
(eight of them 🔒). None of them blocks the start: under D10 they only change data and tests,
not the architecture.

## 1. Goal

Freeze the domain core so that every later slice builds on tested rules instead of re-deciding them:

```
packages/domain   lifecycle (main status + profiling track + DSV track, canTransition, guards,
                  system planner), audit event model, completeness engine, field catalog,
                  access matrix                                        — pure, no I/O, 100 % covered
packages/config   regional template model (JSON Schema), resolver, base defaults, 2 samples
packages/adapters Clock
packages/db       participation, audit_event, lifecycle_edge, the status functions, grants
apps/api          status service (the only TypeScript caller of the status functions),
                  pg-boss with the nightly lifecycle job
```

**Done when** (roadmap): tests document every allowed and forbidden transition and every access
rule. Detailed acceptance criteria are in section 7. There is no new UI in this slice; the
"demo" is the two generated tables (transitions and access matrix, section 5.10) and a nightly
run on seed data (`pnpm jobs:lifecycle --today …`).

## 2. Facts checked on 2026-10-15

### Fresh session start (the check you asked for)

Run in this cloud session (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 pre-installed):

| Step | Result |
|---|---|
| `scripts/session-start.sh` (hook, then re-run by hand) | **OK**, exit 0 in ~4 s on the second run: Postgres started, `pnpm install --frozen-lockfile`, `db:setup`, `db:migrate`. Only output: pnpm's "Ignored build scripts" notice (expected, ADR-0003). |
| `pnpm db:seed` | **OK** (silent, idempotent). |
| `pnpm dev` | **OK.** API `:3001` (`/api/v1/health` 200), web `:5173` (200, `/api` proxied), portal `:5174/portal/` (200). Without a session `/api/v1/projects` is a 401 problem. After `POST /api/v1/dev/session` as the seeded PL, `/api/v1/projects` returns the three seeded projects from Postgres and `/api/v1/me` the PL. |
| `pnpm verify` | **OK** in ~26 s: typecheck, lint (Oxlint, Oxfmt, tsconfig guard), 19 test files / 186 tests, API client drift check clean. |

Nothing failed. Two small observations, no action needed: `pnpm db:seed` prints nothing on
success, and the browser UI was checked through the dev proxy with `curl`, not with a
screenshot.

### Dependencies (checked against npm on 2026-10-15)

| Package | Pin | Released | Notes |
|---|---|---|---|
| `pg-boss` | **`12.38.0`** | 2026-10-13 | MIT. `engines.node >=22.12.0` (fits `^22.18.0 \|\| ^24.11.0`). Depends on `pg ^8.23.1` (we pin `pg@8.23.1`), `cron-parser`, `rrule-temporal`, `serialize-error`. Declares a **non-optional peer `@opentelemetry/api ^1.9.0`**. Very frequent releases (12 in the last 4 weeks): pin, and upgrade only in deliberate PRs. Goes into `@transfer/api` (runtime, bundle keeps npm deps external) and `@transfer/db` (schema install in `db:migrate`). |
| `@opentelemetry/api` | `1.9.1` *(only if spike S2 shows pnpm needs it explicit)* | 2026-10 | Apache-2.0. Peer of pg-boss. |
| `ajv` | `8.20.0` *(fallback for D5 only)* | 2026-04-24 | MIT. Not added unless spike S1 fails. |

No other new dependency. Exhaustive tests replace property-based testing (the state space is
small: 10 × 5 × 5 statuses), so no `fast-check`. Coverage uses the existing
`@vitest/coverage-v8@5.0.5`.

### Other facts

- **`zod@4.6.7` ships `z.fromJSONSchema()`** (`zod/v4/classic/from-json-schema.d.ts`). It is
  marked experimental upstream, hence spike S1 and the restricted profile.
- **Zod 4 tries `new Function` for fast object parsing** and falls back when `eval` is blocked.
  Under our CSP (`script-src 'self'`) the attempt alone can raise a CSP violation, and the
  Playwright suite fails on any CSP violation (ADR-0003, PR 0d note). The SPAs will therefore set
  `z.config({ jitless: true })` before using config-driven schemas (Slice 4a); S1 checks it.
- **`SELECT … FOR UPDATE` needs `UPDATE` privilege** on at least one column in PostgreSQL. Since
  `transfer_app` has none on `participation` (D2), row locking goes through a `SECURITY DEFINER`
  function too (section 5.4).
- `ta_only` projects have no signing deadline (Slice 0 `CHECK`), so the grace period, which is
  signing deadline + 90 days, **does not exist for them**. The docs don't say how `ta_only`
  participations end other than `ta_completed` → Q73.

## 3. Spike (first part of PR 1a)

**Timebox:** half a working session. If an item fails, apply its fallback and record the result
in an ADR note (S1 → ADR-0004, S2 → ADR-0011), as Slice 0 did.

| # | Check | Fallback |
|---|---|---|
| S1 | `z.fromJSONSchema` (zod 4.6.7) compiles the field-schema profile (section 5.7) and behaves like hand-written Zod for every allowed keyword; `format: date` rejects `2027-02-31` and `2027-02-29`; with `z.config({ jitless: true })` a Vite build validating a compiled schema in the browser raises **no CSP violation** under the API's CSP. | `format: date` compiled to our own `isoDate` if only that keyword differs. Otherwise **`ajv@8.20.0` server-only** (`ajv/dist/2020`, strict mode); the portal shows server-side validation errors for custom fields (Slice 4a). |
| S2 | `pg-boss@12.38.0`: (a) its schema is created and migrated by `db:migrate` running as `transfer_owner`; (b) it then starts as `transfer_app` with schema migration turned off and only explicit grants on its schema; (c) a cron schedule with `tz: "Europe/Berlin"` is registered and fires; (d) works on Node 22.22 and 24; (e) its peer `@opentelemetry/api` resolves under `--frozen-lockfile`; (f) `pnpm deploy --legacy` puts it into the image and the smoke test passes. | (b) fails → a dedicated **`transfer_jobs`** role owns the `pgboss` schema and pg-boss gets its own connection string (`DATABASE_JOBS_URL`); app tables are unaffected. (e) → add `@opentelemetry/api@1.9.1` as a pinned dependency. |

## 4. PR series

Tests are written first in every PR. Generated files (Drizzle snapshots, `openapi.json`,
`schema.d.ts`, the generated JSON Schema and the generated docs tables) don't count towards the
~400-line guideline. A PR that goes well over ~500 hand-written lines is split.

| PR | Content | Depends on | Ends with |
|---|---|---|---|
| **1a** `feat: domain vocabulary, dates and the Clock adapter` | Spike S1/S2. `packages/adapters` with `Clock` (section 5.8). Domain enums: `MainStatus`, `ProfilingStatus`, `DsvStatus`, `Track`, `Step` (+ scope), `EndReason` (+ phase), `ActorType`, `AuditEventType`, `OrgRole`, `ProjectRole`, `AccessCategory`. Date helpers (`addDays`, `addMonths` with month-end clamp, `asuDueDate`, *verify Q1*). Field catalog (section 5.6). Docs: decisions round 7 (D1–D10), ADR notes for S1/S2, CLAUDE.md layout. | — | vocabulary + Clock tested |
| **1b** `feat(domain): lifecycle transitions and guards` | Edge tables, track activity, `canTransition`, guards with override classes, manual withdrawal, withdrawal after `dsv_signed`, derived overall status, generated transitions table, 100 % coverage thresholds. | 1a | every (track, from, to) documented |
| **1c** `feat(domain): system transition planner` | `planSystemTransitions` for `dsv_expired`, TG entry and the grace-period withdrawal (precedence, secondary reasons, conflict and other flags), catch-up semantics, effective dates. | 1b | every grace-period combination documented |
| **1d** `feat(domain): field-level access matrix` | `decideAccess` (role × project × assignment × access category × mode × phase × action), transition permissions, list-payload rule, break-glass, generated access table. | 1a | every access rule documented |
| **1e** `feat(domain): completeness engine` | Rule types, presence semantics, `evaluateCompleteness`, rule validation against the field catalog. | 1a | truth tables pass |
| **1f** `feat(config): template model, resolver and base defaults` | `packages/config`: Zod model → committed JSON Schema (+ drift), field-schema profile and compiler, nationwide vs. regional settings, merge rules, two-level resolver with provenance, `base-defaults.json`, two sample templates, pinned-version loading. | 1e | resolution 100 % covered |
| **1g** `feat(db): participation, audit and the status function` | Tables, enums, `SECURITY DEFINER` functions, grants, `lifecycle_edge` drift test, data catalog entries, seed participations, `apps/api` status service with the fail-closed facts provider. | 1b, 1c, 1d | grant and atomicity tests pass |
| **1h** `feat(api): pg-boss and the nightly lifecycle job` | pg-boss setup (schema install, grants, in-process start), `job_run`, schedule, sweep + per-project job, `pnpm jobs:lifecycle`, idempotency tests with a manual clock, image smoke. Docs: CLAUDE.md commands, `.env.example`, architecture overview, ADR-0011 note, settings allowlist. | 1c, 1g | **slice done** |

1b/1d/1e can run in parallel after 1a.

## 5. Design

### 5.1 Repo layout after Slice 1

```
packages/
  domain/
    config/base-defaults.json        nationwide defaults (ADR-0004), validated by packages/config
    src/lifecycle/                   enums, edges, canTransition, guards, planner, derived status
    src/audit/                       audit event schemas (Zod, discriminated by type)
    src/completeness/                rules and engine
    src/fields/                      field catalog (key → dataClass, accessCategory, listable, …)
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

### 5.2 Vocabulary (all `snake_case` values, from the docs)

| Enum | Values |
|---|---|
| `MainStatus` | `self_registered`, `imported`, `contacted`, `unreachable`, `informed`, `active_in_tg`; terminal `withdrawn`, `rejected`, `ta_completed`, `exited` |
| `ProfilingStatus` | `not_started`, `profiling_accepted`, `profiling_in_progress`, `profiling_done`, `profiling_declined` |
| `DsvStatus` | `not_offered`, `dsv_offered`, `dsv_signed`, `dsv_declined`, `dsv_expired` |
| `Track` | `main`, `profiling`, `dsv` (DB column names `status`, `profiling_status`, `dsv_status`) |
| `Step` | `asu_registration`, `data_collection`, `profiling`, `agentur_submission`, `dsv` (participant scope); `project_checklist` (project scope) |
| `EndReason` (one enum, `phase` attribute, Q34) | `pre_tg`: `declined_profiling`, `declined_dsv`, `no_response`, `placed_direct`, `self_employed`, `retirement`, `other_measure`, `deceased`, `other`; `tg`: `placed_permanent`, `placed_fixed_term`, `self_employed`, `retirement`, `apprenticeship_or_study`, `max_duration_reached`, `own_termination_without_job`, `terminated_by_tg`, `long_term_illness_reduced_earning_capacity`, `deceased`, `other`. A PL may choose any `pre_tg` reason for a manual withdrawal; the grace-period job derives only `declined_dsv`, `declined_profiling` and `no_response`. |
| `ActorType` | `user`, `participant`, `system` |
| `OrgRole` / `ProjectRole` | `admin`, `regional_admin` / `project_lead`, `consultant`, `back_office` (D6) |

### 5.3 Lifecycle (`packages/domain/src/lifecycle`)

#### Edges

Encoded as data (`edges: Edge[]`, each `{ track, from, to, actors, kind }`), exactly the arrows
of process-and-lifecycle.md plus manual withdrawal. Everything else is `no_edge`.

| Track | From → to | Actors | Notes |
|---|---|---|---|
| main | *(create)* → `imported` | user | import / manual (Slice 2) |
| main | *(create)* → `self_registered` | participant | QR registration (Slice 4c) |
| main | `self_registered` → `imported` | user | matched by the PL (Slice 4c) |
| main | `self_registered` → `rejected` | user, system | not in scope / unmatched after 30 days (job in Slice 4c) |
| main | `imported` → `contacted` | user | |
| main | `contacted` → `informed` | user | attended info event / consultation |
| main | `contacted` → `unreachable` | user | |
| main | `unreachable` → `contacted` | user | return arrow: guard `before_grace_end` |
| main | `informed` → `active_in_tg` | **system only** | TG entry guard |
| main | `informed` → `ta_completed` | user | `ta_only`; guard `ta_completion` |
| main | `active_in_tg` → `exited` | user | `tg`-phase reason + exit date |
| main | `imported` / `contacted` / `unreachable` / `informed` → `withdrawn` | user | manual withdrawal, `pre_tg` reason |
| main | `unreachable` / `informed` → `withdrawn` | system | grace-period withdrawal (5.3, planner) |
| profiling | `not_started` → `profiling_accepted` / `profiling_declined` | user | |
| profiling | `profiling_accepted` → `profiling_in_progress` / `profiling_declined` | user | |
| profiling | `profiling_in_progress` → `profiling_done` | user | guard `tl407_signed` |
| profiling | `profiling_in_progress` → `profiling_declined` | user | |
| profiling | `profiling_declined` → `profiling_accepted` | user | return arrow: guard `before_grace_end` |
| dsv | `not_offered` → `dsv_offered` | user | guard `dsv_generated` |
| dsv | `dsv_offered` → `dsv_signed` | user | guard `dsv_scan_received` (PRD F8: scan + who received it) |
| dsv | `dsv_offered` → `dsv_declined` | user | |
| dsv | `dsv_offered` → `dsv_expired` | **system only** | signing deadline passed |
| dsv | `dsv_declined` / `dsv_expired` → `dsv_offered` | user | return arrows: guard `before_grace_end` |

"user" means staff; *which* staff role may take which edge is the access module's job
(`mayPerformTransition`, section 5.6), not `canTransition`'s.

#### Track activity

- Tracks move only while the main status is `informed` (they "start when the main status reaches
  `informed`").
- The **DSV track exists only in `ta_tg` projects**; in `ta_only` every DSV edge is
  `track_inactive`.
- **Profiling catch-up after TG entry:** with `profilingException = true`, the profiling track
  also moves while `active_in_tg`, but only forward (`not_started → profiling_accepted →
  profiling_in_progress → profiling_done`). Whether it may be declined then is Q74 (until
  answered: not allowed).
- After a terminal main status, nothing moves.

#### `canTransition(track, from, to, context)`

```ts
type TransitionContext = {
  projectType: ProjectType;
  current: { status: MainStatus; profilingStatus: ProfilingStatus; dsvStatus: DsvStatus };
  actor: { type: "user" } | { type: "participant" } | { type: "system" };
  today: IsoDate;                      // from the Clock, Europe/Berlin
  project: { signingDeadline: IsoDate | null };
  participation: { tgStart: IsoDate | null; profilingException: boolean };
  facts: GuardFacts;                   // see guards; absent facts are false (D4)
  config: { gracePeriodDays: number }; // from resolved base defaults (90, Q3)
  endReason?: EndReason;               // required for → withdrawn / → exited
  override?: { guard: GuardId; reason: string };
  confirmed?: boolean;                 // explicit PL confirmation where a rule needs one
};

type TransitionCheck =
  | { ok: true; overriddenGuards: GuardId[]; flagForReview: boolean }
  | { ok: false; code: "no_edge" | "track_inactive" | "actor_not_allowed" | "reason_required"
                      | "reason_wrong_phase" | "guard_failed";
      failedGuards: { id: GuardId; overridable: OverrideClass }[] };
```

Evaluation order (each step can stop): edge exists → track active → actor type allowed → end
reason present and of the right phase → guards (each `passed`, or overridden with a non-empty
reason if its class allows it). An override **never creates an edge** that doesn't exist.

#### Guards and overrides

`OverrideClass` is `none`, `with_reason` (PL, mandatory reason, audited, flagged for review) or
`profiling_exception` (the exception itself is the override). Guards are listed in the code
with their class and a source; a test asserts the list below exactly.

| Guard | Transition | Passes when | Override | Source |
|---|---|---|---|---|
| `dsv_fully_executed` | `informed → active_in_tg` | participant, customer and TG signature dates all set | **none** | docs (§623 BGB) |
| `asu_registered_with_proof` | `informed → active_in_tg` | an ASU record with proof, any channel | **none** | docs (§111(4) Nr. 4) |
| `profiling_done_or_exception` | `informed → active_in_tg` | `profilingStatus = profiling_done`, or `profilingException` with a reason | `profiling_exception` | docs (Q17); exception not allowed with `profiling_declined` until Q74 |
| `tg_start_reached` | `informed → active_in_tg` | `tgStart` set and `today ≥ tgStart` | **none** (change the planned date instead) | design; late entry is Q68 |
| `ta_completion` | `informed → ta_completed` | `ta_only`, `profiling_done`, PL confirms measures completed | **none** until Q71/Q73 | docs + Q73 |
| `withdrawal_after_dsv_signed` | `informed → withdrawn` with `dsv_signed` | cancellation document signed by all three parties present **and** PL confirms | **none** until Q71 | docs (*verify*, Q46) |
| `before_grace_end` | the four return arrows | no grace period (`ta_only`), or `today ≤ signingDeadline + gracePeriodDays` | **none** until Q71 | docs |
| `tl407_signed` | `profiling_in_progress → profiling_done` | signed TL 407 (participant and profiler) present | **none** until Q71 | docs |
| `dsv_generated` | `not_offered → dsv_offered` | a DSV document was generated | **none** until Q71 | docs |
| `dsv_scan_received` | `dsv_offered → dsv_signed` | scan stored and receiver recorded | **none** until Q71 | PRD F8 |

The docs say a PL may override any guard not marked "none", but they only classify the TG
entry guards. Q71 asks for the rest; until then they are `none` (D10). The facts behind
`dsv_*`, `tl407_signed`, `asu_*` and the cancellation are absent in Slice 1 (D4), so those
guards fail closed; the domain tests cover both outcomes with explicit facts.

**Deadline days are inclusive** (reading of the docs, to be confirmed in Q69): the DSV expires
on the first day *after* the signing deadline, and the grace period ends at the end of
`signingDeadline + gracePeriodDays`.

#### Withdrawal after `dsv_signed`

Before TG start, `informed → withdrawn` with `dsvStatus = dsv_signed` needs the cancellation
guard and an explicit PL confirmation. `dsvStatus` stays `dsv_signed` (the history is the
document plus the audit trail). The customer-notification flag comes with Slice 7. After TG
start it is a normal exit.

#### System planner (`planSystemTransitions`, PR 1c)

A pure function: `(participation, project, facts, window, config) → { changes[], flags[] }`,
where `window = { from, to }` runs from the day after the last completed sweep to `today` (a
normal night: one day; after an outage: every missed day). It applies its rules **in order on
the updated snapshot**, so one run after several missed nights reaches the same end state as
nightly runs, and a second run plans nothing (idempotency).

1. **`dsv_expired`**: `dsvStatus = dsv_offered`, `today > signingDeadline`. Effective date =
   `signingDeadline + 1`. (Re-offers after the deadline: Q69. Until answered, a re-offer after
   the project deadline is not expired by the system; it is flagged `reoffer_without_deadline`.)
2. **TG entry**: `status = informed`, `today ≥ tgStart`, all TG guards pass → `active_in_tg`,
   effective date = `tgStart`, `tg_entry_date = tgStart`. If a guard fails, no change and the
   participation shows up in "what's missing" (Slice 5). Entry *after* `tgStart` is Q68: until
   answered, the planner enters only when `tgStart` lies inside the window (so a missed night
   is caught up with the right effective date); a participation still `informed` with
   `tgStart` before the window is flagged `tg_start_missed`, and the PL sets a new planned
   start (Slice 2).
3. **Grace-period withdrawal** (only `ta_tg` with a signing deadline), when
   `today > signingDeadline + gracePeriodDays`; effective date = grace end + 1:

   | Precedence | Situation | Reason |
   |---|---|---|
   | 1 | `dsv_declined` | `declined_dsv` |
   | 2 | `profiling_declined` and DSV not signed | `declined_profiling` |
   | 3 | `dsv_expired`, or main status `unreachable` | `no_response` |

   - The highest applicable reason is the **primary** reason; all other applicable reasons go
     into the **secondary list** (participation column and audit details).
   - **Flags instead of withdrawal:** `dsv_signed` + `profiling_declined` →
     `conflict_dsv_signed_profiling_declined`; `informed` + `not_offered` →
     `dsv_never_offered`; `imported`/`contacted` → `not_informed_at_grace_end` (Q70).
   - `informed` with `dsv_signed` and profiling still open stays (it waits for TG start).

Flags are **derived, not stored**: `lifecycleFlags(snapshot, project, today)` returns them,
and the PL dashboard (Slice 5) calls it. Nothing about them needs a table.

#### Derived overall status

`deriveOverallStatus(main, profiling, dsv)` returns one i18n key (e.g.
`dsvSignedProfilingOpen`) for every *consistent* combination; it is never stored.
`isConsistentState` rejects impossible combinations (e.g. `imported` with
`profiling_in_progress`, `ta_only` with any DSV status but `not_offered`); the DB function
checks the same invariants via the edge table and `CHECK`s.

### 5.4 Audit events and the single status function

#### Audit event model (`packages/domain/src/audit`, table `audit_event`)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | `gen_random_uuid()` |
| `seq` | `bigint generated always as identity` | strict ordering |
| `project_id` | `uuid not null` FK `project` | data catalog rule (ADR-0002) |
| `participation_id` | `uuid null`, **no FK** | so retention (Slice 7) can delete the participation and pseudonymise the audit trail |
| `event_type` | enum | see below |
| `actor_type` | `user` / `participant` / `system` | |
| `actor_staff_user_id` | `uuid null` FK `staff_user` | staff are never hard-deleted (Q59) |
| `actor_participation_id` | `uuid null` | participant actor |
| `system_job` | `text null` | job name for `system` (e.g. `lifecycle.evaluate-project`, `seed`) |
| `on_behalf_of_participation_id` | `uuid null` | assisted mode; only with `actor_type = user` |
| `field` | `status` / `profiling_status` / `dsv_status` / null | |
| `from_value`, `to_value` | `text null` | |
| `reason_code` | `text null` | end reason, guard id, … |
| `reason_text` | `text null` | mandatory for overrides and break-glass; personal data possible, **never written to app logs** |
| `effective_date` | `date null` | the business date (TG entry, deadline + 1, …) |
| `occurred_at` | `timestamptz not null default now()` | DB time, not settable by the app |
| `request_id`, `job_id` | `text null` | correlation |
| `details` | `jsonb not null default '{}'` | IDs and codes only, shape validated per type by Zod (e.g. secondary reasons) |
| `flagged_for_review` | `boolean not null default false` | overrides, break-glass |

`CHECK`s make the actor consistent (user ⇒ staff id; participant ⇒ participation id; system ⇒
`system_job`; `on_behalf_of` ⇒ user). **Reviews are new events** (`review_recorded` pointing at
the reviewed `id`), never updates, because the table is append-only.

Event types (Postgres enum created now; the slice that first writes each is noted):
`participation_created`, `status_changed`, `guard_overridden`, `profiling_exception_set`
(Slice 1); `sensitive_read`, `break_glass_access`, `document_opened`, `warning_confirmed`,
`export_created`, `config_override_changed`, `review_recorded` (Slices 3–9).

Audit entries without a project (staff logins, admin template changes) don't fit
`project_id not null`; Slice 3 adds them to a separate table (section 8).

#### Functions (hand-written custom migration, owner `transfer_owner`)

All `SECURITY DEFINER`, `SET search_path = pg_catalog, public`, no dynamic SQL (explicit
branches per field), `REVOKE EXECUTE … FROM PUBLIC`, `GRANT EXECUTE … TO transfer_app`.

| Function | Does |
|---|---|
| `create_participation(project_id, actor…, request_id) → uuid` | inserts with the initial statuses (`imported`, `not_started`, `not_offered`) and writes `participation_created`. `self_registered` creation comes with Slice 4c. |
| `lock_participation(id) → participation` | `SELECT … FOR UPDATE`; the lock lasts until the caller's transaction ends (needed because `transfer_app` has no `UPDATE` privilege, section 2). |
| `change_participation_status(id, field, expected_from, to, actor…, on_behalf_of, end_reason, secondary_reasons, reason_text, effective_date, request_id, job_id, details) → audit id` | checks `expected_from` against the row (`stale_status` otherwise), checks `(field, from, to)` in `lifecycle_edge` (`invalid_transition` otherwise), checks `ta_only` ⇒ DSV unchanged, sets the column plus the dependent columns (`end_reason`, `end_reason_secondary`, `tg_entry_date`, `exit_date`), bumps `status_version`, inserts **one** `status_changed` event. |
| `set_profiling_exception(id, reason, set_on, actor…) → audit id` | sets the exception and writes `profiling_exception_set`. |
| `record_audit_event(type, …) → audit id` | for every other event type; **refuses** `participation_created`, `status_changed` and `profiling_exception_set`, so those can't be forged. |

Errors use one SQLSTATE (`P0001`) with a stable message code that the API maps to problems
later (`stale_status` → 409, `invalid_transition` → 422).

#### Status service (`apps/api/src/participations/status-service.ts`)

The only TypeScript code that calls the functions. One transaction:

1. `lock_participation(id)` and load the project.
2. Load guard facts through `GuardFactsProvider` (Slice 1: fail closed, D4). Later slices that
   write facts (DSV, ASU) take the same lock.
3. `canTransition(...)`; on failure throw a domain error, **write nothing**.
4. `change_participation_status(...)`; if guards were overridden, `record_audit_event(
   'guard_overridden', flagged)` in the same transaction.
5. Commit.

The nightly job uses the same service with the `system` actor.

#### Grants (custom migration, on the Slice 0 pattern)

| Object | `transfer_app` |
|---|---|
| `participation` | `SELECT` only |
| `audit_event` | nothing in Slice 1 (writes only through functions; `SELECT` comes with the first feature that reads it) |
| `lifecycle_edge` | nothing (read by the functions as owner) |
| `job_run` | `SELECT`, `INSERT` (one row per job and day, never updated) |
| the five functions | `EXECUTE` |
| `pgboss` schema | `USAGE` + DML on its tables/sequences (spike S2) |

The pseudonymisation role for the retention job comes with Slice 7 (ADR-0002).

### 5.5 Completeness engine (`packages/domain/src/completeness`)

The rule language is the minimal set from ADR-0004. **No scripting**: rules are data, validated
by a closed Zod schema (`additionalProperties: false` in the exported JSON Schema).

```ts
type CompletenessRule =
  | { id: string; kind: "required"; field: FieldKey }
  | { id: string; kind: "requiredIf"; field: FieldKey;
      when: { field: FieldKey; equals: string | number | boolean } | { field: FieldKey; exists: true } }
  | { id: string; kind: "documentPresent"; documentType: DocumentType; accepted?: boolean };

evaluateCompleteness(rulesByStep, facts) → { byStep: Record<Step, { complete: boolean; missing: MissingItem[] }> }
type MissingItem = { step: Step; ruleId: string; kind: "field" | "document"; key: string;
                     reason: "missing" | "not_accepted" };
```

- **Presence:** `null`, `undefined`, `""` (after trim) and `[]` are absent; `false` and `0` are
  present. Completeness checks presence only; value validity is checked on write.
- `equals` is strict equality on scalars (enum values, booleans, numbers).
- `documentPresent` with `accepted: true` needs a document of that type with status
  `accepted`; `uploaded`/`rejected` give `not_accepted`.
- **The output carries keys, never values**, so "what's missing" can't leak a sensitive value.
- Rule validation (used by `packages/config`): every `field` must exist in the field catalog or
  as a declared custom field; every `documentType` must exist; rule ids are unique.
- Document types in Slice 1: the ones the docs name (`dsv_signed_scan`, `tl407_signed_scan`,
  `kug200b_signed_scan`, `asu_proof`, `dsv_cancellation`); more come with Slices 4b/6.

### 5.6 Field catalog and the access matrix

#### Field catalog (`packages/domain/src/fields`)

One entry per participant field the docs name: `{ key, dataClass, accessCategory, listable,
customerVisible, storage: "column" | "custom" }`. Fields Slice 1 lists: Personalnummer, first
and last name, birth date, address, mobile, private email, work email, employment end date,
knowledge date, RV-Nummer, IBAN, Steuer-ID, BA-Kundennummer, Familienstand, nationality, entry
date, residence status, Bürgergeld, health restriction, Schwerbehinderung/Gleichstellung, GdB,
section C ratings, Gesamteinschätzung, weiteres Vorgehen, statuses, TG dates, end reasons.

- `listable` is `false` for every `special_category` and `highly_confidential` field (rule 9);
  a test enforces it.
- `customerVisible` is `true` for exactly the whitelist *(provisional, Q13)*: name,
  Personalnummer, DSV signed (yes/no + date), beE entry date, beE exit date.
- Fields the classification table doesn't cover (Familienstand, gender, Personalnummer,
  employment end date, knowledge date, work email, end reasons, free-text reasons) get the
  **more protective** of the plausible classes until Q66 is answered, never a weaker one.

#### Access categories (finer than data classes, because the matrix rows are)

| Category | Matrix row in data-protection.md | Data class |
|---|---|---|
| `case_internal` | statuses, dates (Internal) | internal |
| `confidential` | Confidential data | confidential |
| `health` | Health (structured) | special category |
| `disability` | Schwerbehinderung/Gleichstellung, GdB | special category |
| `identifiers` | RV-Nr., IBAN, Steuer-ID, BA-Kundennummer | highly confidential |
| `residence_social` | Nationality, residence status, Bürgergeld | highly confidential |
| `profiling_assessment` | Section C ratings, Gesamteinschätzung, weiteres Vorgehen | highly confidential |
| `signed_tl407`, `signed_kug200b` | Signed TL 407 / Kug 200b PDF | most sensitive content |
| `absence` | Sub-status periods | payroll records |
| `aggregated` | counts per project | aggregated |

#### `decideAccess(subject, resource, action, mode)`

```ts
type Subject =
  | { kind: "staff"; staffUserId: string; orgRole: OrgRole | null;
      projectRoles: Record<ProjectId, ProjectRole>;       // D6
      assignedParticipationIds: ReadonlySet<string> }
  | { kind: "participant"; participationId: string; knowledgeCheckPassed: boolean };
type Resource = { projectId: string; participationId: string | null;
                  category: AccessCategory; phase: "active" | "evidence_set" };
type Action = "read" | "list" | "open_document";
type Mode = { kind: "normal" } | { kind: "assisted"; onBehalfOf: string }
          | { kind: "break_glass"; reason: string };

type Decision =
  | { effect: "allow"; view: "full" | "metadata_only" | "absence_only" | "type_and_dates";
      audit: null | "sensitive_read" | "document_opened" | "break_glass_access";
      flagForReview: boolean }
  | { effect: "deny"; because: "not_member" | "not_assigned" | "never" | "needs_break_glass"
      | "needs_assisted_mode" | "needs_knowledge_check" | "not_in_list_payloads"
      | "undecided" };   // undecided = a docs gap (D10), with the question number
```

Rules, straight from the matrix (*assumed*, Q28/Q49/Q51):

- **Admin and regional admin:** every participant-level category is `never`; `aggregated`
  only (regional admin: their region's projects, region comes with Slice 2).
- **Project scope:** staff need a membership in `resource.projectId`; profilers/Berater also
  need the participation assigned. Non-assigned participations in a member project are
  `undecided` (Q62).
- **PL:** confidential and internal yes; health and disability only in assisted mode or
  break-glass; identifiers, residence/social, section C **no**; signed TL 407/Kug 200b: `read`
  gives metadata only, `open_document` is allowed and audited; absence: "abwesend" + dates.
- **Back office:** confidential, identifiers, residence/social yes; disability (Schwerbehinderung,
  Gleichstellung, GdB) yes; health no; section C no; signed forms **no**; absence: type + dates.
- **Profiler/Berater (assigned):** everything except as stated: section C yes, signed forms
  yes (opening audited), absence "abwesend" + dates.
- **Participant (own):** all own categories, special category only after the birth-date check;
  section C and signed forms: deny (Q67).
- **Read logging:** every allowed read of `special_category`/`highly_confidential` categories
  returns `audit: "sensitive_read"`; every `open_document` returns `document_opened`.
- **Lists:** `list` is denied for every special-category and highly confidential category,
  whoever asks (rule 9, review finding C11).
- **Break-glass:** only where the docs allow it (PL on health/disability; profiler, PL and back
  office on the evidence set), needs a non-empty reason, returns `break_glass_access` and
  `flagForReview`. On the evidence set it never grants more than the role has in the active
  phase. When the evidence-set phase starts is Q64.
- **Transition permissions** (`mayPerformTransition(subject, edge)`): the docs name the PL for
  manual withdrawal, matching, the profiling exception and `ta_completed`. Until Q60 is
  answered, **the PL may take every manual edge** of their project and everyone else is
  `undecided` (D10). Participants trigger no transition in Slice 1.

Write rules are not in the docs (Q65); Slice 1 builds `read`, `list` and `open_document` only.

### 5.7 `packages/config`

#### Template model

Authored in Zod (`src/model.ts`), exported by `pnpm generate` to
`schema/regional-template.schema.json` (JSON Schema 2020-12, committed, drift-checked).
`base-defaults.json`, the templates and project overrides are **layers** of one schema:

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
                                     "field": "custom.beispiel_zusatznachweis_nr" } ] },
  "helpTexts": { "de": { "asu_registration.intro": "…" } }
}
```

- Settings are marked **`nationwide`** or **`regional`** in the model. Nationwide settings live
  only in base defaults: grace period (90 days, Q3), ASU formula parameters (3 months / 3 days,
  *verify* Q1), profiling-exception deadline (1 month, Q17), Kug 200b confirmation follow-up
  (14 days), TL 407 escalation (14 days after TG start, Q54). Regional settings are the channels,
  `originalRequired`, `leadTimeDays`, `rejectsOutdatedFormVersions` (regional-variation.md).
  A template or override that sets a nationwide setting is invalid.
- Channel enums from the docs: ASU `kug_200b` / `online_self` / `in_person`; Kug 200b batch
  `paper_courier` / `paper_post` / `scan_email` / `upload`; TL 407 `email` / `upload` /
  `paper_original`.
- `dsv.deadlineRule` (regional-variation.md) and the "signing-deadline offset" (ADR-0004) have no
  defined meaning yet (Q69), so they are **not** in the model; `schemaVersion` bumps when added.
- Reminder rules are left to Slice 5 for the same reason.

#### Field-schema profile (custom fields, D5)

Allowed: `type` (`string` / `integer` / `number` / `boolean`), `enum`, `const`, `format: "date"`,
`minLength`, `maxLength` (≤ 2000), `pattern` (≤ 200 characters), `minimum`, `maximum`,
`title`, `description`, and our `x-dataClass` (only `confidential` or `internal`: special and
highly confidential fields need encrypted columns, never `jsonb`), `x-retentionClass` (must
exist in the data catalog), `x-label`. Anything else (`$ref`, composition, objects, arrays,
other formats) is rejected before compiling. Keys must start with `custom.`, so they can't
shadow catalog fields. Compiled validators are cached per (template id, version).

#### Merge rules (resolution: base defaults → template → project override)

- Settings: per key, the later layer replaces the earlier one (only regional keys may appear in
  templates and overrides).
- Rules: merged by `id`. **Base rules are locked**: a template or override can add rules, never
  remove or replace a base rule (Q75 asks whether relaxing should ever be allowed).
- Fields: templates and overrides add custom fields; redefining an existing key is invalid.
- Help texts: per language and key, the later layer wins.

#### Resolver (`resolve.ts`, 100 % covered)

```ts
resolveForParticipation({ base, templatesByAgentur, override, placementAgenturKey, kugAgenturKey })
resolveForProject({ base, templatesByAgentur, override, kugAgenturKey })
  → { config: ResolvedConfig; provenance: Record<SettingPath, LayerRef>; warnings: Warning[] }
```

- **Two levels** *(provisional, Q15)*: participant steps (`Step.scope = participant`) use the
  placement Agentur's template, project steps the KuG-Agentur's.
- **Provenance** for every resolved setting and rule (`base`, `template:<id>@<version>`,
  `override`), for tests now and for the UI later.
- **No template for an Agentur:** resolve with base defaults + override and return the warning
  `no_template_for_agentur` (Q76; the warning is what reaches the PL dashboard).
- **Pinned versions** *(provisional, Q36)*: the resolver takes the snapshotted template
  objects; `load.ts` reads `templates/<agenturKey>/<version>.json` and validates it. Storing
  snapshots per project and the explicit migration are Slice 2.
- `ResolvedConfig` must be complete; `base-defaults.json` alone must resolve to a complete
  config (test).

#### Base defaults (`packages/domain/config/base-defaults.json`)

Only what the docs state: the nationwide settings above, default channels (`kug_200b` for the
ASU), and the default completeness rules the docs name: the import-required fields
(Personalnummer, Nachname, Vorname, Geburtsdatum, Austrittsdatum, Anschrift; PRD F2,
provisional), the Kug 200b fields the BA marks required (RV-Nummer, declarations 16 and 17;
ba-forms.md), and the documents per step (`dsv_signed_scan`, `asu_proof`). **TL 407's
required fields** come with the form registry in Slice 6, read from the blank form's `*`
markers (a primary source), not guessed now.

### 5.8 `packages/adapters`: `Clock`

```ts
interface Clock { now(): Date; today(): IsoDate }   // today() in Europe/Berlin
class SystemClock implements Clock {}
class ManualClock implements Clock { set(instant: Date): void; advanceDays(n: number): void }
createClock(env)  // CLOCK=system (default) | fixed:<ISO instant> (dev/test only; refused in production)
```

- `today()` uses `Intl.DateTimeFormat` with `Europe/Berlin` (no Temporal on Node 22).
- **No `Date.now()` / `new Date()`** in `packages/domain`, `packages/config` and
  `apps/api/src/jobs`: a test scans those sources and fails on them (Oxlint has no rule for
  `Date.now`).
- `createApp` gets `clock` injected (Slice 0 left the slot open).

### 5.9 Jobs (`apps/api/src/jobs`, pg-boss, ADR-0011)

- **Setup:** `db:migrate` (and `dist/migrate.js`) installs and migrates the `pgboss` schema as
  `transfer_owner`, then (re)applies the grants for `transfer_app` (idempotent, because pg-boss
  upgrades can add tables). The API starts pg-boss as `transfer_app` with migration off when
  `JOBS_ENABLED=true` (default `true`; `false` in tests, which start it explicitly).
- **Schedule:** `lifecycle.sweep`, cron `JOBS_LIFECYCLE_CRON` (default `15 2 * * *`), `tz:
  Europe/Berlin`. The sweep enqueues one `lifecycle.evaluate-project` job per `ta_tg`/`ta_only`
  project with `singletonKey = <projectId>:<today>`, so a double run that day is a no-op.
- **Per-project job:** loads the project's participations, runs `planSystemTransitions` per
  participation with the window from the last completed sweep (`job_run`, written when the
  sweep's project jobs have finished) to `clock.today()`, and applies each change through the status service with
  `actor_type = system`, `system_job = lifecycle.evaluate-project`, `job_id`. Idempotent by
  construction: the planner plans nothing for an already-moved participation, and the status
  function's compare-and-set rejects a concurrent duplicate.
- **Payloads carry IDs only:** each job has a Zod payload schema; a test asserts every payload
  schema contains only `uuid`/ISO-date fields. Logs carry job name, job id, project id and
  counts, never participation data.
- Retries with backoff (pg-boss defaults, `retryLimit: 3`); failed jobs are visible in the
  `pgboss` tables and in the log (monitoring with Slice 9).
- **`pnpm jobs:lifecycle [--today YYYY-MM-DD]`** runs the sweep once, synchronously (dev, CI
  and demos; `--today` uses a `ManualClock` and is refused with `NODE_ENV=production`).
- pg-boss's tables aren't Drizzle tables, so they're outside the data catalog test; ADR-0011
  already excludes them from participant retention (their archive settings clean them up).

### 5.10 Database, data catalog and seed

| Table | Columns (main) | `retentionClass` | `dataClass` | Participant data |
|---|---|---|---|---|
| `participation` | `id`, `project_id` (FK, not null), `status`, `profiling_status`, `dsv_status`, `tg_start`, `tg_end`, `tg_entry_date`, `exit_date` (all `date`), `end_reason`, `end_reason_secondary end_reason[]`, `profiling_exception`, `profiling_exception_reason`, `profiling_exception_set_on`, `status_version`, `created_at` | **`participation_record`** (new): the event-driven rules of ADR-0008 (non-signers: grace end; TG: 3 years after the end of the year of exit; evidence set) — *verify* Q3/Q24; period `unset` in code until Slice 7 | `confidential` (end reasons and free-text reasons, Q66) | yes |
| `audit_event` | section 5.4 | **`audit_log`** (new): 3 years, pseudonymised when the subject's data is deleted; entries of an evidence set follow it — *verify* Q3; `unset` in code until Slice 7 | `confidential` | yes |
| `lifecycle_edge` | `track`, `from_value`, `to_value` (pk), `actors` | **`reference_data`** (new): no personal data, never touched by the retention job | `internal` | no |
| `job_run` | `job_name`, `run_date` (pk), `completed_at` | `reference_data` | `internal` | no |

`CHECK`s on `participation`: `tg_start ≤ tg_end`; `end_reason` set exactly for `withdrawn` /
`exited`; `tg_entry_date` set for `active_in_tg` / `exited`; `exit_date` set for `exited`.

**Seed (synthetic only):** for "Restrukturierung Werk Nord" (`ta_tg`, deadline 2027-02-15, TG
start 2027-03-01) about 15 participations covering every main status, each track status and
every flag case; three in the `ta_only` project. No names (there are no personal
columns yet). Created and moved **through the functions** with `actor_type = system`,
`system_job = seed`, so every seeded state has its audit trail. Idempotent by fixed UUIDs.

**Generated tables** (`pnpm generate`, drift-checked in `pnpm verify`):
`docs/domain/generated/lifecycle-transitions.md` (every edge with actors, guards and override
class) and `docs/domain/generated/access-matrix.md` (role × category × mode × phase → decision,
including the `undecided` cells with their question number). These are what the DPO and the
PLs review.

### 5.11 Open questions and what Slice 1 builds meanwhile (D10)

| Q | Gap | Built in Slice 1 until answered |
|---|---|---|
| Q60 | Who may take which manual transition | PL: all manual edges of their project; others `undecided` |
| Q61 🔒 | Global vs. per-project role; same person PL and profiler | one project role per person per project (D6) |
| Q62 🔒 | Profiler/Berater access to non-assigned participants in a member project | denied (`undecided`) |
| Q63 🔒 | Who reviews break-glass and overrides; scope of one break-glass | flagged in the audit; one decision per resource read |
| Q64 🔒 | When "evidence set after exit: break-glass only" starts | `phase` is an input; nothing sets `evidence_set` before Slice 7 |
| Q65 🔒 | Write permissions per category | no write rules in Slice 1 |
| Q66 🔒 | Classification of fields the table doesn't list, of health-revealing end reasons, of free-text reasons | most protective plausible class |
| Q67 🔒 | Participant access to own signed forms | denied in the portal |
| Q68 | TG entry after the planned start date | only catch-up within missed job days; otherwise flag `tg_start_missed` |
| Q69 | Deadline for re-offered DSVs; meaning of "signing-deadline offset" / `deadlineRule`; inclusive deadline days | no system expiry of re-offers (flag); inclusive days as in 5.3 |
| Q70 | Grace end for `imported`/`contacted` | flag, no withdrawal |
| Q71 | Override class of the guards the docs don't classify | `none` |
| Q72 | Changing the primary reason after a system withdrawal | not possible |
| Q73 | How `ta_only` participations end; "measures completed" | manual withdrawal; PL confirmation; no override |
| Q74 🔒 | Profiling after TG entry with the exception (allowed moves, missed 1-month deadline, exception with `profiling_declined`) | forward moves only; deadline miss is a reminder (Slice 5), no status change; no exception with `profiling_declined` |
| Q75 | May templates or overrides relax base requirements | no (base rules locked) |
| Q76 | No template for the placement Agentur | base defaults + warning |

## 6. Commands (new or changed)

| Command | What it does | PR |
|---|---|---|
| `pnpm test:coverage` | `vitest run --coverage` with **100 % thresholds** (statements, branches, functions, lines) on `packages/domain/src/{lifecycle,access,completeness}/**`, `packages/domain/src/dates.ts` and `packages/config/src/resolve.ts`; CI runs it in the Node 24 test leg | 1b |
| `pnpm generate` | all generators: `api:generate`, the config JSON Schema, the two docs tables | 1b, 1d, 1f |
| `pnpm verify` | now `typecheck`, `lint`, `test:coverage`, `generate` + `git diff --exit-code` on all generated paths | 1b |
| `pnpm jobs:lifecycle [--today YYYY-MM-DD]` | runs the lifecycle sweep once | 1h |
| `pnpm db:migrate` | also installs/migrates the `pgboss` schema and applies its grants | 1h |

New environment variables (`.env.example`, PR 1h): `JOBS_ENABLED` (`true`),
`JOBS_LIFECYCLE_CRON` (`15 2 * * *`), `CLOCK` (`system`). Plus `DATABASE_JOBS_URL` only if the
S2 fallback is taken.

## 7. Acceptance criteria

U = unit, I = DB/API integration, CI = workflow, R = review. Test files are named so the
criterion can be found.

### Lifecycle (PRs 1b, 1c)
- [ ] **AC-1** For every `(track, from, to)` pair (10² + 5² + 5²) the expected result is
      listed, and the allowed set equals section 5.3's edge table exactly; all others are
      `no_edge`. (U `lifecycle/edges.test.ts`)
- [ ] **AC-2** Tracks move only in `informed`; the DSV track never moves in `ta_only`; profiling
      moves forward in `active_in_tg` only with the exception; nothing moves after a terminal
      status. (U `lifecycle/track-activity.test.ts`)
- [ ] **AC-3** System-only edges (`informed → active_in_tg`, `dsv_offered → dsv_expired`)
      reject `user`; user-only edges reject `system`. (U)
- [ ] **AC-4** TG entry: all 2⁵ combinations of {DSV fully executed, ASU with proof, profiling
      done, exception with reason, TG start reached} — entry only when all hold (exception
      replacing "profiling done"); `dsv_fully_executed` and `asu_registered_with_proof` fail
      **even with an override request**; an exception without a reason doesn't count.
      (U `lifecycle/tg-entry-guard.test.ts`)
- [ ] **AC-5** Every guard declares its override class; the `none` set equals section 5.3; an
      override needs a non-empty reason, sets `flagForReview`, and never creates an edge.
      (U `lifecycle/overrides.test.ts`)
- [ ] **AC-6** Manual withdrawal: allowed from `imported`/`contacted`/`unreachable`/`informed`
      with a `pre_tg` reason only; with `dsv_signed` it needs the cancellation fact **and** PL
      confirmation, with no override; `exited` needs a `tg` reason. (U)
- [ ] **AC-7** Grace-period planner: every combination of main ∈ {`imported`, `contacted`,
      `unreachable`, `informed`} × 5 profiling × 5 DSV statuses × project type gives the
      primary reason by precedence, the secondary list, or the right flag; nothing happens on
      the grace-end day itself; nothing happens in `ta_only`. (U `lifecycle/planner-grace.test.ts`)
- [ ] **AC-8** `dsv_expired` happens on `signingDeadline + 1`, not on the deadline; TG entry
      has effective date `tgStart`; a catch-up run whose window covers N missed days ends in
      the same state as N nightly runs; a `tgStart` before the window gives `tg_start_missed`
      instead of an entry; a second run on the same day plans nothing.
      (U `lifecycle/planner.test.ts`)
- [ ] **AC-9** Every consistent `(main, profiling, dsv, projectType)` has a derived-status i18n
      key; `isConsistentState` rejects the rest. (U)
- [ ] **AC-10** `asuDueDate` and `addMonths`: the docs' examples (end 31.12., knowledge 01.12. →
      04.12.; 31.05. − 3 months → 28./29.02.; 31.12. → 30.09.) and leap years. (U, *verify* Q1)

### Audit and the status function (PR 1g)
- [ ] **AC-11** As `transfer_app`: `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on `participation`,
      `audit_event` and `lifecycle_edge` fail with `42501`; `SELECT … FOR UPDATE` on
      `participation` fails; `EXECUTE` on the five functions works. (I `db/grants.int.test.ts`)
- [ ] **AC-12** `change_participation_status` writes the column and **exactly one** audit row;
      if the surrounding transaction rolls back, neither exists; a stale `expected_from` gives
      `stale_status`; an edge missing from `lifecycle_edge` gives `invalid_transition`;
      `record_audit_event` refuses the three status event types. (I `db/status-function.int.test.ts`)
- [ ] **AC-13** `lifecycle_edge` equals the domain edge list. (I, drift)
- [ ] **AC-14** Audit `CHECK`s reject inconsistent actors (system without job, `on_behalf_of`
      without a user, user without staff id). (I)
- [ ] **AC-15** Status service: a failed guard writes nothing; an override writes
      `status_changed` + flagged `guard_overridden` in one transaction; two concurrent changes
      of the same participation serialize (one wins, the other gets `stale_status`).
      (I `api/participations/status-service.int.test.ts`)

### Completeness (PR 1e)
- [ ] **AC-16** Truth tables for `required`, `requiredIf` (`equals`, `exists`) and
      `documentPresent` (± `accepted`), including `""`, `[]`, `null`, `false`, `0`; the output
      contains keys, never values. (U `completeness/engine.test.ts`)
- [ ] **AC-17** Rules referencing unknown fields or document types, duplicate ids, or unknown
      keys are rejected. (U)

### Access (PR 1d)
- [ ] **AC-18** Every cell of data-protection.md's access matrix is an explicit expectation and
      passes; the full enumeration (subject × membership × assignment × category × mode × phase
      × action) yields exactly one decision per case, and every case not covered by the docs is
      `undecided` with its question number. (U `access/matrix.test.ts`)
- [ ] **AC-19** `list` is never allowed for special-category or highly confidential categories,
      for any subject. (U)
- [ ] **AC-20** Break-glass only where the docs allow it, only with a reason, always audited and
      flagged; admins never. Special-category reads by participants need the birth-date check.
      Every allowed sensitive read returns `sensitive_read`; every `open_document` returns
      `document_opened`. (U)
- [ ] **AC-21** Field catalog: every field has a data class and access category; no
      special-category or highly confidential field is listable; `customerVisible` is exactly
      the five whitelist fields. (U `fields/catalog.test.ts`)
- [ ] **AC-22** `docs/domain/generated/lifecycle-transitions.md` and `access-matrix.md` match the
      code. (U, drift)

### Config (PR 1f)
- [ ] **AC-23** `base-defaults.json` and both sample templates validate against the committed
      JSON Schema, which matches the Zod model (drift); base defaults alone resolve to a
      complete config. (U)
- [ ] **AC-24** Resolution order, provenance, two-level resolution (participant steps from the
      placement Agentur, project steps from the KuG-Agentur), locked base rules, rejection of
      nationwide settings in templates/overrides, and `no_template_for_agentur`. (U
      `config/resolve.test.ts`, 100 %)
- [ ] **AC-25** Field-schema profile: each allowed keyword compiles and validates like
      hand-written Zod; disallowed keywords, `special_category`/`highly_confidential` custom
      fields and unknown retention classes are rejected; `format: date` rejects `2027-02-31`.
      (U)
- [ ] **AC-26** Adding a version 2 file of a template doesn't change resolution for a project
      pinned to version 1. (U)

### Clock and jobs (PRs 1a, 1h)
- [ ] **AC-27** `today()` is the Berlin date around midnight UTC and across both DST switches
      (e.g. `2027-03-27T23:30Z` → `2027-03-28`). No `Date.now()`/`new Date()` in domain, config
      and jobs (source scan). (U)
- [ ] **AC-28** pg-boss starts as `transfer_app` against the schema installed by `db:migrate`,
      and the nightly schedule is registered with `Europe/Berlin`. (I)
- [ ] **AC-29** With a `ManualClock` and fake facts, the lifecycle job produces `dsv_expired`,
      `active_in_tg` and grace-period withdrawals with the right reasons and `system` actor;
      running it twice adds no status change and no audit row. (I `api/jobs/lifecycle.int.test.ts`)
- [ ] **AC-30** With the Slice 1 facts provider, no participation enters the TG (fail closed). (I)
- [ ] **AC-31** Job payload schemas contain only IDs and dates; job log lines contain no
      participation data (captured logger). (U, I)
- [ ] **AC-32** The image smoke test passes with the pg-boss schema installed by
      `node dist/migrate.js`. (CI)

### Platform and data protection
- [ ] **AC-33** Data catalog has `participation`, `audit_event`, `lifecycle_edge`, `job_run`; both
      participant-data tables have `project_id` FKs. (U)
- [ ] **AC-34** Seeded participations are created only through the functions, and each has a
      complete audit trail; synthetic only. (I, R)
- [ ] **AC-35** New dependencies pinned exactly; one `pg-boss` in the lockfile; tests pass on
      Node 22 and 24. (CI)
- [ ] **AC-36** `pnpm test:coverage` enforces the 100 % thresholds in CI. (CI)

### Definition of done (CLAUDE.md) applied to this slice
- Status changes through the audit helper: **the core of this slice** (functions + grants).
- No hard-coded regional rules: regional settings only in templates; nationwide settings only in
  base defaults; no Agentur name in code.
- No vendor calls outside adapters: pg-boss is infrastructure on our own Postgres (ADR-0011),
  not an external service; `Clock` is an adapter.
- New personal data: `participation` (confidential, `participation_record`) and `audit_event`
  (confidential, `audit_log`) have a class, an access rule (5.6) and a retention class.

## 8. Deliberately left out

| Not in Slice 1 | Why / where it lands |
|---|---|
| Person data, import, duplicate handling | Slice 2 (`participation` has no personal columns yet) |
| Storing template snapshots per project, project overrides in the DB, template migration | Slice 2 (project setup with template selection); the resolver already takes pinned snapshots |
| Project membership and assignment tables, region on projects | Slices 2/3; the access function takes them as input (D6) |
| API routes for status changes, participations or access | Slices 2, 3, 5; Slice 1 has no new route |
| Wiring `decideAccess` into requests, sessions, logins and their audit | Slice 3 |
| Audit events without a project (logins, template publication) | Slice 3 (separate table) |
| Write permissions per category | after Q65, with Slice 4a |
| Field-level encryption, separate sensitive endpoints, `sensitive_read` writes | with the first such field (Slices 4a/6); the access decision already says when to log |
| DSV documents, signature dates, ASU records, signed TL 407, cancellation documents | Slices 6/7; guards fail closed until then (D4) |
| Customer-notification flag after withdrawal from `dsv_signed` | Slice 7 |
| `self_registered` creation and the 30-day rejection job | Slice 4c |
| Reminders, "what's missing" UI, dashboards, escalation to the regional admin | Slice 5 (they call `evaluateCompleteness` and `lifecycleFlags`) |
| TL 407 required-field list in base defaults | Slice 6, from the blank form (ADR-0009) |
| Reminder rules and `dsv.deadlineRule` in the template model | Slice 5 / after Q69 |
| Retention job, pseudonymisation role, retention periods in code | Slice 7 (classes added now, periods `unset`) |
| Row-level security | pre-pilot gate (ADR-0005) |
| Other adapter interfaces | with their slices (D9) |
| Separate worker process, job monitoring | Slice 9 if needed (D7) |
| Admin UI for templates | later; templates are seed files in the MVP (ADR-0004) |

## 9. Doc changes made by the implementing PRs

Not in this plan PR (which only adds this plan and Q60–Q76). Each lands with the PR named here.

- **1a:** `docs/decisions/2026-10-15-answers-round-7.md` (D1–D10 and any answers to Q60–Q76,
  with their status in `open-questions.md`); S1 note in ADR-0004, S2 note in ADR-0011;
  CLAUDE.md "Repo layout" (`config`, `adapters` with `Clock` only); glossary additions
  (`gracePeriodEnd`, `endReason`, access categories) where new terms appear.
- **1b/1c:** process-and-lifecycle.md: link the generated transitions table; record the
  readings this plan relies on (inclusive deadline days, effective dates, catch-up order,
  derived flags) or their answers.
- **1d:** data-protection.md: access categories and a link to the generated access matrix.
- **1f:** regional-variation.md: the concrete template model replaces the sketch (layers,
  nationwide vs. regional settings, merge rules, field-schema profile); ADR-0004 amendment
  (Zod-authored model exported as JSON Schema, the profile, D5).
- **1g:** ADR-0002 amendment (`SECURITY DEFINER` functions, `lifecycle_edge`, no FK from
  `audit_event` to `participation`, grants); data-protection.md / ADR-0008: the retention
  classes `participation_record`, `audit_log`, `reference_data`.
- **1h:** ADR-0011 amendment (schema install, runtime role, in-process workers, schedule time
  zone, `singletonKey`); architecture overview (jobs); CLAUDE.md "Commands" (`test:coverage`,
  `generate`, `jobs:lifecycle`, the changed `verify` and `db:migrate`); `.env.example`;
  `.claude/settings.json` allowlist for the new commands; README status.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `z.fromJSONSchema` is experimental upstream | Restricted profile validated before compiling; spike S1 with the Ajv fallback; contained in `packages/config/src/field-schema.ts`. |
| Zod's JIT probe raising CSP violations in the SPAs | `z.config({ jitless: true })` in both SPAs (checked in S1, enforced by the e2e CSP check from Slice 4a on). |
| pg-boss needs more than DML at runtime, or releases break us | Spike S2 with the `transfer_jobs` fallback; pinned exactly, upgrades only in deliberate PRs; contained in `apps/api/src/jobs` and the migrate step. |
| Logic duplicated between TypeScript and SQL drifts | SQL checks only the edge list (from a table kept equal to the domain by a test) and invariants; guards live only in TypeScript. |
| `SECURITY DEFINER` functions as an attack surface | Fixed `search_path`, no dynamic SQL, `EXECUTE` revoked from `PUBLIC`, inputs checked, grant tests (AC-11/12). |
| 100 % coverage tempts tests that only touch lines | Table-driven expectations derived from the docs (AC-1, AC-7, AC-18), generated tables reviewed by people. |
| Fail-safe defaults (D10) make later demos look restrictive | Answers to Q60–Q76 change tables and tests, not the design; the generated tables show exactly which cells wait for an answer. |
| Free-text reasons (overrides, break-glass, profiling exception) may contain sensitive details | Never in app logs or job payloads; classified `confidential` pending Q66; shown only through the audit views (Slice 3+). |
| Nightly job misses days (deploys, outages) | State-based planner with catch-up semantics (AC-8); `singletonKey` per project and day. |
| Deadlines read off by one day | Inclusive-day reading stated explicitly (5.3), tested, and put to the PLs in Q69. |

## 11. Approval

Answer D1–D10 (and any of Q60–Q76 you can) in the PR. Implementation starts with PR 1a on a
new branch once the plan is approved.
