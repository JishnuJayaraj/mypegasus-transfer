# Synthetic import fixtures

Everything here is **synthetic**: no real person, employer or contact detail (CLAUDE.md rule 1).
They are the files of the import tests (`apps/api/src/imports/`) and the Playwright happy path.

| File | Content |
|---|---|
| `teilnehmer-beispiel.csv` | UTF-8, `;`, 12 rows `BSP-0001…BSP-0012`, all columns of the sample header |
| `teilnehmer-beispiel.xlsx` | the same content as text cells, sheet `Teilnehmende` (a test asserts equality with the CSV) |
| `teilnehmer-aktualisiert.csv` | the re-import: `BSP-0001` has a new street, `BSP-0002` a new phone number, `BSP-0012` is missing, `BSP-0013` is new |
| `teilnehmer-fehler.csv` | one row per error and warning code of the row rules (see below) |
| `teilnehmer-cp1252.csv` | Windows-1252 with umlauts (`Müstermann`, `Größe`, `Jürgen`, `Heinrichstraße`) |
| `teilnehmer-gemischt.xlsx` | sheet `Info`, then `Teilnehmende` with two title rows above the header (row 3), real date cells, numeric Personalnummer / postcode / phone cells and a date cell with a time |

`teilnehmer-fehler.csv` (header row 1, data from row 2): row 3 empty last name (`required_missing`),
4 `31.02.1975` and 5 `03.14.1998` (`invalid_date`), 6 birth date in the future, 7 Austrittsdatum
before the birth date, 8 a tab in a name (`control_characters`), 9 and 10 the same Personalnummer
(`duplicate_in_file`), 11 postcode `1234` (`postal_code_invalid`), 12 country `Frankreich`
(`foreign_address_unsupported`), 13 street and postcode but no city (`address_incomplete`),
14 no country (`country_required`), 15 a 101-character name (`too_long`), 16 a person aged 16 at the
Austrittsdatum (`age_implausible`), 17 an invalid email and phone (`value_invalid_dropped`),
18 same name and birth date as `BSP-0003` of the sample file (`possible_duplicate` once that file is
imported), 19 an empty Personalnummer (`required_missing`). Row 2 is clean.

## What is made up

- **Names:** German placeholder names (`Mustermann`, `Musterfrau`, `Beispiel`, `Normalverbraucher`,
  `Muster`, `Probe`, …) with common first names; birth dates are arbitrary.
- **Personalnummern:** `BSP-0001…`.
- **Addresses:** `Musterstraße n`, `99999 Beispielstadt`.
- **Email:** `teilnehmer-nnnn@example.org` (`example.org` is reserved for documentation, RFC 2606).
- **Phone numbers:** only from the ranges the Bundesnetzagentur reserves for fiction ("Drama
  Numbers"): landline `030 23125 000–999` (Berlin) and mobile `0171 39200 00–99`. Source: the
  Bundesnetzagentur page *Rufnummern für Medienproduktionen („Drama Numbers")*
  (bundesnetzagentur.de, Telekommunikation › Nummerierung › DramaNumbers), as quoted by search
  results on 2026-10-19; the page itself could not be opened from the development sandbox, so
  re-check it before adding other ranges. No number outside these two ranges may be added.
- The zip bomb of the limits tests is generated inside the test, never committed.
