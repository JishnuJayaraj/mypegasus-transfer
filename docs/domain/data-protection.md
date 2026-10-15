# Data protection (DSGVO / social data) — engineering rules

> This is an engineering guideline, not legal advice. Have it reviewed by the company's data
> protection officer before go-live. Items marked **[DPO]** need confirmation.

## Classification

| Class | Examples | Handling |
|---|---|---|
| Social data / special | health restrictions, disability status, BA data | encrypted at rest (column/field level), access logged, need-to-know roles only |
| Personal | name, contact, CV, certificates | role × project access |
| Aggregated | counts, rates per project | may be shown to customer / works council |

## Rules

1. **Purpose limitation per phase.** Consent and legal basis are recorded per purpose
   (information, profiling, Agentur submission, TG employment). The UI shows the participant
   what each purpose means. **[DPO]** confirm legal bases.
2. **No person-level data to the customer (old employer).** Customer/works-council views are
   aggregated; suppress small groups (e.g. counts < 5 shown as "< 5"). **[DPO]** threshold.
3. **Retention & deletion.**
   - Non-signers (`profiling_declined`, `dsv_declined`, `dsv_expired`, `rejected`): delete or
     anonymise after a configurable period. **[DPO]** period.
   - TG participants: retention according to employment/social-law periods. **[DPO]**
   - Deletion is a scheduled job; anonymised records keep only what reporting needs.
4. **Audit log** for every read of special-category data and every export.
5. **Hosting: locally, then on the company Hetzner cluster in Germany** (ADR-0005). No participant data in US-hosted services, including
   AI providers, unless contractually covered. **[DPO]**
6. **No real data in development, tests, cloud coding sessions or screenshots.** Synthetic
   seed data only (`pnpm db:seed`).
7. **Data processing agreements (AVV)** with the customer and every subprocessor.
8. **Uploads**: virus scan (adapter, mock in MVP), file-type allowlist, size limit, stored
   outside the web root with signed, short-lived URLs.
9. **Participant rights**: export of own data and deletion requests must be possible
   (admin workflow is fine for MVP).
10. **AI (v2)**: suggestions only, human approval, no automated decisions about people;
    check EU AI Act classification before building matching/assessment features.
