# Decisions — 2026-10-19, round 31 (Slice 2, PR 2e-2 review; the round 30 docs PR)

The product owner's review of the round 30 docs PR (JishnuJayaraj/mypegasus-transfer#39) and of
PRs 2e-2a (JishnuJayaraj/mypegasus-transfer#40), 2e-2b (JishnuJayaraj/mypegasus-transfer#41) and
2e-2c (JishnuJayaraj/mypegasus-transfer#42), and the readings taken in 2e-2. Where it differs from
earlier rounds, round 31 wins.

## Standards

1. **#39:** Q102 and Q103 were only **proposed**, so the record can't claim the owners'
   confirmation. `personnel_file` stays a provisional fail-safe classification under Q105: the PL
   can't confirm a retention classification the DPO owns; its period and final class stay subject
   to the DPO's approval.
2. **#40:** `TemplateMigrationPreview.agenturKey` uses the shared `AgenturKey` schema, not an
   unrestricted string; OpenAPI is regenerated in #41.
3. #41 and #42: no further hard standards violations.

Non-blocking:
- Extract a browser-safe canonical JSON comparison instead of duplicating `canonicalJson`.
- Name the API helper `plan` more precisely.
- Rename the exported web type `Value`; consider sharing the setting-formatting helpers.

## Spec

1. **#39 falsely closed Q102/Q103.** Required: keep Q102 and Q103 open; don't lift the 2f/2g or 2h
   gates; don't apply A1–A15 as authoritative plan amendments; keep Q105 fully open and describe
   `personnel_file` only as provisional; fold the proposed DSV-amendment question back into Q102
   (Q110 isn't opened until that policy is accepted). Round 30 becomes a status record: the
   package is proposed and awaits confirmation, all gates retained. A later round applies the
   amendments once the owners really approve them.
2. **#40/#41 didn't always return 409 when the pin moved.** The service and `append_template_pin`
   checked the target against the current pin before comparing `fromVersion`, so a concurrent
   migration that reached the review's target gave `template_already_pinned` (422) and one beyond
   it `template_version_not_newer`. Required order for the confirm:
   1. 404 visibility;
   2. 403 capability;
   3. 404 missing pin;
   4. 422 target absent from the catalog or not newer than the declared `fromVersion`;
   5. 409 actual pin differs from `fromVersion`;
   6. 409 override differs from `expectedVersion`;
   7. 422 incomplete review;
   8. 422 invalid override;
   9. write.

   The same invariant in SQL, with tests where the concurrent migration reaches the requested
   target and moves beyond it: both 409, no write.
3. **#41: the preview could combine incompatible database states.** `projectSnapshot` runs
   separate statements under `READ COMMITTED`, so a migration committing between the pins and the
   override read gives an impossible old-pin/new-override preview. The preview uses one coherent
   snapshot, preferably a read-only `REPEATABLE READ` transaction (no exclusive project lock
   needed), with a concurrency integration test proving it is entirely before or after a
   migration, never mixed.
4. **#42 could show a preview for the wrong target.** The selector stayed enabled while the
   preview loaded: request v2, select v3, receive and confirm the v2 preview while v3 is shown.
   Disable the selector while either mutation is pending (or discard obsolete responses), with a
   delayed-response component test for targets [2, 3]. The existing project-list invalidation is
   acceptable: reading 10 says "invalidate and refetch when active or next used" instead of an
   immediate request for an inactive query.

## Readings of "Built in PR 2e-2"

- 1–3: confirmed.
- 4: confirmed; every moved pin is a 409 (spec 2).
- 5: confirmed.
- 6: confirmed with a coherent preview transaction (spec 3).
- 7: amended to the order of spec 2.
- 8: confirmed.
- 9: the shared loader confirmed; the preview's snapshot must be coherent.
- 10: confirmed after fixing the target-selection race; cache invalidation is sufficient.
- 11: confirmed; 2e-2 raises no documentation question.

## Applied

- #39: round 30 rewritten as a status record of a proposed package awaiting confirmation; Q102
  and Q103 open with a pointer to it, gates retained, the plan's readings and the domain docs
  unchanged, `personnel_file` provisional under Q105, the DSV-amendment question inside Q102, no
  Q110.
- 2e-2a (#40): `AgenturKey` in the preview; `planTemplateMigration` takes the declared
  `fromVersion` and returns `stale` only after the target checks; `append_template_pin` checks the
  target against `p_from_version` before `pin_version_stale` (migration 0023, not merged before);
  database tests for a concurrent migration that reached the target and one beyond it (both
  `pin_version_stale`, nothing written; both failed against the previous order); the canonical
  form moved to `packages/config/src/canonical.ts` (no imports), used by `hash.ts` and
  `migration.ts` (non-blocking item 1); this record, the plan's readings, ADR-0002.
- 2e-2b (#41) and 2e-2c (#42): see their commits.
