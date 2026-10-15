# Open questions

Add questions here instead of guessing. Remove them (and update the relevant doc) once answered.

| # | Question | Owner | Status | Answer / doc updated |
|---|---|---|---|---|
| 1 | What exactly is the "ASU form" in each region — Arbeitsuchendmeldung or something else? Which version/channel? | PLs | open | |
| 2 | Which profiling forms are required per Agentur, and in which format (BA form, own form, upload)? | PLs | open | |
| 3 | Retention periods for non-signers and for TG participants | DPO | open | |
| 4 | Legal basis per processing purpose (consent vs. contract vs. legal obligation) | DPO | open | |
| 5 | Small-group suppression threshold for customer reporting | DPO | open | |
| 6 | Hosting provider in Germany/EU (ADR-0005) | Tech lead | answered | Local first, then company Hetzner cluster — ADR-0005 |
| 12 | Hetzner cluster: Kubernetes or plain VMs/Compose? Managed Postgres, backups, TLS, monitoring available? | Cluster team | open | |
| 7 | Staff identity provider (Microsoft Entra ID? other?) | IT | open | |
| 8 | Payroll system and export format (DATEV?) | Back office | open | |
| 9 | Which languages are needed in the participant portal? | PLs | open | |
| 10 | Are BA forms allowed to be signed electronically anywhere, or always paper? | PLs / legal | open | |
| 11 | Does every participant have an email address or mobile number? (magic-link login) | PLs | open | |
| 13 | The customer signs the DSV and usually pays per-head costs (Remanenzkosten, top-up). Which person-level data may the customer legitimately receive (DSV status, signers, TG start/exit dates for billing)? Rule 6 in CLAUDE.md currently forbids all of it. | DPO / PLs | open | |
| 14 | Controller vs. processor per phase: is the TG a processor for the customer in the TA phase and controller in the TG phase (as employer)? Who "owns" non-signer data? Drives AVV, legal basis and deletion. | DPO | open | |
| 15 | Which Agentur is responsible for a participant — the project's location, the TG/beE's location, or the participant's place of residence (Arbeitsuchendmeldung)? Can one project involve several Agenturen (and therefore several templates)? | PLs | open | |
| 16 | Which BA steps happen per *project* rather than per person (consultation of the parties by the Agentur, Anzeige of the Arbeitsausfall, Transfer-KuG approval, choice of profiling provider)? Should the app track them? | PLs | open | |
| 17 | Is the order data collection → profiling → Agentur submission → DSV offer fixed? Is the DSV ever offered before or in parallel with profiling? Can profiling be completed after TG start in exceptional cases? | PLs | open | |
| 18 | Do participants of one project have individual TG start/end dates (staggered notice periods, different contract lengths), or is there one TG start per project? | PLs | open | |
| 19 | How do participants drop out before the TG (found a job directly, withdraws, leaves the customer, withdraws from a signed DSV before start)? Do direct placements in the TA phase count in placement statistics? | PLs | open | |
| 20 | TA-only projects: what is the end state for a participant, and which §110 measures besides profiling must be tracked? | PLs | open | |
| 21 | DSV execution: in which order do participant, customer and TG sign? Does "signed" in the app mean the participant signed or the contract is fully executed? Where is the paper original archived, and for how long? | Back office / legal | open | |
| 22 | Which periodic or end-of-measure reports must the TG submit to the Agentur during/after the TG phase, in which format? | PLs | open | |
| 23 | Who approves qualification measures and from which budget (customer/social plan, BA co-funding, ESF Plus or Land programmes)? If ESF is used: what reporting and retention obligations come with it? | PLs / back office | open | |
| 24 | Do BA audits, ESF, tax or social-insurance rules require keeping profiling/TG records longer than the planned deletion of non-signers? (Conflict between deletion and retention duties.) | DPO | open | |
| 25 | Is a DPIA (DSFA, Art. 35 DSGVO) required before the first pilot, who owns it, and who maintains the record of processing activities? | DPO | open | |
| 26 | Where will a pilot with real data run? ADR-0005 currently allows "locally (Docker Compose)" for pilots — are company laptops acceptable for social data? | Tech lead / DPO | open | |
| 27 | May magic links be sent to work email addresses (employer-controlled mailboxes)? Is a second factor (e.g. birth date, SMS code) required for participant login to social data? | DPO | open | |
| 28 | Exactly which fields are special category (health, Schwerbehinderung, …) and which roles may see them (is the PL allowed, or only the assigned Berater)? | DPO / PLs | open | |
| 29 | Which identifiers are processed and when: customer Personalnummer, BA-Kundennummer, Sozialversicherungsnummer, Steuer-ID, IBAN? Which are needed in the MVP? | Back office / DPO | open | |
| 30 | What is the matching key for re-imports (Personalnummer?) and may the same person be linked across projects of *different* customers? | DPO / PLs | open | |
| 31 | Self-registration via public link/QR: who may register, what is collected before matching, and how long are unmatched registrations kept? | PLs / DPO | open | |
| 32 | Is the Hetzner cluster operated by the TG's own legal entity or by a group company (AVV needed)? Is S3-compatible object storage available for uploads? Are only German locations used? | Cluster team | open | |
| 33 | Does the TG phase need sub-statuses that affect KuG/payroll (long-term sickness, parental leave, trial work, suspended employment)? | PLs / back office | open | |
| 34 | Which exit reasons/categories do BA, customer and works council reporting require? | PLs | open | |
| 35 | What is a "region" for regional admins — an Agentur, a TG branch office, a Bundesland? | PLs / admin | open | |
| 36 | When a PL upgrades a running project to a new template version, what happens to participants who are already past a step and to documents already generated? | PLs | open | |
| 37 | Are BA forms official fillable PDFs we fill in, or our own layouts? Are we allowed to reproduce them, and how do we learn about new versions? | PLs | open | |
| 38 | AI providers: are non-EU/US-hosted providers acceptable with contractual cover (data-protection.md rule 5) or never (ADR-0005)? | DPO | open | |
| 39 | MVP portal languages: CLAUDE.md says `de` only (`en` later), PRD says German + English in MVP. Which is it? (Related to #9.) | Product owner | open | |
