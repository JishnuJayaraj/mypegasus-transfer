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
