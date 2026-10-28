# Building with agents

Use this routine for an implementation PR, a bounded fix or its review. Project rules and
approval boundaries remain in [CLAUDE.md](../../CLAUDE.md); domain rules remain in the domain
docs and ADRs. Use the existing plan, issue and PR as the handoff, rather than creating a new
tracking document for each step.

## 1. Establish the task

Read the approved PR unit, its dependencies and the relevant domain/ADR sections. Inspect the
current code and git state, including existing user changes. For an expressly authorized
maintenance fix, the task itself can be the brief; a new slice plan is unnecessary.

Write a short working brief before editing:

- The user-visible result and the approved scope.
- The relevant source links and three to five observable conditions that must remain true.
- The first small implementation step and the check that will prove it works.
- Any unresolved decision and which part of the work depends on it.

**Checkpoint:** the intended behavior, its evidence and the next step are clear. This brief is
a progress update or part of the existing plan/issue, not another approval request.

## 2. Resolve uncertainty at the right level

Choose implementation details within the approved architecture autonomously: names, helper
boundaries, equivalent query shapes and test organization. Complete routine fixes and CI
corrections within the authorized scope without asking the owner to reapprove the same work.

Raise a new product decision early when it changes user behavior, permissions, evidence,
retention, a lifecycle rule, regional policy or the agreed scope. Link the conflicting rule,
give a concrete scenario, propose an answer and identify the affected work. Continue independent
work while the decision is pending; keep dependent behavior gated until it is authorized.

Use existing provisional answers only within their documented approval/use boundaries. Keep
`assumed`, `verify` and `accepted` distinct, and cite the owner's answer when recording acceptance.
If implementation exposes a contradiction, propose the documentation change explicitly rather
than rewriting the requirement to fit the code.

**Checkpoint:** every decision needed for the next step is authorized or covered by an existing
approved provisional rule. Remaining questions have a clear owner and impact.

## 3. Complete one observable step

Build one coherent behavior through the necessary layers, then verify it before expanding the
rest of the PR. For a domain-rule change or bug, first demonstrate the failing behavior at the
boundary where the rule is enforced. A step can cross DB, domain, API and UI; it is not necessarily
a separate PR or commit.

Choose the failure scenarios that apply to the change:

| Change | Scenario to settle before calling the step complete |
|---|---|
| Read, edit or confirm | Values change after display but before save/commit; values and their revision still match. |
| Evidence or status | The exact supporting record backs both the effective date and the recorded-at instant. Try a second record, quarantine or replacement. |
| Permissions | The allowed role succeeds; a nearby forbidden role and loss of assignment remain forbidden at the enforcing boundary. |
| Form or export | Inspect representative rendered output, including overflow and an explicitly absent/unknown value. Assert required content survives. |
| External operation | A relevant failure leaves a recoverable, accurately reported state. |
| Migration or performance | Use representative existing data, or comparable before/after measurements, as appropriate to the claim. |

Select relevant rows, rather than running this whole table for every change. Use controlled
interleavings for races; two calls in `Promise.all` alone do not prove the intended ordering.
Expected results come from the approved behavior, not from what the implementation returns.
Coverage thresholds remain required; a passing coverage number does not establish those results.

**Checkpoint:** the behavior and its material failure case work, with matching contracts across
the touched layers. Run the focused checks, then take the next step within the same approved PR.

## 4. Verify the final change

Run the required repository checks for the change after the small steps pass. Reuse successful
results when the files/behavior they cover have not changed; rerun affected checks after a fix,
and broaden when there is a concrete remaining concern. Preserve every required CI gate.

Record skipped checks as skipped, with the reason and where they will run. A mock or a lower-level
test supports the behavior it exercises; name the missing boundary if the intended integration
cannot yet be tested. Keep synthetic seed accommodations within the existing architecture and
separate from production permissions and invariants.

For UI or generated documents, inspect the actual result as well as test assertions. For a
performance claim, record the same workload, environment, before/after values and aggregation;
check the arithmetic and distinguish observed results from an unproven improvement.
At an integrated slice milestone, walk a complete staff/participant journey with synthetic data,
including recovery from a mistake, and record any dead end or missing next action.

**Checkpoint:** the final diff has evidence appropriate to its claims, required checks are
accounted for, and any limitation is explicit.

## 5. Review the implementation and close the loop

Review the actual diff against both the approved behavior and repository standards. When using
an independent reviewer, provide the base/head commits and the original requirements, not only
the implementer's summary. Delegate bounded independent work; keep ownership of the final result.

Classify feedback as a merge blocker, a nonblocking correction or a future improvement. Include
the concrete failing scenario, the applicable rule and the smallest sufficient fix. A review
can approve the current architecture even when another design is possible.

For a re-review, start with the previous findings and the changes that address them. Expand to
other areas when the changes create a new dependency or risk; give each blocker a closure
criterion. Keep nonblocking improvements from repeatedly reopening an accepted plan.

**Checkpoint:** every blocker is resolved or explicitly remains open, required CI is green, and
the final approval applies to the reviewed revision. Merge/publish only under the session's
existing authorization; a green build is not that authorization by itself.

## 6. Leave a resumable handoff

Use the PR and a compact session summary to record:

- Branch, head commit and PR; the behavior delivered and what remains.
- Checks run, their results, skips and unresolved limitations.
- Accepted decisions with their sources, open questions, and the next concrete action.

At the next session, verify this state against the actual branch, diff and CI before proceeding.
After a recurring failure, prefer a focused regression or an appropriate automated guard; add a
short instruction/pointer only when judgment is still needed. Keep the rule in one authoritative
place instead of appending the full review history to the agent instructions.

**Checkpoint:** another agent can resume from the repository state and this summary without
guessing what was approved, tested or left unfinished.
