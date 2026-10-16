# Decisions — 2026-10-16, round 13 (Slice 1, PR 1d-2 follow-up)

The product owner's answers to the three readings taken while applying round 12. Q88 and the
field-authority mapping stay **assumed** until the DPO and the PLs confirm them (pre-pilot
gate). Where it differs from round 12, round 13 wins.

## 1. Field correction authority — narrowed (data minimisation)

`append_evidence_correction` covers only fields **retained in the evidence set**. Payroll and
personnel fields don't become part of the evidence set merely so they can be corrected.

| Authority | Fields |
|---|---|
| PL | `firstName`, `lastName`, `birthDate`, `personnelNumber`, `profilingSessions`, `withdrawnOn`, `profilingDoneOn` |
| Back office | `pensionInsuranceNumber`, `baCustomerNumber` |
| Either | `dsvSignedOn`, `tgStart`, `tgEnd`, `tgEntryDate`, `exitDate` |
| No evidence-set correction | `address`, `taxId`, `iban`, `absencePeriods`, statuses and every other non-evidence-set field |

- The address isn't minimum long-term identity evidence.
- Tax ID and IBAN are payroll data, not §110/§111 evidence-set identity.
- Absence periods follow payroll retention and correction processes; they aren't participation
  dates for Q88.
- Their exclusion doesn't make them uncorrectable: while retained for payroll or personnel
  purposes, corrections use the appropriate active/payroll domain operation, not
  `append_evidence_correction`.
- A `profilingSessions` correction identifies the particular session or entry; it never replaces
  the whole collection.
- Date corrections stay append-only evidence corrections; they don't amend a contract,
  lifecycle status, eligibility or payment.

## 2. Active-phase entitlement — confirmed

Normal, assisted-mode and break-glass access all count. In the evidence-set phase:
- access always requires break-glass;
- the role gets the best view it was authorised to obtain in any active-phase mode;
- assignment, project and regional scope still apply;
- an undecided or denied active-phase cell creates no entitlement;
- lists and writes stay prohibited.

## 3. A consultant's own audit actions — confirmed

- Active phase: the assigned consultant sees the permitted own-action projection normally.
- Evidence-set phase: the same events need break-glass.
- Operational-stream lists stay unavailable.
- The regional operations manager's review queue stays normally accessible, so break-glass
  actions can be reviewed.

## Applied in PR 1d-2

`access/corrections.ts` holds the narrowed table; a correction of a collection field without
an `entryId` is refused (`entry_required`).
