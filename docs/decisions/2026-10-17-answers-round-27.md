# Decisions — 2026-10-17, round 27 (Slice 2, PR 2d-1 review)

The product owner's review of PR 2d-1a (JishnuJayaraj/mypegasus-transfer#32) and 2d-1b
(JishnuJayaraj/mypegasus-transfer#33) and the readings taken in them. Where it differs from
earlier rounds, round 27 wins.

## Corrections (blocking)

1. **Exact change parity in SQL.** `write_project_override` checked the named Agentur's setting
   but not the rest of the content: a caller with `transfer_app` could change fields, rules,
   relaxations or another Agentur's setting while the audit event claimed one Agentur setting.
   Required:
   - compare the current and the proposed content without the named Agentur's setting, an empty
     `agenturSettings` object counting as none, and refuse any other difference with
     `invalid_argument`;
   - for a set, require `confirmedBy` to be the acting staff user (`(p_context).staff_user_id`);
   - database tests for a changed field or rule, another Agentur's setting and a spoofed
     `confirmedBy`, for set and removal alike;
   - the AC-16 fixture (an override that a pin would make invalid) becomes an owner-only direct
     insert: the narrowly scoped production function must not be able to create that state.
2. **Authorise before domain validation.** The `PUT` route ran `checkAgenturSetting` before the
   project's visibility and the `changeOverride` check, so an unauthorised caller could get a 422
   instead of 404/403. Visibility and capability come first; tests show that invalid setting data
   still gives 403 for a visible project the caller can't change and 404 for an invisible or
   unknown one. Framework-level structural validation may stay before the handler.

## Q109 (confirmed)

Staff ids only in the API until Slice 3. In the web: the viewer's own display name; **"Andere
berechtigte Person"** for another confirmer; no id prefix (not actionable, and it surfaces a
pseudonymous staff identifier needlessly); `pinnedBy` stays hidden.

## Readings of "Built in PR 2d-1"

- 1–6: confirmed.
- 7: confirmed with correction 1 (exact SQL delta, actor-bound `confirmedBy`).
- 8–10: confirmed; item 9's test fixture as in correction 1.
- 11: confirmed with correction 2.
- 12: confirmed.
- 13: confirmed with the Q109 wording above.

## Applied

- 2d-1a: `override_without_agentur` (an internal helper, no grant) and the parity and confirmer
  checks in `write_project_override` (migration 0018, not merged before); database tests; the
  route checks access first; the AC-16 fixture inserts as the owner; ADR-0002, the plan, Q109.
- 2d-1b: "Andere berechtigte Person" without an id prefix, with its component test.
