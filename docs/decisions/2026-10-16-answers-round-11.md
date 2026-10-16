# Decisions — 2026-10-16, round 11 (Slice 1, PR 1d-1 review)

The product owner's answers to the 14 readings taken in PR 1d-1, the answer to Q87 and the
changes to the decision and resource types. Q87 is **assumed** until the DPO and the PLs
confirm it (pre-pilot gate). Where it differs from earlier rounds, round 11 wins.

## The 14 readings

1. **Sensitive categories — confirmed.** Never in lists; full reads are audited. Signed-form
   metadata is the stated exception; opening the file is `document_opened`.
2. **Signed TL 407 / Kug 200b — confirmed.** The assigned profiler and the PL get metadata and
   may explicitly open the document. Back office and the participant portal don't.
3. **`case_internal` reads — confirmed.** Project roles within scope; consultants also need the
   assignment; participants see their own applicable status and dates.
4. **Aggregates — confirmed.** Staff only within project, region or global scope; participants
   never.
5. **`case_internal` writes — rule confirmed, name changed.** The deny reason is
   **`via_domain_operation`**: statuses and dependent dates go through the status functions,
   but wave assignment, planned dates and other controlled changes may use other audited
   operations. No generic field write is allowed.
6. **`sensitive_write` — confirmed.** PR 1g adds the audit event. It stores the field or
   document key, actor, subject and timestamp, **never old or new sensitive values**.
7. **Assisted mode — confirmed.** Normal PL health/disability access returns
   `needs_assisted_mode`. Break-glass stays a separate, exceptional read path and never permits
   a write.
8. **Break-glass — confirmed.** Never `list`, never writes, never beyond the role's documented
   active-phase scope.
9. **Evidence-set reads — confirmed.** Break-glass only, with the active-phase view; lists
   never. **Generic writes are `never`**, not `undecided` (Q87 C below).
10. **Participant access — confirmed, with stronger typing.** Own participation, normal mode
    only; knowledge check for health and disability. **A field key is supplied for every
    ordinary write**, not only participant writes.
11. **Multi-role union — confirmed.** The most permissive valid allow wins; a normal allow wins
    over an unnecessary break-glass allow. Otherwise the most actionable denial.
12. **Region and assignment scope — confirmed.** Unassigned consultants get aggregates only. A
    resource without a region is outside regional scope except for a genuinely global role.
13. **Other documents — changed.** `open_document` doesn't run against every access category.
    Fields, documents, audit metadata and aggregates are different resource kinds. Invalid
    action/resource combinations return **`not_applicable`**, not `undecided`.
14. **Health-related end reason — confirmed as temporary.** It can't be stored before encrypted
    storage. **Slice 8 applies the `health` access category dynamically to that value**, not
    merely removing it from lists.

## Q87 🔒 (assumed)

### A. Audit metadata: filtered projections, no unrestricted stream

| Role | Sees |
|---|---|
| PL | operational case history of their projects: lifecycle changes, document status, assignments, corrections. No sensitive-access or security events, no reason code they couldn't otherwise access. |
| Assigned consultant/profiler | the operational history needed for the assigned participation, plus their own actions. No break-glass, export, review or unrelated staff-access history. |
| Back office | DSV, payroll, absence and settlement history needed for its work. No profiling, health-access or section C history. |
| Regional operations manager | only events awaiting or recording their approval or review (profiling exceptions, reconciliations, break-glass). |
| Participant | no audit-log UI in the MVP; relevant information through the data-subject export. |
| Regional admin / admin | no participant-level audit metadata. |

Audit metadata is read-only and not a document: `open_document` doesn't apply.

### B. Other documents: a versioned document-type catalog

Every type declares its data/access category, retention class, permitted roles and participant
visibility.

| Document type | Classification / access | Who may open |
|---|---|---|
| Signed DSV and DSV cancellation | employment-contract document; encrypted | PL and back office, explicitly logged |
| ASU proof | by content, normally identifiers | assigned profiler; the PL gets metadata and may open it only through break-glass |
| Profiling-exception evidence | health when medically related, otherwise confidential | assigned profiler as needed; the PL only in assisted mode or through break-glass; the regional operations manager sees metadata / "evidence present" only |
| CV and general participant uploads | confidential | the participant's own document, assigned consultant, PL |
| Qualification certificates | confidential | participant, assigned consultant, PL; back office only when needed for funding or settlement |
| Generated reports / exports | a dedicated report/export resource | the generating or authorised role; every generation and download logged |

In the MVP portal, the signed DSV, its cancellation and other signed documents stay unavailable
to participants; copies are provided manually or through the data-subject process until
stronger authentication exists. `open_document` on a field, aggregate or audit resource is
`not_applicable`.

### C. Evidence-set writes

The evidence set is immutable through normal field and document writes: no participant or
consultant writes, no generic PL or back-office writes, no update or deletion of an existing
artifact; signed documents stay immutable. Evidence-set write cells are **`never`**.

A separate operation **`append_evidence_correction`** covers exceptional BA/legal requirements:
- PL or back office, according to the document type;
- a mandatory BA/legal reference and a reason code;
- approval by the regional operations manager;
- an append-only new artifact with a supersedes/corrects link; the original is retained;
- fully audited.

It is authorised separately (operation permissions).

## Type changes (approved)

- `via_status_functions` → **`via_domain_operation`**.
- Audit value **`sensitive_write`**.
- `question` is **mandatory exactly when `because: "undecided"`**.
- **`not_applicable`** for invalid action/resource combinations.
- A **field key** is required for ordinary field writes.
- `Resource` is a **discriminated union** `FieldResource | DocumentResource | AuditResource |
  AggregateResource`; only a `DocumentResource` (with `documentType`) supports `open_document`.

## Applied in PR 1d-1

See the plan, section 5.6, "Applied in PR 1d-1 (round 11)" and the readings taken while
applying them.
