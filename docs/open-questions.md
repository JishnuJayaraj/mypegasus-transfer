# Open questions

Add questions here instead of guessing. Remove them (and update the relevant doc) once answered.

**Status values**
- `answered`: confirmed by the owner.
- `assumed`: a working answer given on 2026-10-15 that the owner has **not yet confirmed**. We
  build on it, but it must not be written into rules (CLAUDE.md, data-protection.md) as fact
  until confirmed.
- `verify`: the answer contains a factual point that should be checked (see the note).
- `open`: no answer yet.

Full answers from 2026-10-15 are in [`decisions/2026-10-15-answers.md`](decisions/2026-10-15-answers.md).

| # | Question | Owner | Status | Answer / doc updated |
|---|---|---|---|---|
| 1 | What exactly is the "ASU form"? Which version/channel? | PLs | verify | Arbeitsuchendmeldung §38 SGB III, nationwide. The TG route uses form **Kug 200b (09/2021)**, see `domain/ba-forms.md`. Verify the deadline wording (see answers doc). |
| 2 | Which profiling forms are required per Agentur, and in which format? | PLs | answered | **TL 407 (08/2025)**, nationwide AcroForm. Agenturen differ only in channel, originals, lead time. `domain/ba-forms.md` |
| 3 | Retention periods for non-signers and for TG participants | DPO | assumed / verify | Table in answers doc. Conflicts with #40 and should be checked against current AO/HGB/EStG/SGB IV periods. |
| 4 | Legal basis per processing purpose | DPO | assumed | Table in answers doc |
| 5 | Small-group suppression threshold for customer reporting | DPO | assumed | n < 5, with secondary suppression |
| 6 | Hosting provider in Germany/EU (ADR-0005) | Tech lead | answered | Local first, then the company Hetzner cluster. Real data only on the cluster. |
| 7 | Staff identity provider | IT | assumed | Entra ID via OIDC, MFA via Conditional Access, roles managed in the app |
| 8 | Payroll system and export format | Back office | assumed | DATEV LODAS. MVP: versioned CSV export |
| 9 | Which languages are needed in the participant portal? | PLs | assumed | MVP de + en. v1.1: tr, ar (RTL), pl, ru, uk, ro |
| 10 | Can BA forms be signed electronically anywhere, or always paper? | PLs / legal | answered | Always paper. Both forms say "bitte händisch ausfüllen". |
| 11 | Does every participant have an email address or mobile number? | PLs | assumed | About 90 % mobile, 70 % private email. Mobile is primary, work email is never used for login. |
| 12 | Hetzner cluster setup | Cluster team | assumed | k3s, German locations, CloudNativePG, Object Storage, cert-manager, Prometheus/Grafana/Loki, SOPS |
| 13 | Person-level data for the customer | DPO / PLs | assumed | Whitelist: name, Personalnummer, DSV signed + date, beE entry/exit date |
| 14 | Controller vs. processor per phase (TA: processor for the customer? TG: controller?). Who owns non-signer data? | DPO | open | Not answered yet. This decides the AVV and who may order the deletion of non-signer data. |
| 15 | Which Agentur is responsible? | PLs | assumed / verify | Two: KuG-Agentur per project, placement Agentur per participant (residence). Verify which location decides the KuG-Agentur. |
| 16 | Project-level BA steps | PLs | assumed | Consultation of the Betriebsparteien + Anzeige über Arbeitsausfall, as a project checklist |
| 17 | Process order; profiling after TG start? | PLs | answered | Profiling is a legal prerequisite. Exception flag + reason + deadline of entry + 1 month. |
| 18 | Individual TG dates? | PLs | assumed | Project default + per-participant override (start **and** end — TL 407 needs both) |
| 19 | Dropouts before the TG | PLs | assumed | `withdrawn` + reason from every pre-TG state. `placed_direct` counts as placement. |
| 20 | TA-only projects | PLs | assumed | Project type `ta_only`, end state `ta_completed`, §110 measures as activities |
| 21 | DSV execution and originals | Back office / legal | assumed | Complete only when all three parties have signed. Originals tracked per document. |
| 22 | Periodic reports to the Agentur | PLs | verify | Half-yearly report (30.06 / 31.12) is a working assumption |
| 23 | Qualification approval and funding; ESF | PLs / back office | assumed | PL proposes, customer budget owner approves. No ESF in MVP; `fundingSource` flag. |
| 24 | Do BA audits/ESF/tax/social-insurance rules require keeping data longer than the non-signer deletion? | DPO | open | Partly covered by #3, but not for non-signers who received §110 measures (see #40) |
| 25 | DPIA before the pilot? | DPO | answered | Yes. Required before any real data. |
| 26 | Pilot location | Tech lead / DPO | answered | Nürnberg, one project, on the Hetzner cluster, after the pre-pilot gate |
| 27 | Participant login factors | DPO | assumed | Magic link / SMS code + birth date as a knowledge check before special-category data |
| 28 | Which fields are special category, and which roles may see them? **Is the PL allowed?** | DPO / PLs | open | Fields: answered by #29. Roles: Profiler only for assigned participants. The PL and regional admin are still not covered. |
| 29 | Identifiers and data classes | Back office / DPO | assumed | Classification table in the answers doc. Missing: Bürgergeld, nationality, Einreisedatum (see #43) |
| 30 | Person across projects | DPO / PLs | answered | No linking in the MVP. Duplicates within a project only. |
| 31 | Public self-registration | PLs / DPO | assumed | Project QR code, 14 days, rate limit + captcha, manual matching, delete after 30 days |
| 32 | Is the Hetzner cluster run by the TG's own legal entity or a group company (AVV)? | Cluster team | open | Object storage and German locations are answered by #12. The legal entity/AVV is not. |
| 33 | TG sub-statuses | PLs / back office | assumed | Dated periods: active, sick_paid, sick_krankengeld, parental_leave, qualification, temp_employment_elsewhere |
| 34 | Which exit reasons do BA, customer and works council reporting need? | PLs | open | Not answered yet (#19 covers only pre-TG withdrawals) |
| 35 | What is a "region"? | PLs / admin | assumed | An organisational unit (Niederlassung), not an Agentur district |
| 36 | Template upgrades for running projects | PLs | assumed | Pinned. Explicit migration by the PL recomputes completeness. Documents keep their version. |
| 37 | BA form templates | PLs | answered | AcroForm fill (pdf-lib) for BA forms. Gotenberg HTML→PDF for our own documents. |
| 38 | AI providers | DPO | assumed | No AI in the MVP. Later EU-hosted with AVV only. Never US providers for personal data. |
| 39 | MVP UI languages | Product owner | answered | Staff UI de (via i18n), portal de + en |
| 40 | Health data is "deleted at exit" (#3), but TL 407 and Kug 200b contain health and Schwerbehinderung answers, and profiling is kept 3 years. Do we redact the stored forms, or keep them under the profiling retention? Same question for non-signers who received §110 measures billed to the BA: may they be deleted after 90 days? | DPO | open | |
| 41 | TL 407 has fixed rows (4 profiling sessions, 5 education, 7 jobs, 4 languages). What do PLs do today when there are more: an attachment page, "siehe Anlage", or only the most recent entries? | PLs | open | |
| 42 | Where do official blank form templates live: in the repo (versioned with code) or uploaded by an admin as data (versioned per ADR-0004)? Who notices when the BA publishes a new version? | Tech lead / PLs | open | |
| 43 | TL 407 asks for Bürgergeld (incl. spouse/partner), Einreisedatum and Aufenthaltsstatus (incl. Duldung). Are these "highly confidential" and field-encrypted? May they be collected in self-service, or only in the profiling interview? | DPO | open | |
| 44 | The Jobbörse publication choice (TL 407 q. 50) and the BA contact-data consent (both forms) are BA consents, separate from our own consents. Should the app record them as consent records too, or just as form answers? | DPO | open | |
| 45 | Kug 200b is only for §111 (TG). Is it always collected through the TG in TG projects, or only when the Agentur doesn't do the batch registration at the info event? Does the "batch list" channel mean submitting stacks of Kug 200b, a Teilnehmerliste, or both? | PLs | open | |
| 46 | Withdrawal after `dsv_signed` but before TG start: the DSV has already ended the old employment. Does a withdrawal need a cancellation agreement signed by all three parties, and does the app have to track that document? | Legal / PLs | open | |
| 47 | Is the customer a *user* in the MVP (#34 lists "Customer, read-only") or only the recipient of an export (#13, PRD says portal = v1.1)? | Product owner | open | |
| 48 | The test copies of both forms contain a name and birth date ("Lukas Brenner", "Fußball Bund"). Please confirm they are synthetic. | Product owner | open | |
