# ADR-0002: PostgreSQL + Drizzle, hybrid relational/jsonb model

- Status: Accepted
- Date: 2026-10-15

## Context
The data model is the core of the product and expensive to change later. Regional variation
needs flexible fields; reporting needs solid relational data.

## Decision
PostgreSQL 16 with Drizzle ORM and SQL migrations. Core entities and fields (person,
participation, status, dates, audit) are real columns. Config-driven fields live in `jsonb`
validated by the resolved Zod/JSON schema. Audit log is an append-only table.

## Consequences
+ Strong consistency, good reporting, one database to operate.
+ Pre-installed in cloud coding sessions (`service postgresql start`).
- jsonb fields need careful indexing if they become filter criteria; promote to columns when
  a field becomes universal.

## Database reference by area

- [Database: function and trigger sources](../architecture/database/function-sources.md)
- [Database: lifecycle](../architecture/database/lifecycle.md)
- [Database: project setup](../architecture/database/project-setup.md)
- [Database: config](../architecture/database/config.md)
- [Database: portal access](../architecture/database/portal-access.md)
- [Database: sensitive data](../architecture/database/sensitive-data.md)
- [Database: assisted mode](../architecture/database/assisted-mode.md)
- [Database: documents](../architecture/database/documents.md)
- [Database: messages](../architecture/database/messages.md)
- [Database: audit](../architecture/database/audit.md)
- [Database: appointments](../architecture/database/appointments.md)
- [Database: profiling](../architecture/database/profiling.md)
- [Database: forms](../architecture/database/forms.md)
- [Database: evidence](../architecture/database/evidence.md)
- [Database: ASU and Kug 200b](../architecture/database/asu-kug200b.md)
- [Database: BA reporting](../architecture/database/ba-reporting.md)
- [Database: corrections](../architecture/database/corrections.md)
- [Database: DSV](../architecture/database/dsv.md)
- [Database: conventions](../architecture/database/conventions.md)
- [Database: TG entry](../architecture/database/tg-entry.md)
- [Database: retention](../architecture/database/retention.md)

## [Function and trigger sources](../architecture/database/function-sources.md#function-and-trigger-sources)

### [Generated lists](../architecture/database/function-sources.md#generated-lists)

## Amendments 2026-10-15

Decided (from the decisions log):
- **Legal and calendar dates are `date` columns** (signing deadline, TG start/end, exit, ASU
  due date, settlement dates). Event times are `timestamptz`.
- **Audit events** record the actor type (`user`, `participant`, `system`), `onBehalfOf`
  (assisted mode), from/to, reason, and are also written for guard overrides, break-glass
  access, document openings and confirmed plausibility warnings.
- **Special-category and highly confidential fields use field-level encryption** and are never
  part of list queries/payloads (data-protection.md).
- **Retention runs per data item/document** via `retentionClass` (ADR-0008). Audit entries of
  deleted subjects are pseudonymised.
- Locally Postgres 16, in production CloudNativePG on the cluster (ADR-0005). Keep the major
  versions aligned.

Accepted in the PR #1 review:
- **Status writes are enforced in the database.** Every change of the main status or a track
  (`status`, `profilingStatus`, `dsvStatus`) and its audit entry are written in **one
  transaction through a single function**. `UPDATE` on status columns is revoked from the app
  role. The audit table is **append-only by grants** (no `UPDATE`/`DELETE` for the app role;
  pseudonymisation runs under a separate role used only by the retention job).

- **Every table holding participant data has a `project_id` column from the start**, so
  row-level security per project can be added without migrating data. RLS itself is **not
  needed for the demo but required at the pre-pilot gate** (ADR-0005).

## [Amendment 2026-10-16: status functions and the lifecycle tables (Slice 1, PR 1g-1)](../architecture/database/lifecycle.md#amendment-2026-10-16-status-functions-and-the-lifecycle-tables-slice-1-pr-1g-1)

## [Amendment 2026-10-16: project setup, memberships and the project lock (Slice 2, PR 2a)](../architecture/database/project-setup.md#amendment-2026-10-16-project-setup-memberships-and-the-project-lock-slice-2-pr-2a)

