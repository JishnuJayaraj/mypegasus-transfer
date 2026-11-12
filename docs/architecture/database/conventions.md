# Database: conventions

## Conventions as built (Slices 0–2)

Roles and grants:
- **Two roles, the same names on the cluster** (`packages/db/sql/setup.sql`; CloudNativePG manages
  them there). `transfer_owner` owns the databases and tables and runs migrations and seeds; in
  dev, CI and Compose only it also has `CREATEDB`, for the per-worker test databases (ADR-0003,
  testing). `transfer_app` is the runtime role: `CONNECT`, `USAGE` on `public` and only the per-table grants
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
  not distinct). `project.region_id` references `region` (code `^[A-Z0-9](../../adr/[A-Z0-9-]{0,18}[A-Z0-9])?$`,
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

Queries on one connection:
- **Queries on one transaction or connection run one after another, never concurrently**: no
  `Promise.all` (or un-awaited query) on a `tx`, the client of `transactionWithClient`, or a
  function that may be given one. pg 8 queues such a query with a deprecation warning and pg 9
  removes that queue. Parallel reads are for the pool (`db`) only, each on its own connection; a
  read that belongs to a transaction's snapshot never leaves it to run in parallel. The `db` and
  `api` test projects fail a test on any overlap (`packages/db/src/testing/sequential-queries.ts`).

Migrations:
- A value added with `ALTER TYPE … ADD VALUE` can't be used in the same transaction, and the
  Drizzle migrator runs all pending migrations in one transaction (`packages/db/src/migrate.ts`).
  So `CHECK`s and functions compare `event_type::text` with the new value's string (0024, 0030).
