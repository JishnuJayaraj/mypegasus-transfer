# ADR-0002: PostgreSQL + Drizzle, hybrid relational/jsonb model

- Status: Accepted
- Date: 2026-10-15

## Context
The data model is the core of the product and expensive to change later. Regional variation
needs flexible fields; reporting needs solid relational data.

## Decision
PostgreSQL 16 with Drizzle ORM and SQL migrations. Core entities and fields (person,
participation, status, dates, audit) are real columns. Config-driven fields live in `jsonb`
validated by the resolved Zod/JSON schema. Audit log is an append-only table.

## Consequences
+ Strong consistency, good reporting, one database to operate.
+ Pre-installed in cloud coding sessions (`service postgresql start`).
- jsonb fields need careful indexing if they become filter criteria; promote to columns when
  a field becomes universal.

## Amendments 2026-10-15

Decided (from the decisions log):
- **Legal and calendar dates are `date` columns** (signing deadline, TG start/end, exit, ASU
  due date, settlement dates). Event times are `timestamptz`.
- **Audit events** record the actor type (`user`, `participant`, `system`), `onBehalfOf`
  (assisted mode), from/to, reason, and are also written for guard overrides, break-glass
  access, document openings and confirmed plausibility warnings.
- **Special-category and highly confidential fields use field-level encryption** and are never
  part of list queries/payloads (data-protection.md).
- **Retention runs per data item/document** via `retentionClass` (ADR-0008). Audit entries of
  deleted subjects are pseudonymised.
- Locally Postgres 16, in production CloudNativePG on the cluster (ADR-0005). Keep the major
  versions aligned.

Accepted in the PR #1 review:
- **Status writes are enforced in the database.** Every change of the main status or a track
  (`status`, `profilingStatus`, `dsvStatus`) and its audit entry are written in **one
  transaction through a single function**. `UPDATE` on status columns is revoked from the app
  role. The audit table is **append-only by grants** (no `UPDATE`/`DELETE` for the app role;
  pseudonymisation runs under a separate role used only by the retention job).

- **Every table holding participant data has a `project_id` column from the start**, so
  row-level security per project can be added without migrating data. RLS itself is **not
  needed for the demo but required at the pre-pilot gate** (ADR-0005).

## Amendment 2026-10-16: status functions and the lifecycle tables (Slice 1, PR 1g-1)

Built in PR 1g-1:
- **Only `SECURITY DEFINER` functions write statuses and audit events.** Nine functions
  (`lock_participation`, `create_participation`, `change_participation_status`,
  `assign_entry_wave`, `request_profiling_exception`, `decide_profiling_exception`,
  `revoke_profiling_exception`, `correct_end_reason`, `record_audit_event`), in a hand-written
  migration owned by `transfer_owner`: fixed `search_path` (`pg_catalog, public, pg_temp`),
  schema-qualified names, no dynamic SQL, `EXECUTE` revoked from `PUBLIC` (also by default in
  `public`) and granted to `transfer_app` only. Each writes its change and its audit event in
  the caller's transaction; errors are `P0001` with a stable code, never a value. Grants,
  atomicity and drift are integration-tested.
- **Profiling-exception requests are first-class rows** (`profiling_exception_request`, round 16,
  Q94): one immutable row per request (reason and evidence identity, by an opaque evidence-record
  id and a versioned canonical fingerprint, which never leaves the row: not in audit details,
  logs or responses, round 17), whose status and decision progress on the row along an exact
  transition matrix enforced by a trigger;
  the participation references its current request. Never overwritten by the next request.
- **Grants:** `transfer_app` may `SELECT` `participation`, `profiling_exception_request` and
  `project_entry_wave` and has no
  privilege on `audit_event` or `lifecycle_edge` in Slice 1. Without `UPDATE` it can't
  `SELECT … FOR UPDATE`, so the status service locks through `lock_participation`.
- **`lifecycle_edge`** holds the domain's edge list as reference data for the functions; a
  drift test keeps it, the Postgres enums and the end-reason phases equal to the domain. Guards
  with dated facts stay in TypeScript; the functions check the edge list, the invariants and
  the four-eyes rule.
- **`audit_event` has no FK to `participation`** (`participation_id` stays when retention
  deletes the participation and pseudonymises the trail), a strict `seq` identity, database
  time in `occurred_at`, and **no free text** before encrypted storage exists (Q66): `CHECK`s
  hold every text column and every string in `details` to an id or code pattern and refuse
  inconsistent actors. Its shape per event type is the Zod model in
  `packages/domain/src/audit`.
