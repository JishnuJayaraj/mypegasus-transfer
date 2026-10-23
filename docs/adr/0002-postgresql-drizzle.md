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
  content again (`override_unchanged`). The content is a permitted `jsonb` payload (see
  "Conventions as built" below): the service validates it against every pinned chain first (`validateProjectOverride`), the function
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

## Amendment 2026-10-20: no self-registration in the core (Slice 3, PR 3a)

Built in PR 3a (round 35): `main_status` loses `self_registered` and `rejected`, `edge_kind` loses
`anonymous_self_registration`, and `lifecycle_edge` their edges. Postgres can't drop an enum
value, so migration 0033 recreates both types: it drops every object that names them (the
participation and audit `CHECK`s, `lifecycle_edge_values_of_track`, the early-exit trigger,
`end_reason_fits`), converts the columns through `text` and recreates the objects unchanged; it
replaces `change_participation_status`, `set_participation_dates` and `revoke_profiling_exception`
(same signatures) without the `'rejected'` comparison, which would fail at run time. It refuses a
database holding a removed value. `participation_unmatched_has_no_wave` is gone.

## Amendment 2026-10-21: activation-code and notice evidence (Slice 3, PR 3d)

- `activation_code` holds an activation credential's keyed hash, channel and non-secret state;
  `privacy_notice_delivery` is immutable evidence of the exact Article 14 notice version,
  language, method and provision time. Both carry `project_id` and `participation_id`.
  `transfer_app` may select them for authorised projections but has no table-write privilege.
- Five `SECURITY DEFINER` functions own the writes: `issue_activation_code`,
  `record_activation_delivery`, `hand_over_activation_code`, `revoke_activation_code` and
  `record_privacy_notice`. They use the established fixed `search_path`, revoke execution from
  `PUBLIC`, grant it only to `transfer_app`, take the participation/project lock, repeat the
  issuance checks under that lock and write ID/code-only audit details in the same transaction.
- Batch issuance and notice-only letters lock participations in sorted UUID order and are all or
  nothing. The partial unique index permits at most one non-terminal code per participation; a
  conscious reissue revokes the prior code as `reissued` before inserting the replacement.
- A terminal main-status transition invokes an `AFTER UPDATE` trigger in the status transaction
  and revokes every open code as `participation_closed`. Notice rows reject update and delete for
  every role. Database time sets the 30-day code lifetime and every evidence timestamp.
- In-person delivery is a two-transaction protocol around the provider call: issuance commits as
  `pending`; the API sends with the code row id as its idempotency key; then
  `record_activation_delivery` records `sent`, `failed` or `unknown`. Only `sent` creates notice
  evidence, `failed` revokes the code, and `unknown` leaves it valid without claiming delivery.

## Amendment 2026-10-21: participant activation and sessions (Slice 3, PR 3e)

- New tables, each with `project_id`: `participant_account` (one per participation),
  `consent_record`, `participant_channel` (the normalised private address, unique per kind while
  not removed), `one_time_code_challenge` (a keyed hash and the address it went to, 15 minutes,
  5 wrong entries) and `participant_session` (a token's SHA-256, `activating` or `active`, the
  activation steps done, the step-up). `transfer_app` may select them and update
  `participant_session.last_seen_at` only.
