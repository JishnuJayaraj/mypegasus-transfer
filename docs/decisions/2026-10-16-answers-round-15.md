# Decisions — 2026-10-16, round 15 (Slice 1, PR 1f-2 review)

The product owner's answers to Q90–Q93 and to the thirteen readings taken in PR 1f-2 (#18).
Where they differ from earlier rounds, round 15 wins.

## Q90 — Project Agentur (confirmed; terminology and model correction)

A `ta_only` project still has a project-level Agentur, responsible for the §110 measure, even
though it has no Transfer-KuG. The canonical product term is **Project Agentur**
(`projectAgentur`):
- `ta_tg`: the Project Agentur acts as the **KuG-Agentur**;
- `ta_only`: it is the Agentur responsible for the §110 measure and its funding administration;
- participant-level ASU, profiling and placement keep resolving against the participant's
  **Placement Agentur**.

Therefore a missing Project-Agentur template blocks activation for **both** project types,
project-level steps resolve against the Project Agentur, `kugAgenturKey` becomes
`projectAgenturKey` in the resolver API and the docs, and the label "KuG-Agentur" is used only
for `ta_tg`. This corrects terminology and the model; the fail-closed behaviour is unchanged.

## Q91 — Missing Kug 200b batch channel (confirmed)

- Applies only to `ta_tg`, never to `ta_only`.
- Blocks only the Kug 200b batch-submission operation; never project activation, contact, data
  collection, profiling, another valid ASU route, TG entry or TL 407 submission.
- Until Slice 6 provides that operation, it is only a configuration warning.
- The blocker stays explicitly **step-scoped**: callers must not read any
  `agentur_submission_blocked` as a general project blocker.

## Q92 — Outdated-form policy (confirmed)

All four Agentur-submission settings are required: `submissionChannel`, `originalRequired`,
`leadTimeDays`, `rejectsOutdatedFormVersions`. The application never guesses whether an Agentur
accepts an older signed form. An unset value keeps Agentur submission blocked but blocks neither
project activation nor unrelated work.

## Q93 — Temporary setting precedence (confirmed)

Per key: base → pinned Agentur template → Agentur-scoped project setting. The Agentur-scoped
setting wins only for the keys it supplies; the other keys still come from the pinned template.
It keeps source, confirmer, confirmation date, audit and provenance. Such a setting is not only a
fallback while no template exists; it may also be a **confirmed project-specific exception to a
pinned template**. When a project migrates to another template version, Slice 2 surfaces the
existing temporary settings for review instead of silently dropping them or changing precedence.

## The thirteen readings of PR 1f-2

1. **Two-level resolution — confirmed**, with `projectAgenturKey`: participant steps use the
   Placement Agentur, `project_checklist` the Project Agentur; participant settings, custom
   fields and help texts come from the participant level.
2. **Required `projectType`, rules not filtered — confirmed.** The resolver keeps
   `projectTypes`; evaluation, displays and reminders use `ruleAppliesTo`.
3. **Rule ids unique within a resolved chain — confirmed**, needed for unambiguous relaxation
   and provenance.
4. **Relaxations — confirmed, with a Slice 2 invariant.** They affect only lower layers, never
   the same override's own rules; duplicate entries are invalid; a template-specific rule absent
   from one Agentur chain may be a no-op there. **Slice 2 validates an override against all
   pinned Agentur chains and rejects a relaxation that matches none of them**: a typo must
   never become a silent global no-op. The relaxed-rule record and its provenance are approved.
5. **Override fields — confirmed.** An override applies project-wide, so a rule depending on a
   custom field from only one Agentur's template is invalid for the project. **Slice 2
   validates the override against every pinned template.** Agentur-specific fields and rules
   belong in that Agentur's template.
6. **Invalid configuration throws — confirmed.** It is a configuration error, not an operational
   blocker; `ConfigError` keeps excluding configuration values.
7. **Per-key settings merge — confirmed** by Q93.
8. **Project-Agentur activation blocker — confirmed** after the terminology correction. Only a
   pinned template lifts it; temporary settings can unblock individual submission settings but
   can't stand in for the complete template activation needs.
9. **Submission blockers — confirmed** by Q91 and Q92. Without a Placement-Agentur key no
   Agentur-scoped temporary setting can apply.
10. **Warnings — confirmed**, one per blocker. The later PL task keeps the blocker's Agentur and
    step scope.
11. **`projectActivationBlockers` — confirmed.** A `ta_tg` project needs at least one usable wave
    with a `latestEntryDate`; other incomplete waves may stay drafts; an incomplete wave must not
    permit a DSV offer; Agentur-submission blockers don't block activation.
12. **Provenance paths — confirmed.** Temporary settings keep source, confirmer and date in their
    provenance.
13. **Pinned loading and the validator cache — confirmed.** The reference is validated before a
    path is built; file identity and version match the path; (template id, version) is a cache
    key only because published versions are immutable. **Slice 2 prevents modifying or
    replacing an existing version and stores the project snapshot.** Override fields stay
    uncached until versioned snapshots exist.

## Merge conditions for PR 1f-2

1. Rename the project-level concept from `kugAgenturKey` to `projectAgenturKey`.
2. Update the glossary and the affected docs.
3. Record the two Slice 2 cross-chain invariants: every relaxation matches at least one pinned
   chain; the override validates against every pinned template.

Then, with green checks, PR #18 is approved to merge.

## Applied (PR 1f-2)

All three conditions: the resolver API, tests and docs use `projectAgenturKey`; the glossary has
**Project Agentur**; the Slice 2 invariants are in the Slice 1 plan (section 8) and the roadmap.
"An incomplete wave must not permit a DSV offer" already holds: the `offer_deadline_valid` guard
(PR 1b-1) fails closed without an offer deadline, the wave's `latestEntryDate` or a TG start.
