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
  signing deadline is built into the lifecycle), `rejected`, beE exit, end of year of exit,
  project settlement dates.
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
- The values are in `docs/domain/data-protection.md` and must be confirmed by the DPO and tax
  advisor before the pilot.

## Consequences
+ Data minimisation and audit duties are both met, and periods change by configuration.
- Every table and document type needs a retention class from the start. That's a review item
  in every PR that adds personal data.
- The settlement dates become operationally important: the admin dashboard warns about projects
  that ended more than 12 months ago without them.