- The status body moved into the internal `apply_status_change` (no grant), unchanged in
  behaviour but for the `activation` edge kind; `change_participation_status` keeps its signature,
  asserts `user` or `system` and delegates. `edge_kind` was recreated with `activation` (an
  `ADD VALUE` couldn't be used by the same migration transaction).
- Eight granted functions (`0042_participant_activation_functions.sql`): `start_activation`,
  `check_activation_birth_date`, `check_activation_delivery_address`, `create_one_time_code`,
  `record_one_time_code_delivery`, `complete_activation`, `end_participant_session`,
  `mark_activation_notice_sent`. They lock participation, then code, then session, and repeat
  every step rule under the locks. A counted failure (a wrong birth date or delivery address, a
  wrong one-time code) is **returned**, never raised, so its count commits; the fifth locks the
  code (`activation_code_locked`, actor `system`, job `portal-activation`) or ends the one-time
  code (`one_time_code_exhausted`). An unusable code returns `NULL` from `start_activation` and
  counts nothing.
- `create_one_time_code` serialises an address on a transaction advisory lock and counts its codes
  of the last hour (login and verification together). `complete_activation` writes the code's use,
  the consent, the channel, the account, the audit events and the status change, ends the
  activating sessions and starts the `active` one, all in one transaction; a refusal after the
  verification rolls the verification back too.
- `issue_activation_code` refuses an activated account (`already_activated`); the terminal-status
  trigger also ends the participation's sessions.

## Amendment 2026-10-21: portal login, channels and recovery (Slice 3, PR 3f)

- No new tables. `0043` adds the audit types `participant_login`, `contact_channel_removed`,
  `consent_ended`, `contact_channels_suspended` and the session end reasons `lost_access` and
  `no_channel`; `0044` adds the functions, with 0042's conventions.
- Six new granted functions: `request_login_code` (a live channel's address gets a `login`
  challenge, any other address `NULL` and nothing written), `record_login_code_delivery` (the
  send's outcome, no session needed), `start_participant_session` (the code sent to that address,
  an `active` session with its step-up, `participant_login`), `request_channel_code`,
  `add_participant_channel` (the verified channel with its own consent) and
  `remove_participant_channel` (consent ended `revoked`; the last one ends every session). Counted
  failures are returned as in 0042. The active-session functions lock through the internal
  `lock_active_session` (participation, then session).
- `issue_activation_code` gains `p_purpose` (`activation` by default). `recovery` needs an
  activated account (`not_activated`), skips the cutoff, and in the same transaction ends every
  session (`lost_access`) and suspends every live channel (`contact_channels_suspended`).
  `start_activation`, `create_one_time_code` and `complete_activation` accept a recovery code for
  an activated account; its completion removes the old channels and ends their consents with
  `lost_access_replaced`, writes no account and no status change, and audits a
  `participant_login`. `assert_channel_available` may ignore the participation's own old
  channels (a recovery only); `verify_one_time_code` may require the challenge's address (login).
  Both were dropped and recreated, so no overload remains.

## Amendment 2026-10-21: field encryption with pgcrypto (Slice 4a, PR 4a-4)

Decided in [round 38](../decisions/2026-10-21-answers-round-38.md) (Q135): the highly confidential
and special-category fields are encrypted **in the database**, inside the SECURITY DEFINER
functions that write and read them.

- `0049` creates three tables, one row per participation and one retention class each:
  `participant_identifier_data` (RV-Nummer, `participation_record`),
  `participant_residence_social_data` (nationality, entry date, residence status, Bürgergeld,
  `personnel_file`) and `participant_health_data` (health restrictions and
  Schwerbehinderung/Gleichstellung yes/no, `health_record`). Each field is a `bytea` ciphertext
  beside an unencrypted `<field>_present` boolean (a CHECK holds them equal), with the row's
  `key_id` and `written_at`. Completeness and every list or state payload use the presence only.
- `0050` installs `pgcrypto` in its own schema `crypto` (a trusted extension the owner role
  creates); `transfer_app` has no `USAGE` on it, so it can't call pgcrypto at all.
- **Encryption:** `pgp_sym_encrypt(…, 'cipher-algo=aes256, compress-algo=0')` (OpenPGP with an
  integrity check, no compression). The plaintext is an envelope `{p: participation id, f: field
  key, v: value}`; decryption checks `p` and `f` and refuses a mismatch (`envelope_mismatch`), so a
  ciphertext copied to another row or field can't be read there. A wrong key or damaged
  ciphertext is `decryption_failed`, pgcrypto's own message dropped.
- **The key:** the API derives it (HKDF-SHA256, info `field-encryption:v1`) from
  `FIELD_ENCRYPTION_KEY` (at least 32 characters, required outside development; a fixed constant
  in development like `ACCESS_CODE_SECRET`'s) and passes it per call as a **bind parameter**,
  never with `set_config` (which would leave it in the session). `key_id` is a 64-bit fingerprint
  of the derived key, stored per row: a row written under another key is `key_unknown`, never
  misread. Rotation (re-encrypting under a new key) is a later migration; the key never reaches a
  log, an error or the audit trail. The cluster's Postgres must log no statements or bind
  parameters (ADR-0005, pre-pilot gate).
- Two granted functions: `write_sensitive_fields(context, participation, group, values, revision,
  notice version, key, key id, token hash)` writes one group (`ba_details` or `health`) whole for
  the participant through their live active session (`lock_self_service_writer`, as the page
  writes); the health group needs the session's step-up (`step_up_required`); the notice and the
  wizard's one `revision` are checked as for the pages, and a write bumps it. It decrypts the stored
  values to find the changed fields and audits one `sensitive_write` per changed field key;
  nothing changed writes nothing. `read_sensitive_fields(context, participation, keys, key, key
  id, token hash)` decrypts the keys and audits one `sensitive_read` per key, so no read path skips
  the log: a participant through their own live active session (health and disability need the
  step-up), staff in normal mode only as the assigned consultant (every field) or back office of
  the project (all but the health restrictions), else `actor_not_allowed`. The API decides with
  the access matrix first; the functions check again. Staff write, and read on the participant's
  behalf, in assisted mode (amendment below).
- The structure of each value is checked in the database too (`sensitive_value_valid`: the
  RV-Nummer's format, nationality `german` or `other` with a country other than `DE`, an ISO
  date, the residence statuses, booleans), and entry date and residence status only with the
  nationality `other`; the domain's schemas (`packages/domain/src/self-service/sensitive.ts`)
  validate first and give the codes.
- Grants: `transfer_app` selects only the key, presence, key-id and time columns of the three
  tables (column grants), never a ciphertext; no `INSERT`, `UPDATE` or `DELETE`. The step-up
  functions are below (ADR-0007).
- **Step-up state** on `participant_session`: `sensitive_step_up_method` (`birth_date`,
  `photo_id_and_code`), `sensitive_step_up_at` (both or neither, only on an `active` session) and
  `step_up_failures` (0–5). Granted: `check_step_up_birth_date`, `request_step_up_code` (a
  `step_up` one-time code to a live channel of the participant's; returns its kind and address
  for the send) and `verify_step_up_code`; counted failures are returned, never raised, as in 0042.
  Internal: `record_step_up` (audited `step_up_completed`), `fail_step_up` (the fifth ends the
  session `step_up_failed`, audited), `participant_session_stepped_up`. `record_audit_event`
  refuses the two step-up types.

## Amendment 2026-10-22: assisted mode (Slice 4a, PR 4a-5)

- **`assisted_mode`** (internal, `case_internal`, `access_credential`; data-protection.md): the
  staff session's hash (FK to `staff_session`), the staff user, the participation and project, how
  (`in_person`, `phone`), started, ended and the end reason (`ended`, `staff_session_ended`); at
  most one live row per session and participation (a partial unique index). `transfer_app`
  selects it, writes none of it.
- **`start_assisted_mode(participation, context, staff session hash, how, id)`** (granted): a
  staff user acting for themselves (`on_behalf_of` null) through their live session
  (`session_invalid`), under the participation lock; refuses a terminal participation
  (`participation_closed`) and a user without a role that may use it (`actor_not_allowed`: the
  PL or back office of the project, the consultant while assigned, an active account). A mode the
  session had open for the participation, and the user's modes of sessions no longer live, end
  first. Audited `assisted_mode_started` (the id and how). **`end_assisted_mode(participation,
  context, staff session hash)`** (granted) ends the session's live mode (`assisted_mode_ended`,
  `ended`) and returns whether there was one. Both event types are reserved
  (`record_audit_event` refuses them).
- **The staff session's end ends its modes:** a trigger on `staff_session` (`ended_at` set by
  logout, a superseding login or a deactivation) ends them (`staff_session_ended`, audited as the
  mode's staff user). An expired session's modes aren't live (every check joins the session);
  the user's next start closes them.
- **Writes and reads on the participant's behalf:** the self-service functions take actor `user`
  with `on_behalf_of` the participation and `p_token_hash` the staff session's hash
  (`lock_self_service_writer` → `lock_assisted_mode`: the live mode of that session and
  participation, share-locked, else `assisted_mode_required`; the roles again, else
  `actor_not_allowed`). `write_self_service_data` and `acknowledge_self_service_notice` then work
  as for the participant (contact fields become participant-maintained). `write_sensitive_fields`
  takes exactly the group's fields the roles see (`assisted_sensitive_fields`: the assigned
  consultant all, the PL health and disability, back office all but the health restrictions); the
  others keep their stored values, re-encrypted under the current key. `read_sensitive_fields`
  returns only those fields. No step-up for staff. Every write and read is audited with actor and
  `on_behalf_of`.

