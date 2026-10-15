# Decisions — 2026-10-15, round 4 (PR #1 review)

The product owner's review of PR #1. These decisions are carried into the docs in the same PR.

## Lifecycle design
1. **DSV offered from `informed` onwards, for everyone.** In practice the DSV is handed out at
   the info event with a signing deadline, in parallel with profiling. So after `informed`
   there are **two parallel tracks**:
   - profiling track: `profiling_accepted` → `profiling_in_progress` → `profiling_done`, or
     `profiling_declined`
   - DSV track: `dsv_offered` → `dsv_signed`, or `dsv_declined` / `dsv_expired`

   TG entry guard: DSV fully executed **and** ASU submitted **and** (profiling done **or**
   profiling exception). The UI may show one overall status derived from the tracks.
2. **ASU required before TG entry: confirmed.** §111(4) Nr. 4 SGB III requires registration as
   job-seeking before the transfer into the beE. The profiling exception does not extend to the
   ASU, so this is a **hard guard with no override**.
   - "Registered" = Kug 200b submitted to the Agentur, with a recorded submission date and
     channel. Agentur confirmation is optional.
   - No confirmation 14 days after submission → warning for the PL.
3. **`dsv_signed` = participant signed; TG entry needs all three signatures: confirmed.** Track
   `customerSignedOn` and `tgSignedOn` on the DSV document and derive `dsvFullyExecuted`. PLs
   get a list of DSVs signed by the participant but not yet fully executed.
4. **Rename to `profiling_accepted`: confirmed.** The participant can still refuse, but then
   loses Transfer-KuG eligibility. The TL 407 page 2 signature is a declaration on the form,
   not our consent record.

## Q53 — `profiling_declined`
- Separate reason **`declined_profiling`**: unlike `declined_dsv`, the person can't get
  Transfer-KuG at all, which matters for reporting.
- Works like `dsv_declined`: non-terminal during the grace period, then the system job moves
  the person to `withdrawn` with `declined_profiling`.
- Edge case: `dsv_signed` + `profiling_declined` → the person can't enter the beE. Flag it to
  the PL as a conflict for manual clarification; the system never resolves it automatically.

## Review proposals: all accepted
1. **Separate participant portal:** `apps/portal` next to `apps/web`, sharing `packages/*`
   (ADR-0001).
2. **Status writes enforced in the database:** status change + audit entry in one transaction
   through a single function. `UPDATE` on status columns revoked from the app role. Audit table
   append-only by grants (ADR-0002).
3. **JSON Schema for regional fields:** regional config validated by JSON Schema stored as
   data. Completeness rules limited to `required`, `requiredIf` (equals/exists), document
   present + accepted. No scripting (ADR-0004).
4. **Permission model in Slice 1:** the field-level access matrix becomes pure domain logic with
   tests in Slice 1. Slice 3 only connects login and identity (roadmap, ADR-0007).
5. **Tighten `.claude/settings.json`:** `pnpm add *` → ask. Deny reading `.env*` via Bash
   (`cat`, `less`, `head`, `grep`). `git commit` stays allowed, `git push` stays ask.

## Q32 — Cluster operator and AVV chain
The product owner operates the cluster and owns the AVV chain. "AVV chain signed" remains a
blocking item of the pre-pilot gate.

## Decided while applying this round, for review
- **DSV fully executed is a hard guard** (no override), like the ASU: there is no employment in
  the beE without the written three-party contract (§623 BGB).
- **Main status keeps `informed`** while the tracks run. `profiled`, `submitted_to_agentur`,
  `data_collection` and the main-status `dsv_*`/`profiling_*` states are gone. Data collection
  is a completeness measure, not a state.
- The tracks don't exist before `informed`, and the DSV track doesn't exist in `ta_only`
  projects.
- `tail` was added to the `.env*` Bash deny list, next to `cat`, `less`, `head` and `grep`.
- New open questions: Q54 (TL 407 submission as TG guard?), Q55 (other ASU channels), Q56 (order
  of withdrawal reasons).
