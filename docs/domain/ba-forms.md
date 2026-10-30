# BA forms used in the process

The forms are nationwide BA forms, published as fillable PDFs (AcroForm, no XFA). We fill
them with the PDF adapter, print them, and they are signed by hand. Store `formCode` and
`formVersion` with every generated document. Field names below are the real AcroForm field
names, checked against the copies we received on 2026-10-15 and the blanks committed on
2026-10-24 (the registry test checks every field map against its blank).

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
  This is the form behind the "batch" registration at info events. The batch goes to the Agentur
  with the official **Kug 200a** (07/2025; BA guidance of 4 May 2026, section 2.13(12)) unless the
  Agentur's acceptance of an alternative is recorded (Q187, Q195); as built below.
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
with date and form version. They are not our consents (Q44). What was signed binds to the paper:
pending values may change until a signed form is accepted, which records the values actually
marked on it, its form version and signature date, and a later edit never rewrites them (Q193).
As built for the TL 407 (Slice 6, PR 6-3b): `signed_declaration`, one row per declaration of the
accepted scan; for a form printed by the platform the reviewer confirms the generation's snapshot
("wie gedruckt") or records what is marked, for external paper always what is marked
(data-protection.md, signed declarations).
The Kug 200b acknowledgement of TG access to the BA profile (declaration 17) is recorded as
written and kept as the record `kug200b_profile_access`; whether it is a consent is to verify
(Q185).

## Kug 200a — Liste der Teilnehmenden (cover list of a Kug 200b batch)

- Title: *Liste der Teilnehmenden an einer Transfergesellschaft — Vorblatt zu den Erklärungen
  „Schriftliche Arbeitsuchendmeldung" und „Einverständniserklärung zur Einschaltung eines
  Dritten"*; "Nur durch Transfergesellschaft auszufüllen". No field is marked `*`.
- Version: `Kug200a - 07/2025`, 2 pages, 56 fields (Q195).
- Header (on both pages, one field each): the TG's name, Betriebsnummer, T-Kug-Nummer
  (if known; the form prints `TK-` before the box), Branche/Wirtschaftsklasse; the
  personalabgebender Betrieb's name, Betriebsnummer and Branche/WK; the date of the info event.
- Six participant rows (two on p. 1, four on p. 2): name and address in one box, the
  Versicherungsnummer (VSNR, an identifier), the last activity at the employer and its period,
  the planned period in the TG, "Erklärung zur schriftlichen Arbeitsuchendmeldung ist beigefügt",
  the consent declaration "ist beigefügt" / "liegt nicht vor" (one checkbox with two on-states),
  "Teilnahme an der Info-Veranstaltung".
- The "Lfd. Nr." column is printed (1–6 on every copy), not a field. Identifying a copy within
  its batch is an open follow-up (`docs/issues/kug200a-copy-identification.md`).

### The Kug 200a as built (Slice 6, PR 6-5a-2; readings Q205)

`checkKug200a` in `packages/domain/src/asu/kug200a.ts` (pure, no system time) builds the cover list
of a Kug 200b batch from what the API reads under the project's exclusive lock; the export rules
are in data-protection.md, exports.

- **Copies of six:** the members in the list's order (last name, first name) fill copies of six
  rows each (two on p. 1, four on p. 2), each a complete form with the header, merged into one PDF
  (`mergePdfs`); each copy numbers its rows 1–6 as printed.
- **Header:** the TG's name, Betriebsnummer and Branche/WK from the organisation configuration
  (`transfergesellschaft.betriebsnummer`, `.economicClass`; architecture/overview.md); the
  personalabgebender Betrieb's name (the project's customer), its Betriebsnummer and Branche/WK
  and the T-Kug-Nummer from the project (set by the PL on "Einrichtung"; the number without the
  printed `TK-`, which the form would otherwise repeat); the info event's date only when every
  attendance (`attended`) of the batch's members at the project's scheduled info events falls on
  one Berlin date.
