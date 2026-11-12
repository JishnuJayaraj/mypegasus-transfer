# PR #104 — Slice 7 plan review and the Q210–Q219 decisions

Reviewed 2026-11-06. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/104>.
Head: `48ebac6`. This records the product owner's decisions as given; the revised plan
([slice-7.md](../plans/archive/slice-7.md)) follows in the same PR. This does not constitute external DPO,
legal, works-council or Agentur confirmation.

## Standards (corrections before 7-7a–c)

1. **Don't freeze the whole participation after the first class purge.** Deleting health data must
   leave personnel-file data accessible for its remaining retention period. Enter the evidence-only
   phase only when that phase actually applies. Specify which minimal DSV facts survive deletion of
   the contractual scans.
2. **Pseudonymise every subject reference.** Replacing `participation_id` alone misses
   participant-actor fields, assisted-mode references and identifying references in event details.
3. **Specify the dedicated retention role.** ADR-0002 requires a job-only role for
   pseudonymisation. Define its grants and its permitted path through the immutability triggers;
   ordinary runtime access must not gain destructive powers.

## Spec (four bounded gaps)

1. **D8 changed the wrong date after a quarantine.** Keep `validOn` tied to the actual signatures;
   advance only `recordedAt` to the lift. Otherwise a legitimately pre-start contract becomes
   ineligible for reconciliation.
2. **Choose the re-offer deadline before generating its PDF.** The generation must already print
   it. Bind generation and offering to that exact deadline and all printed source values.
3. **Resolve signed-but-never-entered cases.** After the planned start or the cutoff some cases
   qualify for neither reconciliation nor withdrawal, and an `informed` participation can't exit.
   Provide an owned contractual/legal clarification path without fabricating an entry or an exit.
4. **Correct the field-recovery claim.** Slice 6 has no correction route for `profilingDoneOn`.
   Broad field corrections may stay deferred, but the relevant date-error recovery must exist before
   the affected pilot workflow, independently of retention activation.

## Q210–Q219 decisions

| Question | Decision |
|---|---|
| Q210 — Contract text | Accept the stamped development sample. Pin an immutable template version per project; approved wording is required before live offering. |
| Q211 — External paper | Allow it in 7-2. Record external provenance and verify parties, terms and actual dates. Never require a fabricated generation or re-signing. |
| Q212 — Signatures | Accept one reviewed complete packet showing all three signatures, bound to the same contract/offer. Keep the actual signature dates separate from the recording time. |
| Q213 — Cancellation | Accept the proposed development flow provisionally; legal verification remains. Address never-entered cases after the planned date explicitly. |
| Q214 — Cutoff flag | Accept. Informational and actionable; never automatically withdraw a signed DSV. |
| Q215 — Contact statuses | A small independent operational PR, using the existing transitions and audit rules. It need not block the DSV work. |
| Q216 — Reconciliation review | Include a PL reply and a manager resolution/escalation path. A clarification stays actionable until resolved. No automatic reversal, no invented legal deadline. |
| Q217 — Funding | Use known yes / known no / unknown. Unknown blocks dependent deletion; don't assert everyone was funded or require fictitious settlement dates. |
| Q218 — Holds | Provisional: the PL or back office place scoped holds at once; a different regional operations manager releases them against documented legal/DPO instructions. Live deletion requires confirmed, usable hold administration. |
| Q219 — Retention/access | Accept the provisional classes with the retained-fact mapping. Keep activation disabled until evidence-only access and the maintenance rules are complete. |

## Second review

Reviewed 2026-11-06, head `5ff12ed`. The previous retention findings (phase timing, surviving DSV
facts, pseudonymisation, the dedicated job role) are addressed.

**Standards.** Before 7-7b: restrict legal holds to affected records. D23 permitted a
whole-participation hold, conflicting with the existing "never the whole profile" rule. Use selected
records or classes with a documented basis; unrelated due data must still be deleted.

**Spec.**
1. Before 7-2a: remove the external-paper circular dependency (an accepted external scan was
   required to create the offer, while uploading the scan required an open offer). Record the
   external offer's metadata first; require accepted scans for the signature and full-execution
   facts afterwards.
2. Before 7-8: timestamp corrected facts at approval. Update `tl407_facts` explicitly: a corrected
   `profilingDoneOn` has `recordedAt` no earlier than the correction's approval (the reader used the
   original completion event and the scan's availability). Add a regression proving historical
   snapshots remain unchanged.
3. Before 7-3: define the recovery from a wrong signature date. The plan required matching
   replacement dates while claiming a scan correction fixes `dsvSignedOn`. Specify an approved,
   linked replacement that can establish truthful corrected dates, preserving the original history
   and advancing the recording instant. A general field editor is unnecessary.

**Decisions carried forward.**
- Q220 may remain open behind its pilot gate; the owned clarification and escalation flow is
  acceptable for development.
- TG entry may be a conservative retention trigger, but must not be described as proof that
  Transfer-KuG was received. Keep employment entry and actual funding or payment facts distinct.
