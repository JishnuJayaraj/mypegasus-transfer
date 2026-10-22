# Slice 4a — Self-service wizard and consent (F5)

Status: approved; **done**: PRs 4a-1 to 4a-4 merged, PR 4a-5 implemented 2026-10-22; archived.
History, not the source of the rules: those live in ADR-0002/0004/0005/0007,
`docs/domain/data-protection.md`, `regional-variation.md` and `process-and-lifecycle.md`.
Decisions come from [round 38](../../decisions/2026-10-21-answers-round-38.md)
(Q133–Q141); the rules they set move to `docs/domain/` and the ADRs in the PRs that build them.
Builds on Slice 3: activated accounts, portal sessions, one-time codes, channels and their
`portal_contact` consents (`apps/api/src/routes/portal.ts`, `portal-session.ts`,
`packages/domain/src/portal/*`, `apps/portal/src/routes/*`).

## Decisions

- **D1. Wizard pages are code; requirements, custom fields and help texts are configuration**
  (ADR-0004, Q140). `packages/domain/src/self-service/wizard.ts` defines the pages in the order of
  TL 407 section B; each page lists catalog fields. The resolved participant chain (base →
  placement Agentur's pinned template → override) decides which fields are required (rules of the
  `data_collection` and `profiling` steps that name a self-service field), adds the custom fields
  on a final page "Weitere Angaben" and supplies help texts (`self_service.<field>`). No page
  keyword in the template schema.
- **D2. TL 407 stars become base rules** (Q140). Base defaults version 2 adds `profiling` rules
  `base-tl407-<field>`, `basis: "ba_form"`, every project type, for the section B fields marked
  `*` that a participant answers: `gender`, `maritalStatus`, `nationality`,
  `pensionInsuranceNumber`, `buergergeld`, `healthRestrictions`, `severeDisability`,
  `educationHistory`, `workHistory`, `languageSkills`, `drivingLicence`, `vehicleAvailable`,
  `workingTimePreferences`, `jobWishes`, `desiredWorkLocations`, `maxCommuteDistance`,
  `earliestStartDate` (address and identity are covered by the import rules). Entry date and
  residence status are not starred: shown when the nationality is not German, never required.
  `unemploymentPeriod` (Q85) and `jobboerseChoice` (a declaration to the BA, profiler) stay out.
- **D3. Value sets are the form's** (TL 407 08/2025): gender `male`/`female`/`diverse`/
  `not_specified`; Familienstand `single`/`married` (the form offers no more); nationality
  `german` or `other` + ISO 3166-1 alpha-2 country; residence status `blue_card`,
  `residence_permit`, `visa`, `settlement_permit`, `permission_to_reside`, `toleration`;
  Bürgergeld, health and disability `yes`/`no`; languages German first, levels `basic`/
  `extended`/`business_fluent`; employment `full_time`/`part_time` + weekly hours; maximum
  distance `km` + number, `nationwide` or `international`; driving licence the EU classes (AM, A1,
  A2, A, B, BE, C1, C1E, C, CE, D1, D1E, D, DE, L, T). Row tables are bounded (education and work
  history 20 rows, languages 10); overflow onto the Anlage is Slice 6. Dates `TT.MM.JJJJ` in the
  UI, ISO in the API; impossible dates are errors, `von > bis` a warning the participant sees.
  Validity is checked on write (domain Zod), completeness checks presence.
