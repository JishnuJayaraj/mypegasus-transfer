# Database: project setup

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
