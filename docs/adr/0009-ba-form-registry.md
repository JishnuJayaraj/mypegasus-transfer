# ADR-0009: Registry for official BA forms

- Status: Accepted
- Date: 2026-10-15

## Context
TL 407 (profiling, 08/2025) and Kug 200b (Arbeitsuchendmeldung via TG, 09/2021) are nationwide,
official fillable PDFs (AcroForm). The BA publishes new versions from time to time, and some
Agenturen reject outdated versions. See `docs/domain/ba-forms.md`.

## Decision
- Blank forms are stored in the repo at `packages/forms/templates/ba/<form_code>/<version>/`.
  Each version folder contains:
  - the blank PDF
  - a field map: our domain field → AcroForm field name, including how fixed table rows are
    filled
  - a manifest: `formCode`, `version`, `validFrom`, `validUntil`, SHA-256 of the PDF
- Blank official forms are non-personal documents. **Filled forms never go into the repo**,
  except the synthetic test copies under `fixtures/forms/`.
- Filling uses pdf-lib behind `PdfRenderer`. Our own documents (DSV, letters, Teilnehmerliste,
  "Anlage zum Profilingbogen") are HTML templates rendered by Gotenberg.
- **Overflow** *(provisional, Q41)*: the data model has no row limits. Rows that don't fit go
  onto a generated "Anlage zum Profilingbogen" page, and the last row on the form reads
  "weitere siehe Anlage".
- **Validation before rendering** in the domain layer:
  - impossible dates (`TT.MM.JJJJ`) are hard errors
  - plausibility checks are warnings that staff can confirm (audited)
  - required fields must be present, except the fields the Agentur fills in itself
- **New versions:** a named form owner in back office checks the BA download pages monthly
  (reminder), and rejections citing the form version trigger a check. A new version gets its
  own folder, and the previous one gets `validUntil`. Unsigned forms are regenerated, and signed
  forms keep their version. Every generated PDF records `formCode` and `formVersion`.

## Consequences
+ Form versions are reviewed in PRs like code, with a checksum.
+ Contract tests can fill the real blank forms.
- Adding a form version needs a deploy. That's acceptable at a few changes per year.

## Amendment 2026-10-24: the registry as built (Slice 6, PR 6-1)

- **Folder per version** `packages/forms/templates/ba/<formCode>/<version>/` (`MM-JJJJ`), four
  files:
  - `blank.pdf`: the BA's download, unchanged (no field values, no XFA);
  - `source.json`: provenance as committed (URL, retrieval date, SHA-256, pages, field count;
    Q176), never edited;
  - `manifest.json`: `formCode`, `version`, `validFrom`, `validUntil`, `validitySource` and the
    PDF's `sha256`, which must equal `source.json`'s. The effective dates come from a reviewed
    source, named in `validitySource`, or are `null`; they are never derived from the printed
    version month (Q188). No reviewed dates exist yet, so all three committed versions are in use.
  - `field-map.json` (`FieldMap`, `packages/domain/src/forms/field-map.ts`): in form order, each
    input key → its AcroForm field(s) (one value may fill a repeated name, e.g. the name on pp. 2
    and 3), its kind (`text` with its box, `multiline` and optional own `fontSize`; `date`
    `TT.MM.JJJJ`; `time` `hh:mm`; `radio` with our codes → export values; `checkbox` with its
    on-state; `checkbox_choice` for a checkbox whose widgets carry different on-states), the
    form's `*` (`required`), `applies` (the beE dates `ta_tg` only, Q181), `group` (any one
    satisfies a `*`, TL 407 field 49) and `identifier` with its maximum length (never cut, Q180);
    the fixed row tables (rows, columns, the marker column, date and time ranges); the fields
    never filled with their reason (`agentur`, `signature`, `handwritten`, `declaration`,
    `health_detail`); the form's text size and the minimum we shrink to; `missingRequired`
    (`error` for the TL 407, `blank` for forms completed by hand); the Anlage template.
- **Checks.** A registry test (`packages/forms/src/registry.test.ts`) compares each folder with its
  blank: hashes, pages, field count, no value, no XFA, every PDF field mapped once (filled or never
  filled), kinds, options, on-states, boxes, border widths and text sizes. `pnpm generate` writes
  `packages/forms/templates/manifest.json` (every version with its label, effective dates, hash,
  pages and fields; the own templates' files by SHA-256); CI fails on drift.
  `scripts/check-template-immutability.mjs` also keeps every merged `blank.pdf` (bytes),
  `source.json` (canonical JSON), the identity in `manifest.json` (`formCode`, `version`,
  `sha256`) and every own template file unchanged. The effective dates and the field map may
  change in a reviewed PR: the map is our mapping, pinned to the blank by the registry test, not
  the BA's document.
- **Which version is used**: `formVersionInUse(entries, formCode, today)` on the Berlin date of
  the request: `validFrom` null or ≤ today, `validUntil` null or ≥ today; none is
  `form_version_unavailable`, two at once a registry error. A new version gets its folder and the
  previous one its reviewed `validUntil`.
- **Own templates** `packages/forms/templates/own/<name>/v<n>/` (`index.html`, `header.html`,
  `footer.html`): `anlage-profilingbogen:v1`. A change is a new version.
- **The font**: `packages/forms/fonts/noto-sans-subset.ttf`, Noto Sans Regular 2.015 (OFL,
  `OFL.txt`) subset to Latin with its extensions, combining marks and common punctuation
  (`source.json` holds the source, its hash and the subset command). `printableRanges` in the
  domain names the same code points; a test checks the font covers each.
- `@transfer/forms/load` (Node only) reads and checks the files; `packages/forms` holds no rule.
  The validation, row order, overflow and the Anlage are domain code (ba-forms.md, the registry
  as built).
- The **Kug 200a 07/2025** (2 pages, 56 fields, six participant rows) has its manifest and field
  map so the registry test checks it; filling it is PR 6-5a (Q195).
