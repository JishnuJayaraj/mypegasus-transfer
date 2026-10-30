# Identify a Kug 200a copy within its batch

Status: open, nonblocking (the review of PR #99, 2026-10-30; Q205 (8)).

A batch of more than six members spans several copies of the Kug 200a, each a complete form whose
rows are printed 1–6. Nothing on a copy says which batch it belongs to or that it is copy n of m,
so a packet whose pages are separated can't be put back together from the paper alone.

Wanted: a way to identify each copy within its batch (for example "Blatt n von m" and the batch's
date) without writing into a field the BA's form doesn't have: on the alternative list it can be
part of our template; on the official form it needs a decision on where it may be printed (a
margin, a cover page or a separate index) and whether the Agentur accepts it.

Where: `checkKug200a` and `renderArtifact` (`packages/domain/src/asu/kug200a.ts`,
`apps/api/src/forms/kug200a.ts`); ba-forms.md, the Kug 200a as built.
