# Regional variation (Agentur-specific requirements)

> Status: updated 2026-10-15 from the decisions log; the configuration model on 2026-10-16
> (Slice 1, PRs 1f-1 and 1f-2). Items marked *(provisional, Qnn)* rest on
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
| Reminder rules, deadlines, help texts | none for reminders: one policy everywhere (Q152, Q155) | |

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
  ├─ rules            { <Step>: CompletenessRule[] }   basis (Q75), projectTypes (Q89)
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
  └─ projectAgenturKey (the KuG-Agentur for ta_tg, Q90), the snapshotted template versions per
     Agentur and the override (Slice 2)
Participation
  └─ placementAgenturKey   (set by the PL or back office, Q139; see "Placement Agentur" below)
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
  Keys are `custom.` plus lower snake_case starting with a letter, at most 63 characters after
  the prefix. A field needs `type`, `enum` or `const`; a free string (no `enum`, `const` or
  `format`) needs `maxLength`; string keywords only with `type: "string"`, `minimum`/`maximum`
  only with numbers; `enum`/`const` values match the type; bounds are ordered. `x-label.de` is
  required. Help-text keys are dotted lower snake_case (`<scope>.<key>`), texts at most 2000
  characters (`packages/config/src/field-schema.ts`, `model.ts`). Everything else is rejected
  before compiling.
- `parseLayer` validates one layer: its shape, the profile, and its rules against the field
  catalog plus the custom fields it declares or inherits.
- **The resolver** (`packages/config/src/resolve.ts`) merges the layers:
  `resolveForParticipation` (participant steps from the placement Agentur, project steps from
  the Project Agentur) and `resolveForProject` (project steps only). Both return the resolved
  config, the **provenance** of every setting, field, rule, relaxation and help text (`base`,
  `template:<id>@<version>`, `override`, `override:agentur:<key>` with source, confirmer and
  date), the **blockers** and a **warning** for each blocker. Settings merge per key (later
  layer wins), rules by id (never redefined), help texts per language and key. Resolved rules
  keep their `basis` and `projectTypes`. An invalid layer is an error.
- **Blockers** (Q76): `project_activation_blocked` without a Project-Agentur template, for both
  project types (Q90); only a pinned template lifts it, never a temporary setting.
  `agentur_submission_blocked` is **step-scoped** and never blocks activation or other work:
  `agentur_submission` needs `submissionChannel`, `originalRequired`, `leadTimeDays` and
  `rejectsOutdatedFormVersions` (Q92: the app never guesses whether an Agentur accepts an older
  form); `asu_registration` blocks only the Kug 200b batch submission, needs the
  `batchSubmissionChannel` in `ta_tg` projects only, and is a configuration warning until Slice 6
  (Q91). The ASU `defaultChannel` never blocks (round 14). Project
  activation additionally needs, for `ta_tg`, an entry wave with a `latestEntryDate` (Q77,
  `projectActivationBlockers` in the domain).
- **Samples**: `packages/config/templates/beispielstadt-nord/1.json`, `2.json` and `3.json`
  (version 3 adds the self-service rule `beispielstadt-nord-private-email` in `profiling` and
  `self_service.*` help texts), `beispielstadt-sued/1.json`: fictional Agenturen with
  `sample: true`, never a real Agentur's rules. `@transfer/config/load` reads a pinned version and checks its path.
- **No regional reminder rules** (Q152, Q155): reminders are manual and follow one domain
  constant, `reminderPolicy` (3 Berlin calendar days between requests, 1–500 per request), in
  every Agentur; data-protection.md, "Reminders". Deadlines are entry-wave data (above).

- The **Step enum** in `packages/domain` is the single vocabulary for steps, used by both the
  lifecycle guards and the config.
- **Two-level resolution** *(provisional, Q15)*:
  - participant steps: base defaults → template of the participant's **placement Agentur** →
    project overrides
  - project steps: base defaults → template of the project's **Project Agentur** (the
    KuG-Agentur for `ta_tg`, Q90) → project overrides
