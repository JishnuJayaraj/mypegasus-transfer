# Decisions — 2026-10-16, round 22 (Slice 2 planning)

The product owner's review of [the Slice 2 plan](../plans/slice-2.md) (PR #24): seven required
corrections, the decisions D1–D11, the dependencies and the disposition of Q98–Q107. Where they
differ from earlier rounds, round 22 wins. The corrections are carried into the plan and
`open-questions.md` in the same PR.

## Required corrections

1. **D3: locking is enforced inside the database functions.**
   - Every setup mutation function acquires the exclusive project lock itself.
   - `lock_participation` acquires the shared project lock before its row lock.
   - The participation creation edge (`create_participation`) also acquires the shared project
     lock.
   - Lock order is always project → template version → participation row.
   - Services are never relied on to remember `lock_project_setup`.
2. **D5: template immutability needs cross-project serialisation.**
   - Project locks don't stop two projects from concurrently pinning different contents for the
     same `(agenturKey, version)`. Either take a global advisory lock on that identity, or
     normalise versions into a table keyed by `(agenturKey, version)`.
   - The stored `jsonb` content is compared as well as the supplied hash: the same claimed hash
     with different content fails.
   - A concurrent integration test shows that exactly one of two conflicting pins succeeds.
3. **D6: the import confirm has no TOCTOU window.**
   - Parsing may happen before the transaction.
   - Everything else happens under the exclusive project lock in one transaction: reloading the
     configuration and state, re-planning, comparing the preview token, validating the decisions,
     and the writes.
   - A ZIP central-directory check on expanded size and ratio runs even when worker isolation
     works.
   - If spike S1 fails, there is **no fallback to synchronous XLSX parsing in the API process**:
     use a child process, or ship CSV only until isolation works.
4. **R1/Q98, type changes.**
   - "No lifecycle transition" means **no post-creation lifecycle transition**: creation stays
     allowed in draft.
   - A draft `ta_tg` project can't become `ta_only` once it has participations **or entry waves**,
     because Slice 2 has no wave deletion.
5. **R5/Q102 is not yet fail safe.**
   - A participation date override fails when its wave has no `latestEntryDate`.
   - "No 12-month check" is **not** confirmed. §111 SGB III and current BA guidance limit
     Transfer-KuG to twelve months. Whether `tgEnd` means the end of employment or the end of the
     funded period needs legal/BA-process-owner confirmation.
   - Until confirmed, periods longer than twelve months are blocked, not accepted silently.
   - Q102 is settled before PR 2h.
6. **R6/Q103 leaves two import cases open.**
   - Foreign addresses: decide between an ISO country target and explicitly rejecting unsupported
     foreign addresses.
   - An XLSX numeric Personalnummer can lose its displayed leading zeros. Numeric identifier cells
     are rejected with a stable error unless the parser can prove that the exact displayed
     identifier is preserved.
   - Both are settled before PRs 2f/2g, because they may change the schema and the import target
     catalog.
7. **R10/Q107, audit provenance.**
   - The base defaults may stay release-managed rather than pinned per project.
   - Every audited operation whose result depends on them records the base-defaults version: at
     least activation, migration and the confirmed import, and every future
     configuration-dependent operation.

## Decisions

- **Approved:** D1, D2, D4, D7, D10, D11.
- **Approved after the amendments above:** D3, D5, D6, D9.
- **D8:** architecture approved; Q105 stays a DPO gate.
- **Dependencies approved:** exact pins `read-excel-file@9.3.12` and `csv-parse@7.0.3`, subject to
  S1 and the containment rules above. The registry metadata matches the plan, and a fresh
  production audit found no known vulnerabilities. The single-maintainer risk of
  `read-excel-file` is acceptable because of isolation and replaceability.

## Readings

R2–R4 and R7–R22 are accepted as written. R18 includes the corrected confirm transaction under the
project lock (correction 3). R1, R5, R6 and R10 are amended by corrections 4, 5, 6 and 7.

## Open-question disposition

| Q | Disposition |
|---|---|
| Q98, Q99, Q100, Q104, Q106, Q107 | **confirmed** with the amendments above |
| Q101 | PL confirmation still required |
| Q102 | PL / legal / BA process owner confirmation required, **before PR 2h** |
| Q103 | PL confirmation required **before the import implementation (PRs 2f/2g)** |
| Q105 🔒 | DPO confirmation required before the pilot; no production personal data while retention periods are `unset` |

## Applied (PR #24)

The plan's sections 0, 2.4, 3, 5 and 7 and `open-questions.md` (Q98–Q107) carry the corrections.
Readings taken while applying them are listed in the plan under "Readings taken while applying
round 22".
