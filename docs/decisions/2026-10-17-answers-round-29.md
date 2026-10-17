# Decisions — 2026-10-17, round 29 (Slice 2, PR 2e-1 review)

The product owner's review of PRs 2e-1 (JishnuJayaraj/mypegasus-transfer#37) and 2e-1-web
(JishnuJayaraj/mypegasus-transfer#38) and the readings taken in them. Where it differs from
earlier rounds, round 29 wins.

## Correction (blocking, 2e-1-web)

1. **A refusal must outlive the activation component.** On a refusal the web reread only the
   configuration. After a concurrent activation by another request:
   1. the POST returns `project_not_draft`;
   2. the reread configuration sets `capabilities.activateProject` to false;
   3. the activation component unmounts and loses its local error;
   4. the cached project may still show "Status: Entwurf".

   Required:
   - keep the refusal message outside the conditionally rendered activation component (or show
     it as a persistent toast);
   - after `project_not_draft`, reread the project, the project list and the configuration;
   - a component test for the concurrent activation asserting that "already active" stays
     visible, the status becomes active and the activation action disappears.

## Readings of "Built in PR 2e-1"

- 1–9: confirmed.
- 10: confirmed with the correction above.
- 11–12: confirmed.
- Q110 stays unused.

## Non-blocking observations

- Activation and the configuration duplicate some snapshot-loading code.
- The activation refusal codes could later be a domain-owned union instead of plain strings.
- Two activation messages duplicated the blocker messages in the translations.

## Round numbering, Q102 and Q103

- Round 29 is this review.
- Q102 and Q103 are handled in a **separate docs-only PR**, and only after the required people
  explicitly confirm the proposed answers:
  - **Q103:** the PL; it may then close before PRs 2f/2g.
  - **Q102:** the PL, legal and the BA process owner, all three, before it closes and before PR
    2h.
- If both are approved together, that confirmation is **round 30**. If Q103 is confirmed first,
  round 30 is Q103 and a later round is Q102.
- That PR updates `docs/open-questions.md`, the decision record, `docs/plans/slice-2.md` and the
  relevant data-catalog and address requirements.

## Applied

- 2e-1-web: the refusal is kept in the setup section, which outlives the activation component
  (a closable error notice); every refusal rereads the project, the project list and the
  configuration; a component test for the concurrent activation; the blocker refusals reuse the
  blocker list's messages, so the duplicated translations are gone.
- 2e-1: this record and the plan's readings marked confirmed.
- Not applied (non-blocking): the shared snapshot loading and a domain union of refusal codes.
