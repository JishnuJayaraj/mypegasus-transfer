# Data protection: classification

## Classification *(assumed, Q29, Q43)*

| Class | Data | Handling |
|---|---|---|
| **Special category** | health restrictions, Schwerbehinderung/Gleichstellung, GdB | field-level encryption; never in list payloads; separate endpoint; every read logged |
| **Highly confidential** | RV/SV-Nummer, Steuer-ID, IBAN, BA-Kundennummer; Bürgergeld (yes/no only, concerns the spouse too); nationality, date of entry, residence status (incl. Duldung); profiling results (TL 407 section C ratings, Gesamteinschätzung, weiteres Vorgehen) | field-level encryption; never in list payloads; every read logged |
| **Confidential** | name, address, contact, date of birth, CV, qualifications, job wishes | role × project access |
| **Internal** | project, dates, statuses | role × project access |
| **Aggregated** | counts, rates per project | may go to the customer, with suppression |

- **Signed documents** (TL 407, Kug 200b, DSV) take the class of their most sensitive content
  and are stored encrypted.
- **TG sub-status periods** (sickness, parental leave) are payroll records: type and dates only,
  never diagnoses, never AU scans (Q51).
- **Activation credentials** are confidential. The printable code and in-person destination are
  transient secrets: only separately keyed hashes are stored. Code state, channel and timestamps
  are `case_internal`; hashes are never served. Article 14 delivery evidence (version, language,
  method, staff id and time) is internal and immutable.
- Free text in section C is **never** included in exports.
- **Additions (round 7, assumed, Q66):**
  - Familienstand, gender, Personalnummer, end of the old employment, knowledge date, work
    email, language skills, driving licence: **confidential**.
  - **Address country** (`addressCountry`, Q103/Q105, [round 32](../../decisions/2026-10-19-answers-round-32.md), accepted pilot decision): personal data,
    **confidential**, part of the structured address (street, postal code, city, country), retention
    class `personnel_file`. It is not nationality or citizenship and not a special category (Art. 9
    GDPR). Only `DE` in the MVP; never inferred from the postal code.
  - **DSV amendment metadata** (PR 2h, Q102/Q105, round 32 pilot decision): **confidential**, retention class
    `participation_record`, part of the evidence set, never in ordinary participant lists or
    customer exports; no free text. The signed amendment itself is an `employment_contract`
    document: highly confidential, encrypted when uploaded, immutable, separately access-controlled.
  - **BA reporting tasks** (`baReportingTask`, PR 2h-3): **confidential**, not listable, never in
    customer exports, retention class `participation_record`; read like other confidential case
    data (assigned consultant, PL, back office; `packages/domain/src/fields/catalog.ts`). PR 6-6
    adds the outcome's facts to the same row and class: the not-required reason (a code, never
    free text), who closed the task and when; only the PL or back office closes one. The work
    list shows only that a task is pending and since when (`ba_report_pending`), never its kind
    or date, to whoever reads the tasks.
  - **Entry-wave code and name** are text the PL types: they stay on the wave row and never enter
    audit details; a wave change records only the changed key names (and a changed date's old and
    new value).
  - End reason `long_term_illness_reduced_earning_capacity`: **special category**, never in
    ordinary lists. End reason `deceased`: confidential.
  - Profiling-exception reasons: **structured reason codes** where possible (Q81); a free-text
    reason is **special category**, because it may disclose illness.
  - Override and break-glass free text: **highly confidential**, encrypted, excluded from lists
    and logs, visible only to the actor and the authorised reviewer.
  - UI copy tells staff not to enter diagnoses or unnecessary personal details in free text.
