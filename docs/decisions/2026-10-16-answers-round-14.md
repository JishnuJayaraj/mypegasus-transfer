# Decisions — 2026-10-16, round 14 (Slice 1, PR 1f-1 review)

The product owner's answers to the nine readings taken in PR 1f-1 (#17) and to Q89. Where they
differ from earlier rounds, round 14 wins.

## The nine readings of PR 1f-1

1. **No regional value in the base defaults — confirmed**, the ASU `defaultChannel` included.
   An unset default channel is not a blocker, since any valid ASU channel with proof counts.
   Q76 is unchanged: a missing KuG-Agentur template still blocks project activation for its
   own reason.
2. **Nationwide settings — confirmed.** The base values equal the domain constants. The Kug 200b
   follow-up and the TL 407 escalation stay configuration-only until Slice 5 implements them.
3. **Base rules — partially confirmed.**
   - Confirmed: "Austrittsdatum" is `oldEmploymentEndDate`. An accepted ASU proof represents
     proof from **any valid channel**, including a **structured PL attestation of the BA
     customer number**; it must never require a fabricated uploaded file. `accepted: true` is
     correct for the current evidentiary document rules. The DSV evidence rule stays locked.
   - An accepted Kug 200b scan may prove fields 16 and 17 **only when acceptance includes the
     check that both declarations and the required handwritten signature are present**.
   - **Corrected:** an accepted Kug 200b scan can't also stand for merely *offering* the form.
     - When ASU uses `kug_200b`, the RV-Nummer and the accepted signed scan are required.
     - When ASU happened through `online_self` or `in_person`, the ASU proof is sufficient for
       entry.
     - Kug 200b must still be offered for the profile-access consent, but the participant may
       decline it. The **offer and its outcome are recorded separately**; a declined offer must
       not remain an impossible "missing signed scan".
     - The RV-Nummer and signed-scan rules therefore need **Kug 200b-route applicability**
       instead of applying to every TG participation: a narrow applicability condition, or
       deferring the two rules until the ASU channel and offer outcome can be evaluated. No
       generic workflow language.
4. **Q89 — answered:** TG-specific rules don't apply to `ta_only` projects (below).
5. **Custom-field profile — confirmed:** only participant retention classes; every
   unconstrained free-text string needs `maxLength`; special-category and highly confidential
   custom fields stay out of generic JSON storage; the keyword/type and pattern checks are
   approved.
6. **Template identity — confirmed:** one template per Agentur and version, `id === agenturKey`.
7. **Source and reason codes — confirmed provisionally.** The four temporary-setting sources
   (`phone_call_agentur`, `email_agentur`, `letter_agentur`, `meeting_agentur`) are enough for
   Slice 1. An open snake_case relaxation `reasonCode` is acceptable **only until Slice 2**:
   before overrides can be activated, Slice 2 validates it against a controlled list. No
   free-text reason is ever stored in `reasonCode`.
8. **Help texts — confirmed:** the key format, `de`/`en` and the 2000-character maximum.
9. **JSON Schema vs. `parseLayer` — confirmed:** the committed JSON Schema describes the
   structure; `parseLayer` does the cross-field, catalog and template-identity checks. Both
   stay covered by drift and validation tests.

## Q89 — Base rules in `ta_only` projects (confirmed)

TG-specific rules must not apply to `ta_only` projects. The shared `CompletenessRule` gets an
explicit **`projectTypes?: ProjectType[]`**; absence means every project type. Evaluation
receives the project type and skips rules that don't apply; a skipped rule produces neither a
missing item nor a reminder. Configuration, completeness displays and reminders must all know a
rule is inapplicable; relying on the inactive DSV track is not enough.

| Rule | Project types |
|---|---|
| Import / data-collection defaults | `ta_only`, `ta_tg` |
| ASU proof | `ta_tg` |
| Kug 200b RV-Nummer and declarations | `ta_tg`, and only on the Kug 200b route |
| DSV signed scan | `ta_tg` |
| TL 407 rules (Slice 6) | both, subject to the configured or assigned profiling activity; the form's checkbox stays §110 vs. §111 |

## Merge conditions for PR 1f-1

1. Project-type applicability is implemented and the TG-only base rules no longer appear as
   missing in `ta_only`.
2. Kug 200b completeness no longer treats an optional, declined offer as a permanently missing
   accepted scan.

## Applied (PR 1f-1)

- `CompletenessRule.projectTypes` (non-empty, no duplicates), `ruleAppliesTo`, and
  `evaluateCompleteness` takes `projectType` in its facts (required, so no caller can forget
  it).
- The ASU proof and DSV scan rules are `ta_tg` only; the import rules apply to both.
- The two Kug 200b rules are **deferred to Slice 6**, which brings the ASU record (channel) and
  the Kug 200b offer with its outcome: the rules then apply only to `ta_tg` participations on
  the `kug_200b` route, and a declined offer is an outcome, not a missing scan. Until then no
  base rule asks for a Kug 200b scan or the RV-Nummer.