- **Rows:** "Nachname, Vorname", street, "PLZ Ort" in the one box; the Versicherungsnummer (the
  RV-Nummer, through the purpose-bound read); the planned period in the TG as the effective
  contractual TG dates, `TT.MM.JJJJ – TT.MM.JJJJ`; "Erklärung … ist beigefügt" for every member
  (their accepted Kug 200b goes with the list); the consent as the packet carries it (Q205 (4)):
  "ist beigefügt" only when declaration 17's record in force is on the member's scan in the batch,
  "liegt nicht vor" when none is in force, and when it is on another paper the packet doesn't
  carry (a renewed declaration after a withdrawal) left blank with the checklist entry
  `not_in_packet`: rebuild the batch, which takes the newest scan, or write the box by hand; the
  alternative list the same; "Teilnahme" ticked when the member
  attended an info event (on the header's date when there is one). The last activity at the
  employer and its period are never filled: no record says which work row was at the old employer
  (Q205).
- **Nothing is guessed or refused as a whole:** what the platform doesn't hold, what the data
  doesn't decide, a text too long at the 6 pt floor and a value the form can't take
  (`character_unsupported`, `identifier_too_long`) stay blank and go on the **handwriting
  checklist** (codes `not_recorded`, `not_decided`, `not_in_packet`, `text_not_fitting`, …, by key
  and member, never a value), shown on the tab "Agentur" before printing (Q197 (8)).
- **The 6 pt floor (Q197 (1)), assessed 2026-10-29, accepted 2026-10-30** (the review of PR #99,
  which also rendered the alternative list through CI's Gotenberg image) on a representative synthetic batch of seven
  (`syntheticKug200a`: long double names and addresses, `Ł`, `ğ`, `ş`, `ß`; the contract test
  fills the real blank and reads it back): the name-and-address box takes five lines at 6 pt, and
  at print resolution (300 dpi) 6 pt Noto Sans stays legible with every special character
  distinct, so 6 pt holds; beyond it the box is left blank and listed. Long job titles don't
  arise, since the last activity isn't filled.
- **The accepted alternative** (regional-variation.md): our own template
  `sammelliste-kug200b:v1` (`packages/forms/templates/own/`, hash-checked, rendered through
  `PdfRenderer.renderHtml`) with the Kug 200a's contents: the header as labels and values, then
  one numbered table of all members with the Kug 200a's columns (no copies of six), the batch's
  date and count on every page, "Seite n von m"; every value escaped. Its checklist is the Kug
  200a's but for what only the form's boxes refuse.

## The registry as built (Slice 6, PR 6-1)

Files and checks: ADR-0009, amendment 2026-10-24. The rules, all in `packages/domain/src/forms`
(no I/O, no system time):

- **Input.** `tl407Input` and `kug200bInput` build the form input from domain data, keyed by the
  field map: dates ISO, times `hh:mm`, choices our codes, null blank. TL 407: §110 in `ta_only`,
  §111 in `ta_tg`; the Träger from the organisation configuration (`transfergesellschaft`: name,
  street, house number, postal code, city); the beE stay from the effective contractual TG dates
  in `ta_tg`, blank in `ta_only` (Q181); phone, mobile and email only when the TL 407's own BA
  contact declaration is yes; the health line's rating without text (field
  `txtfLeistungHandlungZ1` is never filled). Kug 200b: 1–12; 13–19 never. The address's street
  and house number are split best effort (Q197): a trailing number or range, digits inside the
  street name kept; ambiguous input keeps the original street and leaves the number blank for
  clarification or handwriting.
- **Validation** (`validateFormInput`), codes and keys, never values:
  - errors (refuse generation): `unknown_key`, `value_kind_invalid`, `value_not_applicable` (a
    value for a field that doesn't apply, e.g. beE dates in `ta_only`), `option_invalid`,
    `date_invalid` (an impossible date; 29.02. only in a leap year), `time_invalid`,
    `time_range_reversed` (a session whose `bis` isn't after `von`, equal included),
    `identifier_too_long` (the RV-Nummer longer than 12; never cut), `character_unsupported` (a
    character the embedded font can't print, by field; never transliterated, the stored name
    stays as it is; the external-paper path before live use, Q197), `required_missing` (an applicable `*` field or a
    required table without rows, where the map says `error`);
  - blanks (`required_blank`): the same on a form completed by hand (Kug 200b), shown to staff
    before printing;
  - warnings staff confirm by code (`PlausibilityWarning`): `age_implausible` (outside 15–67
    whole years at the effective TG start, else at today; 15 and 67 are plausible),
    `entry_before_birth`, `range_reversed` (a date range with `von > bis`; equal is fine).
  - The laid-out output is checked again (`checkFilledFields`): every date field a real
    `TT.MM.JJJJ` date (the test copy's `03.14.1998` is an error), every time `hh:mm`, no value in
    a field the map never fills.
- **Row order** (Q41): `orderSessions`; `orderEducation`: the highest school qualification first,
  as the participant marks it and the profiler confirms it (never inferred from text or recency;
  persisted from 6-2, Q196), then the rest most recent first; `recentWork`: rows started on or
  before the generation date and running or ending on or after it minus three years, most recent
  first (a running row first, then by end and start); languages as given, German its own row.
- **Layout and overflow** (`layoutForm`, `layoutTl407`; Q182, readings Q197): each text starts at
  the form's own size and shrinks in 0.5 pt steps to the map's minimum, measured with the
  embedded font's metrics (`TextMeasure`, from the PDF adapter). A table with more rows than the
  form fills all but its last form row, which reads "weitere siehe Anlage" in the marker column;
  that row and every later one go to the Anlage. A text too long for its box at the minimum
  size is cut at a word boundary with "… Fortsetzung siehe Anlage" (or "siehe Anlage" where that
  doesn't fit) and continues on the Anlage under its heading, a table cell under
  "<table>, Zeile n: <column>"; nothing is lost. Identifiers shrink but are never cut. A form
  without an Anlage (Kug 200b) leaves such a text blank for handwriting (`text_not_fitting`),
  which the pre-print checklist shows with the blank `*` fields (Q197).
- **The Anlage** (`renderAnlage` with `anlage-profilingbogen:v1`): "Anlage zum Profilingbogen
  (TL 407 08/2025)", name and birth date in the header of every page, "Seite n von m" in the
  footer, each continued table or text under its source heading; every value HTML-escaped. A word
  longer than its line breaks anywhere (headings, header, text, table cells) and tables have fixed
  column widths, so the printed PDF keeps every character; nothing is truncated or shrunk. It is
  appended to the TL 407 as one packet (`mergePdfs`) and takes the TL 407's strictest class.


## TL 407 generation as built (Slice 6, PR 6-3a)

The storage, access and retention rules are in data-protection.md, generated forms and the
readiness projection.

- **The check** (`checkTl407`): the version in use on the Berlin date of the request
  (`form_version_unavailable` without one), `validateFormInput` over `tl407Input` of the
  decrypted sources, the school designation (`schoolQualificationCheck`, Q196, Q198) and, without
  errors, the layout with its overflow per table and text (`FormLayout.overflow`). The unemployment
  period's reversed range is a warning here too (`range_reversed`, key `unemployedUntil`).
- **Confirmations by code** (`confirmWarnings`) for one readiness (`sourceToken`): a source changed
  since that readiness is `409 source_changed` at `/sourceToken` before any confirmation applies;
  each warning code the check raises must be confirmed, else `422` with the code at
  `/confirmWarnings`. The codes are the plausibility warnings and `school_qualification_none`, the
  explicit answer that the participant has no school qualification when no education row is
  marked, or none is recorded (the empty table stays blank then; never inferred; Q198, Q199). Only
  the confirmations the check asked for are recorded and audited (`warning_confirmed`).
- **Form-level refusals:** a form that can't be generated is `422` with its error codes, each once
  and without a field pointer (`form_version_unavailable`, `required_missing`,
  `character_unsupported`, …); the readiness names the fields.
- **The packet:** the filled and flattened TL 407 and, when something overflows, the Anlage
  rendered by `PdfRenderer.renderHtml` and appended (`mergePdfs`); without an HTML renderer
  (production before Gotenberg) a packet that needs an Anlage is `503 pdf_unavailable`, a form
  without one is generated in process.
- **The declaration snapshot:** the pending Jobbörse choice and BA contact declaration the form
  printed are stored with the generation (`form_generation`), so the review of a signed scan can
  record the paper "as printed" (signed TL 407, below).
- **Versions:** a generated form whose version is no longer in use shows "Neu erzeugen" before it
  is signed (Q188, derived); a signed form keeps its version (Q42).

## The signed TL 407 as built (Slice 6, PR 6-3b)

The storage, access and retention rules are in data-protection.md, signed scans, signed
declarations and quarantine; the track in process-and-lifecycle.md, the profiling record.

- **Upload** ("Unterschriebenen Bogen hochladen"): from a generated form of the participation
  (its version and printed declarations are known) or "Außerhalb der Anwendung ausgefüllt", the way
  out for paper signed before the platform and for a name the renderer can't print (Q197).
- **Review** ("Prüfen"): the participant's and the profiler's actual signature dates; both
  signatures and every page of the packet, the Anlage included; for external paper the registry
  version printed on it, an expired one included (a signed form keeps its version, Q42); the
  declarations as printed or as marked. The later signature date is the form's: the default and
  the earliest `profilingDoneOn` (Q191).
- **Wrong paper:** "Löschen" by the PL before the review; "Unter Quarantäne stellen" and
  "Quarantäne aufheben" (Q183); approved corrections follow with 6-8.

## The Kug 200b as built (Slice 6, PR 6-4b)

The storage, access and retention rules are in data-protection.md (generated forms, the signed
Kug 200b, declaration 17, exports); the offer and withdrawals in process-and-lifecycle.md, the
Kug 200b offer.

- **The check** (`checkKug200b`): the version in use on the Berlin date, `validateFormInput` over
  `kug200bInput`; an error (`character_unsupported`, `identifier_too_long`, …) refuses the
  generation (the external-paper path stays, Q197). A Kug 200b has no plausibility warnings.
- **The handwriting and clarification checklist** (Q197 (8)): every applicable `*` field left
  blank (`required_blank`, e.g. "11 Rentenversicherungsnummer" when it isn't recorded) and every
  text too long for its box at the 7 pt floor (`text_not_fitting`), left blank for handwriting
  rather than cut; by key and label, never a value. The generation answers it and stores it with
  the form; the tab and the work list show it before printing.
- **The print file:** the generated forms of a bulk generation are merged at the download of an
  export link (`kug200b_print`), never stored as one file.
- **The review** checks the completed paper: 16 and 17 ticked, the mandatory information
  completed (also what the checklist named), signed, and the date in field 19 (Q185).
