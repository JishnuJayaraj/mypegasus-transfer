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
