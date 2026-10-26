# Slice 6 — Profiling & forms (F6)

Status: **approved** 2026-10-24 by the product owner for development on synthetic data (PR #87,
[the product review](../reviews/2026-10-24-pr-87-product-review.md) of `e73b312`), with the
review's amendments carried in this revision: external paper forms, quarantine and approved
corrections of wrong evidence, the complete ASU fact's recording instant, both exception-evidence
sources, immediate compliance escalation, the statutory ASU branches, the official Kug 200a, the
meaning of Kug 200b declaration 17, the health-detail gate, signed declarations bound to the paper,
the readiness projection, the export lifecycle and the working copies' expiry. Q176 is resolved
(the blanks are in `packages/forms`); Q177–Q194 carry the review's answers (`accepted`; Q181, Q182
and Q185 `verify` for their Agentur or legal check; 🔒 rows still need their DPO confirmation
before the pilot). Q195 (the Kug 200a blank) is confirmed since its blank was committed and
checked in PR 6-1, which also opened Q196 and Q197; PR 6-2 recorded its readings as Q198. 6-3 came to
about 4,200 lines and splits into 6-3a and 6-3b (the owner's choice, 2026-10-26); 6-3a recorded its
readings as Q199. Q1 stays `verify`. This is not an external DPO, legal, works-council or Agentur
confirmation.
Roadmap: Arbeitsuchendmeldung (ASU record, due date, Kug 200b, batch export), profiling screen,
`packages/forms` with TL 407 and Kug 200b (ADR-0009), the PDF adapter (pdf-lib + Gotenberg behind
`PdfRenderer`, ADR-0006), the overflow attachment, scan upload, Agentur submission status; from
Slice 2 sending BA reports (`reported` / `not_required`; process-and-lifecycle.md, BA reporting).
Builds on: the profiling track and its guards (`canTransition`, the status service,
`apply_status_change`), the guard-facts provider (`apps/api/src/participations/guard-facts.ts`,
fail-closed today), the documents of Slice 4b (catalog, encryption, `document_link`, the logged
opening), the sensitive-field storage of Slice 4a (`pgp_sym_encrypt`, logged reads), the
completeness engine and the resolver (`agentur_submission` and `asu_registration` blockers), the
consent records (`paper_form` source, Q138), the profiling-exception requests of Slice 1, the work
list's deadlines and items, the audit history (`auditProjection`, `audit_event_projection`),
`ba_reporting_task` (PR 2h-3) and the participant page's tabs.

## Decisions

### Forms and PDFs

- **D1. The form registry** (`packages/forms`, ADR-0009). One folder per form version,
  `templates/ba/<form_code>/<version>/`: `blank.pdf` (the BA's download, unchanged),
  `source.json` (provenance as committed: URL, retrieval date, SHA-256, pages, field count; Q176),
  `manifest.json` (`formCode`, `version`, `validFrom` and `validUntil` from a reviewed source or
  `null`, never derived from the printed version month, Q188; the PDF's SHA-256 equal to
  `source.json`'s) and `field-map.json`: our input key → AcroForm field, its kind (text, date
  `TT.MM.JJJJ`, time `hh:mm`, radio with the value map, checkbox with its on-state), whether the
  form marks it `*` and when it applies (`applies: ta_tg` for the beE dates, Q181), whether it is
  an identifier (never truncated or overflowed, Q180), the fixed row tables and the fields we never
  fill (the Vermerke, the signatures). Form codes `tl407`, `kug200b` and, once its blank is added,
  `kug200a` (Q195). A test checks every map against its PDF (each field exists, kinds and states
  match, no field unmapped except the never-filled and handwritten ones); `pnpm generate` writes
  the forms manifest, CI checks it like the template manifest, and the immutability check compares
  every merged version by hash (`scripts/check-template-immutability.mjs` covers both).
- **D2. Which version is used** (Q188): generation uses a version in use on the Berlin date of the
  request (`validFrom` null or `≤ today`, `validUntil` null or `≥ today`); none is
  `form_version_unavailable`. A new version gets its folder and the previous one its reviewed
  `validUntil`. An unsigned generated form of an expired version shows "Neu erzeugen" (derived); a
  signed form keeps its version (Q42). Every generated document and every scan records `formCode`
  and `formVersion`; an expired version is not a claim that an Agentur rejects it (D26).
- **D3. `PdfRenderer`** (`packages/adapters/src/pdf`, ADR-0006): `fillForm({ template, fieldMap,
  values })` fills the AcroForm with pdf-lib in process and flattens it, with a committed subset of
  Noto Sans (OFL) embedded through `@pdf-lib/fontkit` for the appearance streams, so names outside
  WinAnsi (`Ł`, `ğ`, `ș`) print; `renderHtml({ html })` is Gotenberg's Chromium route
  (`PDF_ADAPTER=gotenberg`, `GOTENBERG_URL`, a cluster-internal service: no third party sees the
  data); the mock renders the same structured document with pdf-lib text and no network. Merging
  PDFs and turning a JPEG/PNG scan into a page are pure pdf-lib helpers of the package. Production
  wires no mock: what needs HTML answers `503 pdf_unavailable` without Gotenberg; generation stores
  documents, so it also needs the store (`503 storage_unavailable` until Q149). Contract tests fill
  each real blank, read every value back from the unflattened fill (special characters included)
  and check the flattened output's page count; a Gotenberg contract test runs against
  `GOTENBERG_URL` (a CI service container), skipped without it.
- **D4. `Exporter`** (`packages/adapters/src/export`): versioned CSV (`;`, UTF-8 with BOM, a header
  row, quoting; a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading
  `'`, as Q159 requires).
- **D5. Validation before rendering** (`packages/domain/src/forms/`, no I/O, no system time): the
  form input is built from domain data (`tl407Input`, `kug200bInput`) and checked against the field
  map (`validateFormInput`): an impossible date or time, a time pair with `bis` before `von`, an
  identifier that doesn't fit its field, and a missing **applicable** `*` field of the TL 407
  (signatures are paper's, the Agentur's fields excluded, the beE dates only in `ta_tg`; Q180,
  Q181) are **errors** that refuse generation; the plausibility checks are **warnings** staff
  confirm by code (age 15–67 at the effective TG start, else at today; entry to Germany before the
  birth date; a date range with `von > bis`), each confirmation audited `warning_confirmed`. The
  formatted output is checked again (real `TT.MM.JJJJ` dates), so the month-14 fixture is a hard
  error. A Kug 200b may be generated with blanks (D7).
- **D6. Overflow and the Anlage** (Q41, Q182): sessions chronological; education with the highest
  school qualification first, then vocational and university, most recent first; jobs of the last
  three years before the generation date, most recent first; languages in their order (German
  first, not a row). When a table has more rows than the form (4 sessions, 5 education, 7 jobs, 4
  further languages), its last form row reads "weitere siehe Anlage" and every row from that one on
  moves to the Anlage, the displaced row included. A free text longer than its box at the minimum
  font size (measured with the embedded font) is cut at a word boundary with "Fortsetzung siehe
  Anlage" and continues there without loss. Identifiers never overflow. The Anlage is our own HTML
  template `anlage-profilingbogen:v1` (`packages/forms/templates/own/`, versioned, hash-checked):
  name and birth date on every page, "Anlage zum Profilingbogen (TL 407 08/2025)", page "n von m",
  each continued table or text under its source heading; the whole Anlage takes the TL 407's
  strictest class. It is appended to the generated TL 407 as one packet, previewed and signed
  together, and the review checks the packet's pages (D17).
- **D7. What is filled** (Q180, Q181).
  - TL 407: `chbxParagraph110` in `ta_only`, `chbxParagraph111` in `ta_tg` (regional-variation.md);
    the Vermerke never; the Träger (section A) is the actual delivering legal entity from new
    organisation-configuration keys (`transfergesellschaft`: name and address; synthetic in the
    repo), never the old employer; names and birth date from the identity; the expected stay in the
    beE from the effective contractual `tgStart`/`tgEnd` in `ta_tg`, **blank in `ta_only`** (never
    measure dates, old-employment dates or invented TG dates; an Agentur check before live §110
    submissions, Q181); the sessions; section B from the profile, the contact fields and the
    sensitive tables (read inside the generation, each field audited `sensitive_read`); phone,
    mobile and email only when the TL 407's own BA contact declaration is `yes` (never the portal
    consent); the Jobbörse choice; the unemployment period; section C without health narrative
    (D13) and p. 7. Signature places and dates stay blank.
  - Kug 200b: 1 the TG's name, 2 the project's customer, 3–8 name and address, 9 Familienstand,
    10 nationality, 11 RV-Nummer, 12 Schwerbehinderung/Gleichstellung; 13–15 (voluntary contact
    data), the declarations 16 and 17 and place and date 18–19 stay blank: the participant ticks,
    writes and signs by hand. Missing data stays blank for the participant to write; staff see the
    blank `*` fields before printing, and the review checks the completed paper (D17).
- **D8. Generated forms are documents** (Q179): types `tl407_form` (6-3a) and `kug200b_form` (6-4),
  unsigned, immutable, of the signed type's access category and class, stored encrypted like every
  file, named `tl407-<date>.pdf` on download, opened only through the logged opening. Each keeps
  its **provenance**: form code and version, the generation's id, the revisions of the profile,
  sessions and assessment it was built from, and the **declaration snapshot** it printed (the
  Jobbörse choice and the BA contact declaration). Who generates: the TL 407 the assigned consultant
  (the profiler, who alone reads section C; Q49); the Kug 200b the PL or the assigned consultant
  (the PL may open the signed Kug 200b, Q49), the PL also for 1–100 participations at once (all or
  nothing, one print file, D24).
- **D9. The working copies expire** (Q179, ADR-0008): a new class `form_working_copy`. The file is
  deleted 30 days after a newer generation supersedes it or its signed scan is accepted; a sole
  unsigned form 90 days after its generation (abandoned); every working copy of a participation 30
  days after its terminal status; a legal hold suspends each. The row stays as a tombstone with its
  provenance and its scans' links. Proposed periods awaiting the DPO; executable periods `unset`
  until the Slice 7 retention job.

### Profiling

- **D10. The tab "Profiling"** (staff app, normal mode): the profiling status and its actions
  (D11); the sessions (D12); section B as the tab "Selbstauskunft" shows it (the viewer's rights;
  sensitive answers as "angegeben / fehlt"), with "Im assistierten Modus ergänzen": staff write
  self-service fields only in assisted mode (Q136), and the participant is present during
  profiling; for the assigned consultant (profiler only) the unemployment period, section C and
  p. 7 (D13) and the pending declarations to the BA (D15); the TL 407 readiness (D16), generation,
  the generated forms and scans, the review, the Agentur submission (D26). The PL sees the
  sessions, the statuses, the readiness of D16 and the documents' metadata, never section C (Q49);
  back office has no tab.
- **D11. Profiling track actions** (`POST /participations/{id}/profiling-status`; Q60: the PL and
  the assigned consultant, normal mode): along the edges of the
  [transitions table](../domain/generated/lifecycle-transitions.md) through the status service and
  `apply_status_change`, with track activity as built (also forward and a refusal while
  `active_in_tg` under an approved exception, Q74). `profiling_done` needs `tl407_signed` (an
  accepted, unquarantined TL 407 scan, D17) and `profilingDoneOn`: not before the later actual
  signature date (the default), never in the future; the recording instant stays separate, so late
  evidence changes no past scheduled-entry snapshot (Q191). Recording a session doesn't move the
  track. `profilingDoneOn` feeds the Transfer-KuG outcome as built (`transfer-kug.ts`, Q82, Q86);
  this slice shows no outcome.
- **D12. Profiling sessions** (Q193): date, from, to (`hh:mm`, from < to, a date not in the future,
  no overlap on one day); written whole with the record's revision by the assigned consultant; the
  PL reads them. Each change audited per session. A booked consultation (Slice 5b) is never a
  session by itself. `profilingSessions` is evidence-set data (Q88): `participation_record`.
- **D13. Section C, p. 7 and the unemployment period** (Q85, Q192): encrypted like the sensitive
  self-service fields, one table per access category and retention class.
  - Section C's ratings (`kein` / `vermittlungsrelevant` per line) and texts, the "andere" lines'
    labels, Gesamteinschätzung and weiteres Vorgehen: highly confidential, `profiling_assessment`,
    `personnel_file`; a line 300, p. 7 2,000 characters each.
  - **The health line keeps its rating only** (special category, `profiling_assessment`,
    `health_record`, Q40): health detail beyond yes/no needs the explicit-consent contract of
    data-protection.md (legal basis), which doesn't exist yet, so this slice stores no health
    narrative and leaves that text field blank on the generated form. Neither the TL 407 signature
    nor the portal consent stands in for it. Profiling works without it: the rating and the yes/no
    answers are lawfully available.
  - The unemployment period beside the residence and social answers: highly confidential,
    `residence_social`, `personnel_file` (Q85 stays open, fail safe), written by the assigned
    consultant, read like the group's other fields (also back office), never in the PL's readiness.
  - Only the assigned consultant reads and writes section C, each field audited
    `sensitive_write` / `sensitive_read`.

### Signed paper

- **D14. Scans and their origin** (Q183, Q184, Q185): a signed scan (`tl407_signed_scan`,
  `kug200b_signed_scan`) is PDF, JPEG or PNG under the Slice 4b limits, virus-scanned before
  storing, added by the assigned consultant or the PL (normal mode), never by back office or the
  participant. Its origin:
  - `generated`: printed from a generated form of the same participation and form
    (`generationDocumentId`), so its version and the declaration snapshot are known;
  - `external_paper`: a form completed outside the app (also before the platform); the reviewer
    names the form code and a registry version (an expired one included) on acceptance. Nobody is
    asked to regenerate or re-sign for the app's bookkeeping.
- **D15. Signed declarations bind to the paper** (Q185, Q193; ba-forms.md, declarations to the BA):
  the profiling record holds **pending** declaration values, editable until a signed form is
  accepted; acceptance writes an immutable `signed_declaration` (the values actually marked on the
  paper, the form code and version, the signature date, the scan) and never rewrites an earlier
  one; a later edit is pending again until the next signed form. For a `generated` scan the
  reviewer confirms the paper matches the generation's snapshot or records what the paper actually
  shows; for `external_paper` the reviewer records the declarations as marked. Kug 200b
  declarations 16 and 17 are recorded as signed declarations too.
- **D16. The readiness projection** (data-protection.md, access matrix; ADR-0010): the TL 407
  readiness response is built per viewer, and unauthorized properties are absent from it, not
  hidden by the UI.
  - The assigned consultant: every error and warning code, the overflow per table and text; the
    decryptions it needs are audited `sensitive_read`.
  - The PL: `ready` or not, and the missing applicable fields they may know about (presence flags
    only, no decryption); no warning and no overflow detail, since both can derive from section C or
    the sensitive answers.
  - Others: `403`.
- **D17. The review** (Q184, Q185): once, normal mode, the assigned consultant or the PL.
  - TL 407: acceptance records the participant's and the profiler's actual signature dates (≤
    today; for `generated` not before the generation), the confirmation that both signatures and
    every page of the packet (the Anlage included) are present, and the signed declarations (D15).
    It gives the fact `tl407Signed` (`validOn` the later signature date, `recordedAt` the
    acceptance).
  - Kug 200b: acceptance needs the confirmation that **16 and 17 are ticked and the form is
    signed** and that the mandatory information is completed on the paper; it records the date
    written in field 19, the signed declarations and the offer's outcome `signed`. Declaration 17
    is an acknowledgement of selective access: it is recorded as written. For compatibility it is
    also a `consent_record` with purpose `kug200b_profile_access` (source `paper_form`, text version
    `Kug 200b 09/2021`, `de`, given on that date, recorded by the reviewer); whether it is a GDPR
    consent and what a withdrawal effects stay a DPO/legal check (Q185 `verify`).
  - A rejection keeps the reasons `unreadable`, `wrong_document`, `incomplete`; a new scan follows.
- **D18. Wrong paper and mistaken acceptance** (Q183):
  - before the review the PL may delete a scan with `wrong_person` or `wrong_file` (tombstone kept,
    object purged at once);
  - **quarantine, at once:** the PL or the assigned consultant quarantines a document suspected of
    belonging to another person or wrongly accepted (`document_quarantined`, a closed reason). A
    quarantined document opens for nobody (break-glass only), supplies no fact to any future
    evaluation (a past snapshot stays as it was) and counts nothing in completeness; whoever
    quarantined it or the PL may lift it (`document_quarantine_lifted`) while no correction is
    pending;
  - **approved correction:** invalidation or supersession goes through D29; an accepted document is
    never edited or deleted by ordinary operations. No lifecycle status is reversed silently: a
    status that rested on invalidated evidence stays and shows the flag `evidence_invalidated` for
    the PL to resolve (a new signed form, or the existing correction and reconciliation rules).

### ASU and Kug 200b (`ta_tg` only, Q89)

- **D19. The ASU record** (`asu_registration`, Q186): one per participation, its registrations
  append-only.
  - The **route** (`kug_200b`, `online_self`, `in_person`), set by the PL or the assigned consultant;
    the form preselects the placement Agentur's `defaultChannel` (never a blocker, round 14).
    Changeable until a registration is recorded; an entry error is corrected (D29), not by a new
    route or a duplicate registration.
  - A **registration** keeps four things apart: the route, the **actual registration date**
    (`registeredOn`), the **proof** and the **recording instant** of the complete fact. On
    `kug_200b` the registration is the batch submission (D25), `registeredOn` its actual sent date.
    On `online_self` / `in_person` it is recorded with `registeredOn` and its proof: an accepted
    `asu_proof` document (a BA confirmation the assigned consultant reviewed, confirming it belongs
    to the participation and supports that date) or the PL's **attestation**: the BA-Kundennummer
    (encrypted beside the RV-Nummer, write-only for the PL, `sensitive_write`; read by the assigned
    consultant and back office) together with the registration date and where it was verified
    (`ba_document_inspected`, `ba_online_account_inspected`, `ba_confirmed_by_phone`): a customer
    number alone says nothing about when the person registered (Q184, Q186).
  - The fact `asuRegisteredWithProof`: `validOn` the actual registration date; `recordedAt` the
    instant the **complete** registration-with-proof was committed, i.e. the later of the
    registration and the link of its accepted proof (a proof accepted yesterday and linked today is
    recorded today), and for a correction its approval (D29). A quarantined or invalidated proof
    supplies nothing.
  - The **Agentur confirmation** (`confirmedOn`, optional, route `kug_200b`) is follow-up work: none
    14 days after the submission (`kug200bConfirmationFollowUpDays`) is the item
    `kug200b_confirmation_missing`; it never negates the registration.
- **D20. The Kug 200b offer** is separate from the ASU proof (round 14): offered = a generated
  Kug 200b exists or an external paper was received; outcome `signed` (accepted scan) or
  `declined` (recorded by the PL or the assigned consultant with the date). On another route an
  open offer is the item `kug200b_offer_open`, never a guard. A written withdrawal of the
  declaration that reaches the TG is recorded by the same roles with the date received
  (`consent_ended`, `revoked`) and opens the item `kug200b_withdrawal_ba_notice` until "BA
  informiert am" is recorded: the platform never claims BA-system access was disabled. Neither a
  declined offer nor a withdrawal erases or weakens a valid ASU registration.
- **D21. Completeness** (base defaults version 3, regional-variation.md): the rule language gains
  an optional `when` on `documentPresent` (the shape of `requiredIf`'s, a narrow applicability
  condition, round 14; the JSON Schema regenerated, old layers stay valid); a new field
  `asuChannel` (`case_internal`, listable); two `asu_registration` rules, `ta_tg`, basis `ba_form`,
  applying only while `asuChannel` equals `kug_200b`: `base-kug200b-rv-nummer` (`requiredIf`
  `pensionInsuranceNumber`) and `base-kug200b-signed-scan` (`documentPresent`
  `kug200b_signed_scan`, accepted). `base-asu-proof` keeps its shape; the engine's state for
  `asu_proof` comes from the ASU record (accepted once a registration with proof exists, any
  channel; `uploaded` while an `asu_proof` document awaits review), so the attestation and the
  batch submission satisfy it without a file.
- **D22. The ASU due date** (§38(1) SGB III; Q1 `verify`, Q177, Q178):
  - **The formula is corrected to the statute's two branches** (`asuDueDate` in
    `packages/domain/src/dates.ts` and process-and-lifecycle.md, dates): with the reference date
    `end − 3 months` (month end clamped), knowledge on or before it → due on the reference date;
    knowledge after it (less than three months before the end) → due 3 days after the knowledge.
    The unconditional maximum wrongly gave 01.04.2027 for an end on 30.06.2027 and knowledge on
    29.03.2027 (due 30.03.2027). Calendar, boundary, weekend/holiday and unusual cases stay under Q1.
  - `knowledgeDate` is the individual's fact (`personnel_file`, confidential): an optional import
    target and an audited PL correction; never inherited from a wave or project (a confirmed bulk
    entry may come later).
  - The deadline `asu_due` appears only with a knowledge date: in `ta_tg`, before `active_in_tg`,
    non-terminal, while no registration with proof exists. Without a knowledge date the row shows
    the item `knowledge_date_missing` with the reference date as a labelled orientation and
    "Kenntnisdatum klären", never as overdue. Informational; **no automatic reminder** until Q1 is
    confirmed (Q152). The UI never says that `ta_only` participants have no duty to register.