## Amendment 2026-10-22: documents (Slice 4b, PR 4b-2)

Migrations `0053_documents.sql` (generated) and `0054_document_functions.sql` (hand-written, the
0052 hardening); data-protection.md ("Uploads", documents) holds the rules.
- **`document_type_policy`** (reference data, written only by migrations): per document type and
  catalog version the retention class, whether the file name is kept, signed, and the roles that
  add, review, delete and open (`participant` and project roles; empty while the type's operations
  are undecided, Q65). A drift test holds it equal to the domain's `documentTypeCatalog`; a new
  catalog version is a migration adding its rows. Opening in assisted mode or through break-glass
  (the PL's `assisted_or_break_glass` and `metadata_break_glass_open` rights) comes with the types'
  slices.
- **`document`**: one row per stored file, never its content: type, catalog version and retention
  class (a composite FK to the policy, so a row has its type's class: retention per row,
  ADR-0008, `by_document_type` in the data catalog), media type, size (1 B–10 MB), the content's
  SHA-256, the kept file name, the key id and the wrapped data key, who added it (actor kind, staff
  id, on behalf), the review (state, reason, reviewer, time) and a deletion's tombstone (who by
  kind, reason; the file name erased by a `CHECK`) and `purged_at`. `transfer_app` selects every
  column but `wrapped_key` and `content_sha256` (column grants) and writes none.
