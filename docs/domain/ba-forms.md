# BA forms used in the process

Both forms are nationwide BA forms, published as fillable PDFs (AcroForm, no XFA). We fill
them with the PDF adapter, print them, and they are signed by hand. Store `formCode` and
`formVersion` with every generated document. Field names below are the real AcroForm field
names, checked against the copies we received on 2026-10-15.

> Blank templates live in `packages/forms/templates/ba/<form_code>/<version>/` (ADR-0009). Filled
> copies never go into the repo, except the synthetic test copies in `fixtures/forms/`.
>
> Access: the signed PDFs are visible to the assigned profiler and PL only (opening is logged).
> Back office has no access. Section C fields are profiler only (data-protection.md).

## Kug 200b — Arbeitsuchendmeldung via the Transfergesellschaft

- Title: *Erklärung zur schriftlichen Arbeitsuchendmeldung und Kenntnisnahme zur Einschaltung
  eines Dritten (Transfergesellschaft)*, nach §§ 38 Abs. 1 und 111 Abs. 4 SGB III.
- Version: `Kug 200b - 09/2021`, 1 page, 20 fields.
- Purpose: the participant registers as job-seeking **in writing through the TG**, and
  acknowledges that the TG gets selective access to their applicant profile at the Agentur.
  This is the form behind the "batch" registration at info events.
- Only for §111 (TG) cases. In TA-only projects participants register themselves.
- Signature: handwritten (field 20, no AcroForm field).

| # | Field name | Content | Notes |
|---|---|---|---|
| 1 | `1_txtf_Bezeichnung_Transfergesellschaft` | TG name | project/TG data |
| 2 | `2_txtf_Bezeichnung_Betrieb` | personalabgebender Betrieb | customer |
| 3–8 | `3_txtf_Vorname` … `8_txtf_Ort` | name, address | |
| 9 | `9_rbtn_Familienstand` | ledig / verheiratet | |
| 10 | `10_rbtn_Staatsangehoerigkeit`, `10_txtf_andere_Staatsangehoerigkeit` | deutsch / andere | |
| 11 | `11_txtf_Rentenversicherungsnummer` | RV-Nummer (required) | highly confidential |
| 12 | `12_rbtn_Schwerbehinderung_Gleichstellung` | ja / nein | **special category** |
| 13–15 | `13_txtf_Telefon`, `14_txtf_Mobil`, `15_txtf_Email` | voluntary | BA consent text for internal use and IAB research |
| 16 | `16_chbx_Erklaerung_arbeitsuchend` | declaration | must be ticked |
| 17 | `17_chbx_Erklaerung_zur_Kenntnis_genommen` | acknowledgement | must be ticked |
| 18–19 | `18_txtf_Ort`, `19_txtf_Datum` | place, date | |

## TL 407 — Arbeitspaket / Profilingbogen für Personen mit Bezug von Transferleistungen

- Version: `Arbeitspaket SGB III - TL 407 - 08/2025`, FormID 000159, 7 pages, 160 fields.
- Checkbox `chbxParagraph110` / `chbxParagraph111`: §110 for Transfermaßnahmen (TA-only),
  §111 for Transfer-KuG (TG). This is driven by the project type, not by region.
- Page 1 "Vermerke der Agentur" (`txtfVermerkKdNr`, `txtfVermerkOrg`) is filled in by the
  Agentur. **We never fill these.**
- Two handwritten signatures: participant (fields 12–14) and profiler (fields 15–17).
  By signing, the participant agrees to the results being passed to the Agentur.

### Sections and data

| Section | Content | Classification |
|---|---|---|
| A (p. 2) | Maßnahmeträger (TG) name/address; participant name, birth date; **expected stay in the beE from/to** (`dateVerweilDauerVon/Bis`); **profiling sessions: date, from, to** | confidential |
| B Kurzprofil (p. 3) | RV-Nummer, gender (m/w/d/ohne Angabe), address, phone/mobile/email (voluntary), Familienstand, nationality, **Einreisedatum, Aufenthaltsstatus** (incl. Duldung), unemployed since / until, **Bürgergeld (self or spouse/partner)**, **health restrictions affecting work ability (yes/no)**, **Schwerbehinderung/Gleichstellung (yes/no)** | highly confidential / special category |
| B (p. 4) | education history, last 3 years of work history (incl. gaps), languages | confidential |
| B (p. 5) | driving licence classes, vehicle, full/part-time + hours, working-time preferences, desired job + alternative, desired work locations, max. distance, **Jobbörse publication choice** (4 options), earliest start date | confidential |
| C (p. 6) | profiler's assessment of need for action, each "kein / vermittlungsrelevanter Handlungsbedarf" + free text: qualification (school, vocational, experience, languages), performance (**health restrictions**, **intellectual capacity**, work and social behaviour), motivation, mobility | highly confidential; health line is **special category** |
| p. 7 | Gesamteinschätzung, weiteres Vorgehen (free text) | highly confidential |

### Fixed row limits (overflow must be handled)

| Table | AcroForm rows |
|---|---|
| Profiling sessions | 4 |
| Education | 5 |
| Work history (last 3 years) | 7 |
| Additional languages (besides German) | 4 |

Rule *(provisional, Q41)*: profiling sessions chronological; education with the highest school
qualification first, then vocational/university, most recent first; jobs filtered to the last
3 years, most recent first. Rows that don't fit go onto a generated "Anlage zum
Profilingbogen" (name, birth date, continued tables). The last row on the form reads "weitere
siehe Anlage".

### Validation before rendering

- All dates `TT.MM.JJJJ`, and real calendar dates. Impossible dates are hard errors.
- Plausibility checks are warnings staff can confirm (audited): age 15–67 at TG start, entry
  date not before birth date, von ≤ bis. The test copy we received contains
  `03.14.1998` (month 14). The BA rejects exactly this kind of error, so validate in the domain
  layer, not only in the UI.
- Required (`*`) fields must be complete before the form can be generated, except the
  Agentur-only fields.
- Times `hh:mm`, with from < to.

### Declarations to the BA on the forms

The Jobbörse choice (field 50: `full`, `anonymous_callme`, `anonymous_no_contact`, `none`) and
the BA contact/research consent (notes on the contact fields) are stored on the profiling record
with date and form version. They are not our consents (Q44). The Kug 200b acknowledgement of TG
access to the BA profile **is** stored as our own consent record.
