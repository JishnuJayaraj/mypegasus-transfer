# Decisions — 2026-10-17, round 26 (Slice 2, PR 2c-2 review)

The product owner's review of PR 2c-2 (domain, database, API and web, about 840 production lines)
and the readings taken in it. Where it differs from earlier rounds, round 26 wins.

## Split

- **2c-2a** — domain, database, API, seed and docs, with the corrections below. The exception of
  about 630 lines is accepted: it is one domain → database → API invariant and includes SQL
  redeclarations.
- **2c-2b** — the web commit, on its own branch, rebased onto 2c-2a.

No third split.

## Standards

Required:
1. **One step vocabulary.** `packages/domain/src/projects/pins.ts` redeclared step names in an
   own enum. ADR-0004 makes the domain's `Step` enum the single shared vocabulary: the subset of
   submission steps is derived from `Step`.

Non-blocking:
2. The Agentur-key pattern is declared in both `@transfer/config` and the domain; consider one
   definition later.
3. The template catalog and wave queries in the web app repeat the loop that reads every page; a
   shared helper may be worthwhile when another consumer appears.

## Spec

4. **D2: the `jsonb` function parameters.** D2 said an override's content is the only `jsonb`
   parameter, but `pin_agentur_template` necessarily takes the template content as `jsonb`. D2
   now permits exactly these versioned configuration payloads: the **validated template content**
   for `pin_agentur_template` and the **validated override content** for the override function.
   The SQL structural checks and the service validation stay.
5. **The pin form follows the current project's capability, not catalog access.** Reading the
   catalog doesn't mean pinning in this project: the global org roles read the catalog and every
   project but can't pin, and a user may be PL in one project and only consultant in another.
   - The API returns a server-derived capability for the current project, and the web shows the
     form only when it is true.
   - On an active project the PL may still pin a further Agentur, but "Als Projekt-Agentur
     festlegen" isn't offered.
   - Component and API tests cover the global roles, a PL of another project and an active
     project. The API's 403 stays the authoritative enforcement.

## Readings

- Items 1–13 of "Built in PR 2c-2" are **confirmed**.
- Item 14 is confirmed **in part**: not showing "pinned by" before the staff directory exists is
  confirmed; showing the form because the catalog loaded is **not** (use the current project's
  capability, correction 5); the Project-Agentur action is absent once the project is active.
- Item 15 and the split are **confirmed**.

## Applied

- 2c-2a: the submission steps are `Step.extract([...])`; `ProjectConfig.capabilities`
  (`pinTemplate` from the `pinTemplate` operation for this project, `setProjectAgentur` only
  while draft) with API tests for the global org roles, a PL of another project and an active
  project; D2 and the readings in the plan.
- 2c-2b: the form appears only with `capabilities.pinTemplate`; "Als Projekt-Agentur festlegen"
  only with `capabilities.setProjectAgentur`; component tests for the same cases.
