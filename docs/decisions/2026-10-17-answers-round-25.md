# Decisions — 2026-10-17, round 25 (Slice 2, PR 2c-1 review)

The product owner's review of PR 2c-1 (#29). Where it differs from earlier rounds, round 25 wins.

## Spec correction (blocking)

1. **Validate manifest ordering and uniqueness at startup.** `TemplateManifest` validated the
   entry shapes only. A schema-valid manifest could hold duplicate or out-of-order
   `(agenturKey, version)` entries, while the catalog's pagination assumes strict ordering, so an
   entry could be skipped or repeated. The entries must be strictly increasing by
   `compareTemplateVersions`; tests show that startup refuses duplicates and out-of-order entries.

## Documentation correction

2. **The cursor is opaque, not authenticated.** A caller can build a schema-valid cursor, which
   is harmless for the read-only catalog; HMAC signing is unnecessary. Say "malformed or
   schema-invalid cursor", not "forged cursor", and rename the test variable.

## Questions

- **Q108 confirmed:** the global template catalog may be read by the flat `project_lead` role,
  anyone holding the `project_lead` membership in any project, and the global organisation roles.
  Consultants and back office without a PL membership get 403; unauthenticated callers get 401.

## Applied (PR #29)

- `TemplateManifest` refuses any entry that isn't after its predecessor
  (`manifest_not_strictly_ordered`, at the entry's path); tests in `manifest.test.ts` and an API
  test that the start fails for duplicate and out-of-order catalogs.
- The cursor wording in the plan and the test (`schemaInvalid`).
- Q108 `confirmed` in `open-questions.md`; the plan's readings 3, 7 and 8, `access.ts`,
  `regional-variation.md`.