- **D4. Save and resume:** every page saves on "Weiter" into the real fields; there is no draft
  store. A page may be left incomplete; the progress bar counts pages without missing required
  fields. Writes carry the profile's `revision` (optimistic concurrency; a stale one is `409
  stale_revision`, e.g. the participant and an assisted session at once). No "submit" state:
  completeness is derived (process-and-lifecycle.md, profiling).
- **D5. Purposes notice before the first page** (Q138): `self-service-purposes:v1` (de/en) explains
  the purposes per phase and the legal bases; its acknowledgement (version, language, actor, time)
  is recorded, not a consent. A new version is shown again before the next page.
- **D6. Consent model generalised** (Q138): `consent_record` gets `source` (`portal`,
  `paper_form`); `channel_id` is required exactly for `portal_contact`. `ConsentPurpose` adds
  `kug200b_profile_access` (written in Slice 6 from paper). The portal page "Einwilligungen"
  lists the participant's own consents (purpose, version, given, ended); revoking
  `portal_contact` stays the channel removal.
- **D7. Contact data** (Q112): the "Kontakt" page edits `address`, `phone`, `mobile` and
  `privateEmail` (never the login channels or the work email; names and birth date shown
  read-only). `participant_details.participant_maintained` holds the field names a participant
  wrote (also assisted); the import never overwrites them and reports `participant_maintained`
  differences by row and target, never a value.
- **D8. Sensitive fields** (Q135, CLAUDE.md rule 9): `pensionInsuranceNumber`, `nationality`,
  `entryToGermanyDate`, `residenceStatus`, `buergergeld` (highly confidential) and
  `healthRestrictions`, `severeDisability` (special category) are stored encrypted, never in list
  payloads, read and written only through their own endpoints; every read is `sensitive_read`,
  every write `sensitive_write` (field keys, never values). Completeness needs only presence,
  which is stored unencrypted as a boolean; no other response carries them.
- **D9. Encryption in the database with `pgcrypto`** (round 38): `pgp_sym_encrypt` with AES-256
  inside the SECURITY DEFINER functions that write and read these fields; the plaintext envelope
  includes the participation id and field key, checked on decrypt, so a ciphertext can't be moved
  to another row. The API derives the key (HKDF, `field-encryption:v1`) from the new
  `FIELD_ENCRYPTION_KEY` (required outside development; a fixed development constant like
  `ACCESS_CODE_SECRET`'s) and passes it as a bind parameter per call, never `set_config`; a `key_id`
  per value allows rotation later. The runtime role has no privilege on the ciphertext columns.
  Pre-pilot gate item (ADR-0005): the cluster's Postgres logs no statements or bind parameters
  (`log_statement` `none`/`ddl`, `log_parameter_max_length*` 0).
- **D10. Step-up before special-category data** (Q129, Q137): once per session. Birth-date accounts
  re-enter the birth date (the session that follows an activation with the birth-date step
  counts); photo-ID accounts get a step-up one-time code (purpose `step_up`) to a verified channel
  they pick; the login code doesn't count. Five wrong birth dates end the session
  (`step_up_failed`); a step-up code has its own five attempts. Only `health` and `disability` are
  gated; until a step-up the "Gesundheit" page shows only the step-up.
- **D11. Assisted mode** (Q136): the PL, the assigned consultant and back office open the wizard in
  `apps/web` for a participation, after confirming "Die Person ist anwesend oder am Telefon und hat
  um Unterstützung gebeten" and picking `in_person` or `phone`. That writes an `assisted_mode` row
  bound to the staff session (no own expiry; it ends with the session or "Beenden") and
  `assisted_mode_started`; every assisted request names it, and the API checks it belongs to this
  staff session and participation. Rights are the matrix in mode `assisted`; the Q65 cells decided
  in Q136: the assigned consultant writes `identifiers` and `residence_social` self-service fields,
  back office writes `confidential` and `residence_social` self-service fields; the PL never sees
  `identifiers` or `residence_social`, back office never `health`. Fields a role can't see are
  hidden, not shown empty. No step-up for staff; no participant session is used.
- **D12. Placement Agentur** (Q36, Q139): `participation.placement_agentur_key`, set by the PL or
  back office (`set_placement_agentur`) to any Agentur key while the participation isn't terminal,
  also in a draft project. A catalog Agentur the project hasn't pinned is pinned at its latest
  version in the same transaction through `pin_agentur_template` (actor the staff user, cause
  `placement_agentur`); if the override wouldn't validate with it, nothing is written
  (`override_invalid` with the issues). Without a template the participation resolves base +
  override and its Agentur submission stays blocked (Q76). A participant-written address newer
  than the choice shows "Vermittlungs-Agentur prüfen" on the detail (derived, never stored).
- **D13. Who sees what on the staff side:** the detail gets a tab "Selbstauskunft" in normal mode:
  confidential values per `participationDetail`, the sensitive fields as "angegeben / fehlt"
  with a "Anzeigen" button for the roles the matrix allows (consultant: all; back office:
  disability, identifiers, residence_social), each click a logged read. Missing items per step
  come from completeness, as codes.
- **D14. When writes are refused:** terminal participation (`participation_closed`), evidence-set
  phase (matrix), a participant whose session is `activating`. Self-service needs no activated
  account in assisted mode (ADR-0007: 5–10 % never activate).
- **D15. Housekeeping:** comments citing "Slice 3 plan Dnn" or other plan items in files a PR
  touches are replaced by the doc that holds the rule (CLAUDE.md, Comments); 38 such comments
  exist today, about half in files this slice touches.

## PRs

One planned PR = one branch, each based on `main` after its predecessor merged (none stacked).
Five PRs, because the slice has five separable concerns and together exceeds 1,500 lines several
times over; each stays under it excluding tests and generated code.

| PR | Scope | Est. lines |
|---|---|---|
| 4a-1 | Placement Agentur and its automatic pin (D12): column, `set_placement_agentur`, route, resolution per participation, staff UI | ~600 |
| 4a-2 | Confidential self-service data (D1–D7, D14, the D12 hint): wizard definition, value schemas, base defaults v2, `participant_profile`, purposes acknowledgement, consent model, Q112, portal and staff read API, completeness per participation | ~1,400 |
| 4a-3 | The wizard UI (D1, D3–D5): shared package `@transfer/self-service-ui`, portal routes, "Einwilligungen", de/en | ~1,300 |
| 4a-4 | Encrypted fields and the step-up (D8–D10): `pgcrypto`, three tables, read/write functions, `FIELD_ENCRYPTION_KEY`, logged endpoints, step-up, the two sensitive pages | ~1,400 |
| 4a-5 | Assisted mode and the staff view (D11, D13): `assisted_mode`, assisted routes, Q65 cells, the wizard in `apps/web`, tab "Selbstauskunft"; slice e2e | ~1,200 |

## Design

### Data model

New or changed tables (data catalog `packages/db/src/data-catalog.ts`; every table has
`project_id`; retention periods stay `unset` until Slice 7):

| Table | Holds | dataClass / accessCategory | retentionClass | PR |
|---|---|---|---|---|
| `participation` + `placement_agentur_key`, `placement_agentur_set_at` | the Agentur key (format of `AgenturKey`) | internal / `case_internal` (listable) | `participation_record` | 4a-1 |
| `participant_profile` (one row per participation) | `gender`, `marital_status` (enums), `education_history`, `work_history`, `language_skills`, `working_time_preferences`, `job_wishes`, `max_commute_distance` (jsonb, domain schema + `jsonb_typeof` checks), `driving_licence` (enum array), `vehicle_available`, `desired_work_locations` (text ≤ 500), `earliest_start_date`, `custom_fields` (jsonb, validated by the resolved schema), `revision`, `updated_at` | confidential / `confidential` | `personnel_file` | 4a-2 |
| `participant_details` + `participant_maintained` (field names) | which contact fields the participant wrote | internal / `case_internal` | `personnel_file` | 4a-2 |
| `self_service_notice_acknowledgement` | notice version, language, actor (participant or staff with `on_behalf_of`), time; immutable | internal / `case_internal` | `personnel_file` | 4a-2 |
| `consent_record` + `source`, `channel_id` nullable (check: required exactly for `portal_contact`) | consent records | confidential (unchanged) | `personnel_file` | 4a-2 |
| `participant_identifier_data` | `pension_insurance_number` ciphertext, `key_id`, `written_at`; presence boolean | highly confidential / `identifiers` | `participation_record` (Q88) | 4a-4 |
| `participant_residence_social_data` | `nationality`, `entry_to_germany_date`, `residence_status`, `buergergeld` ciphertexts, `key_id`, presence booleans | highly confidential / `residence_social` | `personnel_file` | 4a-4 |
| `participant_health_data` | `health_restrictions`, `severe_disability` ciphertexts, `key_id`, presence booleans | special category / `health`, `disability` | `health_record` (new class, Q141) | 4a-4 |
| `participant_session` + `sensitive_step_up_method` (`birth_date`, `photo_id_and_code`), `sensitive_step_up_at`, `step_up_failures` | step-up state | internal | `access_credential` | 4a-4 |
| `assisted_mode` | staff session hash, staff user, participation, `how` (`in_person`, `phone`), started, ended | internal / `case_internal` | `access_credential` (ends with the staff session) | 4a-5 |

Field catalog: `placementAgenturKey` (4a-1); `workingTimePreferences` becomes the TL 407 44/45
pair (employment type, weekly hours, distribution text); `jobWishes` desired + alternative; each
entry gets its `retentionClass`; `ParticipantRetentionClass` adds `health_record` (4a-4).
`ConsentPurpose` adds `kug200b_profile_access`, `OneTimeCodePurpose` adds `step_up`,
`ParticipantSessionEndReason` adds `step_up_failed`.

### Functions and grants (hand-written, SECURITY DEFINER, audit in the same transaction)

- `set_placement_agentur(context, participation, key, pin jsonb|null)`: locks the project, refuses
  terminal participations, pins through `pin_agentur_template` when `pin` is given (the API passes
  the catalog's latest content and hash, the database checks them as for every pin), audits
  `placement_agentur_set` (old and new key, `baseDefaultsVersion`) (4a-1).
- `write_self_service_data(context, participation, page, values jsonb, revision)`: the
  participant or staff in assisted mode; writes only the page's self-service fields, computes the
  changed keys, audits `participant_data_changed` (names only), marks `participant_maintained`
  for contact fields; refuses per D14 (4a-2). `write_participant_data` (import) skips
  participant-maintained fields and returns them as differences (4a-2).
- `acknowledge_self_service_notice(context, participation, version, language)` (4a-2).
- `write_sensitive_fields(context, participation, values jsonb, key, key_id)` and
  `read_sensitive_fields(context, participation, keys text[], key)`: encrypt/decrypt with
  `pgcrypto`, refuse a mismatched envelope, audit `sensitive_write` / `sensitive_read` (field
  keys), so no read path skips the log (4a-4). The API decides access with `decideAccess` first;
  the functions check actor, participation and project again.
- `record_step_up(session, method)`, `fail_step_up(session)` (fifth ends the session),
  `create_one_time_code` with purpose `step_up` (4a-4).
- `start_assisted_mode(context, staff_session_hash, participation, how)`,
  `end_assisted_mode(...)` (4a-5); ending a staff session ends its assisted modes.
- Grants: the runtime role selects `participant_profile`, the presence columns and
  `assisted_mode`; no `INSERT`/`UPDATE`/`DELETE` on any new table; no privilege on ciphertext
  columns. `CREATE EXTENSION pgcrypto` in the migration (a trusted extension; the owner role
  creates it).

### API (`/api/v1`, OpenAPI, RFC 9457; no sensitive value outside its own endpoint)

Portal (an `active` session):

| Route | Does | PR |
|---|---|---|
| `GET /portal/self-service` | pages with their fields (required, help text, custom-field schema), confidential values, sensitive presence, missing items (codes), notice state, `revision`, step-up state | 4a-2 |
| `PUT /portal/self-service/pages/{page}` | writes one confidential page | 4a-2 |
| `POST /portal/self-service/notice` | acknowledges the purposes notice | 4a-2 |
| `GET /portal/consents` | own consents | 4a-2 |
| `GET`/`PUT /portal/self-service/sensitive/{group}` (`ba_details`, `health`) | decrypted values / write; `health` needs the step-up (`403 step_up_required`); `no-store` | 4a-4 |
| `POST /portal/step-up/birth-date`, `POST /portal/step-up/code-request`, `POST /portal/step-up/code` | the step-up; per-IP throttle like every code submission | 4a-4 |

Staff:

| Route | Does | PR |
|---|---|---|
| `PUT /participations/{id}/placement-agentur` | sets the placement Agentur (PL, back office) | 4a-1 |
| `GET /participations/{id}/self-service` | the normal-mode projection (D13) | 4a-2 |
| `GET /participations/{id}/self-service/sensitive/{group}` | logged read in normal mode, per matrix | 4a-4 |
| `POST`/`DELETE /participations/{id}/assisted-mode` | starts / ends assisted mode | 4a-5 |
| `GET`/`PUT /participations/{id}/assisted/self-service…` | the portal routes' equivalents in assisted mode, with the `assistedModeId` | 4a-5 |

The participation detail and list add `placementAgenturKey` (4a-1). Problems: `stale_revision`,
`step_up_required`, `participation_closed`, `assisted_mode_required`, `override_invalid`.

### Portal UI (4a-3, 4a-4)

`@transfer/self-service-ui` (new package, no staff code, imported by both SPAs; the portal lint
rule is unchanged) renders a page from the API's page definition with Carbon through
`packages/ui`: purposes notice → Persönliches → Kontakt → Angaben für die Agentur (4a-4) →
Schule und Ausbildung → Beruflicher Werdegang → Sprachen und Mobilität → Arbeitswunsch →
Gesundheit (4a-4, behind the step-up) → Weitere Angaben (only with custom fields) → Übersicht
(missing items, links back). Mobile-first, progress bar, "Weiter"/"Zurück", save on "Weiter",
logical CSS properties, de/en. `z.config({ jitless: true })` in both SPAs (ADR-0004, spike S1)
before custom-field schemas compile. Copy says optional data may be left for the Berater and
warns against diagnoses in free text. The portal home links "Meine Angaben" and
"Einwilligungen".

### Web UI (4a-1, 4a-5)

Participation detail: "Vermittlungs-Agentur" with a combobox of catalog Agenturen plus a free key,
(4a-1), the D12 hint (4a-2); tab "Selbstauskunft" (D13) and "Assistierte Erfassung starten" with the
confirmation dialog, then the same wizard with a banner "Assistierte Erfassung für … ·
Beenden" (4a-5). German only.

### Jobs

None. The step-up code is sent in the request like a channel verification code (ADR-0006).

## User flows

1. **Participant, birth-date account:** logs in → "Meine Angaben" → purposes notice → pages,
   saving each → "Angaben für die Agentur" (logged read and write) → "Gesundheit" asks the birth
   date once → answers → Übersicht shows what is missing.
2. **Participant, photo-ID account:** as 1, but "Gesundheit" sends a step-up code to a channel the
   participant picks.
3. **Assisted (consultant, phone):** detail → "Assistierte Erfassung starten" → confirm, `phone` →
   the wizard with the consultant's rights → "Beenden".
4. **PL:** sets the placement Agentur `beispielstadt-nord` → pinned at the latest version if new →
   the participant's wizard now requires the template's fields.
5. **Re-import** after the participant changed their mobile: the preview reports
   `participant_maintained` for that row and target; the value stays.

## Acceptance criteria

**4a-1**
- Setting a catalog Agentur the project hasn't pinned pins its latest version and sets the key in
  one transaction, audited (`placement_agentur_set`, `config_template_pinned` with
  `baseDefaultsVersion`); an already pinned Agentur uses its pinned version; an override that
  wouldn't validate refuses both.
- A key without a template is accepted; that participation's resolution reports
  `agentur_submission_blocked`.
- Only PL and back office of the project may set it; consultants, org roles and terminal
  participations are refused (domain tests for the permission, integration tests for the SQL).
- The detail and list show the Agentur.

**4a-2**
- `GET /portal/self-service` returns the pages of D1 and the requirements of the resolved chain:
  the base TL 407 rules, plus `beispielstadt-nord`'s rules and custom field for a participation
  placed there (sample template version 3 adds a self-service rule).
- Page writes validate per D3 (impossible dates and out-of-set values `422` with code and
  location, never the value), bump the revision, `409` on a stale one, audit field names only.
- The purposes notice must be acknowledged before the first write (`409 notice_required`).
- A re-import doesn't overwrite a participant-maintained field and reports the difference.
- A participant address write after the placement Agentur was set shows "Vermittlungs-Agentur
  prüfen" on the detail (D12).
- Writes are refused for terminal participations and `activating` sessions; nothing sensitive
  is accepted on these routes (unknown keys `422`).
- `consent_record` accepts `portal_contact` with a channel and `kug200b_profile_access` without;
  the existing activation and channel flows pass unchanged.
- Domain coverage stays at 100 % for completeness and the wizard definition.

**4a-3**
- Component tests: rendering from a page definition, required markers, row tables add/remove,
  date entry `TT.MM.JJJJ`, save on "Weiter", resume at the first page with missing items, `409`
  handling, de/en switch.
- No CSP violation with custom fields (jitless).
- e2e: activated participant logs in, acknowledges the notice, fills Persönliches and Kontakt,
  reloads, resumes, sees the progress.

**4a-4**
- The ciphertext columns hold no plaintext (integration test reads them as owner); the runtime
  role can't select them; a value moved to another row fails to decrypt.
- Every read and write audits `sensitive_read`/`sensitive_write` with field keys; no value in
  logs, errors or audit details (log capture test).
- `health` without a step-up is `403 step_up_required`; the birth date unlocks it for the session;
  five wrong ones end the session; a photo-ID account needs the step-up code; a login code
  doesn't count.
- List payloads and `GET /portal/self-service` carry presence only.
- The API refuses to start outside development without `FIELD_ENCRYPTION_KEY`.
- e2e: the participant answers "Angaben für die Agentur" and, after the birth date, "Gesundheit".

**4a-5**
- Assisted mode needs the confirmation and `how`; it is audited; requests without an
  `assistedModeId` of this staff session are `403 assisted_mode_required`.
- Per role (generated access matrix updated, Q65 cells of Q136): PL sees and writes confidential
  and health/disability, never identifiers/residence_social; assigned consultant all self-service
  fields; back office confidential, disability, identifiers, residence_social, never health; an
  unassigned consultant nothing.
- Assisted writes are audited with actor and `onBehalfOf`; contact fields become
  participant-maintained.
- The "Selbstauskunft" tab shows presence without values and logs each "Anzeigen".
- e2e happy path of the slice: PL sets the placement Agentur → participant fills the wizard
  including the sensitive pages → consultant opens assisted mode by phone, completes a missing
  page, ends it → the tab shows no missing items.

## Docs updated by the PRs

`data-protection.md` (classification and access of the new tables, assisted mode, step-up,
encryption), `regional-variation.md` (base TL 407 rules, wizard pages vs configuration),
`process-and-lifecycle.md` (placement Agentur), ADR-0002 (encryption amendment), ADR-0004
(placement pin), ADR-0005 (Postgres logging gate item), ADR-0007 (assisted mode, step-up),
`architecture/overview.md` (`@transfer/self-service-ui`), `.env.example`
(`FIELD_ENCRYPTION_KEY`), the generated access matrix; this plan moves to `plans/archive/` with
4a-5.
