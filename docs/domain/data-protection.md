# Data protection (DSGVO / social data) — engineering rules

> This is an engineering guideline, not legal advice. Have it reviewed by the company's data
> protection officer before go-live.
>
> Status: updated 2026-10-15 from the decisions log, and 2026-10-16 from round 7 (roles per
> project, break-glass scope, evidence-set phase, write permissions, classification additions)
> and round 8 (regional operations manager, approval of profiling exceptions, deletion clock),
> and updated 2026-10-21 with Slice 3 PR 3d activation issuance and Article 14 notice evidence,
> and the self-service data, purposes notice and consent model of round 38.
> Most answers here are still **`assumed`**
> (rows marked 🔒 in `open-questions.md`). Build on them, but **nothing in this file may be
> `assumed` or `verify` at the pre-pilot gate.** Items marked *(Qnn)* point to the question.

## Topics

- [Data protection: overview](data-protection/overview.md)
- [Data protection: classification](data-protection/classification.md)
- [Data protection: access matrix](data-protection/access-matrix.md)
- [Data protection: messages](data-protection/messages.md)
- [Data protection: documents](data-protection/documents.md)
- [Data protection: corrections](data-protection/corrections.md)
- [Data protection: self-service](data-protection/self-service.md)
- [Data protection: forms and scans](data-protection/forms-and-scans.md)
- [Data protection: exports](data-protection/exports.md)
- [Data protection: consent](data-protection/consent.md)
- [Data protection: retention](data-protection/retention.md)
- [Data protection: authentication](data-protection/authentication.md)

## [Roles under the GDPR *(assumed, Q14)*](data-protection/overview.md#roles-under-the-gdpr-assumed-q14)

## [Classification *(assumed, Q29, Q43)*](data-protection/classification.md#classification-assumed-q29-q43)

## [Access matrix *(assumed, Q28, Q49, Q51)*](data-protection/access-matrix.md#access-matrix-assumed-q28-q49-q51)

- [Reminders and messages about appointments](data-protection/messages.md)

### [Resources, categories and the generated matrix *(assumed, round 11)*](data-protection/access-matrix.md#resources-categories-and-the-generated-matrix-assumed-round-11)

- [Documents: the catalog, operations, file names, files, uploads, the portal and the staff app](data-protection/documents.md)
- [Evidence corrections](data-protection/corrections.md)

### [Write permissions *(assumed until DPO and PL review, Q65)*](data-protection/access-matrix.md#write-permissions-assumed-until-dpo-and-pl-review-q65)

### [Person-data writes and the HR import](data-protection/access-matrix.md#person-data-writes-and-the-hr-import)

### [Self-service data *(assumed, Q112, Q138, Q140, Q141)*](data-protection/self-service.md#self-service-data-assumed-q112-q138-q140-q141)

### [The profiling record *(accepted, Q49, Q85, Q192, Q193; as built in Slice 6, PR 6-2; readings Q198)*](data-protection/forms-and-scans.md#the-profiling-record-accepted-q49-q85-q192-q193-as-built-in-slice-6-pr-6-2-readings-q198)

### [Generated forms and the readiness projection *(accepted, Q49, Q179, Q196–Q198; as built in Slice 6, PR 6-3a; readings Q199)*](data-protection/forms-and-scans.md#generated-forms-and-the-readiness-projection-accepted-q49-q179-q196q198-as-built-in-slice-6-pr-6-3a-readings-q199)

### [Signed scans, signed declarations and quarantine *(accepted, Q49, Q183–Q185, Q191, Q193; as built in Slice 6, PR 6-3b; readings Q200)*](data-protection/forms-and-scans.md#signed-scans-signed-declarations-and-quarantine-accepted-q49-q183q185-q191-q193-as-built-in-slice-6-pr-6-3b-readings-q200)

### [Exports *(accepted, Q159; as built in Slice 6, PRs 6-4b, 6-5a-1 and 6-5a-2)*](data-protection/exports.md#exports-accepted-q159-as-built-in-slice-6-prs-6-4b-6-5a-1-and-6-5a-2)

### [The ASU record *(accepted, Q49, Q184, Q186, Q201; as built in Slice 6, PR 6-4a)*](data-protection/forms-and-scans.md#the-asu-record-accepted-q49-q184-q186-q201-as-built-in-slice-6-pr-6-4a)

### [Exception evidence *(accepted, Q49, Q80, Q81, Q94, Q194; as built in Slice 6, PR 6-7; readings Q208)*](data-protection/forms-and-scans.md#exception-evidence-accepted-q49-q80-q81-q94-q194-as-built-in-slice-6-pr-6-7-readings-q208)

## [Customer reporting *(assumed, Q5, Q13, Q47)*](data-protection/exports.md#customer-reporting-assumed-q5-q13-q47)

## [Legal basis and consent *(assumed, Q4, Q44)*](data-protection/consent.md#legal-basis-and-consent-assumed-q4-q44)

## [Retention and deletion *(verify, Q3, Q24, Q40, Q51, Q52)*](data-protection/retention.md#retention-and-deletion-verify-q3-q24-q40-q51-q52)

## [Authentication *(assumed, Q7, Q11, Q27, Q28)*](data-protection/authentication.md#authentication-assumed-q7-q11-q27-q28)

## [Other rules](data-protection/overview.md#other-rules)

### [DSV scan operations (catalog version 9)](data-protection/forms-and-scans.md#dsv-scan-operations-catalog-version-9)

### [The DSV cancellation and the customer notice (catalog version 10; Slice 7, PR 7-5)](data-protection/forms-and-scans.md#the-dsv-cancellation-and-the-customer-notice-catalog-version-10-slice-7-pr-7-5)

### [The entry clarification (Slice 7, PR 7-4)](data-protection/access-matrix.md#the-entry-clarification-slice-7-pr-7-4)

### [The reconciliation and its review (Slice 7, PR 7-6)](data-protection/access-matrix.md#the-reconciliation-and-its-review-slice-7-pr-7-6)

- [The 7-7b follow-up and the retained dependencies](data-protection/retention.md)

### [Stage-two erasure (Slice 7, PR 7-7c; readings Q237–Q238)](data-protection/retention.md#stage-two-erasure-slice-7-pr-7-7c-readings-q237q238)
