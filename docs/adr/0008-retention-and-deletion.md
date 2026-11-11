# ADR-0008: Retention and deletion per data item

- Status: Accepted (values provisional — Q3, Q24, Q40, Q51, Q52 are `assumed`/`verify`)
- Date: 2026-10-15

## Context
Participant data has many retention duties at once: data minimisation (delete non-signers
quickly), payroll and tax law (years), funding audits by the Agentur (evidence of measures), and
the health-data rules. A per-person retention rule would keep whole profiles for the longest
duty.

## Decision
- Every data category and document type has a **`retentionClass`**, configured as data. Each
  item follows its own class. Where one item falls under several rules, the longest of those
  rules applies. **Never per person.**
- Retention starts from lifecycle events: `withdrawn` (the grace period of 90 days after the
  signing deadline is built into the lifecycle), beE exit, end of year of exit,
  project settlement dates. *Note 2026-10-16 (round 7): the fixed 90-day grace period is
  reopened; withdrawal happens at the final admission cutoff after `latestEntryDate` (Q69, Q70,
  Q77). Round 8: the non-signer deletion clock starts at `withdrawnOn` (manual or automatic);
  the proposed 90 calendar days stay `unset` in executable configuration until the DPO confirms.*
- **Two-stage deletion:**
  1. full deletion of everything not needed as evidence
  2. deletion of the **evidence set** (identity, measure, participation dates/times, signed
     participation pages, proof of submission, matching audit entries) at the end of the
     calendar year of the later of `kugFinalSettlementDate` / `measure110SettlementDate` + 4
     years. The evidence set is never deleted while the required settlement dates are missing.
- A **nightly, idempotent job** with the `system` actor runs both stages and writes audit
  events.
- Audit entries of deleted subjects are **pseudonymised**. Audit entries belonging to an
  evidence set follow the evidence set.
- **Backups are kept for at most 30 days.**
- *Note 2026-10-16 (Slice 1, PR 1g-1):* the lifecycle tables brought three classes, listed in
  data-protection.md: **`participation_record`** (`participation`, `profiling_exception_request`), **`audit_log`**
  (`audit_event`) and **`reference_data`** (`lifecycle_edge` and, from PR 1h-1, `job_run`, never
  touched by the retention job); entry waves are `project_master`. Periods stay `unset` until the DPO confirms them
  (Q3, Q77); the data-catalog test refuses a table without a known class.
- *Note 2026-10-19 (Slice 2, PR 2f):* person data arrives in two tables of different classes:
  `participant_identity` (`participation_record`) and `participant_details` (`personnel_file`,
  Q105). The field catalog names each stored field's class, and a test maps every person-data
  column to its field and refuses a table whose fields don't share its class, so "per data item"
  holds at table level.
- The values are in `docs/domain/data-protection.md` and must be confirmed by the DPO and tax
  advisor before the pilot.

## Consequences
+ Data minimisation and audit duties are both met, and periods change by configuration.
- Every table and document type needs a retention class from the start. That's a review item
  in every PR that adds personal data.
- The settlement dates become operationally important: the admin dashboard warns about projects
  that ended more than 12 months ago without them.

## As built 2026-11-11: the framework (Slice 7, PR 7-7a)

Rules in the domain, periods in the data catalog, activation gated (data-protection.md, retention
as built; readings Q234): `retentionDue` per item, `retentionActivation` over the prerequisites of
a live deletion, all unmet, so every run is a dry run. The job applies stage one without a person
trigger (access credentials, generated working copies' files, orphaned objects) once a class's
period is set; the other classes are reported, never deleted. It runs under its own role through
the immutability triggers' retention path (ADR-0002). The funding (`funded110`) and the settlement
dates are recorded by back office. Not built yet: the per-class deletions, legal holds, the
evidence-only phase and stage two's erasure; the admin dashboard's warning about missing
settlement dates needs project closure.

**Stage one per class (Slice 7, PR 7-7b; readings Q235).** The job deletes a participation's
`personnel_file` and `health_record` each at its own trigger and period, skipping exactly the rows a
legal hold names; the participation record waits for the erasure and is blocked while the funding of
a participation that never entered the TG is `unknown`. The evidence-only phase starts only where an
evidence set exists and nothing outside it is left; then one trigger refuses writes and the API
ordinary reads (data-protection.md, retention per class).

## 7-7b follow-up as built (Q234–Q236)

The non-signer branch for personnel and health data applies only with funding `known_no`; `unknown` blocks it and `known_yes` remains unmapped. The TA-completion and health-after-closure mappings remain open. Evidence-only starts once data outside the evidence set has gone, even if evidence itself is held. Ordinary work lists and dashboard counts exclude evidence-only participations. All periods remain unset and activation off; hold administration includes an operational single-document hold workflow before activation (data-protection.md, retained dependencies and retention follow-up).