- **Base defaults** are `packages/domain/config/base-defaults.json` (ADR-0004), validated by the
  same JSON Schema as regional templates. It describes the nationwide
  process (fields required by TL 407 and Kug 200b, standard documents). Templates only add or
  change things relative to it.
- **Template versions are pinned** per project *(provisional, Q36)*. When a participation gets a
  placement Agentur the project hasn't pinned, the latest version of that Agentur's template is
  pinned (snapshotted) into the project in the same step (Q139, "Placement Agentur" below). A PL
  can **migrate** a project to a newer version explicitly. This recomputes completeness.
  Generated documents always keep the version they were made with.
- **Field schemas are JSON Schema** (ADR-0004) stored as data and compiled to validators at runtime. Zod
  source code cannot be configuration. Core fields are real columns. Custom fields are `jsonb`,
  validated by the resolved schema.
- **Completeness rules** use a minimal declarative format (ADR-0004): `required`, `requiredIf` (field
  equals / exists), `documentPresent` (+ accepted, and from Slice 6, PR 6-4a, an optional `when` of
  `requiredIf`'s shape: the rule applies only while its condition holds; older layers stay valid).
  No scripting. The engine
  (`packages/domain/src/completeness/`):
  - Absent is `null`, `undefined`, a string blank after trim and `[]`; `false`, `0` and `{}` are
    present. Completeness checks presence; validity is checked on write.
  - `equals` compares strictly, without coercion; `exists` means present.
  - `documentPresent`: a rejected document doesn't count, and `accepted: true` needs an accepted
    one. An unmet rule is `not_accepted` when documents of the type exist, `missing` when none. A
    rule whose `when` doesn't hold gives no item. The state of `asu_proof` comes from the ASU record
    (process-and-lifecycle.md, Arbeitsuchendmeldung): accepted once a registration with proof
    exists, so the attestation and the batch submission satisfy it without a file.
  - Rule ids are unique across all steps (`duplicate_id`). Each failed rule gives one item (step,
    rule id, kind, key), never a value.
- **What may be relaxed** (Q75): every base rule is classified `statutory`, `ba_form` or
  `operational_default`. Statutory and BA-form requirements are **locked**. Regional templates
  only add requirements or change explicitly regional settings. A project override may relax
  only an `operational_default`, with reason, approval and audit. An unclassified rule is
  locked.
- **Missing template** (Q76): base defaults apply for data collection, but operations don't
  silently continue. A missing **Project-Agentur** template blocks project activation (both
  project types, Q90). A missing
  **placement-Agentur** template allows contact, data collection and profiling, but **blocks
  Agentur submission** until channel, original requirement and lead time are confirmed and
  recorded; the PL gets a blocking task and a warning. A real Agentur's rules are never guessed.
- **Base defaults** contain the nationwide rules, the **allowed channel values** and the
  official form requirements, but **no default** for an Agentur's submission channel, batch
  channel, `originalRequired`, `leadTimeDays` or `rejectsOutdatedFormVersions` (round 8).
  The base rules (`packages/domain/config/base-defaults.json`):

  | Step | Rule id | Requires | Basis | Project types |
  |---|---|---|---|---|
  | `asu_registration` | `base-asu-proof` | accepted `asu_proof` document | `statutory` | `ta_tg` |
  | `asu_registration` | `base-kug200b-rv-nummer` | `pensionInsuranceNumber` (`requiredIf`) while `asuChannel` equals `kug_200b` | `ba_form` | `ta_tg` |
  | `asu_registration` | `base-kug200b-signed-scan` | accepted `kug200b_signed_scan` document, `when` `asuChannel` equals `kug_200b` | `ba_form` | `ta_tg` |
  | `data_collection` | `base-import-<field>` for `personnelNumber`, `lastName`, `firstName`, `birthDate`, `oldEmploymentEndDate`, `address` | the field | `operational_default` | all |
  | `profiling` | `base-tl407-<field>` for `gender`, `maritalStatus`, `nationality`, `pensionInsuranceNumber`, `buergergeld`, `healthRestrictions`, `severeDisability`, `educationHistory`, `workHistory`, `languageSkills`, `drivingLicence`, `vehicleAvailable`, `workingTimePreferences`, `jobWishes`, `desiredWorkLocations`, `maxCommuteDistance`, `earliestStartDate` | the field | `ba_form` | all |
  | `dsv` | `base-dsv-signed-scan` | accepted `dsv_signed_scan` document | `statutory` | `ta_tg` |

  Document rules need `accepted: true`. The import rules are not form requirements. The TL 407
  rules (base defaults **version 2**, Q140) are the section B fields marked `*` on the form
  (08/2025, the primary source) that a participant answers; address and identity are the import
  rules. The entry date and the residence status aren't starred (asked when the nationality
  isn't German, never required); the unemployment period (Q85, the profiler records it) and the
  Jobbörse choice (a declaration to the BA, the profiler's) are not base rules. As `ba_form`
  rules they are locked: no project relaxes them, and `relaxableRules` doesn't offer them. Base
  defaults **version 3** (Slice 6, PR 6-4a) add the two Kug 200b rules, applying only on the ASU
  route `kug_200b` (the field `asuChannel`, `case_internal`, listable); a declined offer is never a
  missing item (PR 6-4b).
- **Required import targets** (`isRequired` in `packages/domain/src/import/targets.ts`,
  `apps/api/src/imports/analysis.ts`): Personalnummer, last and first name always (the import
  ignores a relaxation of their rules); date of birth, Austrittsdatum and the address unless the
  resolution for the base-only participant chain plus the project level (the import rules are
  base rules, and a new participation has no placement Agentur) relaxes `base-import-birthDate`,
  `-oldEmploymentEndDate` or `-address`.
  An approved relaxation lifts exactly its target.
- **Project types** (Q89): a rule may name the project types it applies to (`projectTypes`;
  absent = every type). Completeness skips a rule for another type, so it is never a missing
  item or a reminder. The ASU proof and the DSV scan are `ta_tg` only; the Kug 200b rules apply
  only on the `kug_200b` ASU route (base defaults version 3, round 14).
- **Agentur-scoped project settings** are recorded in the project override **scoped to that
  Agentur**, with source, confirmer and confirmation date, and audited: a fallback while the
  Agentur has no template, or a confirmed project-specific exception to its pinned template
  (Q93). Per key: base → pinned template → Agentur-scoped setting, which wins only for the keys
  it supplies. They are never a project-wide value that silently applies to every placement
  Agentur. When a project migrates to another template version, Slice 2 surfaces them for
  review.
- **Overrides apply project-wide** (round 15): Slice 2 validates an override against every
  pinned Agentur template and rejects a relaxation that matches none of them. Agentur-specific
  fields and rules belong in that Agentur's template.
- In the MVP, templates are seed files. A new region therefore needs a deploy until an admin UI
  exists.

## Self-service wizard: pages are code, requirements are configuration (Q140)

- **Pages** (`packages/domain/src/self-service/wizard.ts`) are fixed in code, in the order of
  TL 407 section B (`ba-forms.md`), the special-category page last behind its step-up:
  `personal` (gender, Familienstand), `contact` (address, phone, mobile, private email; names and
  birth date shown read-only), `ba_details` (RV-Nummer, nationality, entry date, residence status,
  Bürgergeld), `education`, `work_history`, `languages_mobility` (languages, driving licence,
  vehicle), `job_wish` (working time, desired job and alternative, locations, distance, earliest
  start), `health` (health restrictions, Schwerbehinderung/Gleichstellung), `further`
  ("Weitere Angaben", only when the chain has custom fields) and `documents` ("Unterlagen",
  Slice 4b). `ba_details` and `health` hold the highly confidential and special-category fields
  and are written on their own encrypted path, never through the page writes. There is no page
  keyword in the template schema.
- **"Unterlagen"** (`documents`) has no fields and no page write: one section per document type
  the participant adds themselves (`wizardDocumentTypes`: `cv`, `participant_upload`,
  `qualification_certificate`; data-protection.md, documents), each document added, opened and
  deleted at once on the documents routes (ADR-0010). Which document a participation needs is
  configuration like any requirement: a template's `documentPresent` rule of the
  `data_collection` or `profiling` step (none in the base defaults). The page is complete when no
  document item of its types is missing; a rejected document is `not_accepted` until a new
  upload replaces it. Other types (signed scans, ASU proof, exception evidence) are staff
  documents of their slices, never on this page. In assisted mode the page shows the types the
  role reads there and is left out without any (back office).
- **Value sets** (`packages/domain/src/self-service/values.ts`) are the form's (TL 407 08/2025):
  e.g. gender `male`/`female`/`diverse`/`not_specified`, Familienstand `single`/`married`,
  language levels `basic`/`extended`/`business_fluent` with German first, the EU driving licence
  classes or `none` (an answer, so the starred field is present), distance in km, `nationwide`
  or `international`. Row tables are bounded (education and work history 20 rows, languages 10;
  the Anlage for rows beyond the form's is Slice 6). Dates are ISO in the API, `TT.MM.JJJJ` in the
  UI; an impossible date is an error, `von > bis` a warning the participant sees. The sensitive
  fields' (`packages/domain/src/self-service/sensitive.ts`): the RV-Nummer's format, nationality
  `german` or `other` with an ISO 3166-1 alpha-2 country, entry date and residence status
  (`blue_card`, `residence_permit`, `visa`, `settlement_permit`, `permission_to_reside`,
  `toleration`) only with another nationality and never required, Bürgergeld, health restrictions
  and Schwerbehinderung/Gleichstellung yes/no.
- **Configuration decides** from the participation's own chain (`resolveForParticipation` with its
  placement Agentur): which fields are **required** (an applicable rule of the `data_collection`
  or `profiling` step names the field; a `requiredIf` while its condition holds), the **custom
  fields** of the final page (the chain's `confidential` custom fields; `internal` ones are staff
  data) and the **help texts**: `self_service.<field>`, the field key keeping its case
  (`self_service.educationHistory`, `self_service.custom.<key>`).
- **Completeness is derived per participation** (codes only): the wizard shows the missing items a
  participant can fix (fields on a page, documents of the types on "Unterlagen"), staff see every
  missing item of the two steps they may read (`selfServiceMissing`). A page is complete when none
  of its required fields (on "Unterlagen": documents) is missing.
- **The UI renders the pages from this definition** (`@transfer/self-service-ui`, both SPAs): a
  required field carries `*`, help texts show under their field, custom fields are entered by
  their field schema's type (text, number, date `TT.MM.JJJJ`, yes/no, a list for `enum`) and
  checked in the browser with the same compiled schema as on the API. A returning participant
  resumes at the first page with missing items; the progress bar counts the pages without a
  missing required field, the sensitive ones by their fields' presence (Q140).

## Template versions: identity, immutability, snapshots (Slice 2)

- **Identity:** a template version is `templates/<agenturKey>/<version>.json`; its content
  identity is the **SHA-256 of its canonical JSON** (keys sorted, no insignificant whitespace),
  so reformatting a file never counts as a change and any change of content does. The hash covers the whole file, `$schema` included.
- **Catalog:** `pnpm generate` writes `packages/config/templates/manifest.json` with every
  version's key, version, labels, `sample` flag and hash; CI fails when it differs from the files.
  Its entries must be strictly ordered by Agentur key, then version, without duplicates; the API
  refuses to start otherwise (`manifest_not_strictly_ordered`, `packages/config/src/manifest.ts`).
  `GET /api/v1/config/templates` serves it to the flat role `project_lead`, the PL members of any project and the global org
  roles (Q108).
- **Immutability:** a merged version never changes and is never deleted.
  `scripts/check-template-immutability.mjs` (in `pnpm lint` and CI) compares every version
  present at the base branch by hash. A change of an Agentur's rules is a **new version**, which
  projects reach only through an explicit migration with review (Q36, Q93).
- **Snapshot (PR 2c-2):** pinning stores the version's content and hash in the database
  (`config_template_version`, one row per key and version; `project_template_pin`, append-only);
  the first pin of a version anywhere registers it, every later pin, in any project, must match
  both the stored content and the hash (`template_version_changed`). Resolution of a pinned
  project reads only the stored content (validated, cached per key, version and hash), so a later
  change of a file can't change a project. Versions and pins are never updated or deleted.
- **Choosing the Project Agentur:** only an Agentur with a template in the catalog; the PL
  pins its latest version (or an older one) and sets it as the Project Agentur in one step, while
  the project is a draft. Further Agenturen are pinned the same way, also once the project is
  active. Another version of an Agentur that is already pinned is a migration with review (PR
  2e-2), never a plain pin (the database refuses it too). `GET /api/v1/projects/{id}/config` shows the pins and, from the
  snapshot, the project's blockers, each pinned Agentur's step-scoped blockers and the activation
  blockers.
- **Placement Agentur (Q139):** the PL or back office of the project sets a
  participation's placement Agentur (`PUT /api/v1/participations/{id}/placement-agentur`) to any
  key in the template key format, from the catalog or not, while the participation isn't
  terminal, in a draft or an active project; a consultant, an org role and assisted mode can't.
  A catalog Agentur the project hasn't pinned is pinned at its **latest** catalog version in the
  same transaction as the key (`set_placement_agentur` calls `pin_agentur_template`, so content
  and hash are checked as for every pin; `config_template_pinned`). An Agentur the project has
  pinned keeps its pinned version (a newer one is a migration). If the override wouldn't validate
  with the new template (cross-chain validation below), nothing is written (`override_invalid`
  with the issues). A key without a template is accepted: that participation resolves base +
  override (+ an Agentur-scoped setting for its key) and its Agentur submission stays blocked
  (Q76); data collection and profiling go on. The same key again is
  `placement_agentur_unchanged`, a terminal participation `participation_closed`. Each change is
  audited as `placement_agentur_set` (new and replaced key, `baseDefaultsVersion`). The
  participation detail shows the key, when it was set and the participant-level blockers of its
  own chain; the PL and back office get the catalog's and the project's Agenturen to choose from,
  or type a free key. There is no postcode mapping: the choice is the staff's. A participant
  address the participant writes after the choice (also in assisted mode;
  `participant_details.participant_address_written_at` newer than `placement_agentur_set_at`)
  shows the hint `placement_agentur_check`, "Vermittlungs-Agentur prüfen", on the detail (derived,
  never stored); nothing changes automatically.
- **Agentur-scoped settings (PR 2d-1):** the PL sets or removes one per Agentur key, also for an
  Agentur without a template (`PUT`/`DELETE /api/v1/projects/{id}/config/agentur-settings/{key}`),
  with its settings, a source (`phone_call_agentur`, `email_agentur`, `letter_agentur`,
  `meeting_agentur`) and the confirmation date (not after today); the confirmer is always the
  acting user. Every change is a new **override version** (optimistic concurrency: a stale
  expected version is a 409) with a `config_override_changed` audit event naming the keys and the
  source, never a value. The project snapshot is its pins plus its current override version,
  so a setting lifts the step-scoped blockers it supplies, for its own Agentur only.
- **Rule relaxations with approval (PR 2d-2; Q75, round 8, round 14):** the PL requests
  the relaxation of one rule with a **controlled reason code** (`source_data_not_provided`,
  `not_needed_for_project_measures`, `collected_outside_platform`,
  `agentur_confirmed_not_required`; Q100), never free text; any code may go with any relaxable
  rule, the code enforces no pairing
  (`POST /api/v1/projects/{id}/config/relaxations`). The request is checked against the current
  snapshot: the rule must exist in some chain, apply there to the project's type and be
  `operational_default` (`relaxation_unmatched`, `relaxation_locked`; round 28); one open request
  per rule. A relaxation names a rule id matching `^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$` (`RuleId`,
  `packages/domain/src/projects/relaxations.ts`, checked in SQL too), so a template rule with
  another id can't be relaxed. It **takes effect
  only once another person approves it**: the regional operations manager, never the requester
  (four eyes in the access check and in SQL). The approval writes, in the same transaction, a new
  override version that adds `{ ruleId, reasonCode, approvedBy, approvedOn }` and is validated
  against every chain again; the regional operations manager may reject instead, and the PL may
  withdraw a pending request. The PL may remove an approved relaxation without approval
  (tightening), as a new override version. Request, approval, rejection, withdrawal and removal
  are audited (rule id and reason code, never free text); request and approval record the
  base-defaults version. The configuration response lists the approved relaxations, the
  open requests and the rules a request may name, with what the viewer may do.
- **Template version migration with review (PR 2e-2; Q36, Q93):** the PL moves a pinned
  Agentur to a **newer** catalog version, in a draft or an active project. A preview
  (`POST /api/v1/projects/{id}/config/pins/{key}/migration-preview`, writes nothing) lists the
  template settings that differ (old and new value), the rules and custom fields added, removed or
  changed, the issues the current override would have with the new version, and the **review**:
  every key of that Agentur's scoped setting with its project value and the old and new template
  value. The confirm (`…/migration`) names **keep or remove for exactly those keys**
  (`review_incomplete` otherwise) and the pinned and override versions the preview was made on
  (a 409 when either moved meanwhile). Under the project lock it re-plans and re-validates, then
  writes in one transaction the new pin (`config_template_pinned` with `previousVersion`) and,
  when keys are removed, a new override version (`config_override_changed`,
  `agentur_setting_reviewed`, with the removed and kept keys; the setting keeps its source and
  confirmation), both with the base-defaults version. A migration that would leave the override
  invalid is refused with its issues. Afterwards that Agentur resolves from the new version; the
  others are unchanged. Completeness is derived, so it follows the new version; generated
  documents don't exist yet.
- **Cross-chain validation (round 15):** every override write and every pin (also the automatic
  pin of a placement Agentur) validates the
  override against the base-only chain and every pinned Agentur chain
  (`validateProjectOverride`): a rule on a custom field only one template declares, an override
  field a template declares too, a relaxation of a locked rule, a relaxation that matches no chain
  or a reason code outside the controlled list is refused (`override_invalid` with the issue
  codes), never stored. A migration validates the override with the new version the same way.
- **How an override changes:** only through Agentur-scoped settings, approved relaxations (and
  their removal) and the removals of a migration review; each write function checks in SQL that
  the new version differs from the current one by exactly that change. Override additions of
  fields, rules and help texts have no API until the admin UI.
- **Base defaults** are release-managed, not pinned (Q107); configuration-dependent audit events
  record their `version` as `baseDefaultsVersion`: `project_activated`, `config_template_pinned`,
  `config_override_changed`, `rule_relaxation_requested`, `rule_relaxation_approved`,
  `import_confirmed`, `participation_created_manually`, `placement_agentur_set`
  (`configurationDependentEventTypes` in
  `packages/domain/src/audit/events.ts`; a test keeps the list exact). A self-service write
  (`participant_data_changed`) isn't one: it validates values with the domain's schemas and custom
  fields with the pinned template's, never with the base defaults, whose rules decide only what
  is missing (derived, never stored).
- **Where the files are at runtime:** the repo paths in dev and tests; the API build copies the
  templates and the base defaults to `apps/api/dist/config/`, and `CONFIG_DIR` points the built
  API there (the image, `pnpm start`, Playwright).

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