## [Amendment 2026-10-17: template versions and pins (Slice 2, PR 2c-2)](../architecture/database/config.md#amendment-2026-10-17-template-versions-and-pins-slice-2-pr-2c-2)

## [Amendment 2026-10-17: project override versions (Slice 2, PR 2d-1)](../architecture/database/config.md#amendment-2026-10-17-project-override-versions-slice-2-pr-2d-1)

## [Amendment 2026-10-17: rule relaxation requests (Slice 2, PR 2d-2)](../architecture/database/config.md#amendment-2026-10-17-rule-relaxation-requests-slice-2-pr-2d-2)

## [Amendment 2026-10-17: project activation and the draft gate (Slice 2, PR 2e-1)](../architecture/database/project-setup.md#amendment-2026-10-17-project-activation-and-the-draft-gate-slice-2-pr-2e-1)

## [Amendment 2026-10-17: template version migration (Slice 2, PR 2e-2)](../architecture/database/config.md#amendment-2026-10-17-template-version-migration-slice-2-pr-2e-2)

## [Amendment 2026-10-20: no self-registration in the core (Slice 3, PR 3a)](../architecture/database/portal-access.md#amendment-2026-10-20-no-self-registration-in-the-core-slice-3-pr-3a)

## [Amendment 2026-10-21: activation-code and notice evidence (Slice 3, PR 3d)](../architecture/database/portal-access.md#amendment-2026-10-21-activation-code-and-notice-evidence-slice-3-pr-3d)

## [Amendment 2026-10-21: participant activation and sessions (Slice 3, PR 3e)](../architecture/database/portal-access.md#amendment-2026-10-21-participant-activation-and-sessions-slice-3-pr-3e)

## [Amendment 2026-10-21: portal login, channels and recovery (Slice 3, PR 3f)](../architecture/database/portal-access.md#amendment-2026-10-21-portal-login-channels-and-recovery-slice-3-pr-3f)

## [Amendment 2026-10-21: field encryption with pgcrypto (Slice 4a, PR 4a-4)](../architecture/database/sensitive-data.md#amendment-2026-10-21-field-encryption-with-pgcrypto-slice-4a-pr-4a-4)

## [Amendment 2026-10-22: assisted mode (Slice 4a, PR 4a-5)](../architecture/database/assisted-mode.md#amendment-2026-10-22-assisted-mode-slice-4a-pr-4a-5)

## [Amendment 2026-10-22: documents (Slice 4b, PR 4b-2)](../architecture/database/documents.md#amendment-2026-10-22-documents-slice-4b-pr-4b-2)

## [Amendment 2026-10-22: reminders and consent v2 (Slice 5, PR 5-2)](../architecture/database/messages.md#amendment-2026-10-22-reminders-and-consent-v2-slice-5-pr-5-2)

## [Amendment 2026-10-23: the audit history (Slice 5, PR 5-3)](../architecture/database/audit.md#amendment-2026-10-23-the-audit-history-slice-5-pr-5-3)

## [Amendment 2026-10-23: appointments and staff bookings (Slice 5b, PR 5b-1)](../architecture/database/appointments.md#amendment-2026-10-23-appointments-and-staff-bookings-slice-5b-pr-5b-1)

## [Amendment 2026-10-23: attendance and `informed` (Slice 5b, PR 5b-2)](../architecture/database/appointments.md#amendment-2026-10-23-attendance-and-informed-slice-5b-pr-5b-2)

## [Amendment 2026-10-23: the portal's bookings and messages about appointments (Slice 5b, PR 5b-3)](../architecture/database/appointments.md#amendment-2026-10-23-the-portals-bookings-and-messages-about-appointments-slice-5b-pr-5b-3)

## [Amendment 2026-10-24: missed appointments on the work list (Slice 5b, PR 5b-4)](../architecture/database/appointments.md#amendment-2026-10-24-missed-appointments-on-the-work-list-slice-5b-pr-5b-4)