- **`document_link`**: an opening's link: the SHA-256 of 32 random bytes, the document, the
  session's kind and hash, `expires_at` (60 s). `transfer_app` has no privilege on it.
- **Functions** (granted): `add_document` (the upload, after the API scanned, encrypted and
  stored the object; refuses `participation_closed`, `document_type_not_supported`,
  `actor_not_allowed`, `document_limit`, `upload_rate_limited`; audited `document_added` with the
  source `portal` / `staff` / `assisted`), `record_document_upload_rejected` (the audit event only,
  the same actor checks), `open_document` (the open right again, a live session of the caller,
  inserts the link, audited `document_opened`), `document_link_content` (the only path that returns
  the wrapped key: a live link of that live session and a live document; not audited again),
  `review_document` (normal mode, once: `document_reviewed`), `delete_document` (staff with a
  reason in normal mode, the participant their own while not accepted: `document_accepted`; signed
  types `document_immutable`) and `record_document_purged` (the purge job; idempotent, refuses a
  live document). The actor is found by the internal `lock_document_actor`: the participation
  locked first, the participant through their live active session, staff in assisted mode through
  `lock_assisted_mode`, staff in normal mode by their project roles (`document_staff_roles`, the
  consultant while assigned). The five document event types and `document_opened` are reserved
  (`record_audit_event` refuses them); their details carry ids and codes, never a file name, the
  content or its hash.

## Amendment 2026-10-22: reminders and consent v2 (Slice 5, PR 5-2)

Migrations `0055_reminders.sql` (generated) and `0056_reminder_functions.sql` (hand-written, the
0054 hardening); data-protection.md ("Reminders", "Consent v2") holds the rules.
- **`participant_reminder`** (internal, `case_internal`, `personnel_file`; the field
  `reminderLog`): id, project and participation (a composite FK), batch, kind, text version,
  language, the channel's id (FK) and kind, the consent id it was queued under (FK), the
  requester's staff id, `requested_at`, `requested_on` (the Berlin date of the window), status, a
  closed cancel reason, `claimed_at`, `outcome_at`; `CHECK`s tie the cancel reason to `cancelled`
  and the outcome time to a final status. Never an address, a text, a provider answer or an
  error. `transfer_app` selects it and writes none.
