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