## [Amendment 2026-10-26: the profiling record (Slice 6, PR 6-2)](../architecture/database/profiling.md#amendment-2026-10-26-the-profiling-record-slice-6-pr-6-2)

## [Amendment 2026-10-26: generated forms (Slice 6, PR 6-3a)](../architecture/database/forms.md#amendment-2026-10-26-generated-forms-slice-6-pr-6-3a)

## [Amendment 2026-10-27: signed scans, quarantine and the TL 407 facts (Slice 6, PR 6-3b)](../architecture/database/evidence.md#amendment-2026-10-27-signed-scans-quarantine-and-the-tl-407-facts-slice-6-pr-6-3b)

## [Amendment 2026-10-28: the ASU record (Slice 6, PR 6-4a)](../architecture/database/asu-kug200b.md#amendment-2026-10-28-the-asu-record-slice-6-pr-6-4a)

## [Amendment 2026-10-28: the Kug 200b and exports (Slice 6, PR 6-4b)](../architecture/database/asu-kug200b.md#amendment-2026-10-28-the-kug-200b-and-exports-slice-6-pr-6-4b)

## [Amendment 2026-10-29: Kug 200b batches (Slice 6, PR 6-5a-1)](../architecture/database/asu-kug200b.md#amendment-2026-10-29-kug-200b-batches-slice-6-pr-6-5a-1)

## [Amendment 2026-10-29: a batch's official artifacts (Slice 6, PR 6-5a-2)](../architecture/database/asu-kug200b.md#amendment-2026-10-29-a-batchs-official-artifacts-slice-6-pr-6-5a-2)

## [Amendment 2026-11-04: the TL 407's submission and the regional view (Slice 6, PR 6-5b)](../architecture/database/ba-reporting.md#amendment-2026-11-04-the-tl-407s-submission-and-the-regional-view-slice-6-pr-6-5b)

## [Amendment 2026-11-05: closing a BA reporting task (Slice 6, PR 6-6)](../architecture/database/ba-reporting.md#amendment-2026-11-05-closing-a-ba-reporting-task-slice-6-pr-6-6)

## [Amendment 2026-11-05: profiling exception evidence (Slice 6, PR 6-7)](../architecture/database/profiling.md#amendment-2026-11-05-profiling-exception-evidence-slice-6-pr-6-7)

## [Amendment 2026-11-05: evidence corrections (Slice 6, PR 6-8)](../architecture/database/corrections.md#amendment-2026-11-05-evidence-corrections-slice-6-pr-6-8)

## [Amendment 2026-11-06: the DSV's generation (Slice 7, PR 7-1)](../architecture/database/dsv.md#amendment-2026-11-06-the-dsvs-generation-slice-7-pr-7-1)

## [Conventions as built (Slices 0–2)](../architecture/database/conventions.md#conventions-as-built-slices-02)

#### [DSV scan evidence (7-2b)](../architecture/database/dsv.md#dsv-scan-evidence-7-2b)

#### [DSV packet and original (7-3)](../architecture/database/dsv.md#dsv-packet-and-original-7-3)

#### [The entry clarification and the bulk generation (7-4)](../architecture/database/dsv.md#the-entry-clarification-and-the-bulk-generation-7-4)

#### [The DSV cancellation, the withdrawal and the customer notice (7-5)](../architecture/database/dsv.md#the-dsv-cancellation-the-withdrawal-and-the-customer-notice-7-5)

#### [The reconciliation and its review (7-6)](../architecture/database/tg-entry.md#the-reconciliation-and-its-review-7-6)

## [Amendment 2026-11-10: date corrections (Slice 7, PR 7-8)](../architecture/database/corrections.md#amendment-2026-11-10-date-corrections-slice-7-pr-7-8)

## [As built 2026-11-11: the retention role and the trigger path (Slice 7, PR 7-7a)](../architecture/database/retention.md#as-built-2026-11-11-the-retention-role-and-the-trigger-path-slice-7-pr-7-7a)

## [7-7c as built: erasure](../architecture/database/retention.md#7-7c-as-built-erasure)
