# Decisions — 2026-10-16, round 16 (Slice 1, PR 1g-1 review)

The product owner's answers to Q94 and Q95 and to the eighteen readings taken in PR 1g-1 (#19).
Where they differ from earlier rounds, round 16 wins.

## Q94 — Profiling-exception evidence and request history (confirmed)

A profiling-exception request is a **first-class record**; earlier requests don't exist only as
audit events. A table `profiling_exception_request` holds:
- an immutable request id;
- `projectId` and `participationId`;
- the reason code;
- the status;
- the requester and the request date and instant;
- the evidence record id;
- the evidence fingerprint;
- the decision's actor, date and instant;
- the superseded reason where it applies.

The participation references its current/latest request. The request table is authoritative: a
rejected, revoked or superseded request is never overwritten by the next one. The exception
columns move from `participation` to the request record (no two competing sources of truth).

"Immutable request" means its reason and evidence identity never change. Its status and decision
fields progress on the same row, and every progression is audited. A later attempt creates a new
row.

### Evidence reference

Each request references **one immutable evidence record**, which may represent:
- one or more accepted `profiling_exception_evidence` document versions; or
- a structured BA confirmation with the Agentur, the confirming contact/reference and the
  confirmation date.

The raw documents and BA details arrive in Slice 4b. Until then an opaque UUID reference and a
fingerprint may be stored, but **the status service keeps refusing every real request with
`evidence_missing`** until it can validate the referenced evidence.

### Changed evidence

A canonical **fingerprint** of the evidence record is stored. A new request after a rejection,
revocation or supersession needs a fingerprint different from the latest request's:
- reordering the same documents doesn't count;
- re-uploading identical bytes under another document id doesn't count;
- a genuinely changed document version has a different content digest;
- a BA confirmation counts as changed only when its normalised substantive facts differ;
- merely creating a new database row with the same facts doesn't count.

Audit events carry only the `profilingExceptionRequestId`, evidence-record id/fingerprint
identifiers where needed, actors, dates and reason codes, **never evidence contents**. The
request, approval, rejection, revocation and supersession events all identify the same request.

## Q95 — Seed actors (confirmed)

- Imported/manual creation and every user edge act as the appropriate seeded staff user.
- PL, consultant and back-office actors follow the Q60 permission matrix.
- System edges act as `system` with job `seed`.
- The seed gets no bypass actor, and `system` never becomes eligible for user edges.
- 1g-2 uses the same service and functions as production, never direct table writes.

## The eighteen readings of PR 1g-1

1. PR split and data catalog in 1g-1 — **confirmed**.
2. Wave migration — **confirmed.** Existing `ta_tg` projects get W1; missing dates stay null and
   flagged. Projects created before Slice 2's wave UI may stay without a wave and can't progress
   through wave-dependent operations.
3. `profiling_exception_superseded` — **confirmed.** The triggering change writes
   `status_changed`; the automatic closure writes a second event with the `system` actor and the
   same correlation ids. It includes the exception-request id.
4. Additional columns — **partially confirmed.** `end_reason_source`,
   `lifecycle_edge.project_types` and the composite wave/project FK are approved. The exception
   reason, status, requester, decision and supersession columns belong on
   `profiling_exception_request`; `participation` keeps only the current/latest request
   reference unless a justified derived projection is required.
5. Latest request only on participation — **rejected** (Q94 above).
6. Additional consistency checks — **confirmed**, adapted to the separate request table.
7. `lifecycle_edge` key and actors array — **confirmed**.
8. Database-function checks versus dated guards — **confirmed.** The functions enforce
   structural integrity; the status service enforces dated evidence and contractual guards.
9. Creation actor — **confirmed** by Q95.
10. No caller-supplied status-change JSON — **confirmed.** Typed parameters and internally
    built details are preferable.
11. Function hardening — **confirmed.** Keep `pg_temp` last, schema-qualify objects, revoke
    public execution and expose only the intended functions.
12. Composite audit actor — **confirmed.** A missing or inconsistent actor context fails closed.
13. Business dates versus instants — **confirmed.** Business dates come from the injected Berlin
    clock; immutable recording instants use database time.
14. No free text in audit storage — **confirmed.** The database checks are defence in depth;
    callers additionally validate against the typed `AuditEvent` schema. Sensitive values,
    including numeric or boolean health/payroll values, never go into `details`.
15. Audit model — **confirmed**, with the profiling-exception events identifying their request
    record.
16. Retention classes — **confirmed.** The request table joins the data catalog as
    `participation_record`; evidence records get their class later.
17. Same-wave reassignment — **corrected.** Assigning the current wave again is a no-op:
    refused with `wave_unchanged`, no `status_version` increment, no audit event.
18. Stable SQL error codes — **confirmed**, adding `wave_unchanged` and, where enforced in SQL,
    `evidence_missing` / `evidence_unchanged`.

## Applied in PR 1g-1

See the plan, section 5.4, "Readings taken in PR 1g (1g-1)", and the readings taken while
applying round 16.
