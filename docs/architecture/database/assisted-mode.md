# Database: assisted mode

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
