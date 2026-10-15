# Regional variation (Agentur-specific requirements)

> Status: updated 2026-10-15 from the decisions log. Items marked *(provisional, Qnn)* rest on
> answers that are not yet confirmed.

BA requirements are mostly the same everywhere. Each Agentur für Arbeit has small differences,
mainly in **how** things are submitted, not **what** is collected. The product must absorb
these differences **without code changes**.

## What is nationwide (code / form registry, not regional config)

| Item | Where it lives |
|---|---|
| Lifecycle states, transitions, guards | `packages/domain` |
| Legal rules: profiling as Transfer-KuG prerequisite, ASU due date (§38 SGB III), DSV written form (§623 BGB) | `packages/domain` |
| Official BA forms: **TL 407** (profiling), **Kug 200b** (Arbeitsuchendmeldung via TG) | form registry `packages/forms/templates/ba/<form_code>/<version>/` (see ba-forms.md, ADR-0009) |
| Choice of the §110/§111 checkbox on TL 407 | project type (`ta_only` → §110, `ta_tg` → §111) |
| Audit, permissions, data classification | code |
| Completeness engine (how rules are evaluated) | `packages/domain` |

Do **not** build a generic workflow engine. Only the edges are configurable.

## What is configurable per Agentur (regional template)

| Setting | Example | Source |
|---|---|---|
| ASU default channel | `online_self`, `batch_list`, `in_person` | Q1 |
| Kug 200b batch submission channel | paper originals by courier/post, scan by email, upload | Q45 |
| TL 407 submission channel | email, upload, paper original | Q2 |
| `originalRequired` | does the Agentur need the paper original? | Q2 |
| `leadTimeDays` | how many days before TG start the submission must arrive | Q2 |
| `rejectsOutdatedFormVersions` | does the Agentur reject old form versions? | Q2 |
| Additional required fields/documents per step | rare; e.g. an extra certificate | |
| Reminder rules, deadlines, help texts | | |

Per **project** (not per Agentur): signing deadline, default TG start/end, project overrides.

## Configuration model

```
RegionalTemplate (e.g. "Agentur Nürnberg", version 3)
  ├─ agenturId
  ├─ steps (keys = Step enum from packages/domain):
  │    asu_registration:   defaultChannel, batchSubmissionChannel
  │    data_collection:    requiredFields[], requiredDocuments[], fieldSchemas (JSON Schema)
  │    profiling:          requiredFields[] (beyond the TL 407 required fields)
  │    agentur_submission: submissionChannel, originalRequired, leadTimeDays,
  │                        rejectsOutdatedFormVersions
  │    dsv:                deadlineRule
  │    project_checklist:  (KuG-Agentur only) items, deadlines
  ├─ reminderRules[]
  └─ helpTexts{}  (per language)

Project
  └─ kugAgenturId
  └─ appliedTemplates: { agenturId → RegionalTemplate@version }  (snapshotted)
  └─ projectOverrides: partial config (audited)

Participation
  └─ placementAgenturId   (from place of residence)
```

- The **Step enum** in `packages/domain` is the single vocabulary for steps, used by both the
  lifecycle guards and the config.
- **Two-level resolution** *(provisional, Q15)*:
  - participant steps: base defaults → template of the participant's **placement Agentur** →
    project overrides
  - project steps: base defaults → template of the project's **KuG-Agentur** → project overrides
- **Base defaults** *(proposed)* are a versioned file in `packages/config` that describes the nationwide
  process (fields required by TL 407 and Kug 200b, standard documents). Templates only add or
  change things relative to it.
- **Template versions are pinned** per project *(provisional, Q36)*. When a participant with a
  new placement Agentur joins, the current version of that Agentur's template is snapshotted
  into the project. A PL can **migrate** a project to a newer version explicitly. This
  recomputes completeness. Generated documents always keep the version they were made with.
- **Field schemas are JSON Schema** (ADR-0004) stored as data and compiled to validators at runtime. Zod
  source code cannot be configuration. Core fields are real columns. Custom fields are `jsonb`,
  validated by the resolved schema.
- **Completeness rules** use a minimal declarative format (ADR-0004): `required`, `requiredIf` (field
  equals / exists), `documentPresent` (+ accepted). No scripting.
- In the MVP, templates are seed files. A new region therefore needs a deploy until an admin UI
  exists.

## Forms are versioned separately from templates

Official forms have their own versions (`TL 407 08/2025`, `Kug 200b 09/2021`) in the form
registry, independent of regional templates. Every generated document records `formCode` and
`formVersion`. When the BA publishes a new version, unsigned forms are regenerated and signed
forms keep their version (Q42). Our own documents (DSV, letters, Teilnehmerliste, Anlage zum
Profilingbogen) are HTML templates rendered by Gotenberg, versioned the same way.

## To collect from Projektleiter (fill this table)

For each Agentur, list what differs from the base process. This table is the input for the
first regional templates.

| Location / Agentur | Setting / step | Value or difference | Source (PL, date) |
|---|---|---|---|
| _e.g. Nürnberg_ | _agentur_submission.submissionChannel_ | _upload_ | _…_ |
| | | | |

Questions to ask each PL:
1. Through which channel do you submit TL 407 and the Kug 200b batch? Paper originals required?
2. Lead time before TG start? Does your Agentur reject outdated form versions?
3. Does the Agentur come to info events for the Arbeitsuchendmeldung?
4. Which extra fields/documents does your Agentur ask for that others don't?
5. What gets rejected most often, and why?
6. Does your Agentur accept an "Anlage zum Profilingbogen" for overflowing tables (Q41)?