- **Entry waves** (`project_entry_wave`, Q79) carry the contractual dates; the Slice 0 project
  dates were copied into one wave `W1` per `ta_tg` project. A participation's wave is of its own
  project (composite FK).

## Amendment 2026-10-16: project setup, memberships and the project lock (Slice 2, PR 2a)

Built in PR 2a:
- **Project setup writes go through `SECURITY DEFINER` functions** too, with their audit event
  in the same transaction: `create_project` (the project, the creator's PL membership,
  `project_created`) and `update_project` (`project_changed` with the changed keys, never the free
  text). `transfer_app` has no `INSERT` on `project` any more; `record_audit_event` refuses the
  setup event types like the lifecycle ones.
- **The project lock lives in the functions** (round 22): a transaction-scoped advisory lock per
  project (`project_lock_key`), exclusive in every setup mutation (`lock_project_setup`), shared
  in `lock_participation` before its row lock and in `create_participation`. Every participation
  function locks through `lock_participation`, so none interleaves with a setup mutation of its
  project, whatever a service remembers. Lock order everywhere: project → template version →
  participation row.
- **`project_membership`** holds zero or more project roles per staff user and project; the API builds the access subject from it. Managing members is Slice 3. The migration
  makes each existing project's creator its PL member when their flat role is `project_lead`, and
  fails if a project would be left without a PL; nobody is elevated silently (round 23).
- `create_project` takes the new project's exclusive lock first, `update_project` the project's
  (round 23). The seed creates its projects through `create_project` too.
- **The Slice 0 project date columns are gone**; their values live in the entry waves (W1 copied
  first for projects created after the Slice 1 migration). Projects have a `status`
  (`draft`/`active`) and a `project_agentur_key`.

## Amendment 2026-10-17: template versions and pins (Slice 2, PR 2c-2)

Built in PR 2c-2:
- **`config_template_version`** holds each template version once, keyed by `(agentur_key,
  version)`, with its content (`jsonb`) and canonical SHA-256; global reference data without
  `project_id`. **`project_template_pin`** is append-only (the current pin per Agentur is
  the highest `seq`) and carries `project_id`.
- **`pin_agentur_template`** (`SECURITY DEFINER`) takes the exclusive project lock first, then
  registers the version with `INSERT … ON CONFLICT DO NOTHING`: two concurrent first pins of one
  version serialise on the primary key, and every pin compares the stored content (`jsonb`
  equality) and hash with the supplied ones (`template_version_changed`). Lock order stays
  project → template version → participation row. It writes `config_template_pinned` with the
  base-defaults version.
- **Append-only for every role:** a trigger refuses `UPDATE` and `DELETE` on both tables, for the
  owner too; `transfer_app` has `SELECT` only. `record_audit_event` refuses the new type.
- **`update_project`** is replaced with a `p_project_agentur_key` parameter: only while draft and
  only to an Agentur the project has pinned (`agentur_not_pinned`), so a Project Agentur always
  has its snapshot.

## Amendment 2026-10-17: project override versions (Slice 2, PR 2d-1)

Built in PR 2d-1:
- **`project_config_override`** holds one row per override version, keyed by `(project_id,
  version)`, with the validated `project_override` content (`jsonb`); the current override is the
  highest version, no row is version 0. Append-only for every role (the 0016 trigger), `SELECT`
  only for `transfer_app`; retention class `project_master`.
- **`write_project_override`** (`SECURITY DEFINER`) takes the exclusive project lock first, then
  compares the expected version (`override_version_stale`, the API's 409) and refuses the current
  content again (`override_unchanged`). The content is one of the two permitted `jsonb` payloads (see "Conventions as built"): the
  service validates it against every pinned chain first (`validateProjectOverride`), the function
  checks its structure and that the claimed change is exactly what the content does (round 27):
  apart from the named Agentur's setting (an empty `agenturSettings` counting as none) the content
  equals the current one, so no field, rule, relaxation or other Agentur's setting changes under
  that audit event, and a set is confirmed by the acting user. It writes `config_override_changed` with the version, the change, the
  Agentur key, the setting keys it computes itself, the source of a set and the base-defaults
  version; `record_audit_event` refuses that type now.

## Amendment 2026-10-17: rule relaxation requests (Slice 2, PR 2d-2)

Built in PR 2d-2:
- **`config_relaxation_request`** holds one row per request (`project_id`, rule id, controlled
  reason code, status `requested` → `approved` / `rejected` / `withdrawn`, requester and decider
  with dates and instants). Like `profiling_exception_request`: decision and four-eyes `CHECK`s
  (the decider is never the requester), a trigger that lets the status only move forward and
  keeps the request's identity, at most one open request per project and rule (partial unique
  index). `SELECT` only for `transfer_app`; retention class `project_master`.
