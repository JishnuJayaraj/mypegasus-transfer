# Assign seed participants to the seeded Berater

Status: open (the Slice 7b walkthrough, 2026-11-13, F3; Q263).

The synthetic seed assigns no participant to the seeded consultant, so a Berater who logs in on
seed data gets "Sie dürfen diese teilnehmende Person nicht sehen" on every participant page and
cannot be walked through the product. The access rule (a Berater sees only assigned participants)
is correct and stays as it is.

Wanted: the seed writes participant assignments for the consultant (a few participants in each
seeded project that has any), through the same table and audit path the app uses, with synthetic
data only. A seed test asserts that the consultant can open an assigned participant and not an
unassigned one.

Where: `packages/db/src/seed.ts`, `apps/api/src/scripts/seed.ts`, `participant_assignment`.
