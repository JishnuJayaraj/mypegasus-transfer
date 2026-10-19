# Decisions — 2026-10-17, round 30 (Q102 and Q103: proposed answer package, awaiting confirmation)

**Status record, not a confirmation.** Proposed answers to Q102 and Q103 of the
[Slice 2 plan](../plans/slice-2.md) were prepared on 2026-10-17. They are **not confirmed**:

| Question | Must be confirmed by | Status | Gate |
|---|---|---|---|
| Q102 — individual TG dates | the PL, legal and the BA process owner | proposed, awaiting confirmation | PR 2h stays gated |
| Q103 — the import contract | the PL (retention classes: the DPO, Q105 🔒) | proposed, awaiting confirmation | PRs 2f/2g stay gated |

Until a later round records the owners' confirmation, Q102 and Q103 stay **open**, Q105 stays
fully open, the plan's fail-safe readings (R5, R6, R23, R24, R25) stay in force and nothing below
is applied. The [round 31 review](2026-10-19-answers-round-31.md) corrected an earlier version of
this record, which had claimed the confirmation.

## Proposed answer to Q102 — Individual TG dates (to be confirmed by the PL, legal and the BA process owner)

1. **Meaning of the fields**
   - `tgStart` and `tgEnd` are the inclusive contractual start and end dates of the participant's
     employment in the Transfergesellschaft under the DSV.
   - They are not a definitive representation of the BA-funded Transfer-KuG period.
   - Slice 2 does not calculate or promise Transfer-KuG entitlement.
2. **Twelve-month rule**
   - Transfer-KuG remains limited to twelve months.
   - For staged entry into an existing beE, the individual funding period is limited by the
     remaining term of that beE. A separate later beE may provide its own full period.
   - Therefore the system must not claim that every participant receives twelve months from their
     individual `tgStart`.
   - Until `bee_unit` and the Transfer-KuG case are modelled, keep the current maximum
     twelve-month check as a conservative MVP scope restriction on supported DSV periods, not as
     an exact benefit calculation.
   - Contracts extending beyond that supported period require manual handling outside the MVP.
3. **Who may change dates**
   - Only a project PL may set or change them in Slice 2.
   - Every change is audited.
   - Back office receives no date-edit permission in Slice 2.
4. **`tgStart`**
   - Requires a wave with `latestEntryDate`.
   - May be today or in the future, never in the past.
   - Must not exceed `latestEntryDate`.
   - Must not precede an open `offerDeadline`.
   - Cannot change after the participant has entered the TG.
   - A missed start gets a genuinely new start date; it is never backdated.
   - If today's entry run already completed, a new start of today does not trigger automatic
     entry; that requires the later reconciliation process.
5. **`tgEnd`**
   - May change after TG entry only while the participation is nonterminal and the change
     reflects a documented DSV amendment.
   - The new end must be on or after the effective start and must not be in the past.
   - Past-date corrections belong to the audited correction/reconciliation process, not ordinary
     editing.
   - Clearing an individual date returns to the wave default and must pass all the same
     validation.

## Proposed answer to Q103 — Import contract (to be confirmed by the PL)

1. **Address**
   - Add `addressCountry` as an ISO 3166-1 alpha-2 field, data class confidential, retention
     class `personnel_file` (a provisional fail-safe classification under Q105 🔒: the PL can't
     confirm a retention classification; its period and final class stay subject to the DPO).
   - Import country comes from either a mapped country column, or a country constant explicitly
     selected by the PL.
   - Normalize case, but accept only `DE` in the MVP.
   - Never infer country from postcode.
   - A non-DE row is `foreign_address_unsupported`.
   - If an address is imported, a country source is mandatory (`country_required`).
   - Street, postcode, city, and country form one structured address; partial addresses are
     refused.
   - German postcode must be exactly five digits.
2. **Phone fields**
   - `phone` and `mobile` remain separate targets.
   - Never infer one from the other or copy between them.
3. **Dates**
   - Text dates: strictly `TT.MM.JJJJ`.
   - Genuine XLSX date cells are accepted.
   - Impossible dates and date cells containing a time are errors.
   - Age plausibility is calculated at `oldEmploymentEndDate`.
   - If that date is legitimately absent because its rule was relaxed, no age warning is
     invented.
4. **Re-import**
   - Empty cells never clear stored values.
   - Existing values are retained with `kept_existing`.
   - Clearing data requires a later explicit editing operation.
   - Terminal participations are not updated; return `terminal_not_updated` and skip.
   - Participants missing from the file are only counted, never changed.
5. **Invalid optional values**
   - Invalid optional email or phone values are dropped with `value_invalid_dropped`.
   - The rest of an otherwise valid row may proceed.
   - Invalid required values remain errors.
