# Data protection: overview

## Roles under the GDPR *(assumed, Q14)*

- The **TG is an independent controller**, also in phase 1. It is neither a processor for the
  customer nor a joint controller.
- The **customer** is a separate controller for its own HR data and for transferring the import
  file to us.
- Consequences:
  - The customer contract needs a **data-sharing clause** (what is transferred, for which
    purpose), not an AVV.
  - The customer cannot order deletion. Deletion follows our retention rules only. There is no
    "customer deletion request" feature.
  - We need an **AVV with every processor**: the cluster operator chain (owned by the product owner, Q32; blocking for the
    pilot), SMS/mail providers, Gotenberg/storage if run by a third party.

## Other rules

1. **Purpose limitation per phase.** The UI explains each purpose to the participant.
2. **Audit log** for every read of special-category and highly confidential data, every
   document opening, every export, every break-glass, every guard override, and every confirmed
   plausibility warning.
3. **Hosting**: local for development on synthetic data only. Production and the pilot run on
   the company Hetzner cluster in German locations only (ADR-0005). Real data never goes on
   laptops, into cloud coding sessions or into the repo.
4. **No AI in the MVP.** Later, only EU-hosted providers with an AVV and no training on our
   data. US providers are never used for personal data, even with a contract *(assumed, Q38)*.
   Check the EU AI Act classification before any assessment feature.
5. **No real data in development, tests, cloud coding sessions or screenshots.** Synthetic data
   only (`pnpm db:seed`, `fixtures/`).
6. **Logs, error reports and job payloads contain no personal data.** Use IDs only.
7. **Uploads**: virus scan (adapter), file-type allowlist, size limit, encrypted before storage,
   stored outside the web root, signed short-lived URLs (documents, "Document files" above).
8. **Participant rights**: export of own data and deletion requests (admin workflow in the MVP),
   subject to the retention duties above.
9. **Exports**: no Steuer-ID, SV-Nummer or IBAN in the payroll export unless back office
   explicitly requests it. That request is logged.
10. **DPIA (DSFA)** must be completed before any real data is used (Q25).

DSV offer metadata (`dsv_offer`) is internal case data, class `participation_record`, scoped by
`project_id` and participation. The PL and back office read and record it through the DSV
endpoints; external offers store printed TG dates and wording identity `external_unknown`, with
no scan required at offer time. The generated paper remains a logged, encrypted working copy.