- **`request_reminders(context, project, participation ids, kind, message version, batch)`**: the
  exclusive project lock; refuses `invalid_argument` (1–500 distinct ids, the version
  `portal-reminder:v1`), `actor_not_allowed` (assisted mode, any role but the PL or the assigned
  consultant), `participation_not_found` (another project's id; for a consultant one not assigned
  to them), `project_not_active`. Per row under the participation lock: `participation_closed`,
  `no_channel`, `consent_required`, `reminded_recently` (a row with `requested_on` within 3 days of
  the database's Berlin date); otherwise the channel is picked (`kind = 'email' desc, verified_at
  desc, id`), the row written `queued` and `reminder_queued` audited. Returns per participation
  the reminder id and channel kind, or the skip code.
- **`claim_reminder_dispatch(reminder, has actions, job id)`**: under `lock_participation`, the
  reminder `FOR UPDATE` and its queued channel and consent `FOR SHARE`, rechecks the status, the
  channel (live, still on that consent), the consent (live, `portal_contact`, exactly v2), the
  requester (`document_staff_roles`) and the job's verdict on the actions; `dispatching`, or
  cancelled with the reason; from `dispatching` (a retry) a failed check settles
  `delivery_unknown` (`settled`). `record_reminder_outcome(reminder, outcome, cancel reason, job
  id)`: once per reminder (the same outcome again is a no-op, another `reminder_settled`). Both
  audit `reminder_delivery` as the system (`reminders.send`).
- **Consent v2:** `consent_end_reason` adds `superseded`. `upgrade_channel_consent(session,
  channel, consent id, version, language)` locks the participation (with the session), the channel
  and its consent; ends v1 `superseded`, inserts the participant's v2 consent, repoints
  `participant_channel.consent_id` and audits `consent_ended` and `consent_given`, or returns
  `already_current`. `complete_activation` and `add_participant_channel` are replaced to accept
  `portal-contact-consent:v2` only. No migration changes an existing consent's version (a test
  reads the migrations).
- `reminder_queued` and `reminder_delivery` are reserved (`record_audit_event` refuses them) and
  need their participation (the `CHECK` compares the type as text, as 0054 does). Grants:
  `EXECUTE` on the four functions; the helpers (`reminder_requester_allowed`,
  `reminder_job_context`, `settle_reminder`) have none.

## Amendment 2026-10-23: the audit history (Slice 5, PR 5-3)

Migrations `0057_audit_history.sql` (generated) and `0058_audit_history_function.sql`
(hand-written, the 0056 hardening); data-protection.md ("The audit history as built") holds the
rules.
- **Reference tables, written only by the migrations** (`reference_data`, no personal data),
  each held equal to the domain by a drift test: `audit_event_projection` (per event type, and per
  status field for `status_changed`: the stream, null for project-level events; `shows_change`,
  `shows_reason`, `detail_keys`; the domain's `auditProjection`), `role_field_knowledge` (per
  project role the access categories whose field keys a history keeps; `roleFieldKnowledge`) and
  `field_access_category` (the field catalog's categories and `custom.*`). `event_type` is text:
  a value added to `audit_event_type` can't be inserted in the migration that adds it. A new
  event type is a migration adding its projection row (the drift test fails without it).
- **`audit_history(staff session hash, participation, before seq, limit, request id)`**, the
  authorization boundary: the live session of an active account (`unauthenticated`), the
  participation (`participation_not_found`), a member of its project (`not_member`), the roles of
  `document_staff_roles` (the consultant while assigned; none left: `not_assigned`); limit
  1–100 (`invalid_argument`). Rows: the PL `case`, `profiling`, `dsv`; the consultant `case`,
  `profiling` and, with `actor_staff_user_id` the viewer, `dsv` and `payroll`; back office `dsv`,
  `payroll`; the union. Joined to the projection, it returns per row the seq, time, type, actor
  type, the staff actor's current display name, the system job, whether on behalf (assisted),
  `field`/`from`/`to` and the reason code where shown (else null), the effective date and the
  details through the internal `audit_history_details` (the allowed keys; in `fields` only the
  keys of a category the roles know); newest first before `before seq`. Without `before seq` it
  writes `audit_history_opened` in the caller's transaction.
- `audit_history_opened` is reserved (`record_audit_event` refuses it) and needs its
  participation (the `CHECK` compares the type as text). Grants: `SELECT` on the three reference
  tables, `EXECUTE` on `audit_history`; `audit_history_details` has none; `transfer_app` still has
  no privilege on `audit_event`.

## Amendment 2026-10-23: appointments and staff bookings (Slice 5b, PR 5b-1)

Migrations `0059_appointments.sql` (generated) and `0060_appointment_functions.sql` (hand-written,
the 0058 hardening); process-and-lifecycle.md and data-protection.md ("Appointments") hold the
rules.
- **`appointment`** (`project_master`, `internal`): id, project, kind, host (staff id, a
  consultation only), audience wave (a composite FK to the project's wave, an info event only),
  start, end, public cutoff, capacity, title, venue, status, closed cancel reason, `cancelled_at`,
  creator, `created_at`, `version`; `CHECK`s for the times (end after start, cutoff 0–14 days
  before the start), capacity 1–500, the texts (trimmed, lengths, no control characters), host and
  audience by kind and the cancellation columns. **`appointment_booking`** (`personnel_file`,
  `case_internal`, the field `appointmentBookings`): id, project, participation (composite FK),
  appointment (composite FK), origin, status, closed cancel reason, `booked_by` (null exactly for
  the participant), `booked_at`, `cancelled_by` (exactly for a staff or organizer cancellation),
  `cancelled_at`; the partial unique index `(appointment_id, participation_id) WHERE status =
  'booked'` backs `already_booked`. `transfer_app` selects both and writes neither.
- **The lock order.** Every function takes the project's advisory lock first: shared through
  `lock_participation` when it touches one participation, exclusive (`lock_project_setup`) when it
  changes an appointment. Then always: participation rows (in UUID order) → the appointment row →
  booking rows (in id order); never an appointment before a participation. One host's slots
  serialise across projects on an advisory lock of the host (`assert_host_free`), taken after the
  project lock.

  | Operation | Project lock | Then |
  |---|---|---|
  | `book_appointment`, `cancel_appointment_booking` | shared (`lock_participation`) | the participation → the appointment `FOR UPDATE` (capacity, overlaps) → the booking |
  | `create_appointment`, `update_appointment`, `change_appointment_host`, `cancel_appointment` | exclusive | the participations of its live bookings in UUID order → the appointment → its bookings in id order; the host lock for a slot's times or host |
  | a terminal status (`apply_status_change`) | shared (held) | the participation (held) → its booking rows in id order; no appointment lock (a freed seat only lowers a count) |

  Integration tests race the last seat, the same booking twice, two projects creating
  overlapping slots of one host (Q171), and a booking, an appointment
  cancellation and a terminal transition together (no deadlock, no live booking left on a
  cancelled appointment).
- **Functions** (`SECURITY DEFINER`, staff context in normal mode only, `actor_not_allowed`
  otherwise): `create_appointment(context, project, id, kind, host, wave, start, end, cutoff,
  capacity, title, venue)` (the PL any, a consultant their own slot, in a draft or active
  project, Q170; `host_not_allowed`, `not_ta_tg`, `wave_of_other_project`, `starts_in_past`, `host_overlap`);
  `update_appointment(context, id, version, the whole new state)` (`stale_version`,
  `appointment_cancelled`, `appointment_in_use` for times, cutoff or audience after any booking,
  `starts_in_past`, `capacity_below_bookings`, `host_overlap`, `appointment_unchanged`);
  `change_appointment_host(context, id, version, host)` (the PL, before the start; also
  `not_consultation`, `appointment_started`, `host_not_responsible`); `cancel_appointment(context,
  id, reason)` (every live booking `appointment_cancelled`; returns their number);
  `book_appointment(context, appointment, participation, id)` (origin `staff`; the PL or the
  assigned consultant; an active project only, `project_not_active`; the domain's refusals in its order, `after_cutoff` through
  `participation_before_cutoff`); `cancel_appointment_booking(context, booking)` (`staff_cancelled`;
  `booking_cancelled`, `appointment_started`).
- **The terminal cancellation** is the trigger `participation_terminal_cancel_bookings` beside the
  code revocation: in the status function's transaction, the live bookings of appointments that
  haven't started end `participation_closed`, audited as the system
  (`terminal-booking-cancellation`).
- **Events:** `appointment_created`, `appointment_changed`, `appointment_cancelled` (project-level),
  `appointment_booked`, `appointment_booking_cancelled` (`case`, need their participation), each
  with its `audit_event_projection` row; ids, codes and times only (`startsAt` as written), never
  the title or venue. All five are reserved (`record_audit_event` refuses them). Grants: `SELECT` on
  both tables, `EXECUTE` on the six functions; the helpers have none.

## Conventions as built (Slices 0–2)

Roles and grants:
- **Two roles, the same names on the cluster** (`packages/db/sql/setup.sql`; CloudNativePG manages
  them there). `transfer_owner` owns the databases and tables and runs migrations and seeds.
  `transfer_app` is the runtime role: `CONNECT`, `USAGE` on `public` and only the per-table grants
  the hand-written migrations give it (`0001_grants.sql` onwards). No default privileges; no
  `UPDATE`/`DELETE` unless a feature needs it.
- On every table added in Slice 2 `transfer_app` has `SELECT` only; the functions write. The one
  exception is `import_column_mapping`: `SELECT, INSERT, UPDATE`, no `DELETE`, no audit event. It
  holds keyed hashes of normalised headers and their targets, a suggestion cache the API writes
  itself (`0027_import_mapping_grants.sql`).

- Slice 3 (PR 3b): `transfer_app` has `SELECT` on `staff_session` and no privilege on
  `staff_audit_event`; staff sessions, identity bindings and refused logins are written only by
  their functions (`0035_staff_session_functions.sql`, below).
- Slice 3 (PR 3c): `transfer_app` has `SELECT` on `region`, `staff_org_role` and
  `participant_assignment` and writes none of them, nor `staff_user` or `project_membership`;
  their functions do (`0037_team_and_org_functions.sql`, below).
- Slice 3 (PR 3d): `transfer_app` has `SELECT` on `activation_code` and
  `privacy_notice_delivery`, and no `INSERT`, `UPDATE` or `DELETE`; the functions above perform
  every write (`0039_activation_codes.sql`, `0040_activation_code_functions.sql`).
- Slice 3 (PR 3e): `transfer_app` has `SELECT` on `participant_account`, `consent_record`,
  `participant_channel`, `one_time_code_challenge` and `participant_session`, plus
  `UPDATE (last_seen_at)` on `participant_session`; the activation functions write the rest
  (`0041_participant_activation.sql`, `0042_participant_activation_functions.sql`).

Schema:
- **Data catalog** (`packages/db/src/data-catalog.ts`): every table has a `dataClass`, a
  `retentionClass` and `holdsParticipantData`. A table with participant data needs
  `project_id uuid not null` with an FK to `project`; `data-catalog.test.ts` fails for a table
  missing from the catalog, an unknown class or an unscoped participant table.
- `date` columns use Drizzle `mode: "string"`.

Functions:
- **Typed parameters** (enums, `date`, `uuid`, `audit_context`). The only `jsonb` parameters of
  granted functions are template and override content, whose structure the functions check in SQL,
  and `record_audit_event`'s `details`, held by the audit table's `CHECK`s.
- **Read, decide, write under the project lock.** A service that reads state, decides in
  TypeScript and then calls a function takes `lock_project_setup` first in the same transaction;
  the functions take it again (transaction-scoped advisory locks are re-entrant). So do project and
  entry-wave edits, pins, the template migration, override and relaxation writes, activation, the
  import confirm and the manual creation (`apps/api/src/imports/confirm.ts`,
  `participations/manual-creation.ts`).
- **`write_participant_data`** (0024, 0025) is the only writer of `participant_identity` and
  `participant_details`. A null argument keeps the stored value. Refusals: `identity_required` (a
  first write without the Personalnummer and both names), `personnel_number_immutable`,
  `personnel_number_taken` (unique per project), `address_incomplete`, and `invalid_argument` for a
  `CHECK` violation. Actors `user` and `system` only: no assisted mode (`invalid_actor`), never a
  participant. It writes `participant_data_changed` with the changed keys only (`IS DISTINCT
  FROM`), never values, and no event when nothing changes. Table `CHECK`s: text trimmed, without
  control characters, length 1–50 (Personalnummer), 1–100 (names), 1–200 (street, city), 1–30
  (phone, mobile), 1–254 (emails); the four address columns all set or all null; country
  `^[A-Z]{2}$` and only `DE`; a `DE` postal code has five digits. Nothing deletes these rows; that
  is the retention job's (ADR-0008).
- **`set_participation_dates`** (0031, 0032): user actor only; the amendment parameters all set or
  all null (`invalid_argument`); compare-and-set on `status_version` (`stale_status`). One call
  writes the dates, the amendment of a signed DSV, one `ba_reporting_task` per changed effective
  date (`later_entry`, `planned_end_changed`) and `participation_dates_changed`. Refusals:
  `not_ta_tg`, `wave_required`, `participation_closed`, `dsv_offer_open`,
  `dsv_amendment_required`, `amendment_not_allowed`, `dates_unchanged`, `entered`,
  `amendment_kind_mismatch`. `record_audit_event` refuses the event type.
- `participation_dsv_amendment` is append-only by trigger, for every role. A `ba_reporting_task`
  is never deleted; only its status moves, once, from `pending` to `reported` or `not_required`,
  and what it reports never changes (`task_immutable`). The `early_exit` task comes from an
  `AFTER UPDATE OF status` trigger on `participation` (an exit before the effective contractual
  end, or without one). The trigger is not `SECURITY DEFINER`: status changes run only inside the
  status function, as the owner, so the trigger does too.
- `assign_entry_wave` refuses `individual_dates_set` on the locked row (0028).
  `audit_event_lifecycle_has_participation` requires a participation for
  `participation_created_manually` and `participation_dates_changed` too (0030, 0031).
  `import_confirmed`, `warning_confirmed` and `participation_created_manually` are written through
  `record_audit_event`.

- **Staff sessions (0034, 0035; Slice 3, PR 3b):** four `SECURITY DEFINER` functions, each writing
  its `staff_audit_event` in the caller's transaction, with plain typed parameters and the request
  id (staff events have no project, so no `audit_context`):
  - `start_staff_session(staff_user_id, token_hash, method, oidc_issuer, oidc_subject,
    superseded_token_hash, request_id)` → `expires_at`: locks the account `FOR SHARE`, refuses
    `unknown_account`, `account_deactivated`, and for method `oidc` an identity other than the bound
    one (`identity_mismatch`); ends the superseded live session (`superseded`), inserts the row with
    database time + 8 hours and writes `staff_login` (method). `invalid_argument` for a hash that
    isn't 64 lowercase hex digits, an unknown method, an OIDC login without its identity or a dev
    login with one.
  - `end_staff_session(token_hash, request_id)` → boolean: ends the live session (`logout`) and
    writes `staff_logout`; false and no event when none is live.
  - `bind_staff_identity(staff_user_id, oidc_issuer, oidc_subject, matched_by, request_id)`: locks
    the account `FOR UPDATE`; refuses `unknown_account`, `account_deactivated`, an account already
    bound and an identity bound elsewhere (`identity_mismatch`, also from the unique constraint);
    writes `staff_identity_bound` (`matchedBy`).
  - `record_staff_login_refused(reason_code, subject_staff_user_id, method, request_id)`: the code
    and the matched account (none for `unknown_account`); it takes no email.
  - Table `CHECK`s: `staff_session` holds a SHA-256 key, exactly 8 hours, and an end reason with
    every end; `staff_audit_event` holds the event shape (a refusal has no actor; every other event
    is the actor's own), codes, ids and the details pattern of `audit_event`. `staff_user` keeps
    `(oidc_issuer, oidc_subject)` unique and complete, and one account per `lower(email)`.

- **Org model (0036–0038; Slice 3, PR 3c, Q62, Q126, Q131):** the flat `staff_user.role` is gone.
  0036 maps `project_lead` to `staff_user.may_create_projects` and `admin` to a global
  `staff_org_role` row (`granted_by` null only for these); flat regional roles get none (no region
  is known). `staff_org_role` holds `admin` without a region and `regional_admin` /
  `regional_operations_manager` with one (a `CHECK`), unique per account, role and region (nulls
  not distinct). `project.region_id` references `region` (code `^[A-Z0-9]([A-Z0-9-]{0,18}[A-Z0-9])?$`,
  unique; a trimmed name). `participant_assignment` is of its participation's project (composite
  FK), one open row per participation and consultant (partial unique index), closed with
  `ended_by`, `ended_at`, `end_reason` (`unassigned`, `consultant_removed`, `account_deactivated`),
  never deleted. `staff_user` holds a trimmed name and an address with one `@`.
  - Staff administration, by the global admin only (an active account holding `admin`, checked
    by the internal `assert_global_admin`), each with its `staff_audit_event` (actor, subject, ids
    and codes; never a name or email): `create_region` / `update_region` (`region_created`,
    `region_changed`; `region_code_taken`, `region_unchanged`, `region_not_found`),
    `create_staff_user` / `update_staff_user` (`staff_account_created`, `staff_account_changed`
    with the changed keys and the flag's value; `email_taken` from the case-insensitive unique
    index, `staff_user_unchanged`, `account_deactivated`, `unknown_account`), `grant_org_role` /
    `revoke_org_role` and the atomic complete-set `set_org_roles` (`org_role_granted` /
    `org_role_revoked` with role and region;
    `org_role_exists`, `org_role_not_found`, `region_not_found`, `own_account` for the admin's own
    admin role). Their parameters are typed values, the actor's staff id and the request id.
  - `deactivate_staff_user(id, actor, request_id)`: never the actor's own account
    (`own_account`). It and org-role revocation/set take one stable transaction advisory lock
    before re-checking the acting admin, so concurrent mutual operations leave an active admin
    (Q131). Deactivation then takes the exclusive lock of every project the account is a member of
    or assigned in (id order), then locks the account `FOR UPDATE` (`start_staff_session` holds it
    `FOR SHARE`, the team functions too), takes the locks of anything added before that, and
    refuses `last_project_lead` while the account is a project's only active PL. In the same
    transaction it ends the live sessions (`deactivated`), closes the open assignments
    (`participant_unassigned`, `account_deactivated`), deletes the memberships
    (`project_member_removed`, `account_deactivated`), deletes every org-role grant
    (`org_role_revoked` with role, region and `account_deactivated`), sets `deactivated_at` and
    writes `staff_account_deactivated` with the counts, including removed org roles.
  - Teams, under the exclusive project lock, with `audit_context` (a staff user, never assisted
    mode): `add_project_member` (the project's PL any role; a global admin only `project_lead` for
    someone else, `own_account`; an active account, `membership_exists`), `remove_project_member`
    (the PL; `membership_not_found`, `last_project_lead`; removing `consultant` closes that
    person's assignments in the project as `consultant_removed`), `assign_participations` (the
    PL; 1–500 distinct participations of the project, `participation_not_found`; only to a member
    holding `consultant`, `not_consultant`; open ones stay, returns the count of new ones) and
    `unassign_participation` (the PL; `assignment_not_found`). Events: `project_member_added`,
    `project_member_removed`, `participant_assigned`, `participant_unassigned` (staff id, role or
    assignment id, an end reason as the reason code); `record_audit_event` refuses the four.
  - `create_project` is replaced with `p_region_id` (`region_required`, `region_not_found`; the
    actor's `may_create_projects`), `update_project` with `p_region_id` (`region_not_found`; after
    activation only a global admin changes it, else `project_not_draft`).
  - `staff_audit_event_shape` (replaced in 0036, the new values compared as text): a refusal stays
    actor-less and email-free; logins, logouts and bindings stay the actor's own; account and
    org-role events have an actor and a subject; region events an actor, no subject and the
    region's id in `details`. The case is wrapped in `coalesce(…, false)`, so a missing column
    fails the check instead of passing as null.

Migrations:
- A value added with `ALTER TYPE … ADD VALUE` can't be used in the same transaction, and the
  Drizzle migrator runs all pending migrations in one transaction (`packages/db/src/migrate.ts`).
  So `CHECK`s and functions compare `event_type::text` with the new value's string (0024, 0030).
