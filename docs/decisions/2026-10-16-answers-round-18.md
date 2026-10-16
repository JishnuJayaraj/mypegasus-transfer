# Decisions — 2026-10-16, round 18 (Slice 1, PR 1g-2 review)

The product owner's answers to the readings taken in PR 1g-2 (#20). Where they differ from
earlier rounds, round 18 wins.

1. **Order of checks — confirmed.** Lock/load → permission → expected status → domain → database
   function.
2. **No region yet — confirmed temporarily.** The seeded regional operations manager may use
   global scope. Global production access must not be inferred from the stored role; Slice 3
   assigns regional scope before real use.
3. **Fail-closed facts — confirmed.** Only the participation's own approved exception may be
   reconstructed. All documentary facts and exception evidence stay absent in Slice 1.
4. **Effective dates — corrected: never unbounded.** The service enforces:
   - `active_in_tg`: exactly the effective TG start;
   - `dsv_expired`: exactly the effective offer deadline + 1 day, and an effective date is
     required;
   - automatic cutoff withdrawal: exactly the applicable cutoff + 1 day;
   - manual `withdrawn`, `exited` and `profiling_done`: may be backdated, never future-dated;
   - `exitDate >= tgEntryDate`;
   - no effective date on a transition where it has no meaning.

   Stable errors: `effective_date_not_allowed`, `effective_date_in_future`,
   `effective_date_before_entry`, and `effective_date_mismatch` for derived dates. For system
   transitions the planner-derived date is validated after locking; an arbitrary system
   caller's payload is not trusted. Service tests and a database constraint
   `exit_date >= tg_entry_date`.
5. **Automatic supersession — confirmed.**
6. **No assisted mode in Slice 1 — confirmed.**
7. **Unknown wave as `wave_of_other_project` — confirmed.**
8. **Seed — partially confirmed; the reconciliation rationale changes.** An exception approval
   recorded after the scheduled run can't retroactively authorise entry: it is a decision, not
   late documentary evidence. A seeded exception entry may be a reconciliation only when the
   exception was approved before the scheduled run **and** another prerequisite was recorded late
   but proves it was valid at the TG start. Assertions: `decidedAt <= scheduledAt`, and at least
   one documentary fact justifying the reconciliation has `validOn <= tgStart` and
   `recordedAt > scheduledAt`. The fixed timeline moves far enough into the future, or database
   time is controlled, so the seed doesn't become invalid after 2027.
9. **`regional_operations_manager` — confirmed.** An organisation role, represented by the flat
   `StaffRole` until Slice 3.

## Applied in PR 1g-2

See the plan, section 5.4, "Readings taken in PR 1g-2".