- **`request_rule_relaxation`, `decide_rule_relaxation`, `withdraw_rule_relaxation`**
  (`SECURITY DEFINER`) take the exclusive project lock first (for a decision or withdrawal after
  reading the request's immutable project id), refuse non-users and assisted mode, and write
  `rule_relaxation_requested` / `…_approved` / `…_rejected` / `…_withdrawn`; request and approval
  carry the base-defaults version. `record_audit_event` refuses the four types.
- **Override versions** are appended by the internal `append_project_override` (no `EXECUTE`
  for `transfer_app`), with the change kinds `relaxation_added` and `relaxation_removed` next to
  the Agentur-scoped ones and round 27's exact delta: apart from that rule's relaxation the
  content equals the current one. The granted **`write_project_override`** (replaced with a
  `p_rule_id` parameter) sets or removes Agentur-scoped settings and removes relaxations
  (tightening, no approval), and refuses `relaxation_added`. A relaxation is **added only by
  `decide_rule_relaxation`** in the transaction that approves the request: it passes the exact
  entry built from that locked request, the approver and the decision date, and the new content
  must hold exactly that entry (round 28; nothing is inferred from timestamps).

## Amendment 2026-10-17: project activation and the draft gate (Slice 2, PR 2e-1)

Built in PR 2e-1 (Q98):
- **`activate_project(id, base_defaults_version, context)`** (`SECURITY DEFINER`) takes the
  exclusive project lock first, refuses non-users and assisted mode, and re-checks under the lock
  what the service decided with `projectActivationBlockers`: the project is `draft`
  (`project_not_draft`; activation is one-way), its Project Agentur has a pinned template
  (`project_activation_blocked`, Q76, Q90) and a `ta_tg` project has an entry wave with a
  `latest_entry_date` (`no_entry_wave_with_latest_entry_date`, Q77). It sets `status = 'active'`,
  `activated_at` (database time) and `activated_by` (the context's staff user) and writes
  `project_activated` with the Project Agentur, the version of its pinned template and the
  base-defaults version, all computed in SQL. `record_audit_event` refuses the type.
  `transfer_app` still has no `UPDATE` on `project`.
- **The draft gate in the database:** `change_participation_status` (replaced, same signature)
  refuses every transition of a project that isn't `active` (`project_not_active`), right after
  the participation lock and before the stale check, as defence in depth for the status
  service's own check. Its shared project lock serialises it with `activate_project`.
  Creation and wave assignment stay allowed in draft.

## Amendment 2026-10-17: template version migration (Slice 2, PR 2e-2)

Built in PR 2e-2 (Q36, Q93):
- **`pin_agentur_template` pins an Agentur once per project:** its body moved to the internal
  `append_template_pin` (no `EXECUTE` for `transfer_app`), and the granted function refuses any
  version of an Agentur the project has pinned (`template_already_pinned`). So a version changes
  only through the migration, enforced in SQL.
- **`migrate_agentur_template(project, agentur_key, from_version, version, content, sha256,
  expected_version, override_content, base_defaults_version, context)`** (`SECURITY DEFINER`)
  takes the exclusive project lock first, appends the new pin through `append_template_pin` (the
  Agentur pinned, the version newer than `from_version`, then the pinned one still `from_version`;
  else `agentur_not_pinned`, `template_already_pinned`, `template_version_not_newer`,
  `pin_version_stale`, so a pin another migration moved is always stale, round 31; content and
  hash compared as for every pin), compares the expected
  override version (`override_version_stale`) and, with `override_content`, appends the next
  override version with the change `agentur_setting_reviewed`. Its exact delta (round 27): apart
  from the named Agentur's setting the content is the current one; that setting keeps its source
  and confirmation; its settings are the current ones with at least one key removed and no value
  changed or added (or the setting is gone with its last key). The audit event names the removed
  keys (`settingKeys`) and the kept ones (`keptSettingKeys`), computed in SQL, and the
  base-defaults version. Only this function writes that change kind, in the call that pins
  the new version (round 28); `write_project_override` and `append_project_override` refuse it.
