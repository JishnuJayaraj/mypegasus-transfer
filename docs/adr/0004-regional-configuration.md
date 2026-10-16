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
  has a placement Agentur. Participant steps resolve against the placement Agentur's template,
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
- **Rules reuse the domain's closed `CompletenessRule` schema** with its basis (Q75); a
  relaxation names an `operational_default` rule, a reason code and its approval.
- **Custom fields use a restricted JSON Schema profile** compiled with `z.fromJSONSchema`
  (spike S1): only `confidential` or `internal` data, a participant retention class and a label;
  everything else is rejected before compiling.
- The resolver, its provenance and blockers, pinned-version loading and the sample templates
  follow in PR 1f-2 and amend this ADR then.
