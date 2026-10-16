# Decisions — 2026-10-16, round 23 (Slice 2, PR 2a review)

The product owner's review of PR 2a (#25) and the answers to the readings R23–R28 taken while
applying [round 22](2026-10-16-answers-round-22.md). Where they differ from earlier rounds, round
23 wins.

## Standards

1. **The seed uses the audited creation function.** `packages/db/src/seed.ts` inserted projects
   directly. Seed new projects through `create_project`, by the seeded PL with the fixed ids, so
   each has `project_created`. Reruns stay idempotent; seed fixtures must not weaken production
   invariants.
2. **Database refusals are handled precisely.** The project route turned every `P0001` into a 422.
   Allowlist the expected project refusal codes, map `project_not_found` appropriately and let
   unknown failures propagate. Extract the duplicated `P0001` decoder of the access module and the
   status service.
3. **Size:** the PR exceeds the guideline, but the excess is cohesive SQL redeclaration and
   migration work; no split is required.

## Spec

1. **Backfill existing project memberships.** Migration 0010 created the membership table without
   giving existing projects a PL. Backfill the creators whose flat role is `project_lead`; **fail
   the migration** if an existing project would remain without a PL; never silently elevate a
   non-PL creator. Extend the Slice 1 → 2 migration test.
2. **Complete the locking promise.** `create_project` took no exclusive lock, and `update_project`
   validated the context before locking although the plan makes the project lock its first
   operation. Acquire the new project id's advisory lock inside `create_project`, and move
   `update_project`'s project lock before any other work.
3. **Reject obsolete and unknown input fields.** `CreateProjectInput` stripped the old date fields
   and created the project without them: a stale client would silently lose contractual data.
   Create and update inputs are strict; the old date fields and a premature `projectAgenturKey`
   are validation errors.
4. **AC-3 wording.** The implementation correctly creates W1 only when at least one legacy date
   exists; creating empty W1 waves would needlessly prevent later type changes. AC-3 says so.

## Readings

- **R23 — not confirmed.** Five digits don't prove a German address: French and other foreign
  postal codes have five digits too. Until Q103 is answered, an import must **establish DE
  explicitly**, through a country column or a constant the PL selects, never infer it from the
  postal code.
- **R24 — confirmed** (numeric XLSX identifier cells are refused or dropped).
- **R25 — confirmed** as the conservative rule pending Q102.
- **R26 — confirmed with this exact list:** `project_activated`, `config_template_pinned`,
  `config_override_changed`, `rule_relaxation_requested`, `rule_relaxation_approved`,
  `import_confirmed`. Rejection and withdrawal need no base-defaults version unless they resolve
  configuration.
- **R27 — confirmed** (`config_template_version` without `project_id`).
- **R28 — confirmed** (the lock keys).

## Applied (PR #25)

- Migration 0011: the PL backfill with the failing check; `create_project` takes the new id's
  exclusive lock first; `update_project` locks before anything else. Tests: the backfill, the
  failing migration that leaves the database unchanged, and both locks.
- `seed.ts` creates the projects through `create_project` (skipping existing ones); the
  consultant and back-office memberships stay direct seed fixtures until Slice 3 brings member
  management (a reading in the plan).
- `apps/api/src/database-errors.ts` (`functionRefusal`) used by the status service and the project
  route; the route allowlists `project_unchanged`, `project_not_draft`,
  `project_has_participations`, `project_has_waves`, maps `project_not_found` to 404 and rethrows
  everything else (500).
- `CreateProjectInput` and `UpdateProjectInput` are strict; the validation problem lists each
  unknown field at its own pointer (`unrecognized_keys`).
- The plan (AC-3, R23–R28, 5.3, 5.11) and Q103/Q107 in `open-questions.md`.
