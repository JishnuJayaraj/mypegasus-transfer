# Decisions — 2026-10-17, round 30 (Q102 and Q103 confirmed)

The answers to Q102 and Q103 of the [Slice 2 plan](../plans/slice-2.md), confirmed together on
2026-10-17, so this is round 30 ([round 29](2026-10-17-answers-round-29.md): "if both are approved
together"). Where they differ from earlier rounds, round 30 wins.

| Question | Confirmed by | Lifts |
|---|---|---|
| Q102 — individual TG dates | the PL, legal and the BA process owner (reported by the product owner) | the gate of PR 2h |
| Q103 — the import contract | the PL | the gate of PRs 2f/2g |

## Q102 — Individual TG dates (confirmed by the PL, legal and the BA process owner)

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

## Q103 — Import contract (confirmed by the PL)

1. **Address**
   - Add `addressCountry` as an ISO 3166-1 alpha-2 field, data class confidential, retention
     class `personnel_file`.
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

## Where the answers differ from the plan's fail-safe readings

Recorded as amendments in the [Slice 2 plan](../plans/slice-2.md) (section 0, "Amended by round
30"), sections 5.1, 5.2, 5.7, 5.10, 5.11 and 8.

| # | Plan before (fail safe) | Round 30 | Where |
|---|---|---|---|
| A1 | R5/R25: periods over twelve months blocked "because §111 SGB III limits Transfer-KuG to twelve months"; whether `tgEnd` ends the employment or the funded period was open | `tgStart`/`tgEnd` are the inclusive **contractual employment dates** under the DSV, not the funded period. The check stays (same code, same arithmetic, wave defaults included) as a **conservative MVP scope restriction on supported DSV periods**, not a benefit calculation; nothing in Slice 2 calculates, displays or promises Transfer-KuG entitlement or "twelve months of Transfer-KuG" from an individual `tgStart`; a longer contract is handled manually outside the MVP | 5.6, 5.7 |
| A2 | R5: `tgEnd` may change while the participation isn't terminal | After TG entry only for a **documented DSV amendment** (and still nonterminal). How the amendment is documented in Slice 2 is not said: **Q110** (fail safe until answered: refused after entry) | 5.7 |
| A3 | R5: a new `tgEnd` only never precedes the effective start | It also **must not be in the past** (`end_in_past`), before and after entry | 5.7 |
| A4 | — (5.7 only said "never backdated" for `tgStart`) | **Past-date corrections** of either date go to the audited correction/reconciliation process (Slice 7, D10), never to ordinary editing | 5.7 |
| A5 | 5.7: a new start of today after today's run "can only be entered by reconciliation" | Confirmed as written: it **doesn't trigger automatic entry**; entry needs the later reconciliation | 5.7 |
| A6 | 5.7: clearing returns to the wave default and must satisfy the same rules | Confirmed as written, including A2 and A3 for the resulting default | 5.7 |
| A7 | R5: PL only | Confirmed; **back office gets no date permission** in Slice 2 (`setParticipationDates` stays PL only) | 5.4 |
| A8 | R23: an import must establish DE through a country column or a constant; rows of another country refused; **every** import without a country source can't be confirmed | New stored field **`addressCountry`** (ISO 3166-1 alpha-2, confidential, `personnel_file`; field-catalog key `address`): a new `ImportTarget` and column `address_country`. Case is normalised, only `DE` accepted; anything else, a value that isn't a code included, is `foreign_address_unsupported`. `country_required` applies **when an address is imported**, not to an import without address targets (possible only with `base-import-address` relaxed) | 5.1, 5.2, 5.10, 5.11 |
| A9 | — (each address part validated on its own) | Street, postal code, city and country are **one structured address; a partial address is refused** (row error, code proposed `address_incomplete`) | 5.1, 5.11 |
| A10 | Section 8: foreign addresses "left out" (no country target) | The country is stored; **non-DE rows are refused**; foreign addresses remain unsupported in the MVP | 8 |
| A11 | 5.11: age 15–67 against the Austrittsdatum | Confirmed; **no age warning** when `oldEmploymentEndDate` is legitimately absent because its rule (`base-import-oldEmploymentEndDate`) was relaxed | 5.11 |
| A12 | R24: a numeric XLSX cell refused for Personalnummer and postal code, dropped with that warning for phone and mobile | Confirmed: postal code **error**; phone/mobile **dropped with `identifier_cell_numeric` as a warning** (the code is both an error and a warning, by target) | 5.1, 5.11 |
| A13 | R6: Personalnummer matched exactly after trimming | Confirmed precisely: **leading and trailing whitespace only**, case-sensitive, punctuation and leading zeros kept; numeric-looking text cells and CSV accepted | 5.11 |
| A14 | R6: `phone` and `mobile` both selectable | Confirmed; and **never inferred from or copied to each other** | 5.11 |
| A15 | R6: invalid optional values dropped with a warning | Confirmed; the rest of the row proceeds; **invalid required values stay errors** | 5.11 |

Everything else in R5, R6, R23, R24 and R25 is confirmed as written.

## Open question raised

- **Q110** (PL, legal, BA process owner): how a `tgEnd` change after TG entry shows that it
  "reflects a documented DSV amendment" in Slice 2, which stores no documents yet. Fail safe until
  answered: after TG entry, `tgEnd` doesn't change through ordinary editing.

## Gates

- **PRs 2f and 2g** may start (Q103 confirmed).
- **PR 2h** may start (Q102 confirmed); one rule (A2) is built fail safe until Q110 is answered.
- Q101 (PL) and Q105 🔒 (DPO) stay open; the retention class `personnel_file` is the PL's answer
  for `addressCountry`, its period stays `unset` with Q105.

## Applied

This docs-only PR: this record; Q102 and Q103 confirmed and Q110 added in
`open-questions.md`; the plan's readings R5, R6, R23, R24, R25, the gates (section 0 "Open",
section 3), sections 5.1, 5.2, 5.4, 5.6, 5.7, 5.10, 5.11, 8, 9 and 11; `data-protection.md` and
`process-and-lifecycle.md`. The schema, field catalog and code change in PR 2f (and 2g/2h).
