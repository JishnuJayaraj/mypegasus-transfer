# Glossary (German ↔ English)

Use these terms consistently in code, UI and docs. The **Code term** column is what appears in
identifiers. If you find a term that is not here, add it.

| German | English | Code term | Meaning |
|---|---|---|---|
| Transfergesellschaft (TG) | Transfer company | `tg` | Company that employs affected workers for up to 12 months, organised in one or more beE units, to move them into new jobs. Funded via Transfer-KuG. |
| betriebsorganisatorisch eigenständige Einheit (beE) | beE unit | `beeUnit` (later slice) | The unit in which TG employment is organised. One beE may hold several entry waves; a later wave may instead get its own beE with its own term. Not a synonym for an entry wave (round 10). |
| Transferagentur (TA) | Transfer agency / pre-phase | `ta` | Services before employment ends: information, consultation, profiling, transfer measures under §110 SGB III. Also used for TA-only projects without a TG. |
| Transferprojekt | Transfer project | `project` | One engagement with one employer (customer) for one restructuring. Has its own dates, budget, rules. |
| Auftraggeber / abgebender Arbeitgeber | Customer / old employer | `customer` | The employer who is reducing staff and pays for the transfer. |
| Betriebsrat (BR) | Works council | `worksCouncil` | Employee representatives; negotiate the social plan; receive aggregated reporting. |
| Sozialplan / Transfersozialplan | Social plan | `socialPlan` | Agreement defining the transfer solution, budgets, terms. |
| Projektleiter (PL) | Project lead | `projectLead` | TG staff member responsible for a project. |
| Berater / Coach | Consultant / coach | `consultant` | TG staff doing consultation, profiling, coaching. |
| Teilnehmer (TN) | Participant | `participant` | An affected employee in a project. |
| Agentur für Arbeit (AA) | Local employment agency | `agentur` | Local office of the BA. Requirements vary slightly per Agentur → see regional-variation.md |
| Bundesagentur für Arbeit (BA) | Federal Employment Agency | `ba` | Funds Transfer-KuG and transfer measures. |
| Transferkurzarbeitergeld (Transfer-KuG) | Transfer short-time allowance | `transferKug` | Benefit (§111 SGB III) paid while participants are in the TG, max. 12 months. |
| Transfermaßnahmen | Transfer measures | `transferMeasure` | Funded measures under §110 SGB III (TA phase). |
| Profiling (Maßnahme zur Feststellung der Eingliederungsaussichten) | Profiling | `profiling` | Assessment of qualifications and job prospects. Prerequisite for Transfer-KuG. |
| Arbeitsuchendmeldung (ASU) | Job-seeker registration | `arbeitsuchendmeldung` | Registration of the person as job-seeking with the Agentur. Obligation under §38 SGB III, nationwide. Via the TG it uses form **Kug 200b** — see ba-forms.md. |
| Dreiseitiger Vertrag (DSV) | Tripartite contract | `dsv` | Contract between participant, old employer and TG: ends the old employment and starts employment in the TG. **Wet-ink signature required.** |
| Qualifizierungsplan | Qualification plan | `qualificationPlan` | Planned trainings/courses for a TG participant. |
| Bildungsträger | Training provider | `trainingProvider` | Provider of courses; often must be AZAV-certified for funding. |
| AZAV | Accreditation regulation | `azav` | Certification of providers/measures for BA funding. |
| Probearbeit | Trial work | `trialWork` | Trial employment with a potential new employer during TG. |
| Vermittlung / Austritt | Placement / exit | `exit` | Participant leaves the TG (new job, self-employment, end of term, other). |
| Vermittlungsquote | Placement rate | `placementRate` | Share of participants placed into employment. |
| Abrechnungsliste / KuG-Abrechnung | KuG billing list | `kugBilling` | Monthly billing to the Agentur for Transfer-KuG. |
| Fehlzeiten | Absences | `absence` | Sickness, holidays etc. — relevant for KuG and payroll. |
| Sozialdaten | Social data | — | Personal data processed in a social-law context; specially protected (§35 SGB I, §§67 ff. SGB X). |
| Einwilligung | Consent | `consent` | Participant's consent for specific processing purposes. |
| Profilingbogen TL 407 | Profiling form | `tl407` | Nationwide BA form "Arbeitspaket / Profilingbogen" (§110/§111 SGB III), AcroForm, signed by participant and profiler. See ba-forms.md. |
| Kug 200b | Written job-seeker registration via TG | `kug200b` | Nationwide BA form for the Arbeitsuchendmeldung through the TG, incl. consent to TG access to the applicant profile. See ba-forms.md. |
| Profiler | Profiler | `profiler` | Staff member who carries out profiling and signs TL 407 (usually a Berater). |
| Anzeige über Arbeitsausfall | Notification of work loss | `arbeitsausfallAnzeige` | Project-level notification to the KuG-Agentur, prerequisite for Transfer-KuG. |
| Remanenzkosten | Residual costs | `remanenzkosten` | Costs of the TG not covered by Transfer-KuG (e.g. social insurance, holiday pay), paid by the customer per head. |
| Ausscheiden vor Eintritt in die beE | Withdrawal (pre-TG) | `withdrawn` | Terminal state for people who leave before the TG, with a reason (`declined_dsv`, `no_response`, `placed_direct`, …). |
| Nachweisbestand | Evidence set | `evidenceSet` | Minimal records kept for funding audits after full deletion (ADR-0008). |
| Projekt-Agentur | Project Agentur | `projectAgentur` | The project-level Agentur; project steps resolve against its template, and a project can't be activated without one (Q90). In a `ta_tg` project it is the KuG-Agentur; in a `ta_only` project the Agentur responsible for the §110 measure and its funding administration. |
| KuG-Agentur | KuG Agentur | `kugAgentur` | The Project Agentur of a `ta_tg` project: responsible for the Anzeige and Transfer-KuG. Use this label only for `ta_tg`. |
| Vermittlungs-Agentur | Placement Agentur | `placementAgentur` | Agentur responsible for a participant (by residence): ASU, profiling (TL 407), placement; participant steps resolve against its template. |
| Schlussabrechnung | Final settlement | `kugFinalSettlementDate`, `measure110SettlementDate` | Agentur's final check of Transfer-KuG / the §110 grant; starts the evidence-set clock. |
| Grad der Behinderung (GdB) | Degree of disability | `gdb` | Special-category data; back office may see it for payroll. |
| eAU | Electronic sick note | — | Employer retrieves sick notes electronically; we store only "AU confirmed" + dates. |
| Niederlassung | Branch / region | `region` | Organisational unit grouping projects and staff; scope of regional admins. |
| Integrationsquote | Integration rate | `integrationRate` | Placements ÷ all exits (which reasons count is configurable). |
| Unterschriftsfrist | Signing deadline / offer deadline | `signingDeadline`, `offerDeadline` | Deadline to return the signed DSV: per project for the first offer, per participation for a re-offer (Q69). Inclusive; expiry the next day. |
| Letzter Eintrittstermin | Latest entry date | `latestEntryDate` | Last possible entry into the beE, per entry wave, inclusive. The final admission cutoff starts the next Berlin day; it replaces the former 90-day grace period (Q69, Q77). |
| Eintrittswelle | Entry wave | `entryWave` | A timing cohort within one `ta_tg` project: participants expected to enter the TG at roughly the same time under the same contractual schedule, with its own signing deadline, default TG start/end and `latestEntryDate` (Q79). Each participation belongs to exactly one wave before its DSV is offered; the individual DSV dates stay authoritative. Neither a beE nor a Transfer-KuG bucket (round 10). |
| Maßnahmegruppe | Measure group | `measureGroup` (later slice) | A cohort of a `ta_only` project with its own activity period. `ta_only` projects have no entry waves (round 10). |
| Transfer-KuG-Fall | Transfer-KuG case | `transferKugCase` (later slice) | The administrative benefit and monthly reimbursement process with the BA: the TG advances the payments and claims them back monthly. Separate from waves (round 10). |
| Regionale Betriebsleitung | Regional operations manager | `regional_operations_manager` | Region-scoped org role without case access: approves profiling exceptions, reviews reconciliations and break-glass from audit metadata (Q80). |
| Anspruch auf Transfer-KuG | Transfer-KuG eligibility | `transferKugEligibility` | Outcome per period: `eligible`, `excluded` or `ba_review_required`. Separate from employment in the beE; under the profiling exception eligibility starts no earlier than the day after profiling is completed (Q74, Q82, verify). |
| Profiling-Ausnahme | Profiling exception | `profilingException` | Justified case where profiling is completed within 1 month after TG entry (Q17, Q74). Requested by the PL with a reason code and evidence (Q81), approved by a different user (regional operations manager, Q80) before it counts. Each request is its own record; a pending one is superseded automatically when it no longer applies (round 10). |
| Notfallzugriff | Break-glass access | `breakGlass` | Exceptional access with a mandatory reason: one participant, one category, one action; reviewed afterwards (Q63). |
