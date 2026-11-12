# Database: audit

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
