# Process & lifecycle: import

### Import and manual creation (Q103, Q104)

Both run under the PL's `importParticipations` capability, also in a draft project, and create
along the creation edge into `imported`. Issues name the row, the target and a code, never a value.

- **Targets**: `personnelNumber`, `lastName`, `firstName` always required; `birthDate`,
  `oldEmploymentEndDate` (Austrittsdatum) and the address unless the project relaxed
  `base-import-birthDate`, `base-import-oldEmploymentEndDate` or `base-import-address` (Q75).
  The address is one unit: `addressStreet`, `addressPostalCode`, `addressCity` and
  `addressCountry` (from a column or one selection for the whole import, never both:
  `country_source_conflict`; only Germany, stored `DE`). Optional: `phone`, `mobile`,
  `privateEmail`, `workEmail` (never used for login). One column per target
  (`target_mapped_twice`); unmapped columns are dropped.
- **File**: the format is decided by content, not the file name: a ZIP signature is `.xlsx`,
  anything else CSV/text; binary content (e.g. `.xls`) is `unsupported_file`. One header row,
  chosen among the first 20 (no multi-row headers). Limits 5 MB, 5,000 data rows, 50 columns,
  500 characters per cell; a workbook beyond the ZIP expansion limits is refused. CSV: strict
  UTF-8 (BOM dropped), else Windows-1252; delimiter `;`, `,` or tab detected from the first 50
  records; both overridable. XLSX: numeric cells stay marked numeric, date cells become ISO
  dates (a non-zero time is `date_has_time`).
- **Row errors**: names ≤ 100, Personalnummer ≤ 50, address parts ≤ 200 characters
  (`too_long`); no control characters; dates `TT.MM.JJJJ` or date cells, an invalid date is an
  error even when its rule is relaxed; `birth_date_in_future`; `end_before_birth`; a numeric
  Personalnummer cell; a Personalnummer in several rows is `duplicate_in_file` on every one.
  **Warnings**: `age_implausible` (15–67 at the Austrittsdatum), invalid optional contact values
  dropped (`value_invalid_dropped`), a five-digit numeric postcode converted, `kept_existing`,
  `participant_maintained` (below).
- **Matching**: the exact Personalnummer is the only automatic match key; it is unique per
  project, never generated and immutable once stored (`personnel_number_immutable`), so a
  re-import never changes it. A match with a terminal participation is skipped with only
  `terminal_not_updated`. Required values are checked on the merged record (row over stored),
  so a blank cell keeps the stored value (`kept_existing`). Outcomes: create, update, unchanged,
  skip, error; participations missing from the file are only counted. A new row with the same
  birth date and names (trimmed, case-insensitive) as another new row or an existing
  participation is a `possible_duplicate` for the PL to decide.
- **Participant-maintained contact fields** (Q112): a contact field the participant wrote in the
  portal (also assisted) is never overwritten: the plan leaves it out of the update, a differing
  value is the warning `participant_maintained` by row and target (never the value), and
  `write_participant_data` skips it too. The maintained fields are part of the plan digest, so a
  participant's write after the preview makes the confirm `import_preview_stale`.
- **Mapping suggestions**: the project's saved mappings, then those of projects with the same
  customer name (newest first), then built-in header synonyms (a combined `Anschrift` never).
  The PL confirms every mapping by sending it; only keyed hashes of headers are saved, and
  nothing when the header row looks like a person's data.
- **Preview** is stateless and stores nothing. Its `previewToken` is an HMAC over project, file
  hash, sheet, CSV options, header row, mapping, country, wave and a digest of the plan; a file
  with any error row gets none.
- **Confirm** parses the file again, then in one transaction under `lock_project_setup` reloads
  the state and re-plans: an error row is `import_has_errors`, a changed plan 409
  `import_preview_stale`, decisions that don't fit the plan exactly `decisions_invalid` (every
  `possible_duplicate` decided create or skip, none for other rows, `confirmWarnings` when a row
  not skipped has another warning). It writes creations through the creation edge and
  `write_participant_data`, updates through `write_participant_data`, `warning_confirmed` per
  participation and code (`possible_duplicate` for a duplicate created anyway), `import_confirmed`
  last with the counts and `baseDefaultsVersion`, then the mapping. All or nothing. In `ta_tg`
  an optional wave applies to every participation the import creates.
- **Manual creation** (`POST /projects/{id}/participations`): one person is one import row under
  the same rules, capability and lock, the country always `DE`. An existing Personalnummer,
  terminal included, is refused (`personnel_number_taken`), never updated; a value the import
  would drop with a warning is a field error (`value_invalid`); warnings need `confirmWarnings`
  and a possible duplicate `createDespiteDuplicate`, audited as `warning_confirmed` like the
  import; it writes `participation_created_manually` with `baseDefaultsVersion`.