6. **Personalnummer**
   - Required for every row and used as the exact project-local match key.
   - Trim leading and trailing whitespace only.
   - Matching is case-sensitive; do not remove punctuation or leading zeros.
   - A numeric XLSX cell is `identifier_cell_numeric` and blocks the row.
   - Numeric-looking text cells and CSV text are accepted because their representation is
     preserved.
7. **Other numeric identifiers**
   - Numeric XLSX postcode: `identifier_cell_numeric`, error.
   - Numeric XLSX phone/mobile: drop the value with that warning because formatting or leading
     zeros may already be lost.

## Where the proposed answers would differ from the plan's fail-safe readings

**Not applied.** These are proposed amendments to the [Slice 2 plan](../plans/slice-2.md) for the
owners' review. The plan, `open-questions.md` and the domain docs keep the current fail-safe
readings until a later round records the confirmation and applies them.

| # | Plan now (fail safe, in force) | Proposed | Where |
|---|---|---|---|
| A1 | R5/R25: periods over twelve months blocked "because §111 SGB III limits Transfer-KuG to twelve months"; what `tgEnd` means is open | `tgStart`/`tgEnd` are the inclusive **contractual employment dates** under the DSV, not the funded period; the check stays (same code and arithmetic, wave defaults included) as a **conservative MVP scope restriction** on supported DSV periods, not a benefit calculation; no entitlement is calculated or promised; a longer contract is handled manually outside the MVP | 5.6, 5.7 |
| A2 | R5: `tgEnd` may change while the participation isn't terminal | after TG entry only for a **documented DSV amendment** (still nonterminal); how Slice 2 would show the documentation is an open sub-question of Q102 (below) | 5.7 |
| A3 | R5: a new `tgEnd` never precedes the effective start | it also **must not be in the past** (code would be proposed with PR 2h) | 5.7 |
| A4 | 5.7: `tgStart` never backdated | **past-date corrections** of either date go to the audited correction/reconciliation process (Slice 7, D10), never to ordinary editing | 5.7 |
| A5 | 5.7: a new start of today after today's run can only be entered by reconciliation | the same: it **doesn't trigger automatic entry** | 5.7 |
| A6 | 5.7: clearing returns to the wave default under the same rules | the same, with A2 and A3 for the resulting default | 5.7 |
| A7 | R5: PL only | the same; **back office gets no date permission** in Slice 2 | 5.4 |
| A8 | R23: DE established through a country column or a constant; other countries refused; **every** import without a country source can't be confirmed | a stored field **`addressCountry`** (ISO 3166-1 alpha-2, confidential; `personnel_file` provisionally, under Q105) as an import target; case normalised, only `DE`, any other value (one that isn't a code included) `foreign_address_unsupported`; `country_required` **when an address is imported** | 5.1, 5.2, 5.10, 5.11 |
| A9 | each address part validated on its own | street, postal code, city and country are **one structured address**; a partial address is refused | 5.1, 5.11 |
| A10 | section 8: foreign addresses left out (no country target) | the country is stored; **non-DE rows are refused** | 8 |
| A11 | 5.11: age 15–67 against the Austrittsdatum | the same; **no age warning** when `oldEmploymentEndDate` is legitimately absent because its rule is relaxed | 5.11 |
| A12 | R24: numeric XLSX cells refused for Personalnummer and postal code, dropped with that warning for phone and mobile | the same (postal code an error; phone/mobile dropped with `identifier_cell_numeric` as a warning) | 5.1, 5.11 |
| A13 | R6: Personalnummer matched exactly after trimming | **leading and trailing whitespace only**, case-sensitive, punctuation and leading zeros kept | 5.11 |
| A14 | R6: `phone` and `mobile` both selectable | the same; **never inferred from or copied to** each other | 5.11 |
| A15 | R6: invalid optional values dropped with a warning | the same; the row proceeds; **invalid required values stay errors** | 5.11 |

## Open sub-question kept in Q102

The proposed Q102 answer lets `tgEnd` change after TG entry only when it "reflects a documented
DSV amendment", but Slice 2 stores no documents. How such a change shows the documented amendment
(an attached or referenced signed amendment in a later document slice, a recorded attestation by
the PL, or waiting for the document handling) stays part of **Q102** for its owners; no separate
question is opened until that policy is accepted.

## Gates

- PRs 2f and 2g stay gated on Q103; PR 2h stays gated on Q102.
- Q101 (PL) and Q105 🔒 (DPO) stay open. `personnel_file` for the import's person data, including
  the proposed `addressCountry`, is a provisional fail-safe classification under Q105; its period
  and final class are the DPO's.

## Applied

This docs-only PR: this status record; in `open-questions.md` a pointer from Q102 and Q103 (both
still open) to it, and the missing round links 26–30; in the plan, a note in the status line and
in section 0 "Open" that the package awaits confirmation. No plan reading, gate, domain doc or
schema changes.
