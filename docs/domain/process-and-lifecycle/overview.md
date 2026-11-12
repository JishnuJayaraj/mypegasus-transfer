# Process & lifecycle: overview

## Big picture

```
Customer (employer) ──► Transferprojekt (type: ta_only | ta_tg)
                          │
       ┌──────────────────┴───────────────────────────┐
  Phase 1: TA / pre-phase                         Phase 2: TG / beE (max. 12 months per person)
  contact → inform → in parallel:                 employment in the beE, Transfer-KuG,
     profiling track (TL 407)                     coaching, qualification, applications, exit
     DSV track (paper DSV, 3 signatures)
     Arbeitsuchendmeldung (Kug 200b)
```

- One **Person** has one **Participation** per project. In the MVP the same person is **not
  linked across projects** (Q30). Duplicate detection runs within a project only.
- A project is **`ta_only`** (§110 measures only, no beE, no DSV track) or **`ta_tg`** (TA phase
  + beE). *(provisional, Q20)*

## Two Agenturen *(provisional, Q15)*

| Role | Belongs to | Determined by | Responsible for |
|---|---|---|---|
| **Project Agentur** (`ta_tg`: the **KuG-Agentur**) | project | set at project setup (`ta_tg`: business location of the TG) | `ta_tg`: Anzeige über Arbeitsausfall, Transfer-KuG, final KuG settlement; `ta_only`: the §110 measure and its funding administration (Q90) |
| **Placement Agentur** | participation | participant's place of residence, chosen by the PL or back office (Q139) | Arbeitsuchendmeldung (Kug 200b), TL 407 submission, placement |

Participant steps resolve configuration from the placement Agentur's template, and project
steps from the Project Agentur's template (see regional-variation.md). Without a Project-Agentur
template a project of either type can't be activated (Q76, Q90).

The placement Agentur *(assumed, Q139)* is a key on the participation, set by the PL or back
office of the project while the participation isn't terminal (also in a draft project), from
the catalog or a free key; it isn't a lifecycle status and needs no transition. Choosing a
catalog Agentur the project hasn't pinned pins its latest template version in the same step;
without a template the participation can still be contacted, collect data and be profiled, but
its Agentur submission stays blocked until the Agentur's settings are known (Q76). There is no
mapping from the postcode: a later address change only shows "Vermittlungs-Agentur prüfen".
Every change is audited (`placement_agentur_set`). Details in regional-variation.md, "Placement
Agentur".

## Project checklist (project-level BA steps) *(provisional, Q16, Q52)*

Not part of the participant lifecycle. Each item has a date, a document and a done-by:

- Consultation of the Betriebsparteien by the Agentur (before the Transfersozialplan)
- Anzeige über Arbeitsausfall to the KuG-Agentur
- `kugFinalSettlementDate` — final Transfer-KuG check by the Agentur (back office)
- `measure110SettlementDate` — settlement of the §110 grant, only if one exists (back office)

The settlement dates drive the evidence-set retention (data-protection.md). The admin dashboard
warns when a project ended more than 12 months ago without them.

## Phase 1 detail

| Step | Who | Output |
|---|---|---|
| Project setup | PL | name, customer, type, Project Agentur (KuG-Agentur for `ta_tg`), pinned Agentur templates, overrides; in `ta_tg` entry waves with their dates; activation |
| Import / manual creation | PL | participations in `imported`; import report with row errors, warnings and possible duplicates (see below) |
| Portal activation | PL/back office → participants | PR 3d issues a personal activation code per participation (letter, printed sheet with recorded handover, or sent in person to a private email/mobile after a photo-ID check), supplies and records the Article 14 notice and revokes open codes when a participation closes; PR 3e lets the participant activate and register a private email/mobile, then moves `imported`/`unreachable` to `contacted` (Q112–Q120) |
| Info events & appointments | PL/Berater book (Slice 5b-1), participants self-book (5b-3), PL/Berater record attendance (5b-2) | bookings and attendance; `informed` confirmed on an attendance (see "Appointments" below); DSV often handed out here (`dsv_offered`) |
| Consents | participant | consent records per purpose (portal contact, Kug 200b profile access) |
| Self-service data collection | participant (or staff in assisted mode) | personal data, CV, documents |
| Arbeitsuchendmeldung | participant / TG | ASU record with channel and proof; Kug 200b signed, collected and submitted in batches per placement Agentur (also offered to people who registered as job-seeking themselves, for the profile-access consent) |
| Profiling | profiler + participant | profiling track, TL 407 (incl. "Anlage" for overflow), signatures |
| Submission to Agentur | assigned PL | TL 407 submission status and channel per participant |
| DSV | PL / back office | DSV track, signatures of all three parties, scan, original location |

### Document review *(assumed, Q146; Slice 4b)*

A stored document is `uploaded` until it is reviewed once: the assigned consultant or the PL, in
normal mode, accepts it or rejects it with `unreadable`, `wrong_document` or `incomplete`. The
review is final (a second one is refused, `document_reviewed`); a wrong or rejected document is
replaced by a new upload, never in place. Completeness rules (`documentPresent`) count the live
documents of a type: an `uploaded` or `accepted` one satisfies a rule, `accepted: true` needs an
accepted one, a rejected one alone gives `not_accepted`, none gives `missing`; a deleted document
counts nothing; a quarantined one counts nothing either. A terminal participation takes no
upload (`participation_closed`); staff deletions stay possible (a wrong-person upload). A signed
TL 407 scan's acceptance records its actual signature dates, the confirmations and the
declarations as marked, and it is deleted only before its review (data-protection.md, signed
scans). Who adds, reviews and deletes is in data-protection.md (document operations).

## Phase 2 detail (TG module)

| Area | Content |
|---|---|
| Participant file | phase 1 data + beE employment data |
| Coaching | appointments, structured notes, goals, agreed tasks |
| Qualification | activities: course, provider, cost, `fundingSource`, `approvalStatus` (customer budget owner approves in writing), certificate (Q23) |
| Applications | applications, interviews, trial work (Probearbeit), offers |
| Sub-status periods | see above; input for payroll/KuG export |
| Exit | reason, date, placement details → statistics |

§110 measures in `ta_only` projects (profiling, application training, career guidance, short
qualification) are activity records with date, duration and attendance (Q20).

## Roles (summary — access rules in data-protection.md)

Admin, Regional admin (region = Niederlassung), Regional operations manager (region-scoped
reviewer and approver without case access, Q80), PL, Berater/Profiler, Back office,
Participant. The customer is **not a user in the MVP**: it receives a monthly export from the
PL (Q47). Access is role × project, plus assignment for profilers. A person can hold **several
project roles** in one project and different roles in different projects; permissions are the
union, and sensitive access still needs the participant assignment *(assumed, Q61)*.