- **D23. Real guard facts** (`dbGuardFacts`, replacing `failClosedFacts` for the facts it reads):
  `tl407Signed` and `profilingDone` (6-3b), `asuRegisteredWithProof` (6-4), the exception evidence
  (6-7); each excludes quarantined and invalidated evidence and carries the database instant of the
  complete fact (the snapshot rule). The DSV facts stay fail closed until Slice 7, so no
  participation enters the TG on real facts before it; the seed overlays its synthetic facts.

### Agentur submissions

- **D24. Exports** (data-protection.md, exports; Q159): an export is issued by a logged request
  (`export_created`) that returns a link valid 60 seconds for the asking session; the download
  **re-authorizes the viewer and every included document** (each still accepted, unquarantined, of a
  participation the viewer may act on), streams the output rendered at that moment from immutable
  inputs (a frozen batch, generated documents), stores no export file, and is audited itself
  (`export_downloaded`). Bounded: a batch ≤ 200 members, a print file ≤ 100 forms.
- **D25. Kug 200b batches** (Q45, Q91, Q187, Q195), the PL only (back office never opens a signed
  Kug 200b, Q49):
  - per placement Agentur of a `ta_tg` project; refused without a placement Agentur, with the
    `asu_registration` step blocker (`batchSubmissionChannel` unset, also when its template is
    missing; Q91) and for a form version the Agentur rejects (D26);
  - candidates: accepted, unquarantined Kug 200b scans not in a live batch and not submitted; a
    batch takes 1–200, all or nothing, its membership fixed;
  - **the submission artifact:** the official **Kug 200a** (07/2025) filled from the registry
    (D1; the BA guidance of 4 May 2026, section 2.13(12), names it beside the Kug 200b), unless the
    Agentur's acceptance of an alternative cover list is recorded as an Agentur-scoped setting with
    source, confirmer and date (regional-variation.md, Agentur-scoped settings). The sensitive values
    the Kug 200a needs follow D24 (logged, re-authorized, streamed) and their own field map; which
    values it holds is read from its blank (Q195). For `scan_email` and `upload` one PDF of the
    members' scans follows the Kug 200a; for paper channels the Kug 200a goes with the originals;
  - **the operational index** (the batch's members, last name, first name, form version, CSV) is the
    PL's working list, never sent as the official artifact;
  - before an export and before "Übermittelt am" the batch is **rechecked**: the PL's authority, each
    scan still accepted and unquarantined, the member's placement Agentur and route unchanged, the
    member non-terminal; any failure refuses with the rows (`batch_stale`), and the PL discards and
    rebuilds. A terminal member stays in the historical batch but never receives a new registration;
  - "Übermittelt am" records the actual sent date (≤ today, not before the batch) and the recording
    instant: each member's submission and, on the `kug_200b` route, its ASU registration (D19).
- **D26. TL 407 submission** per participation, the PL (Q54, Q92, Q188, Q189): after an accepted,
  unquarantined TL 407 scan; refused without a placement Agentur or with the `agentur_submission`
  blocker (all four settings, Q92). The channel is the resolved `submissionChannel`. With
  `originalRequired` the item `tl407_original_missing` stays until "Original versandt am". At the
  actual submission a signed form whose registry version has expired is refused
  (`form_version_outdated`) only when the Agentur's resolved `rejectsOutdatedFormVersions` is
  `true`; the same setting governs the Kug 200b in a batch. Every attempt is kept: an Agentur's
  rejection (`outdated_form_version`, `incomplete`, `other`, its date) reopens the work
  (`tl407_resubmission_open`) until a new submission; it never invalidates the signatures or the
  completed profiling, and a version rejection prompts the form owner's check (ADR-0009).
- **D27. Deadlines, items and escalation** (process-and-lifecycle.md, profiling track):
  - deadline `tl407_submission` while `informed` or `active_in_tg` in `ta_tg` and no TL 407 is
    submitted: the effective TG start minus the placement Agentur's `leadTimeDays` (the TG start
    while unresolved); under an approved exception, the day profiling is done (submit promptly
    after the catch-up);
  - `tl407_escalated` from TG start + `tl407EscalationDaysAfterTgStart` (14) while unsubmitted,
    whatever the exception: no baseline moves, so a submission after a late catch-up escalates at
    once when that date has passed;
  - **compliance escalation at once:** a refusal after entry (`profiling_declined_after_entry`) or a
    missed one-month deadline (`profiling_exception_deadline_missed`) escalates the day it happens,
    with no grace period;
  - the regional admin's view `GET /escalations` (Q57: project, responsible PLs, count per type,
    days overdue of the oldest; no participant), for the regional admins of the project's region and
    the admins, types `tl407_not_submitted` and `profiling_compliance`;
  - items on the work list: `knowledge_date_missing`, `kug200b_offer_open`,
    `kug200b_withdrawal_ba_notice`, `kug200b_confirmation_missing`, `tl407_original_missing`,
    `tl407_resubmission_open`, `tl407_escalated`, `evidence_invalidated`, `ba_report_pending` (6-6).
