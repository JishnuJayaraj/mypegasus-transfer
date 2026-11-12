# Database: config

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
