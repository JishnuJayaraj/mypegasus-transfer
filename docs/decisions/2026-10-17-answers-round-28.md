# Decisions — 2026-10-17, round 28 (Slice 2, PR 2d-2 review)

The product owner's review of PRs 2d-2a (JishnuJayaraj/mypegasus-transfer#34), 2d-2b
(JishnuJayaraj/mypegasus-transfer#35) and 2d-2c (JishnuJayaraj/mypegasus-transfer#36) and the
readings taken in them. Where it differs from earlier rounds, round 28 wins.

## Standards

No blocking standards violations. The explicit Slice 2 decomposition and the approved size
policy override the general one-slice/one-PR guideline here.

Non-blocking naming observations: `w: Writer` in `apps/api/src/projects/overrides.ts` could be
`writer`; `act` / `run` in `apps/web/src/components/relaxations.tsx` could be more descriptive.

## Spec

1. **Blocker — a timestamp is not proof of the current transaction.** `write_project_override`
   accepted an added relaxation for an approved request with `decided_by` = the actor and
   `decided_at = now()`. `now()` is the transaction's start time, not its identity: a committed
   row with the same timestamp satisfies it. Four eyes must be deterministic. Required:
   - bind the addition to the exact request;
   - prove that the approval happened through `decide_rule_relaxation` in the current
     transaction without relying on timestamps;
   - prefer an internal helper for `relaxation_added` with `EXECUTE` revoked from
     `transfer_app`; the app-granted `write_project_override` must not add a relaxation;
   - an adversarial database test: a pre-existing approved row with the current transaction's
     timestamp, and a direct `write_project_override(… relaxation_added …)` still fails.
2. **Blocker — a direct POST can request a rule for another project type.** `relaxableRules`
   filters with `ruleAppliesTo`, but the request relies on `validateProjectOverride`, and the
   resolver recorded an inapplicable rule as relaxed. Required: a rule that applies in no chain
   for the project's type fails with `override_invalid` and `relaxation_unmatched`, enforced in
   the authoritative validation path; config unit tests and direct API tests for a
   `ta_only`-only operational rule in a `ta_tg` project and vice versa.
3. **The refusal order (item 9).** The version-first behaviour after authorization is preferred
   and consistent with 2d-1:
   1. visibility: 404;
   2. operation / four-eyes authorization: 403;
   3. the request's lifecycle state where applicable: 422;
   4. the expected override version: 409;
   5. validation against the current snapshot: 422;
   6. the write.

   A stale approval of an invalid relaxation is a 409; a stale removal is a 409 before checking
   whether the current version still contains the relaxation.

## Readings of "Built in PR 2d-2"

- 1: confirmed — `RelaxationReasonCode` moves to the domain.
- 2: confirmed with the project-type correction: unknown or inapplicable rules are
  `relaxation_unmatched`; existing locked rules are `relaxation_locked`.
- 3: confirmed.
- 4: design confirmed; the implementation must enforce the same transaction deterministically.
- 5: confirmed.
- 6: confirmed — a rejection has no reason code or free text.
- 7: confirmed — any current PL of the project may withdraw; the audit identifies the actor.
- 8: confirmed.
- 9: replaced by the order above.
- 10: confirmed, but the POST must enforce the same eligibility as the server-provided list.
- 11–13: confirmed. Q110 stays unused.

## Applied

- 2d-2a: the internal `append_project_override` (no grant) takes the exact entry
  `decide_rule_relaxation` builds from the locked request; the granted `write_project_override`
  refuses `relaxation_added`; the adversarial database test (it accepts the direct write against
  the previous migration and is refused now); the resolver never relaxes a rule for another
  project type, with config tests both ways; the plan's readings, ADR-0002, ADR-0004.
- 2d-2b: direct API tests for a request of a rule of the other project type, both ways; the 409
  ordering tests; `regional-variation.md`; `w` renamed `writer`.
- 2d-2c: clearer names for the mutation and its helper.
