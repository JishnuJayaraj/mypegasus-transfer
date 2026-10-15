# Synthetic test forms

**Synthetic data only.** Confirmed by the product owner on 2026-10-15 (open question #48).

| File | Form | Content |
|---|---|---|
| `tl407-08-2025-synthetic.pdf` | TL 407, 08/2025 (profiling) | Partly filled. Fictional participant "Lukas Brenner". The birth date `03.14.1998` is **deliberately invalid** (month 14) and is a test case for date validation. The §110 checkbox is ticked. |
| `kug200b-09-2021-synthetic.pdf` | Kug 200b, 09/2021 (Arbeitsuchendmeldung via TG) | Partly filled. Same fictional participant, fictional employer "Fußball Bund". |

- The Träger name and address belong to a company, not a person.
- Use these files for parser/reader tests and as examples. Blank templates for generation go
  into `packages/forms/templates/ba/` (ADR-0009), not here.
- Never add real filled forms. If more fixtures are needed, generate them from synthetic seed
  data.
