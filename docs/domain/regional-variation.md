# Regional variation (Agentur-specific requirements)

> Status: updated 2026-10-15 from the decisions log; the configuration model on 2026-10-16
> (Slice 1, PR 1f-1). Items marked *(provisional, Qnn)* rest on
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
| ASU default channel | `kug_200b`, `online_self`, `in_person` | Q1, Q55 |
| Kug 200b batch submission channel | paper originals by courier/post, scan by email, upload | Q45 |
| TL 407 submission channel | email, upload, paper original | Q2 |
| `originalRequired` | does the Agentur need the paper original? | Q2 |
| `leadTimeDays` | how many days before TG start the submission must arrive | Q2 |
| `rejectsOutdatedFormVersions` | does the Agentur reject old form versions? | Q2 |
| Additional required fields/documents per step | rare; e.g. an extra certificate | |
| Reminder rules, deadlines, help texts | | |

Per **project** (not per Agentur): signing deadline, `latestEntryDate`, default TG start/end, the
contractual deadline rule (`deadlineRule`, from the Sozialplan/DSV, Q69), project overrides.
Signing deadline, default TG dates and `latestEntryDate` live on the project's **entry waves**
(Q79).
Deadlines are contractual, never regional BA rules.

## Configuration model

Base defaults, regional templates and project overrides are **layers of one schema**, authored
in Zod (`packages/config/src/model.ts`) and exported by `pnpm generate` to the committed JSON
Schema `packages/config/schema/regional-template.schema.json` (2020-12, drift-checked in CI).
Every object is closed: an unknown key is an error.

```
ConfigLayer (schemaVersion 1), one of:

BaseDefaults        kind "base_defaults", version          packages/domain/config/base-defaults.json
  ├─ nationwide       asuDueDate { monthsBeforeEnd, daysAfterKnowledge }, profilingExceptionDeadlineMonths,
  │                   kug200bConfirmationFollowUpDays, tl407EscalationDaysAfterTgStart,
  │                   cutoffWarningDays, cutoffFinalReminderDays       (all required, nowhere else)
  ├─ rules            { <Step>: CompletenessRule[] }   each with its basis (Q75)
  └─ helpTexts        { de, en: { "<scope>.<key>": text } }
                      no `settings` (no regional default, round 8), no custom fields

RegionalTemplate    kind "regional_template", id = agenturKey, version, label { de, en? }, sample?
  ├─ settings         asu_registration:   defaultChannel, batchSubmissionChannel
  │                   agentur_submission: submissionChannel, originalRequired, leadTimeDays,
  │                                       rejectsOutdatedFormVersions
  ├─ fields           { "custom.<key>": field schema (profile below) }
  ├─ rules            additions only
  └─ helpTexts

ProjectOverride     kind "project_override"
  ├─ agenturSettings  { <agenturKey>: { settings, source, confirmedBy, confirmedOn } }
  ├─ fields, rules    additions
  ├─ relax            [ { ruleId, reasonCode, approvedBy, approvedOn } ]  operational_default only
  └─ helpTexts        no project-wide `settings`, no `nationwide`

Project
  └─ kugAgenturKey, the snapshotted template versions per Agentur and the override (Slice 2)
Participation
  └─ placementAgenturKey   (from place of residence)
```

- **Channel values** are enums in the schema: ASU `kug_200b` / `online_self` / `in_person`;
  Kug 200b batch `paper_courier` / `paper_post` / `scan_email` / `upload`; TL 407 `email` /
  `upload` / `paper_original`.
- **Custom fields** use a restricted JSON Schema profile, compiled with `z.fromJSONSchema` (spike
  S1, ADR-0004): `type` (`string`, `integer`, `number`, `boolean`), `enum`, `const`,
  `format: "date"`, `minLength`/`maxLength` (≤ 2000), `pattern` (≤ 200 characters, no `u`-flag
  syntax), `minimum`/`maximum`, `title`, `description`, plus the required `x-dataClass` (only
  `confidential` or `internal`: special-category and highly confidential data needs encrypted
  columns, never `jsonb`), `x-retentionClass` (a participant retention class) and `x-label`.
  Keys start with `custom.`. Everything else is rejected before compiling.
- `parseLayer` validates one layer: its shape, the profile, and its rules against the field
  catalog plus the custom fields it declares or inherits. Merging the layers, provenance and
  blockers are the resolver's (Slice 1, PR 1f-2).
- Reminder rules are left to Slice 5; deadlines are entry-wave data (above).

- The **Step enum** in `packages/domain` is the single vocabulary for steps, used by both the
  lifecycle guards and the config.
- **Two-level resolution** *(provisional, Q15)*:
  - participant steps: base defaults → template of the participant's **placement Agentur** →
    project overrides
  - project steps: base defaults → template of the project's **KuG-Agentur** → project overrides
- **Base defaults** are `packages/domain/config/base-defaults.json` (ADR-0004), validated by the
  same JSON Schema as regional templates. It describes the nationwide
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
- **What may be relaxed** (Q75): every base rule is classified `statutory`, `ba_form` or
  `operational_default`. Statutory and BA-form requirements are **locked**. Regional templates
  only add requirements or change explicitly regional settings. A project override may relax
  only an `operational_default`, with reason, approval and audit. An unclassified rule is
  locked.
- **Missing template** (Q76): base defaults apply for data collection, but operations don't
  silently continue. A missing **KuG-Agentur** template blocks project activation. A missing
  **placement-Agentur** template allows contact, data collection and profiling, but **blocks
  Agentur submission** until channel, original requirement and lead time are confirmed and
  recorded; the PL gets a blocking task and a warning. A real Agentur's rules are never guessed.
- **Base defaults** contain the nationwide rules, the **allowed channel values** and the
  official form requirements, but **no default** for an Agentur's submission channel, batch
  channel, `originalRequired`, `leadTimeDays` or `rejectsOutdatedFormVersions` (round 8).
  The base rules and their bases are listed in the Slice 1 plan (5.7). They carry no
  project-type condition yet, so they apply in `ta_only` projects too (Q89, open).
- **Temporary Agentur settings** (no template yet) are recorded in the project override **scoped
  to that Agentur**, with source, confirmer and confirmation date, and audited. They are never a
  project-wide value that silently applies to every placement Agentur.
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
