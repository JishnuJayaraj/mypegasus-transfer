# ADR-0004: Fixed lifecycle core, versioned regional templates

- Status: Accepted
- Date: 2026-10-15

## Context
BA requirements differ slightly per Agentur. Hard-coding them would fork the code per region;
a generic workflow engine would be over-engineering.

## Decision
Lifecycle states/transitions are code. Required fields, documents, form templates, deadlines
and reminder rules are data in versioned **regional templates**, snapshotted into each project
with optional audited project overrides. Resolution: defaults → template → project override.
See `docs/domain/regional-variation.md`.

## Consequences
+ New region = new template, no deploy.
+ Every generated document is traceable to a template version.
- Need an admin UI (or seed files in MVP) to manage templates; template schema must be
  validated strictly.

## Amendments 2026-10-15

Decided (from the decisions log; details in `docs/domain/regional-variation.md`):
- **Official BA forms are nationwide** (TL 407, Kug 200b) and are not regional configuration.
  They live in a separate, versioned form registry (ADR-0009). Regional templates mainly
  configure *channels*: ASU default channel, Kug 200b batch channel, TL 407 submission channel,
  `originalRequired`, `leadTimeDays`, `rejectsOutdatedFormVersions`.
- **Two Agenturen** *(provisional, Q15)*: the project has a KuG-Agentur and each participation
  has a placement Agentur. (Round 15: the project-level Agentur is the **Project Agentur**, the
  KuG-Agentur only in `ta_tg` projects; see the 1f-2 amendment.) Participant steps resolve against the placement Agentur's template,
  project steps against the KuG-Agentur's template. A project therefore snapshots **one
  template version per Agentur** in use.
- **Pinning and migration** *(provisional, Q36)*: projects stay pinned to their template
  versions. An explicit PL migration recomputes completeness. Generated documents keep their
  versions.
- One **Step enum** in `packages/domain` is shared by lifecycle guards and config.
- In the MVP, templates are seed files, so a new region needs a deploy until the admin UI
  exists.

