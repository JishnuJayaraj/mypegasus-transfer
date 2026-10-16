# Decisions — 2026-10-16, round 17 (Slice 1, PR 1g-1, round-16 follow-up)

The product owner's answers to the nine readings taken while applying round 16 in PR 1g-1 (#19).
Where they differ from round 16, round 17 wins.

## 1. Evidence fingerprint — corrected (format and audit use)

The canonicalisation algorithm is versioned, not only the hash: the format is
**`sha256:v1:<64 lowercase hex characters>`**. Slice 4b computes it over a domain-separated
canonical payload that includes the participation id:

```
profiling-exception-evidence:v1
<participationId>
<canonical evidence>
```

Canonical evidence is either the sorted, de-duplicated content digests of the accepted immutable
document versions, or the normalised structured BA-confirmation facts with stable key ordering
and normalised dates and codes. So identical re-uploads stay unchanged, ordering doesn't matter,
fingerprints can't correlate identical evidence across participants, and a future
canonicalisation can use `v2` without pretending the evidence changed.

The fingerprint is **confidential evidence metadata**: it stays on `profiling_exception_request`,
never appears in logs or client responses, and is **removed from the
`profiling_exception_requested` audit details** (unnecessary duplication). The audit event carries
`profilingExceptionRequestId` and may keep the opaque `evidenceRecordId`.

## 2. Decide/revoke by request id — confirmed

`request_not_found` and `request_not_current` are the right distinctions; locking the
participation before the operation is correct.

## 3. One open request — confirmed

At most one `requested` or `approved` request per participation.

## 4. Immutable-request trigger — corrected

The trigger let a direct `requested → revoked` or `requested → superseded` update add fabricated
decision fields. The exact transition matrix:

| Transition | Decision fields |
|---|---|
| `requested → approved` | change from null to a complete decision |
| `requested → rejected` | change from null to a complete decision |
| `requested → revoked` | stay null |
| `requested → superseded` | stay null |
| `approved → revoked` | stay exactly unchanged |

Every other transition is `request_immutable`. Still enforced: reason, requester, dates,
participation/project identity, evidence id and fingerprint never change; only `superseded` has a
superseded reason; the requester can't be the decider. A direct-owner test proves
`requested → revoked/superseded` with fabricated decision fields fails.

## 5. Reusing `profiling_exception_status` — confirmed

`none` belongs only to the absence of a current request and is invalid on a request row.

## 6. Composite foreign keys — confirmed

## 7. `status_version` — confirmed

Request creation, decision and revocation each bump it; an automatic supersession shares the
triggering status change's bump.

## 8. `transfer_app` read access — confirmed with scope

It may select the request table, because the status service needs the current request, the
requester, the fingerprint and the approval fact; no write privilege. The API still applies
project/role access, and request rows or fingerprints are never exposed through generic
endpoints. Pre-pilot RLS remains required.

## 9. Error codes — confirmed

`request_not_found`, `request_not_current`, `request_immutable`, `wave_unchanged`,
`evidence_missing`, `evidence_unchanged`. A malformed fingerprint may stay a `23514` constraint
violation after service/schema validation.