- **D28. BA reporting tasks** (Q111, Q190): the PL or back office closes a pending task:
  `reported` (the actual date sent, not in the future, not before the task) or `not_required` (a
  closed reason: `agentur_confirmed_not_required`, `no_claim_month_affected`, `created_in_error`),
  `ba_report_recorded` in the `dsv` stream. Never deleted, never edited: a wrong outcome is
  superseded through D29 (the task back to `pending`, or a linked replacement task), keeping the
  original's history. No due date. The monthly claim and project closure don't exist in the MVP; a
  pending task is a work-list item, and no helper pretends to enforce workflows that don't exist.

### Corrections and exceptions

- **D29. Approved append-only corrections** (data-protection.md, evidence corrections; Q183, Q186,
  Q190): `request_evidence_correction` and `decide_evidence_correction` for three targets in this
  slice: a document (invalidate; a wrong person's file is purged after approval, the tombstone and
  history stay), an ASU registration (supersede with corrected facts, or invalidate) and a BA
  reporting outcome (supersede). The PL requests with a reason code and a documented source
  (`ba_legal_reference`, `data_subject_rectification`, `corrected_source_document`,
  `documented_internal_error`); the regional operations manager approves or rejects, never the
  requester (four eyes); the approver sees the target's kind, category, reason, source and dates,
  never a value they couldn't otherwise read. The original stays, linked (`corrects` /
  `supersedes`); a corrected fact is recorded at the approval instant; nothing reverses a status, a
  guard, eligibility, a contractual date or a payment on its own. Field corrections (identity,
  dates) stay with a later slice.
