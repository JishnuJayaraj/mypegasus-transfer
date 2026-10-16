# Decisions — 2026-10-16, round 10 (Slice 1, PR 1b-2 review)

The product owner's answers to the six readings taken in PR 1b-2, plus a clarification of what
an entry wave is. Where they differ from earlier rounds, round 10 wins.

## Entry waves, beE units and the Transfer-KuG case

An **entry wave** (Eintrittswelle) is a timing cohort: participants expected to enter the TG at
roughly the same time under the same contractual schedule. Example (synthetic):

| Wave | Signing deadline | Default TG start | Latest entry | Default end |
|---|---|---|---|---|
| Wave 1 — short notice periods | 15 Feb | 1 Apr | 15 Apr | 31 Dec |
| Wave 2 — long notice periods | 15 May | 1 Jul | 15 Jul | 31 Mar next year |

The individual DSV stays authoritative: a participant's own start/end dates override the wave
defaults.

```
Transfer project
├── one or more beE units
├── one or more entry waves
│   └── participants with similar contractual timing
├── individual DSV contracts
│   └── actual start/end dates
└── Transfer-KuG administration
    └── BA case and monthly reimbursement
```

- **Project:** the commercial and operational umbrella for one restructuring.
- **beE** (betriebsorganisatorisch eigenständige Einheit): the unit in which TG employment is
  organised.
- **Entry wave:** the timing cohort for entering the TG.
- **DSV:** the individual three-party contract that actually establishes the participant's dates.
- **Transfer-KuG case:** the administrative benefit and monthly reimbursement process. The TG
  generally advances the payments and claims reimbursement monthly; there is no fixed pool.

A wave is **not** a Transfer-KuG bucket, and wave and beE are **not** synonyms. Per the BA
guidance on staged entry, a later wave either enters an existing beE (its possible Transfer-KuG
duration is limited by that beE's remaining term) or gets a separate beE with its own term. So one
beE may hold several waves. Data model: keep `entry_wave` separate from a later `bee_unit` /
Transfer-KuG case; a wave will eventually reference its beE, and several waves may reference the
same one.

`ta_only` projects have **no entry waves**: no beE entry, no DSV employment transfer. Their
cohorts with different activity periods are **measure groups** (cohorts), not entry waves.

## The six readings

1. **When a wave can be assigned — confirmed.** While `imported`, `contacted`, `unreachable` or
   `informed`; not while `self_registered` (the registration must first be matched); not after
   `active_in_tg` or a terminal status. Assignment stays mandatory before the DSV is offered.
2. **Profiling exception only in `ta_tg` — confirmed.** It exists for the exceptional
   post-entry profiling route under §111 (Transfer-KuG); a `ta_only` §110 measure has no TG entry.
3. **New request after rejection or revocation — confirmed with conditions.** A new, immutable
   request with its own evidence and approval. It needs changed or corrected evidence, profiling
   still open, the participation still eligible for a future entry date, and an approver other
   than the requesting PL. A rejected or revoked request is never reopened or overwritten.
4. **Approval, rejection and stale requests — partially confirmed.** Approval or rejection needs
   the main status `informed`, profiling neither `profiling_done` nor `profiling_declined`, a
   documented request and an applicable future start date. The PL doesn't clean up stale
   requests by hand:
   - when profiling finishes, the participation closes or the project changes to `ta_only`, a
     pending request is marked **superseded** automatically;
   - a PL who deliberately withdraws a still-applicable request marks it **revoked**;
   - when the original start passes, the request may stay pending only while a new valid start
     is prepared; it can never authorise entry for the missed date.

   All closures are audited.
5. **End-reason corrections — confirmed.** Correcting to the same value is a rejected no-op. A
   previous system-derived reason moves to the secondary list (useful factual context). An
   erroneous reason a PL selected stays only in the immutable audit history; it becomes a
   current secondary reason only if the PL explicitly confirms it also applies.
6. **Role checks in PR 1d — confirmed as sequencing only.** PR 1b defines the operations and
   their lifecycle preconditions, PR 1d which roles may perform them, and PR 1g's status service
   enforces both. By the end of the slice, no externally callable operation may bypass
   `mayPerformTransition` or the matching operation permission check. The database functions
   provide integrity; the status service enforces PL versus regional-operations-manager
   authority.

## Applied in PR 1b-2

- Each exception request is its own record (`superseded` added to `ProfilingExceptionStatus`,
  `ProfilingExceptionSupersededReason` added). A new request needs a different evidence
  reference than the latest request.
- "An applicable future start date" is read as: an effective TG start exists and lies after
  today. It is checked on every request, the first included, and on approval and rejection.
- `supersedeStaleException` closes only **pending** requests; a passed start alone doesn't
  close one. A revocation of a request that no longer applies is refused
  (`no_longer_applicable`): it is superseded instead.
- `correctEndReason` takes `previousStillApplies` for the PL's explicit confirmation.
