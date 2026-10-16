# Decisions — 2026-10-16, round 7 (Slice 1 planning)

The product owner's answers in the review of [the Slice 1 plan](../plans/slice-1.md)
(PR #8). They are carried into the plan, the domain docs and `open-questions.md` in the same PR.
Where they differ from earlier rounds, round 7 wins.

## Plan decisions D1–D10

- **D1 — PR shape:** approved. PRs 1a–1h; each PR must stay green on its own.
- **D2 — Status writes:** approved. Statuses and audit events are written only through narrowly
  scoped `SECURITY DEFINER` functions. The runtime role gets no direct participation or audit
  writes. Fixed `search_path`, `EXECUTE` revoked from `PUBLIC`, no dynamic SQL, grants tested.
- **D3 — Tables:** approved. Only the minimal participation, lifecycle, audit and job tables.
  Personal data and memberships belong to later slices.
- **D4 — Missing evidence:** approved for Slice 1. Missing DSV, ASU and profiling evidence fails
  closed. This is a temporary implementation state, **not** a rule that lets the application
  decide whether an employment relationship legally exists.
- **D5 — JSON Schema engine:** approved subject to spike S1. Restricted `z.fromJSONSchema`
  profile; fall back to server-only `ajv@8.20.0` if compatibility or CSP testing fails.
- **D6 — Roles: changed.** Roles are project-specific. A person may hold **several project roles
  in the same project** and different roles in different projects. Permissions are the **union**
  of the explicitly assigned roles; profiler access still requires the participant assignment.
  Example: someone who is both PL and profiler gets section C access only for participants
  assigned to them as profiler.
- **D7 — Jobs:** approved. pg-boss runs in the API process for the MVP. A separate worker is an
  operational scaling decision for Slice 9.
- **D8 — Sample templates:** approved. Fictional Agenturen only. Never invent rules for Nürnberg
  or another real Agentur.
- **D9 — Adapters:** approved. Only `Clock` now; the other adapters come with the slices that
  need them.
- **D10 — Docs gaps:** approved as the default policy. Unknown access is denied, unknown
  automatic transitions don't run, operational exceptions are flagged. Incorporated answers
  replace the corresponding temporary defaults.

## Dependencies

- `pg-boss@12.38.0` approved.
- Its non-optional peer **`@opentelemetry/api@1.9.1` is added explicitly**, not left to pnpm's
  peer installation.
- `ajv@8.20.0` only if S1 takes the fallback.
- All versions exact; pg-boss is upgraded only in deliberate dependency PRs.

## Q60 — Manual transitions (confirmed)

- **PL:** every manual transition in their project, plus matching, withdrawal, `ta_completed`,
  correction of end reasons, and profiling exceptions.
- **Assigned consultant/profiler:** `contacted` / `unreachable` / `informed`, the profiling
  transitions, and recording an exit or placement.
- **Back office:** DSV offered / signed / declined, and the relevant payroll and administrative
  facts. Expiry stays system-only.
- **Participant:** no direct lifecycle transition in the MVP. A portal declaration is evidence
  that authorised staff verify and record.
- **Profiling exception:** PL only, with a documented reason. It may be revoked before TG entry.
  After entry it is closed by completing profiling, never silently revoked.

## Q61 🔒 — Roles (assumed until the DPO confirms the access implications)

Zero or more project roles per membership. A person can be PL in one project, profiler in
another, or both in one project. Sensitive access comes from the role plus the assignment, not
from project membership alone.

## Q62 🔒 — Unassigned participants (assumed)

Consultants/profilers get no person-level data of participants not assigned to them. They may
see aggregate workload counts. The PL does the assignment. No project-wide directory of names
or other confidential fields.

## Q63 🔒 — Break-glass review (assumed)

- One break-glass grant covers **one participant, one resource/category and one action**, never
  a reusable session.
- Every action is logged on its own, with a mandatory reason.
- **Regional operations management** reviews it by the next business day, from audit metadata;
  participant details are not exposed automatically.
- The DPO gets periodic reports and immediate escalation of suspicious access, but is not the
  operational approver.
- Guard overrides use the same four-eyes review.

## Q64 🔒 — Evidence-set phase (assumed)

Evidence-set access starts **after the first retention/deletion stage**, not at the terminal
status. Normal authorised access stays available during case close-out and the ordinary
personnel-file retention period. Once reduced to the evidence set, access is break-glass only.

## Q65 🔒 — Write permissions (assumed until DPO and PL review)

- **Participant:** own self-service fields and uploads; never lifecycle, payroll, audit or
  derived fields.
- **Assigned profiler/consultant:** the case and profiling data their work needs; section C and
  health data only for assigned participants.
- **PL:** operational dates, assignments, status actions, exceptions and case administration; no
  ordinary editing of health data, section C or payroll identifiers.
- **Back office:** DSV administration, payroll identifiers, payroll-relevant disability facts,
  absence types and dates, settlement data.
- **Admin / regional admin:** configuration only, no case-data writes.
- Assisted writes are recorded as actor + `onBehalfOf`.
- Signed or submitted documents are immutable; corrections create a new version or a correction
  record.
- Sensitive writes and corrections are audited.

## Q66 🔒 — Classification (assumed)

- Familienstand, gender, Personalnummer, end of the old employment, knowledge date, work email,
  language skills, driving licence: **confidential**.
- End reason `long_term_illness_reduced_earning_capacity`: **special category** (health), never
  in ordinary lists.
- End reason `deceased`: confidential; death alone doesn't make it health data.
- Profiling-exception reasons: **structured reason codes** where possible; the free-text reason
  is treated as **special category**, because it may disclose illness.
- Override and break-glass free text: **highly confidential**, encrypted, excluded from lists and
  logs, visible only to the actor and the authorised reviewer.
- UI copy tells staff not to enter diagnoses or unnecessary personal details.

## Q67 🔒 — Participant access to signed forms (assumed)

No signed TL 407 or Kug 200b PDFs in the MVP portal. They are provided through the
data-subject export / manual request process. Portal downloads are reconsidered only after
stronger participant authentication and document-specific access tests.

## Q68 — Entry after the planned date (confirmed)

**No automatic late entry.** The PL either:
1. records a new, contractually valid start date, or
2. performs an **audited reconciliation** when documents prove that all requirements were already
   met on the original date and only the system record was late.

Entry is never backdated just because missing evidence was created later. The application
records the effective employment date; it doesn't create the employment relationship.

## Q69 — DSV re-offers and deadlines (confirmed)

Signing and entry deadlines come from the **Sozialplan / DSV / project entry wave**, not from an
Agentur template and not from a nationwide 90-day rule.

- A project/wave-level **`latestEntryDate`**.
- A re-offer needs an explicit participation-level **`offerDeadline`**.
- `deadlineRule` means a project-specific contractual calculation rule, not a regional BA rule.
- Deadlines are **inclusive**; expiry happens the following day.
- A re-offer deadline may not be later than `latestEntryDate` or the planned entry date.
- If no contractual rule is recorded, the PL enters the deadline; the system never invents one.

**The fixed "signing deadline + 90 days" grace period is reopened:** it is not a general legal
rule (follow-up Q77).

## Q70 — `imported` / `contacted` at the final admission cutoff (confirmed)

After advance warning to the PL:
- `imported` → `withdrawn` with **`never_contacted`**
- `contacted` → `withdrawn` with **`not_informed`**
- `unreachable` → `withdrawn` with `no_response`

These run **only when the project has an explicit `latestEntryDate`**. Without it, the cases are
flagged and nothing moves automatically.

## Q71 — Guard overrides (confirmed)

Documentary and contractual guards are **not overridable**: signed DSV scan and receiver, signed
TL 407, fully executed DSV, ASU proof, cancellation after a signed DSV, TA completion evidence.
A late admission after the project cutoff needs a new approved deadline/start date or a
contractual amendment; it is not a generic guard override.

## Q72 — Correcting an end reason (confirmed)

Yes. The PL corrects the primary end reason through a dedicated, audited correction operation,
without reopening the terminal status. The previous and derived reasons stay in the history;
a previous system-derived reason moves to the secondary list.

## Q73 — `ta_only` completion (confirmed)

- A TA participation needs its own planned measure period or final activity date.
- `ta_completed` means all assigned §110 activities are completed or formally closed, the
  required evidence is present, and the PL confirms closure.
- Profiling completion alone is not enough.
- Decline, no response or early termination end as `withdrawn` with the applicable reason.
- Until TA dates and activities exist, Slice 1 allows PL-driven closure only: no guessed
  automatic deadline, no override.

## Q74 🔒 — Profiling exception after entry (verify until legal / BA process owners confirm)

- The exception may be set only for a documented, justified exception, and **never after
  `profiling_declined`**.
- After entry, forward profiling transitions are allowed, and **a later refusal can be
  recorded**: the system must not hide what happened.
- A refusal or a missed one-month deadline creates an **immediate compliance escalation**; it
  doesn't end the employment automatically.
- **beE employment is tracked separately from Transfer-KuG eligibility.**
- When profiling is completed after entry under the exception, Transfer-KuG eligibility starts
  **no earlier than the following day**.
- Affected periods are excluded from Transfer-KuG claims until cleared.

## Q75 — Relaxing base requirements (confirmed)

- Statutory requirements and official BA-form requirements are locked.
- Regional templates may only add requirements or change explicitly regional settings.
- A project override may relax only a requirement classified as an **internal operational
  default**, with reason, approval and audit.
- Until a base rule has that classification, it is locked.

## Q76 — Missing Agentur template (confirmed)

Base defaults apply for data collection, but operations don't silently continue:
- A missing **KuG-Agentur** template **blocks project activation**.
- A missing **placement-Agentur** template allows contact, data collection and profiling, but
  **blocks Agentur submission** until channel, original requirement and lead time are confirmed
  and recorded.
- A blocking PL task and a warning are shown.
- A real Agentur's submission rules are never guessed.

## Required legal/product correction

The domain distinguishes:
1. the participant's **actual employment** in the beE/TG, and
2. **eligibility for Transfer-KuG** for a given period.

The current BA Fachliche Weisungen allow post-entry profiling in justified exceptions, but
Transfer-KuG entitlement begins no earlier than the day after profiling is completed. A
reminder alone is therefore not enough. *(verify, with Q74)*

## Noted while applying (for review)

> Notes 2 and 3 were corrected and notes 4 and 5 confirmed in
> [round 8](2026-10-16-answers-round-8.md).

These readings were needed to carry the answers into the plan and docs. Correct any that are
wrong:

1. **D6 "active role"** is read as "a role the person currently holds in that project", not a
   role switched per session.
2. **Four-eyes review is after the fact** (by the next business day), as for break-glass. Since
   Q71 leaves no overridable guard, in Slice 1 it applies to **profiling exceptions**; from
   Slice 3 also to break-glass. Who exactly reviews is Q80.
3. **Q68 is read strictly:** a missed nightly run doesn't enter anyone into the TG retroactively.
   The participation is flagged and the PL reconciles. (The plan's catch-up window and its
   `job_run` table are dropped.)
4. **Q66 free text needs field-level encryption,** which doesn't exist yet. Slice 1 therefore
   stores **reason codes only**; free text arrives with the encryption work (break-glass in
   Slice 3). The end reason `long_term_illness_reduced_earning_capacity` is refused by the
   status function until encrypted storage exists (TG exits are Slice 8).
5. **Q76** means the base defaults hold **no Agentur submission settings** (channel, original,
   lead time, Kug 200b batch channel); they resolve as *blocking* until a template or a recorded
   project override supplies them.
6. **The first DSV offer** uses the project's signing deadline; if the project has none, the
   offer needs an explicit `offerDeadline` (Q69: the system never invents one).
7. The answers raise seven follow-ups, Q77–Q83, in `open-questions.md`: what replaces the grace
   period, the warning lead time before cutoff withdrawals, entry waves, the reviewer role,
   profiling-exception reason codes, the details of Transfer-KuG exclusion, and whether
   `ta_completed` still needs `profiling_done`.