- **D30. Exception requests with evidence** (Q80, Q81, Q94, Q194; 6-7): each request references one
  immutable **evidence record** (`profiling_exception_evidence_record`), which is either
  - one or more **accepted** `profiling_exception_evidence` document versions: uploaded by the PL
    (write-only for the PL: it opens only in assisted mode or through break-glass), reviewed and
    accepted by the assigned consultant (a file's presence is not verification); special category,
    the stricter class for unstructured uploads; or
  - a **structured BA confirmation**: the Agentur, the confirming contact or reference and the
    confirmation date, normalised (codes, ISO dates, trimmed, case-folded reference), confidential,
    never a clinical file.

  The fingerprint follows round 17: `sha256:v1` over `profiling-exception-evidence:v1`, the
  participation id and the canonical evidence (the sorted, de-duplicated content digests of the
  accepted versions, or the normalised confirmation facts in stable key order), computed in SQL;
  identical re-uploads and reordering don't count as changed (`evidence_unchanged`). The regional
  operations manager decides from the queue "Freigaben" (project, reason code, dates, the evidence
  kind and "Nachweis vorhanden"; no case data or raw evidence), never their own request; the PL
  revokes before entry; after entry the existing completion and compliance workflow applies.

### Cross-cutting

- **D31. Lock order** (ADR-0002: project → template version → participation row). Every new
  function takes the project's advisory lock first: shared through `lock_participation` for one
  participation, exclusive for a batch, a bulk generation or a correction's decision. Then always:
  participation rows (UUID order) → document rows (id order) → the profiling rows →
  `asu_registration` → the batch row → `agentur_submission` rows (id order) → consent rows → the
  sensitive rows → the correction row. Never a batch before a participation.

  | Operation | Project lock | Then |
  |---|---|---|
  | generate one form; write the profiling record or sessions; review, quarantine or lift a document; the ASU route, registration, decline, confirmation, a withdrawal, the BA notice; submit one TL 407, an original, a rejection; close a reporting task; request an exception or a correction | shared (`lock_participation`) | participation → its documents (`FOR SHARE` the generation a scan names, `FOR UPDATE` the one changed) → profiling rows → `asu_registration` → `agentur_submission` → consent → sensitive rows → the correction |
  | bulk Kug 200b generation; create, recheck-and-submit or discard a batch; decide a correction or an exception | exclusive | the participations in UUID order → their documents (id order) → the batch → the submissions (id order) → their `asu_registration` rows → the correction or request |
  | `profiling_done` (`apply_status_change`) | shared (held) | participation (held) → the accepted TL 407 scan `FOR SHARE` |

- **D32. Writes go through SECURITY DEFINER functions** (ADR-0002): `transfer_app` selects the new
  tables (never a ciphertext column) and writes none; each function writes its audit events in its
  transaction; `record_audit_event` refuses the new types. Status changes only through the status
  function. Nothing varies per Agentur in code: channels, original, lead time, outdated versions and
  an accepted alternative to the Kug 200a are resolved settings; the Kug 200b rules are base rules.
- **D33. Required scenarios**, each an integration test in its PR (the review's list):
  - external paper signed before the platform's generation is recorded without re-signing (6-3b);
  - a BA declaration changed after printing doesn't change the signed record, also under a
    concurrent edit during the review (6-3b);
  - the PL can't obtain section C warnings or overflow through readiness (6-3a);
  - a TL 407 scan accepted after the TG start's scheduled run counts only for a reconciliation
    (6-3b);
  - an abandoned unsigned form has a cleanup path (6-3a) and its scan provenance survives the purge
    (6-3b; both
    as a retention-plan test while periods are `unset`);
  - an old proof linked today gives a fact recorded today, not before (6-4); the Kug 200b route
    proven by the batch submission and the `online_self` route by the attestation with its date,
    each passing `asu_registered_with_proof` on the TG start (6-4, 6-5a); a declined offer or a
    withdrawal leaves the registration intact (6-4);
  - a missing knowledge date is no overdue finding, and the branch boundary (knowledge on, one day
    before and one day after the reference date) exposes the old maximum's defect (6-4);
  - a required Kug 200a is generated and checked, or an accepted alternative is used (6-5a); two
    batches racing for one scan give one; a stale batch refuses submission; a terminal member gets
    no registration (6-5a);
  - a missed exception deadline escalates the same day; a rejected submission reopens its work
    (6-5b);
  - a wrong-person scan accepted by mistake is quarantined at once and corrected without losing the
    history; an ASU entry error is superseded; a wrong `not_required` is superseded (6-8);
  - normalised BA confirmations and accepted documents each support an exception; identical
    re-uploads are unchanged evidence (6-7);
  - a name with `Ł` and `ğ` filled and read back; the month-14 date a hard error (6-1).
- **D34. Not in this slice:** automatic ASU reminders (Q1, Q152); narrative health detail and its
  explicit consent (D13); the DSV PDF and its tracking (Slice 7); field corrections of the evidence
  set; signed forms in the portal (Q67); an ASU upload by the participant; electronic BA interfaces
  (the PL sends outside the app); KuG claims, billing and project closure; the half-yearly Agentur
  report and other reports (Slice 9); PDF batch jobs (bulk generation is synchronous, ≤ 100); AI.

## PRs

One planned PR = one branch, each based on `main` after the PRs it needs merged (none stacked).
The approved seven PRs become ten: the official Kug 200a takes 6-5 past the limit, so it splits
into 6-5a (Kug 200b batches with the Kug 200a) and 6-5b (TL 407 submission and escalation), as the
review allowed; the approved corrections of wrong evidence are a concern of their own (6-8, after
its three targets exist). 6-3 came to about 4,200 lines and splits along its two halves, the
generated form (6-3a) and the signed paper (6-3b); quarantine comes with the scans in 6-3b. The
last PR to merge archives this plan.

| PR | Scope | Needs | Est. lines |
|---|---|---|---|
| 6-1 | Forms and PDFs (D1–D7): `packages/forms` (manifests, field maps with applicability, font, Anlage template, generator and checks), `PdfRenderer`, `Exporter`, the domain's form input, validation, overflow and Anlage; contract tests on the committed blanks | — | ~1,300 |
| 6-2 | Profiling record and track (D10–D13, the pending declarations of D15): sessions, encrypted section C with the health line's rating only, unemployment period, the profiling-status route, tab "Profiling" | — | ~1,400 |
| 6-3a | Generated TL 407 (D8, D9, D16; Q196–Q198 at generation): `tl407_form` with provenance and declaration snapshot, `form_generation`, the class `form_working_copy`, the readiness projection, generation with the confirmed warnings, "Öffnen" and "Neu erzeugen"; e2e to the generated form | 6-1, 6-2 | ~1,900 |
| 6-3b | Signed TL 407 (D14, D15, D17, D18, D23): scans `generated` and `external_paper`, signed declarations, the review, the PL's deletion before review, quarantine, `tl407Signed`/`profilingDone`, `profiling_done`; e2e to `profiling_done` | 6-3a | ~2,300 |
| 6-4 | ASU and Kug 200b (D19–D22, D24's print file): the ASU record and attestation with its date, the corrected formula and `knowledgeDate`, Kug 200b generation (single, bulk) and review, declaration 17 and withdrawals, `asu_proof`, rule `when` and base defaults 3, `asuRegisteredWithProof`, tab "Arbeitsuche" | 6-3b | ~1,500 |
| 6-5a | Kug 200b batches (D24, D25): the Kug 200a field map and fill (Q195), the accepted-alternative setting, the operational index, rechecks, submission, Agentur confirmation; project tab "Agentur" | 6-4 | ~1,300 |
| 6-5b | TL 407 submission and escalation (D26, D27): attempts, originals, rejections, `tl407_submission`, `tl407_escalated`, compliance escalation, `GET /escalations`, work-list items and filter | 6-3b | ~1,100 |
| 6-6 | BA reporting tasks (D28) | — | ~400 |
| 6-7 | Profiling exceptions (D30): evidence records of both sources, evidence review, fingerprints, request, decision, revocation, the queue "Freigaben" | — | ~1,300 |
| 6-8 | Corrections (D29): requests and decisions for documents, ASU registrations and BA outcomes in "Freigaben", the purge after an approved wrong-person invalidation, `evidence_invalidated` | 6-4, 6-6, 6-7 | ~1,000 |

Each PR that changes the document-type catalog takes its next version when it merges.

## Design

### Domain (`packages/domain`, no I/O, no system time)

- 6-1, `src/forms/`: `FormCode`, `FormVersionRef`; `tl407Input(...)`, `kug200bInput(...)` (pure:
  identity, profile, contact, sensitive values, sessions, assessment, project type, organisation,
  today) → `FormInput`; `validateFormInput(input, fieldMap, projectType, today)` → `{ errors,
  warnings }` with codes and input keys, never values; `orderRows` (D6); `layoutTl407(input,
  fieldMap, measure)` → `{ fields, anlage }` (`measure` injected: text width under the embedded
  font); `PlausibilityWarning` (`age_implausible`, `entry_before_birth`, `range_reversed`).
  `packages/forms` loads and checks files only (`@transfer/forms/load`).
- 6-2: `ProfilingSession`, `profilingSessionsProblem`; `SectionCRating` (`no_need`,
  `placement_relevant`), the assessment's shape (no health text) and limits; `JobboerseChoice`
  (`full`, `anonymous_callme`, `anonymous_no_contact`, `none`); `mayRecordProfiling`,
  `mayReadProfilingAssessment`.
- 6-3a: `ParticipantRetentionClass` adds `form_working_copy`; `workingCopyExpiry` (D9); document
  catalog version 3 with `tl407_form` (operations `generated`); `tl407Readiness`, the PL's
  `tl407ReadinessSummary` from presence (D16); `schoolQualificationCheck` and the confirmation
  `school_qualification_none` (Q196, Q198); `Tl407GenerationInput`; `layoutForm` names its overflow.
- 6-3b: `ScanOrigin` (`generated`, `external_paper`); `scanReviewProblem`; `SignedDeclaration`;
  `tl407SignedFact`, `profilingDoneDefault`; `QuarantineReason` (`suspected_wrong_person`,
  `suspected_wrong_acceptance`).
- 6-4: `asuDueDate` rewritten with its branches → `{ kind: "statutory", date, branch } | { kind:
  "orientation", date }`; `AsuProofKind` (`kug200b_submission`, `ba_confirmation`,
  `ba_customer_number`), `AttestationSource`, `asuRegistrationProblem`, `asuRegisteredFact` (the
  complete fact's instant), `kug200bOfferOutcome`; the rule `when` and `asuProofState`;
  `DeadlineKind` adds `asu_due` after `tg_start`.
- 6-5a: `batchEligibility`, `batchRecheck` (D25), `kug200aInput`.
- 6-5b: `tl407SubmissionProblem`, `agenturItems(...)` with `AgenturItemKind`; `AgenturFilter`, the
  tile "Agentur offen" and the group "Agentur" in `funnelFilters`; `DeadlineKind` adds
  `tl407_submission`; `escalationRows(...)` (counts only).
- 6-6: `BaReportOutcome`, `BaReportNotRequiredReason`.
- 6-7: `EvidenceRecord` (documents | BA confirmation), `normaliseBaConfirmation`,
  `canonicalEvidence` (the fingerprint's payload, mirrored and tested against the SQL).
- 6-8: `CorrectionTarget`, `CorrectionReason`, `CorrectionSource`, `mayRequestCorrection`,
  `mayDecideCorrection`.

### Data model (data catalog; `project_id` on every participant table, composite FKs to `participation`)

| Table / change | PR | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|---|
| `profiling_session` | 6-2 | id, date, from, to, recorded by/at | confidential / `confidential` (`profilingSessions`) | `participation_record` (Q88) |
| `participant_profiling` | 6-2 | the pending Jobbörse choice and BA contact declaration, `revision` | confidential / `confidential` (`jobboerseChoice`, `baContactConsent`) | `personnel_file` |
| `participant_profiling_assessment` | 6-2 | section C lines but health (rating and text ciphertexts, presence), the "andere" labels, Gesamteinschätzung, weiteres Vorgehen; key id, times | highly confidential / `profiling_assessment` | `personnel_file` (Q192) |
| `participant_profiling_health_assessment` | 6-2 | the health line's rating ciphertext and presence; no text | special category / `profiling_assessment` | `health_record` (Q40) |
| `participant_residence_social_data` | 6-2 | adds the unemployment period's ciphertexts and presence | highly confidential / `residence_social` | `personnel_file` |
| `document` | 6-3b, 6-4 | adds `form_code`, `form_version`, `scan_origin`, `generation_document_id`, `signed_on`, `countersigned_on`, the review's confirmations, quarantine (reason, by, at, lifted by/at), `invalidated_by_correction`; `CHECK`s by type | by type | by type: `form_working_copy` for the generated forms (Q179) |
| `form_generation` | 6-3a | the generated document, form code and version, the source revisions (profile, record, assessment, unemployment period), the declaration snapshot, the confirmed warnings, the Anlage, generated by/at | confidential / `confidential` | `form_working_copy` (its provenance survives the file as the tombstone) |
| `signed_declaration` | 6-3b (+6-4) | the scan, form code and version, the declaration codes and values as marked, the signature date, recorded by/at; immutable | confidential / `confidential` | `participation_record` (part of the signed form's evidence) |
| `participant_identifier_data` | 6-4 | adds the BA-Kundennummer's ciphertext and presence | highly confidential / `identifiers` | `participation_record` (Q88) |
| `participant_details` | 6-4 | adds `knowledge_date` | confidential / `confidential` | `personnel_file` |
| `asu_registration` | 6-4 (+6-5a, 6-8) | per participation the route and its version; per registration (append-only rows) channel, `registered_on`, proof kind and document, attestation source, attested by/at, `recorded_at` of the complete fact, `superseded_by`, `invalidated_by`; the offer's decline, `confirmed_on`, the withdrawal's BA notice date | internal / `case_internal` (`asuRegistration`, listable as codes and dates) | `participation_record` |
| `kug200b_batch` | 6-5a | project, Agentur key, channel, artifact (`kug200a` or `accepted_alternative`), status (`open`, `submitted`, `discarded`), created by/at, `submitted_on`, submitted by/at | internal / project data | `project_master` |
| `agentur_submission` | 6-5a, 6-5b | participation, document, form code and version, Agentur key, channel, batch, `submitted_on`, recorded by/at, `original_sent_on`, rejection (date, reason); one row per attempt | internal / `case_internal` (`agenturSubmissions`) | `participation_record` (proof of submission) |
| `export_link` | 6-4 | a link's token SHA-256, the export (kind and the ids it covers), the session's kind and hash, `expires_at` (60 s); no privilege for `transfer_app` | internal | `access_credential` |
| `ba_reporting_task` | 6-6 (+6-8) | adds `outcome`, `reported_on`, `not_required_reason`, decided by/at, `superseded_by`, `replaces_task_id` | as before | as before |
| `profiling_exception_evidence_record` | 6-7 | kind; the accepted document ids or the normalised BA confirmation (Agentur key, contact or reference, date) | confidential / `confidential`; its documents `health` | `participation_record` (Q81) |
| `evidence_correction` | 6-8 | target kind and id, reason, source, the corrected facts (encrypted where sensitive), requested by/at, decided by/at, decision; append-only | internal / `case_internal` | the target's class |

Enum values are added in their PR's generated migration (`audit_event_type`, `document_type`,
`retention_class`, the new enums), compared as text in that migration run (the lessons below).

### Functions (hand-written, SECURITY DEFINER, audit in the same transaction, the lock order of D31)

- 6-2: `write_profiling_sessions`, `write_profiling_declarations` (pending values),
  `write_profiling_assessment` / `read_profiling_assessment` (the key per call),
  `write_unemployment_period`; the route uses the existing `change_participation_status`.
- 6-3a: `record_form_generation` (the document, its provenance and snapshot, `form_generated`, the
  confirmed warnings' `warning_confirmed`; `source_changed` when a source revision moved);
  `delete_document` refuses a generated form (`document_immutable`).
- 6-3b: `add_document` takes the origin and generation of a
  scan; `review_document` takes the signature dates, the confirmations and the signed declarations;
  `quarantine_document`, `lift_document_quarantine`; `delete_document` lets the PL delete a scan
  before its review; the facts' reader `tl407_facts` (excluding quarantined and invalidated ones).
- 6-4: `set_asu_route`, `record_asu_registration`, `link_asu_proof`, `decline_kug200b_offer`,
  `record_declaration_withdrawal`, `record_withdrawal_ba_notice`, `set_knowledge_date`;
  `review_document` for the Kug 200b; `record_form_generation` for 1–100 participations;
  `create_export_link` / `export_link_content` (re-authorizes, `export_downloaded`);
  `write_participant_data` and the import learn `knowledgeDate`.
- 6-5a: `create_kug200b_batch`, `discard_kug200b_batch`, `submit_kug200b_batch` (rechecks, the
  members' submissions and ASU registrations), `record_asu_confirmation`.
- 6-5b: `submit_tl407`, `record_original_sent`, `record_agentur_rejection`.
- 6-6: `record_ba_report`.
- 6-7: `create_exception_evidence_record` (from accepted documents or a BA confirmation; the
  fingerprint), `review_document` for the evidence type; the request reads the record under the
  participation lock (`evidence_missing`, `evidence_unchanged` as built).
- 6-8: `request_evidence_correction`, `decide_evidence_correction` (applies the supersession or
  invalidation and queues `documents.purge-object` for an approved wrong-person file).

### API (`/api/v1`, OpenAPI, RFC 9457, capabilities on every item)

| PR | Route | Does |
|---|---|---|
| 6-2 | `GET /participations/{id}/profiling`; `PUT …/profiling/sessions`; `PUT …/profiling/declarations` | the tab; whole writes with `revision` (`409 stale_revision`) |
| 6-2 | `GET`/`PUT …/profiling/assessment`; `PUT …/profiling/unemployment`; `POST …/profiling-status` | the profiler's logged read and writes (`no-store`); the track change (`{ to, effectiveDate?, statusVersion }`) |
| 6-3a | `GET /participations/{id}/forms/tl407/readiness`; `POST /participations/{id}/forms/tl407` | the per-viewer projection (D16); generation (`{ confirmWarnings }` → `201 { documentId, formVersion, anlage }`) |
| 6-3b | `POST …/documents` (scans: `origin`, `generationDocumentId`); `POST …/documents/{documentId}/review`; `POST …/documents/{documentId}/quarantine`; `…/quarantine-lift` | scan upload, review with dates, confirmations and declarations; quarantine |
| 6-4 | `GET /participations/{id}/asu`; `PUT …/asu/route`; `POST …/asu/registration`; `POST …/asu/proof-link`; `POST …/asu/kug200b-decline`; `POST …/asu/withdrawal`; `POST …/asu/withdrawal-ba-notice`; `PUT …/knowledge-date` | the tab "Arbeitsuche" and its actions |
| 6-4 | `POST /participations/{id}/forms/kug200b`; `POST /projects/{id}/forms/kug200b` (1–100); `POST /exports/{kind}` → link; `GET /export-content/{token}` | generation, bulk, exports (`attachment`, `no-store`) |
| 6-5a | `GET /projects/{id}/kug200b-batches`; `POST /projects/{id}/kug200b-batches`; `POST /kug200b-batches/{id}/submission`; `…/discard`; `POST /participations/{id}/asu/confirmation` | candidates and batches; create; "Übermittelt am" (`422 batch_stale` with rows); discard; the Agentur's confirmation |
| 6-5b | `POST /participations/{id}/tl407-submissions`; `POST /agentur-submissions/{id}/original`; `…/rejection`; `GET /escalations`; `GET /projects/{id}/worklist`, `/dashboard` | submission, original, rejection; the regional admin's counts; the new deadlines, items, filter and counts |
| 6-6 | `POST /ba-reporting-tasks/{id}/outcome` | `{ outcome: "reported", reportedOn } \| { outcome: "not_required", reason }` |
| 6-7 | `POST /participations/{id}/exception-evidence`; `POST /participations/{id}/profiling-exception-requests`; `POST /profiling-exception-requests/{id}/decision`; `…/revocation`; `GET /reviews` | evidence record; request; decide; revoke; the queue "Freigaben" |
| 6-8 | `POST /participations/{id}/evidence-corrections`; `POST /evidence-corrections/{id}/decision` | request; decide (in "Freigaben") |

Order as in ADR-0010: schema → visibility (`404`; `participation_not_found` for a hidden id in a
body) → permission `403` → state `422`. Logs carry ids, codes and size buckets only; never a value,
a file name, a form's content or a token.

### History (`auditProjection` + an `audit_event_projection` migration row each)

- `profiling` (PL; assigned consultant): `profiling_session_changed` (`action`, `sessionId`,
  `date`), `profiling_declarations_recorded` (changed keys), `signed_declaration_recorded`
  (`formCode`, `formVersion`, the declaration codes), `agentur_submission_recorded` (`formCode`,
  `channel`, `submittedOn`, `batchId`), `agentur_submission_original_sent`,
  `agentur_submission_rejected` (reason).
- `case`: `form_generated` (`formCode`, `formVersion`, `documentId`, `anlage`),
  `document_quarantined` (reason), `document_quarantine_lifted`, `asu_route_set`,
  `asu_registration_recorded` (`channel`, `registeredOn`, `proofKind`, `attestationSource`),
  `asu_proof_linked`, `asu_confirmation_recorded`, `kug200b_offer_declined`,
  `declaration_withdrawal_recorded` (`receivedOn`), `declaration_withdrawal_ba_notified`,
  `knowledge_date_set` (changed or cleared, never the date), `evidence_correction_requested` and
  `evidence_correction_decided` (target kind, reason, source, decision), the existing
  `consent_given` / `consent_ended` with `source`.
- `dsv`: `ba_report_recorded` (`kind`, `outcome`, `reportedOn`, reason).
- Project-level, in no history: `kug200b_batch_created` (Agentur, count, artifact),
  `kug200b_batch_submitted`, `kug200b_batch_discarded`. Security, never shown: `export_created`,
  `export_downloaded` (kind, count), the reads and writes of D13, `document_opened`.
- `document_reviewed` adds `formVersion` and `origin` for the signed types; the exception events
  keep round 17's details (no fingerprint).

### Web UI (`apps/web`, German; every button by its capability)

- 6-2: tab "Profiling": status with "Teilnahme zugestimmt", "Profiling begonnen", "Abgelehnt"
  (confirmation), "Erneut zugestimmt"; "Termine des Profilings"; "Angaben aus der Selbstauskunft"
  with "Im assistierten Modus ergänzen"; for the profiler "Arbeitslos seit / bis", "Handlungsbedarf
  (Abschnitt C)" (per line "kein / vermittlungsrelevant" and text; the health line the rating
  only, with the note that no health details are recorded), "Gesamteinschätzung", "Weiteres
  Vorgehen", "Erklärungen gegenüber der BA (vorgesehen)"; each sensitive block loaded on
  "Anzeigen", never cached.
- 6-3a: "Profilingbogen (TL 407)": readiness as projected, "Erzeugen", the generated forms
  ("Öffnen", "Neu erzeugen"). 6-3b: "Unterschriebenen Bogen hochladen" (from a generated form, or "Außerhalb der
  Anwendung ausgefüllt" with the version), "Prüfen" (dates, signatures, all pages, the declarations
  as marked), "Unter Quarantäne stellen" (reason), "Profiling abschließen" with the date.
- 6-4: tab "Arbeitsuche": Weg, Kenntnisdatum, "Fällig am" or "Orientierung … – Kenntnisdatum
  klären", "Meldung erfassen" (date and proof: BA-Bestätigung, or BA-Kundennummer with the date and
  where it was checked, masked as typed and never shown back), Kug 200b ("Erzeugen", "Öffnen", scan,
  "Prüfen" with "16 und 17 angekreuzt, Pflichtangaben ausgefüllt, unterschrieben", "Abgelehnt"),
  "Erklärung zum Profilzugriff" (since, "Widerruf erfasst", "BA informiert am"). Work list bulk
  "Kug 200b erzeugen".
- 6-5a: project tab "Agentur": per placement Agentur the channel or "Einstellungen fehlen", the
  artifact ("Kug 200a" or "Alternative anerkannt am … von …"), the ready scans, "Sammelmeldung
  bilden", batches with "Kug 200a (PDF)", "Scans (PDF)", "Arbeitsliste (CSV)", "Übermittelt am",
  "Verwerfen", the refused rows of a stale batch; on "Arbeitsuche" "Bestätigung der Agentur am".
- 6-5b: on "Profiling" "An Agentur übermittelt am", "Original versandt am", "Von der Agentur
  abgelehnt" and the attempts; work list deadlines `asu_due` "Arbeitsuche fällig",
  `tl407_submission` "TL 407 einreichen", the column "Agentur", filter "Agentur", tile "Agentur
  offen", group "Agentur"; `/admin/escalations`.
- 6-6: overview's "BA-Meldungen": "Gemeldet am" or "Nicht erforderlich" (reason), confirmed.
- 6-7: "Ausnahme beantragen" (reason; evidence: documents to upload and have reviewed, or a BA
  confirmation); "Widerrufen"; the queue "Freigaben" for the regional operations manager.
- 6-8: "Korrektur beantragen" on an accepted document, an ASU registration and a closed reporting
  task; its decision in "Freigaben"; the flag "Nachweis ungültig" on the work list.

### Lessons carried from Slice 5b

- plpgsql: `text[] || 'x'` parses `'x'` as an array (write `'x'::text`); enum values added in a
  generated migration are compared as text in the same migration run; a boolean SQL helper never
  returns null (`IS NOT DISTINCT FROM`, `coalesce`); a generated migration may need a `UNIQUE` moved
  before the FK that references it (the scan's `generation_document_id` composite FK).
- A new parameter on an existing function (`add_document`, `review_document`, `delete_document`,
  `write_participant_data`): `DROP FUNCTION` with the old signature, `CREATE`, the grants again.
- `packages/domain` has no `new Date(` or `Date.now(` (the form layout and `asuDueDate` get dates);
  React render code no `Date.now()`.
- Each new or changed audit event gets its `auditProjection` row and an `audit_event_projection`
  migration row (the drift test); history details are strings, booleans, string lists or null.
- Zod: an enum with `.meta({ id })` that is also used `.nullable()` makes the OpenAPI component
  nullable everywhere (keep a separate nullable schema); a `.default()` in an input schema becomes
  required in the client body (no defaults in inputs).
- `pnpm verify` takes about 15 minutes; DB tests run from the repo root, never in parallel with it
  (they share `transfer_test`); `pnpm generate` after API schema and form-registry changes;
  `pnpm format` before committing.

## User flows

1. **Info event with Kug 200b:** the PL books the event (5b), then "Kug 200b erzeugen" for the 35
   invited (placement Agentur Beispielstadt-Nord): 31 complete, 4 with a blank RV-Nummer; opens the
   print file. At the event the participants tick, sign and date; the consultant uploads each scan
   to its form and accepts it ("16 und 17 angekreuzt, Pflichtangaben ausgefüllt, unterschrieben").
   One participant brings a Kug 200b already signed last month: uploaded as external paper.
2. **Batch:** tab "Agentur" → Beispielstadt-Nord (`scan_email`, Kug 200a): 33 ready → "Sammelmeldung
   bilden" → "Kug 200a (PDF)" and "Scans (PDF)" (both downloads logged) → the PL mails them outside
   the app → "Übermittelt am 24.11.": 33 ASU registrations. One member was withdrawn meanwhile:
   "Sammelmeldung veraltet", the PL discards and rebuilds with 32.
3. **Self-registered:** a participant registered online on 02.11.; the PL records "Meldung erfassen"
   with the BA-Kundennummer, "02.11." and "BA-Onlinekonto eingesehen"; the work list shows "Kug 200b
   offen" until the participant declines it or signs.
4. **Profiling:** two sessions, section B completed with the participant in assisted mode, section
   C (the health line's rating only), "Bitte prüfen: Alter unplausibel" confirmed, the TL 407
   generated with an Anlage for 9 jobs; the participant changes the Jobbörse choice by hand before
   signing; the review records the choice as marked; "Profiling abschließen" on the signature date.
5. **Mistake:** a scan of another person was accepted on the wrong participation; the consultant
   quarantines it at once; the PL requests a correction, the regional operations manager approves,
   the file is purged, the history stays, "Nachweis ungültig" until a correct form is accepted.
6. **Submission and escalation:** the PL records "An Agentur übermittelt am", later "Von der Agentur
   abgelehnt (unvollständig)": "TL 407 erneut einreichen" until the new submission. A participant
   under an exception misses the one-month deadline: the regional admin's view shows "1 ×
   Profiling-Compliance" the same day, no name.
7. **BA report:** back office sends Kug 208 and records "Gemeldet am"; a `not_required` recorded by
   mistake is superseded through a correction.

## Acceptance criteria

**6-1**
- Each field map matches its committed blank (names, kinds, states) and its manifest's hash equals
  `source.json`'s; the forms manifest and the immutability check run in `pnpm lint` and CI.
- Contract tests fill the real TL 407 and Kug 200b with synthetic data and read every value back,
  `Ł`, `ğ`, `ß` included; the Gotenberg test passes in CI.
- Domain (100 % coverage on the new rules): every error and warning code at its boundary (age 15
  and 67, equal `von` and `bis`, 29.02., `03.14.1998`); the beE dates required in `ta_tg`, blank and
  not required in `ta_only`; an RV-Nummer too long is an error, never cut; the rows of D6 including
  the displaced row; a text one word too long continues on the Anlage with its heading; Vermerke,
  signatures and the Kug 200b's 13–19 never filled.
- `Exporter`: header, quoting, BOM and the guard for `=`, `+`, `-`, `@`, tab and carriage return.

**6-2**
- The PL reads sessions and statuses, never section C or the unemployment period (`403`); back
  office no tab; an unassigned consultant `404`; assisted mode and break-glass grant no write.
- The health line takes a rating and refuses any text (`422`); each section C field written and
  read is one `sensitive_write` / `sensitive_read`; `transfer_app` can't select a ciphertext.
- The profiling track by the PL and the assigned consultant, refused by back office; `profiling_done`
  refused on `tl407_signed` until 6-3; `track_inactive` as built.
- Sessions: overlap, from ≥ to and a future date refused; stale revision `409`.
- Values and their revision read in one snapshot; a save keeps its own returned revision; an
  unrelated save keeps another section's unsaved input, a changed stored value shows a conflict
  (Q198). The unemployment period has its own revision (`409` also when clearing) and warns of a
  reversed range when saving. p. 7 keeps its paragraph breaks through API, storage and the TL 407.
  A closed participation is shown read-only.
- The highest school qualification (Q196): the participant marks one education row, the profiler
  confirms or corrects it (self-service and assisted permissions); it is persisted and passed to
  `orderEducation` as `kind: "school"`, never inferred. Needed before 6-3 enables generation.

**6-3a**
- Readiness: the profiler gets codes, warnings and overflow (each decryption audited); the PL gets
  `ready` and the missing known fields, and the response schema has no warning or overflow property
  for them; generation stores the document with its provenance and declaration snapshot.
- The working copy's class `form_working_copy` with its expiry triggers; executable periods `unset`
  (a retention-plan test); the generated form is immutable and opens only through the logged opening.
- e2e: session, generation.
- Generation refuses without the persisted school designation of 6-2 (Q196); an unsupported
  character is explained per field and points to the external-paper path (Q197).
- The school designation (Q198): an explicit, reviewed "no school qualification" answer is valid;
  "not yet designated / clarified" is incomplete. No education row is fabricated, and the answer
  is never inferred from names, recency or an unticked checkbox. The review is tied to the current
  source values: a later participant edit doesn't inherit an earlier review.

**6-3b**
- Scans: `generated` must name a generation of the same participation and form; `external_paper`
  needs a registry version; the review needs the dates, the confirmations and the declarations as
  marked; the scenarios of D33 for 6-3.
- Quarantine at once by the PL or the assigned consultant: no opening, no fact, no completeness;
  `profiling_done` refused on a quarantined scan; lifting restores it.
- The PL deletes a scan before its review; an accepted one is `document_immutable`.
- e2e: session, generation, scan, acceptance, `profiling_done`.
- The external-paper path is the way out for a name the renderer can't print (Q197).

**6-4**
- `asuDueDate`: both branches and their boundary; month-end clamps; no knowledge date gives the
  orientation item, never `overdue`; `asu_due` gone once registered with proof; never in `ta_only`.
- The attestation needs its date and source; the number is never returned, logged or in an audit
  detail; the PL can't open an `asu_proof` file.
- The complete fact's `recordedAt` is the link's instant when the proof was accepted earlier.
- Kug 200b acceptance without the confirmations is refused; accepted, signed declarations and one
  `consent_given` (`paper_form`); a withdrawal ends it and opens the BA-notice item; the registration
  stays.
- The rules with `when` apply only on the route `kug_200b`; a declined offer is never missing.
- Exports: the download re-authorizes, refuses a quarantined document, writes `export_downloaded`;
  no file is stored; bulk generation of 100 is all or nothing.
- Before printing, a handwriting/clarification checklist shows the Kug 200b's blank `*` fields
  and every `text_not_fitting` field (Q197); nothing disappears silently.

**6-5a**
- The Kug 200a fills from its field map and reads back; with a recorded accepted alternative the
  batch uses the alternative list as its artifact and says so; the index is never the artifact.
- Rechecks refuse a stale batch with its rows; races and the terminal member as D33.
- The Kug 200a's 6 pt minimum is assessed on representative filled PDFs before it is used
  (Q197).

**6-5b**
- Submission refused with the blocker, and for an expired version only where the Agentur rejects
  outdated forms; every attempt kept; a rejection reopens the item until a new submission and leaves
  the signatures and `profiling_done` alone.
- Escalations: TL 407 at TG start + 14 regardless of an exception; compliance the same day; the view
  shows counts and the PL's name, never a participant, only for the project's region and admins.
- For every new count `count = items.filter(filter).length`, distinct participations; the work list
  over 2,000 participations keeps the Slice 5 performance criterion.

**6-6**
- A pending task closes once (`already_recorded`), by the PL or back office, never a consultant;
  `reported` in the future or before the task is refused.

**6-7**
- Evidence from accepted documents and from a BA confirmation; an unreviewed document is
  `evidence_missing`; identical bytes under a new id, a reordering or a re-entered equal confirmation
  is `evidence_unchanged`; the SQL fingerprint equals the domain's canonical payload hash; the PL
  can't open the evidence; the approver is never the requester; the queue holds no raw evidence.

**6-8**
- A correction needs a second person; a rejected request changes nothing; an approved document
  invalidation stops its fact, purges a wrong person's file and keeps the tombstone and history; an
  ASU supersession is recorded at the approval instant; a status that rested on invalidated evidence
  stays and shows `evidence_invalidated`.

## Docs updated by the PRs

- 6-1: ba-forms.md (registry as built, applicability, Anlage), ADR-0006 (`PdfRenderer`,
  `Exporter`), ADR-0009 (field map, manifest, provenance, versions), architecture/overview.md
  (`packages/forms`), `.env.example` (`PDF_ADAPTER`, `GOTENBERG_URL`), organisation configuration.
- 6-2: process-and-lifecycle.md (the profiling record and track actions), data-protection.md
  (profiling tables, section C storage, the health-detail gate, history rows), ADR-0002.
- 6-3a: data-protection.md (generated forms, provenance, working-copy expiry, the readiness
  projection), ba-forms.md (generation as built), ADR-0002, ADR-0006 (the renderer in the API).
- 6-3b: data-protection.md (scans and their origins, signed declarations, quarantine), ba-forms.md
  (declarations bound to the paper), process-and-lifecycle.md (`profiling_done` from the TL 407),
  ADR-0002.
- 6-4: process-and-lifecycle.md (the corrected ASU formula, the ASU record and its recording
  instant, the offer and withdrawals), regional-variation.md (rule `when`, base defaults 3),
  data-protection.md (declaration 17 as written, the attestation, exports), ADR-0002, ADR-0010.
- 6-5a: process-and-lifecycle.md (batches, the Kug 200a), regional-variation.md (the accepted
  alternative; the batch blocker no longer a warning only, Q91), data-protection.md (the Kug 200a's
  values), architecture/overview.md (tab "Agentur").
- 6-5b: process-and-lifecycle.md (submissions, escalations), data-protection.md (the regional view).
- 6-6: process-and-lifecycle.md (BA reporting as built).
- 6-7: process-and-lifecycle.md and data-protection.md (exception evidence records as built).
- 6-8: data-protection.md (evidence corrections as built); the last PR: roadmap.md (Slice 6 done)
  and this plan to `docs/plans/archive/`.
