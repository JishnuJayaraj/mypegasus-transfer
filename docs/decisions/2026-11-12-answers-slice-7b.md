# Answers: Q254–Q258, the Slice 7b plan (2026-11-12)

The product owner's decisions on [the Slice 7b plan](../plans/archive/slice-7b.md) (PR #127), for
implementation on synthetic data.

- **"Agentur" is preserved.** The proposed project routes omitted the existing section with the
  Kug 200b batches. It gets its route, its authorised navigation entry and its legacy redirect;
  its layout can stay unchanged.
- **Q254 accepted:** Carbon, white cards, restrained rounding and shadow, central theme overrides.
- **Q255 accepted:** visual regression for the kit and the reference pages, on stable synthetic
  fixtures in the CI environment, with human-reviewed baseline changes. Behaviour, accessibility
  and zoom checks stay too.
- **Q256 accepted with the upgrade safeguards.** Inventories are generated; the explicit
  retention, dependency and hold rules are preserved.
- **Q257 amended:** separate history from unresolved decisions by their status and substance, not
  by their title.
- **Q258 accepted with "Agentur" restored.** Role visibility is preserved; badges use authorised
  counts; an unsupported badge is omitted rather than inventing access or an endpoint.

The owner's message referred to "the upgrade safeguards above" without listing them. The plan
records them as its D1 states (an upgrade test from the last migration before 7b-1 with existing
rows, an atomic apply, the same path for reset, e2e and the image); if the owner meant further
safeguards, they are added to D1 before 7b-1 starts.
