# Decisions — 2026-10-17, round 24 (Slice 2, PR 2b review)

The product owner's review of PR 2b (#26) and the readings taken in it. Where they differ from
earlier rounds, round 24 wins.

## Split

The combined PR (about 850 production lines) is not merged as-is. It is split at its commit
boundary:
- **2b-1** — domain, database, API, docs. About 600 lines, accepted as an exception because it is
  one cohesive domain → database → API unit.
- **2b-2** — the web page, its component tests and the Playwright step.

## Standards

1. Schema-qualify PostgreSQL built-ins in the hand-written migration, consistent with plan 5.3.
2. Prefer moving the shared route helpers exported from `routes/projects.ts` into focused shared
   modules (recommended, not blocking).
3. Keep generated artifacts with the PR that generates them.
4. In 2b-2, add the one-line `scrollTo` stub to `apps/portal` so test output is clean.

## Spec corrections

Blocking 2b-1:
1. **Defend `ta_tg` on update.** `update_entry_wave` must reject an update of a wave whose project
   is not `ta_tg` itself, with a database integration test; API and domain checks are not enough
   for a database invariant.
2. **Align Unicode length validation.** JavaScript counted UTF-16 units, PostgreSQL counts code
   points. `checkWaveChange` counts code points; astral characters are tested at 100/101.

Blocking 2b-2:
3. **Show every error for a field.** The API can return several errors for one field; the form
   kept only the first. Store and render all of them, with a same-field test.
4. **Send only changed fields on edit.** Sending the whole loaded wave through `PATCH` can
   overwrite another PL's unrelated edit. Diff against the loaded wave and send only the changed
   fields. Same-field last-write behaviour may remain until optimistic versioning.

## Readings

- **R29 confirmed:** "passed" means reached; a `defaultTgStart ≤ today` is immutable. The
  contractual date has begun even if the nightly run hasn't executed yet.
- **Wave code excluded from audit values — confirmed.** It is syntactically constrained but still
  user-authored: record the changed key and the immutable wave id, not old/new code text. The name
  stays excluded too.
- **Ordering as table constraints — confirmed.**
- **Invalid legacy waves fail the migration** rather than being rewritten — confirmed.
- **AC-7's import serialisation deferred to 2g-1** — confirmed.
- **Complete-row SQL function plus lock-scoped API merge** — confirmed, provided the web `PATCH`
  sends only changed fields.
- The remaining access, clock, pagination, seed, 404/403 and refusal mappings are confirmed.

## Applied

- 2b-1 (#26): `update_entry_wave` checks `ta_tg`; code-point length in `checkWaveChange`; built-ins
  schema-qualified in `0014`; `utc`, `callFunction`, `auditContext` in `apps/api/src/sql.ts`,
  `json` in `context.ts`, `projectAccess` in `access.ts`; the plan and Q101.
- 2b-2: the form keeps every error per field and sends only changed fields; the portal stub.
