# Decisions — 2026-10-19, round 32 (Q101, Q102, Q103, Q105 and Q58 answered)

Answers given on 2026-10-19 in a working session with the product owner:

| Question | Answered by | Status |
|---|---|---|
| Q103 — the import contract | the PL, in person in the session | confirmed |
| Q101 — editing entry waves in use | the PL, in person in the session | confirmed |
| Q102 — individual TG dates | the PL (in person), legal and the BA process owner (provided by the product owner as their answers) | confirmed by all three |
| Q105 🔒 — retention classes of the person data | the DPO (provided by the product owner as the DPO's answer) | confirmed, with periods |
| Q58 🔒 — retention of project master data | the DPO (provided by the product owner as the DPO's answer) | confirmed |

The answers are recorded as given; where they differ from earlier rounds, round 32 wins. They
supersede the proposed package of [round 30](2026-10-17-answers-round-30.md), which was never
applied. Gates: PRs 2f and 2g may start (Q103); PR 2h may start (Q102), with the additions under
"What changes for PR 2h". Two follow-up points the answers leave open are Q110 (below); neither
blocks 2f or 2g.

## Q103 — Import contract (PL)

1. Add `addressCountry` using ISO 3166-1 alpha-2. It must come from a mapped column or an
   explicit whole-import country selection. Never infer it from the postcode.
2. For the MVP, accept German addresses only. Trim and compare country values
   case-insensitively, then store `DE`. Refuse rows belonging to another country.
3. Accept as Germany: `DE`, `DEU`, `Deutschland` and `Germany`, case-insensitively after
   trimming; normalise all to `DE`. Do not accept broader or fuzzy country-name variants.
4. When address data is imported, a country column or an explicitly selected whole-import country
   is mandatory. No country source is needed when no address is imported.
5. Refuse the complete row when an address is only partially populated. Street with house number,
   postcode, city and country form one unit; never silently discard a partial address. A
   completely empty address is allowed only when the project's address requirement has been
   formally relaxed.
6. A German postcode must resolve to exactly five digits.
7. Phone and mobile remain separate; never copy one into the other.
8. Invalid optional phone, mobile or email values are dropped with a warning; the rest of the row
   remains importable. Existing stored contact data is retained rather than cleared.
   Phone/mobile: trimmed length 6–30 characters; permitted characters digits, spaces, `+`, `/`,
   `-`, `(`, `)`; at least five digits; `+` only at the beginning, when present. Email: normal
   pragmatic validation, not an unusually strict RFC interpretation.
9. Text dates only as `TT.MM.JJJJ`, plus genuine Excel date cells. Midnight is a normal date
   representation; only a non-zero time component is an error.
10. Keep 15–67 as a plausibility warning, calculated at the Austrittsdatum. It must never be
    presented as an eligibility determination or block the row. No warning when the
    Austrittsdatum is legitimately absent.
11. An empty cell never clears an existing value; the preview identifies the retained existing
    value.
12. For an already matched participant, a non-empty changed value overwrites the stored value
    only after the PL sees old and new values and confirms the import. This never changes the
    Personalnummer itself: it is the match key.
13. Withdrawn or exited participations are not updated; their rows are skipped with a clear
    notice.
14. Participants missing from the file are counted only; never withdrawn, deleted or otherwise
    changed.
15. Personalnummer is mandatory and matched within the project. Trim only leading and trailing
    whitespace; matching stays case-sensitive and preserves leading zeros, punctuation and
    internal spaces.
16. Numeric Excel cells:
    - a numeric Personalnummer always blocks the row;
    - a numeric postcode that is an integer with exactly five digits may be converted to those five
      digits, with a warning;
    - a numeric postcode with fewer than five digits blocks the row (no guessing, no zero-padding);
    - a numeric phone or mobile value is dropped with a warning.
17. When no Personalnummer matches, an exact date of birth plus case-insensitive, trimmed first and
    last names make a `possible_duplicate`. No fuzzy name matching, never an automatic merge; the
    PL decides create or skip. A genuinely same person with a changed Personalnummer is corrected
    separately, never guessed by the import.
18. Limits for the MVP: 5 MB, 5,000 data rows, 50 columns, 500 characters per cell. An oversized
    real customer file is escalated, never silently truncated. Reassess with actual pilot files.
19. The header is not always in the first row (title or report-information rows are common). The
    PL selects **one header row from the first 20 rows**. One header row only; combined two-row
    headers are cleaned up before upload.
20. Automatic mapping suggestions, case-insensitive and tolerant of punctuation and spacing:

| Target | Suggested headings |
|---|---|
| Personalnummer | Personalnummer, Personal-Nr., Pers.-Nr., PersNr, Mitarbeiternummer, Mitarbeiter-Nr., MA-Nr., PERNR, Employee ID |
| Nachname | Nachname, Familienname, Name |
| Vorname | Vorname, Vornamen, Vorname(n) |
| Geburtsdatum | Geburtsdatum, Geb.-Datum, GebDatum |
| Austrittsdatum | Austrittsdatum, Austritt, Beschäftigungsende, Ende Arbeitsverhältnis |
| Straße | Straße, Strasse, Straße/Hausnummer, Strasse/Hausnummer, Anschrift Straße, Hausanschrift |
| Postleitzahl | PLZ, Postleitzahl |
| Ort | Ort, Wohnort, Stadt |
| Land | Land, Ländercode, Länderkennzeichen, Staat, Country |
| Telefon | Telefon, Telefonnummer, Tel., Festnetz |
| Mobil | Mobil, Mobiltelefon, Handy, Handynummer |
| E-Mail privat | E-Mail privat, Private E-Mail, E-Mail (privat) |
| E-Mail dienstlich | E-Mail dienstlich, Geschäftliche E-Mail, E-Mail geschäftlich, Firmen-E-Mail |

    `Anschrift` alone is never mapped automatically when it holds street, postcode and city in one
    combined value. All suggestions stay visible suggestions the PL confirms.

## Q102 — Individual TG dates

### PL

1. `tgStart` and `tgEnd` are contractual employment dates under the DSV, not the Transfer-KuG
   funding period; the application makes no entitlement calculation or promise.
2. As an MVP restriction, block effective DSV periods longer than twelve months; exceptional
   contracts are handled outside the MVP. A product-scope rule, not a statement that employment
   contracts are legally limited to twelve months.
3. Only a PL assigned to the project may set or change individual contractual dates; back office
   may not.
4. `tgStart`: a wave and `latestEntryDate` are required; never in the past; not after
   `latestEntryDate`; not before an open offer deadline; no change after TG entry; a missed start
   receives a genuinely new start date. **Correction:** today is not allowed as the new start when
   today's entry run has already completed, until automatic same-day reconciliation exists; until
   then the earliest permitted date is tomorrow. Once reconciliation exists, today may be allowed
   only if the reconciliation is triggered automatically, completes the same day and is visible
   and audited; it must never depend on the PL remembering a manual follow-up.
5. `tgEnd` is never set in the past. After TG entry, changing it requires a documented DSV
   amendment.
6. The amendment is recorded as (b): the signed date, an audited PL confirmation that the signed
   amendment is available, and an optional document/reference number. No unrestricted free text.
   Document upload isn't required for the MVP, but the metadata must later be linkable to the
   uploaded document. (Refined by legal L4 below.)
7. Clearing an individual date falls back to the wave default and must pass every rule against the
   resulting effective dates; after TG entry it stays subject to the same entry and amendment
   restrictions.

### Legal

- **L1.** `tgStart` and `tgEnd` are the inclusive contractual dates of employment with the
  Transfergesellschaft under the DSV, not the individual Transfer-KuG entitlement or funding
  period. `tgEnd` is the agreed contractual end; an earlier actual departure is recorded separately
  as `exitDate`. The application must not derive or promise Transfer-KuG entitlement from these
  fields.
- **L2.** No legal objection to supporting only DSV periods of up to twelve months, with explicit
  wording: longer contracts are **unsupported by the MVP**, never described as unlawful or
  ineligible. Longer Transfergesellschaft contracts can legally exist (BAG proceedings include a
  24-month Transferarbeitsverhältnis); §111 SGB III limits Transfer-KuG, not every possible
  employment contract. Manual handling outside the application must still retain the necessary
  employment, payroll and BA records.
- **L3.** An extension of `tgEnd` requires: (1) an amendment agreed before the current contractual
  end; (2) the new end date stated unambiguously; (3) paper written form for the MVP; (4)
  signatures of the participant and the Transfergesellschaft; (5) the former employer's signature
  too when the DSV, financing agreement, Sozialplan or that employer's obligations are affected;
  (6) confirmation that the fixed-term basis and the financing continue to support the extension.
  By default all original DSV parties are required, unless the approved DSV template explicitly
  sets a different rule. Employment must not continue beyond the old end while signatures are
  awaited (an ineffective extension risks an indefinite employment relationship under §§14–16
  TzBfG). **A shortening never uses the ordinary `tgEnd` amendment**: it is an early-termination
  case for the cancellation/exit workflow (a signed termination agreement complying with §623 BGB,
  or the exercise of an existing contractual Sprinter/early-exit right in its required form).
  Electronic form is excluded for an agreement terminating employment under §623 BGB.
- **L4.** The application record (no document upload yet) holds: `fullyExecutedOn` (the date the
  last required party signed); the amendment type (extension; shortening belongs to the exit
  workflow); an audited PL confirmation that the original was inspected or received, all required
  parties signed and the original remains retrievable; a structured storage/location reference
  (e.g. `paper_personnel_file`); an optional external document number; the old and new
  contractual dates (already in the audit). No unrestricted evidence free text. The record is
  operational evidence only and doesn't replace the signed original.
- **L5.** Extension checks: `fullyExecutedOn ≤ today`; `fullyExecutedOn ≤` current `tgEnd`; new
  `tgEnd >` current `tgEnd`; new `tgEnd ≥ tgStart`; the amendment exists before anyone works
  beyond the old end; the resulting period satisfies the twelve-month support limit. Early
  termination: the dedicated cancellation/exit operation; its effective date today or later, never
  retroactive through ordinary editing; the paper agreement or valid written exercise of an
  existing exit right complete no later than the effective date. A date shown incorrectly despite
  an already valid historical document is a correction; a document created later can't
  retroactively cure a missing agreement.
- **L6.** A new start after a missed start requires a documented DSV amendment, fully executed
  before the new start, by all original DSV parties by default (a DSV normally also terminates the
  former employment). The new date must preserve the direct transition: the former employment ends
  immediately before the new TG employment begins, no actual unemployment occurs between them, and
  all pre-entry BA requirements stay satisfied. If the former employment already ended and a gap
  has arisen, it is not an ordinary late entry: mark it **`ba_review_required`** and obtain a
  recorded BA/legal determination.
- **L7.** Past dates are corrected only through the audited Slice 7 correction/reconciliation
  process, supported by contemporaneous documents and four-eyes review. A correction preserves the
  previous value, doesn't itself create contractual validity, doesn't automatically change
  Transfer-KuG eligibility, claims or payments, and needs separate reconciliation where a BA
  submission or payroll period was affected.

### BA process owner

- **B1.** For staged entry into an existing beE, the participant has only the remaining duration of
  that beE; an independently established later beE can have its own full duration. The
  application never displays "twelve months from `tgStart`" as an entitlement.
- **B2.** The twelve-month DSV limit is accepted as a conservative MVP restriction. It is not a
  Transfer-KuG calculation and must not be used as one: funding depends on the recognised beE
  period, individual prerequisites, entry date, exclusions and the Agentur's decision.
- **B3.** Relevant date changes enter the BA reporting process. Current BA materials: the planned
  individual residence in the beE is supplied with the initial participant information; Kug 208
  holds späterer Eintritt / Wiedereintritt and vorzeitiger Austritt with the date; Transfer-KuG is
  claimed monthly; the application and Kug 208 reach the Agentur within three calendar months
  after the affected month; corrections stay possible under the BA correction procedure before
  the final decision is binding. Operational decision:
  1. new start before any participant information was submitted: the corrected date goes into the
     initial submission;
  2. new start after the initial submission: a later entry; notify/update the responsible Agentur
     through its approved channel and include it correctly in Kug 208 for the affected month;
  3. earlier end: reported as vorzeitiger Austritt;
  4. extended contractual end: notify the responsible Agentur promptly when its previously reported
     planned residence changes, and always before claiming any newly affected month.

  No universal public rule prescribes one immediate standalone form; the channel stays
  Agentur-specific. **PR 2h creates an immutable reporting task whenever a contractual date
  changes**: `reportingKind` `later_entry`, `planned_end_changed` or `early_exit`; `status`
  `pending`, `reported` or `not_required`; `reportedOn` and channel/reference only when reported.
  Transmission may come with the Agentur-submission slice, but the pending task is created now.
  Project closure and the relevant monthly claim are blocked while a required report is pending.
- **B4.** `latestEntryDate` and "tomorrow after today's run" are acceptable conservative
  operational limits, not the complete BA requirements. Before a late entry, verify: an
  uninterrupted transition from the former employment into the beE; no actual unemployment gap;
  Arbeitsuchendmeldung before entry; profiling before entry unless a documented permitted
  exception applies; inclusion in the relevant Betriebsänderung and beE; the remaining recognised
  term of the beE; the necessary participant information supplied to the responsible Agentur; no
  claim for days before actual entry. A person whose former employment has ended with an
  intervening unemployment gap is `ba_review_required`, never automatically admitted to
  Transfer-KuG.

## Q101 — Editing entry waves in use (PL)

1. Confirmed: `signingDeadline ≤ defaultTgStart ≤ latestEntryDate` and
   `defaultTgStart ≤ defaultTgEnd`.
2. Confirmed: a new or changed latest entry date is never in the past; once the cutoff has passed
   it can't change.
3. Confirmed: a wave's signing deadline can't change while open offers depend on it.
4. Confirmed: once a default TG start has been reached it can't change; exceptional late entrants
   get individual future start dates.
5. Confirmed: a date can be cleared only while nobody is assigned to the wave, and an active project
   always keeps at least one latest entry date.
6. No deletion in Slice 2. An unused mistaken wave may be corrected and reused. If experience shows
   a need, introduce an audited archive operation later, never physical deletion. A wave that ever
   had participants or offers is never deleted.

## Q105 and Q58 — Retention (DPO)

- **D1. Classes and periods.** Both classes are confirmed.
  - `participation_record`: first name, last name, date of birth, Personalnummer, lifecycle and
    contractual dates, the minimum identity retained in the evidence set. Retention: (1) a
    non-signer with no fully executed DSV and no funded §110 participation: deleted 90 calendar
    days after `withdrawnOn`, unless a legal hold or documented dispute applies; (2) a fully
    executed DSV but no TG entry: until the end of the third calendar year after documented
    cancellation or contractual end; (3) a TG participant: the ordinary operational record until
    the end of the third calendar year after exit; (4) a BA-funded participant: after ordinary
    deletion only the defined minimum evidence set, until the end of the fourth calendar year after
    the later of `kugFinalSettlementDate` and `measure110SettlementDate`. The evidence set never
    expires while a required settlement date is missing.
  - `personnel_file`: street and house number, postcode, city, `addressCountry`, phone and mobile,
    private and work email, `oldEmploymentEndDate`. Retention: (1) a non-signer without an
    executed DSV or funded measure: 90 days after `withdrawnOn`; (2) a TG participant or an
    executed employment arrangement: until the end of the third calendar year after exit,
    cancellation or contractual end; (3) then the entire class is deleted unless a field was
    copied into a separately classified payroll, accounting or legal record; (4) `personnel_file`
    is never part of the long-lived BA evidence set.
  - A legal hold suspends only the affected records, not the whole participant profile. Work email
    stays prohibited as a login identifier.
- **D2.** `addressCountry` is personal data, confidential, part of the structured address,
  retention class `personnel_file`; it is not nationality or citizenship and not a special category
  under Art. 9 GDPR.
- **D3.** The DSV amendment metadata (with legal's L4): data class confidential, retention class
  `participation_record`, part of the evidence set, never in ordinary participant lists or customer
  exports. Store only `fullyExecutedOn`, the amendment type, the old/new date references, the PL
  confirmer and confirmation time, a controlled original-location value and an optional document
  reference. The signed document itself is an `employment_contract` document: highly confidential,
  encrypted when uploaded, immutable, separately access-controlled. Retention: the longer of the end
  of the third calendar year after exit, or the evidence-set deadline (the later final settlement
  year plus four years).
- **D4. `project_master` (Q58).** While a project is active or unsettled: retained. After closure:
  until the later of the end of the third calendar year after closure and the end of the fourth
  calendar year after the later BA/§110 final settlement date. A draft that was never activated,
  never contained participants and was never submitted externally: deleted one year after its last
  activity. At expiry: delete or pseudonymise staff membership links and actor references as the
  audit policy specifies; delete customer free text and other identifying metadata without a
  purpose; keep templates or configuration only if they are genuinely non-personal reference data.
  Accounting vouchers, payroll records, contracts and tax records use their own 6-, 8-, 10-year or
  social-security retention classes and never extend every `project_master` item merely because
  they relate to the same project.

The periods are recorded in `data-protection.md`; the data catalog keeps `unset` in code until the
retention job (Slice 7) encodes them, so no deletion runs before then.

## Implementation consequences (as stated with the answers)

These decisions are conservative enough to unblock PR 2h, with these changes:
1. New starts require a fully executed DSV amendment.
2. A gap after the former employment produces `ba_review_required`.
3. Ordinary `tgEnd` editing supports extension only.
4. Shortening uses the cancellation/exit workflow.
5. Amendment metadata includes the required-party and original-location confirmation.
6. Every relevant date change creates a durable BA-reporting task.
7. Past corrections remain Slice 7 only.

## Follow-up: Q110 (open, before PR 2h; doesn't block 2f/2g)

The answers leave two details of 2h open; each gets a fail-safe reading:
- (a) **Date changes after the DSV is signed but before TG entry.** L3/L5 cover `tgEnd` after entry
  and L6 a new start; a `tgStart` or `tgEnd` change of a participation whose DSV is already signed
  but who hasn't entered isn't named. Fail safe: once the DSV is signed, every individual date
  change needs a fully executed DSV amendment (L6's rule applied to both dates).
- (b) **The controlled original-location values** (L4, D3). Only `paper_personnel_file` is named.
  Fail safe: that single value until the list is set.

## Applied

This docs-only PR: this record; Q101, Q102, Q103, Q105 and Q58 confirmed and Q110 added in
`open-questions.md`; the plan's readings (R4, R5, R6, R8, R23–R25), the gates, sections 5.1, 5.2,
5.6, 5.7, 5.10, 5.11, 8, 9 and the PR series (2h grows: the amendment record, `ba_review_required`,
the BA reporting tasks); `data-protection.md` (the person-data classes and the retention periods)
and `process-and-lifecycle.md` (what the TG dates mean, the amendment and reporting rules). The
schema, field catalog and code change in PRs 2f, 2g and 2h.