Accepted in the PR #1 review:
- Regional config is validated by **JSON Schema stored as data**, compiled to validators at
  runtime (Zod source can't be data). Since the BA forms are nationwide, regional templates are
  small: channels, deadlines, `originalRequired`, a few extra fields.
- Completeness rules are a **minimal declarative set**: `required`, `requiredIf` (equals /
  exists), `documentPresent` (+ accepted). **No scripting.**

- **Base defaults** (accepted, round 5): `packages/domain/config/base-defaults.json`,
  validated by the same JSON Schema as regional templates. It holds the nationwide process:
  default channels, deadlines (ASU formula, signing-deadline offset, reminder intervals) and
  default completeness rules. Regional templates override only what differs.

## Note 2026-10-16: spike S1 (`z.fromJSONSchema`, Slice 1 plan section 3)

**Passed; no fallback, `ajv` is not added.** Checked with `zod@4.6.7` in a cloud session
(Node 22.22.0, Chromium via Playwright):

- **Same behaviour as hand-written Zod** for every keyword of the field-schema profile (plan
  5.7): `type` (`string`, `integer`, `number`, `boolean`), `enum` (typed and untyped), `const`,
  `minLength`/`maxLength`, `pattern`, `minimum`/`maximum`, `title`/`description`; 63 values
  compared, no difference. `x-dataClass`, `x-retentionClass` and `x-label` compile and are
  ignored for validation.
- **`format: "date"`** compiles to `z.iso.date()`: rejects `2027-02-31`, `2027-02-29`,
  `2027-04-31`, `1900-02-29`, `2027-13-01`, `2027-1-1` and timestamps; accepts `2028-02-29` and
  `2000-02-29`. Same results as our `isoDate`, so no own `format` mapping is needed.
- **CSP:** a Vite 8 build validating a compiled object schema in the browser, served with the
  API's exact CSP, raised **no violation** with `z.config({ jitless: true })` and returned the
  right results. Without `jitless` the same page raised one `script-src` `eval` violation
  (Zod's JIT probe), so the setting is required in both SPAs (Slice 4a), as planned.

Two details for PR 1f (`field-schema.ts`):
- `pattern` is compiled **without the `u` flag** (like a hand-written `z.string().regex()`), so
  `\p{…}` classes don't work. The profile should reject patterns that need the flag.
- String lengths count code points, as JSON Schema requires (a hand-written `.max()` does too).

## Amendment 2026-10-16: the configuration model (Slice 1, PR 1f-1)

- **One Zod-authored model, exported as JSON Schema.** Base defaults, regional templates and
  project overrides are layers of one schema (`packages/config/src/model.ts`), exported by
  `pnpm generate` to the committed `packages/config/schema/regional-template.schema.json`
  (2020-12) and drift-checked in CI. Zod is the authority: checks JSON Schema can't express
  (the custom-field profile's keyword combinations, rule fields against the field catalog) run
  in `parseLayer`. No `ajv`.
- **Nationwide vs. regional settings.** Nationwide settings (ASU formula, profiling-exception
  deadline, Kug 200b follow-up, TL 407 escalation, cutoff warning and reminder) exist only in
  the base defaults and equal what the domain applies. Regional settings (channels,
  `originalRequired`, `leadTimeDays`, `rejectsOutdatedFormVersions`) exist only in templates
  and in Agentur-scoped temporary settings of an override; the base defaults have none
  (round 8), and an override has no project-wide settings.
- **Temporary Agentur settings** carry a source code, the confirming staff user and the
  confirmation date.
- **Rules reuse the domain's closed `CompletenessRule` schema** with its basis (Q75) and its
  optional `projectTypes` (Q89, round 14: absent = every type; completeness skips a rule for
  another type, so it is never missing or reminded). A relaxation names an
  `operational_default` rule, a reason code (a controlled list from Slice 2) and its approval.
- **Custom fields use a restricted JSON Schema profile** compiled with `z.fromJSONSchema`
  (spike S1): only `confidential` or `internal` data, a participant retention class and a label;
  everything else is rejected before compiling.
- The resolver, its provenance and blockers, pinned-version loading and the sample templates
  follow in PR 1f-2 (amendment below).

## Amendment 2026-10-16: the resolver (Slice 1, PR 1f-2)

- **Two levels** *(provisional, Q15)*: `resolveForParticipation` resolves participant steps
  against the Placement Agentur's template and project steps against the **Project Agentur's**
  (`projectAgenturKey`; the KuG-Agentur in `ta_tg`, the Agentur responsible for the §110 measure
  in `ta_only`, Q90);
  `resolveForProject` resolves only the project steps. Each level is base defaults → that
  Agentur's pinned template → project override, every layer validated by `parseLayer` with the
  custom fields of the layers below.
- **Merge rules:** settings per key, the later layer wins; an override's Agentur-scoped
  settings apply only when resolving for that Agentur and win only for the keys they supply
  (Q93). Rules are merged by id and
  never redefined; templates only add; an override adds rules and relaxes only
  `operational_default` rules (Q75). Custom fields are never redefined. Help texts: the later
  layer wins per language and key. Resolved rules keep `basis` and `projectTypes` (Q89).
  An invalid layer is an error, not a blocker.
- **Provenance** for every setting, field, rule, relaxation and help text: `base`,
  `template:<id>@<version>`, `override`, or `override:agentur:<key>` with source, confirmer and
  date.
- **Blockers and warnings** (Q76): no Project-Agentur template → `project_activation_blocked`
  (both project types, Q90; only a pinned template lifts it); an Agentur submission setting
  supplied neither by the template nor by an Agentur-scoped setting → `agentur_submission_blocked`
  for that step only (`agentur_submission`: all four settings, Q92; `asu_registration`: the
  Kug 200b batch channel in `ta_tg` projects, Q91), never a project blocker. Each blocker also gives a
  warning. `projectActivationBlockers` in the domain adds `no_entry_wave_with_latest_entry_date`
  for `ta_tg` projects (Q77).
- **Pinned versions** *(provisional, Q36)*: the resolver takes the project's template objects;
  `@transfer/config/load` (Node only) reads `templates/<agenturKey>/<version>.json` and checks
  that the file is the template its path names. Compiled custom-field validators are cached per
  (template id, version). Two fictional samples (D8): `beispielstadt-nord` (versions 1 and 2)
  and `beispielstadt-sued`.
- **Slice 2 invariants** (round 15): an override is validated against every pinned Agentur
  template, and each relaxation must match a rule in at least one pinned chain; an existing
  template version can't be modified or replaced; a migration to another version surfaces the
  Agentur-scoped settings for review.

## Amendment 2026-10-17: snapshots, manifest, immutability and `CONFIG_DIR` (Slice 2, PR 2c-1)

Decided in the Slice 2 plan (D5, R10–R12, R22, 5.8; round 22):
- **Content identity:** a template version's identity is the SHA-256 of its canonical JSON
  (object keys sorted, no insignificant whitespace; `packages/config/src/hash.ts`), so formatting
  never changes it and any content change does.
- **Manifest:** `pnpm generate` writes `packages/config/templates/manifest.json` (key, version,
  labels, `sample`, hash per version), validated through `loadTemplate`; a test and the drift
  check keep it equal to the files. It is the catalog the API serves
  (`GET /api/v1/config/templates`).
- **Immutability in the repo:** `scripts/check-template-immutability.mjs <base-ref>` runs in
  `pnpm lint`; CI passes the PR's base or the previous commit on `main`. Every version present at
  the base must exist with the same hash: adding a version passes, changing or deleting one fails.
  Locally it uses `origin/main` when fetched, else it prints a notice and passes; under CI a
  missing base ref fails.
- **Snapshots** (PR 2c-2): a pin stores the version's content and hash in
  `config_template_version`, keyed by `(agenturKey, version)`; every later pin of that version, in
  any project, must match both. A project resolves only from its stored snapshot. Base defaults
  are not pinned (Q107).
- **`CONFIG_DIR`:** the API build copies the templates (with the manifest) and the base defaults
  to `apps/api/dist/config/` (spike S2 passed, no JSON-import fallback). `CONFIG_DIR` names that
  directory (`templates/`, `base-defaults.json`); unset, `@transfer/config/load` uses the repo
  paths. The image sets it; the API reads the catalog once at start and refuses to start without
  it.

## Amendment 2026-10-17: overrides and Agentur-scoped settings (Slice 2, PR 2d-1)

- **One vocabulary in the domain:** the Agentur key, the channel enums, `RegionalSettings`, the
  four confirmation sources and `TemporaryAgenturSetting` moved from `model.ts` to
  `packages/domain/src/projects/agentur-settings.ts`, so the API's schemas and both SPAs share
  them without depending on `@transfer/config`; the model composes its layers from them as it
  does from `Step` and `CompletenessRule`, and re-exports them. The generated JSON Schema is
  unchanged.
- **`validateProjectOverride`** (`packages/config/src/override.ts`) runs `parseLayer`, then
  resolves the override for the project and for participations against the base-only chain and
  every pinned chain; any `ConfigError` fails with its layer and issues. Every relaxation must
  relax a rule in some chain (`relaxation_unmatched`) and carry a controlled reason code
  (`reason_code_unknown`; the four codes of Q100). It runs on every override write and on every
  pin, so pinning a further Agentur can't break the override.
- **Override versions** are stored per project (ADR-0002 amendment of the same date) and are part
  of the project snapshot: the configuration a project resolves is its pinned template contents
  plus its current override version (R11).

## Amendment 2026-10-17: rule relaxations with approval (Slice 2, PR 2d-2)

- **The reason codes in the domain:** `RelaxationReasonCode` (Q100) moved with the relaxation
  vocabulary (request status, `RuleId`) to `packages/domain/src/projects/relaxations.ts`, because
  the audit model and the database enum need it and the domain can't import `@transfer/config`;
  `packages/config/src/override.ts` re-exports it, as `model.ts` does the Agentur vocabulary.
  There is one list.
- **A relaxation enters the override only through an approval** by another person (round 8,
  R2): the approved entry `{ ruleId, reasonCode, approvedBy, approvedOn }` is a new override
  version, validated by `validateProjectOverride` like every other write. `withRelaxation` adds or
  removes one; `relaxableRules` lists the rules a request may name (`operational_default` and
  applicable in some chain, locked in none, not relaxed yet, never the override's own rules).
