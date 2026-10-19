# Decisions — 2026-10-19, round 33 (review of the PR 2h plan)

The product owner reviewed the PR 2h plan ([#52](https://github.com/JishnuJayaraj/mypegasus-transfer/pull/52))
and approved it with amendments. Placeholder Pilot PL, Legal and BA process-owner roles are
sufficient, as in [round 32](2026-10-19-answers-round-32.md). This is an implementation-clarity
review, not a Legal, BA or DPO gate. Everything here stays revisitable.

| Topic | Status |
|---|---|
| The three-PR split (2h-1, 2h-2, 2h-3); no fourth PR: the two 2g follow-ups ride 2h-2 | **approved** |
| Readings R29–R44 of the [Slice 2 plan](../plans/slice-2.md) | **accepted pilot decisions** |
| Q111 (a)–(f) | **accepted pilot decision** (`open-questions.md`) |

## Amendment of round 32 L6 (R34, Q111 a)

A DSV amendment is required **exactly once the DSV is signed** (`dsv_signed`). Round 32 L6 ("a new
start after a missed start requires a documented DSV amendment") applies only then. For a DSV that
was never signed (expired, declined or not offered) there is nothing to amend: the later offer
carries the changed dates.

## Corrections to the plan

1. Apply R34 consistently and close Q111 for the pilot (above).
2. **A direct transition means adjacency:** `oldEmploymentEndDate` equals the new `tgStart` − 1
   day. A gap is `ba_review_required`; an overlap (the former employment ends on or after the new
   start) is refused too (`employment_overlap`). Tests cover gap, exact adjacency and overlap.
3. **`set_participation_dates` takes typed amendment parameters** and, in one call, does the date
   compare-and-set, the immutable amendment row, the BA reporting tasks and the audit event: all
   commit or all roll back. No direct DML on the amendment and task tables.
4. **`import_column_mapping` is classed consistently** as confidential, possibly pseudonymised
   participant data (R44). Keeping `project_master` and the app's direct DML on this cache is
   accepted for the pilot, justified by the keyed-hash design with no link to a person or
   participation, not by "no personal data".
5. **`participation_created_manually`** joins the exact list of configuration-dependent audit
   event types (R26) and its audit-model test.
6. **The worker cap's expired wait** is also a 503 `import_busy` with `Retry-After`; both overflow
   and timeout are tested, and the 503 problem is in the API summary.
7. **2h-2 is based on `main` once 2h-1 is merged**, because its duplicate refusal and its success
   link to the participant page of 2h-1; no dead navigation.

## Accepted without change

Role access; the assignment-aware list scope; manual creation refusing an existing Personalnummer;
individual dates keeping their wave during wave assignment; no date change while an offer is
open; extension-only once the DSV is signed; pending BA tasks for every changed effective date; the
early-exit trigger; two workers and eight waiting requests; the data-row heuristic for saved
mappings.

## Applied

The plan (status, D2, R5, R26, R34, R40, R43, the flows, 5.2, 5.3, 5.7, 5.12, AC-45, AC-47, the
definition of done), `open-questions.md` (Q102, Q111) and `process-and-lifecycle.md` (the new
start date), in #52.
