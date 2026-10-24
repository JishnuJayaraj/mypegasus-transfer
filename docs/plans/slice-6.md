# Slice 6 — Profiling & forms (F6)

Status: **proposed** 2026-10-24 for the product owner's review; nothing is implemented before the
approval. New questions Q176–Q194 (`docs/open-questions.md`): Q176 and Q181 `open`, the others
`assumed` (🔒: Q179, Q183, Q184, Q185, Q192, Q194). The decisions that need the product owner are
listed under "For the product owner" at the end.
Roadmap: Arbeitsuchendmeldung (ASU record, due date, Kug 200b, batch export), profiling screen,
`packages/forms` with TL 407 and Kug 200b (ADR-0009), the PDF adapter (pdf-lib + Gotenberg behind
`PdfRenderer`, ADR-0006), the overflow attachment, scan upload, Agentur submission status; from
Slice 2 sending BA reports (`reported` / `not_required`; process-and-lifecycle.md, BA reporting).
Builds on: the profiling track and its guards (`canTransition`, the status service,
`apply_status_change`), the guard-facts provider (`apps/api/src/participations/guard-facts.ts`,
fail-closed today), the documents of Slice 4b (catalog, encryption, `document_link`, the logged
opening), the sensitive-field storage of Slice 4a (`pgp_sym_encrypt`, logged reads), the
completeness engine and the resolver (`agentur_submission` and `asu_registration` blockers), the
consent records (`paper_form` source, Q138), the work list's deadlines and items, the audit
history (`auditProjection`, `audit_event_projection`), `ba_reporting_task` (PR 2h-3) and the
participant page's tabs.

## Decisions

### Forms and PDFs

- **D1. The form registry** (`packages/forms`, ADR-0009). One folder per form version,
  `templates/ba/<form_code>/<version>/`: the blank PDF as the BA publishes it, `manifest.json`
  (`formCode`, `version`, `validFrom`, `validUntil` or null, the PDF's SHA-256, the source URL and
  the retrieval date) and `field-map.json`: our input key → AcroForm field, its kind (text, date
  `TT.MM.JJJJ`, time `hh:mm`, radio with the value map, checkbox with its on-state), whether the
  form marks it `*`, the fixed row tables (`rows`, the per-row fields, the row that reads "weitere
  siehe Anlage") and the fields we never fill (`txtfVermerkKdNr`, `txtfVermerkOrg`). Form codes
  `tl407` and `kug200b`; versions `08-2025` and `09-2021`. A test checks every map against its PDF
  (each field exists, kinds and radio states match, no AcroForm field unmapped except the
  never-filled and handwritten ones), `pnpm generate` writes the forms manifest, CI checks it like
  the template manifest, and the immutability check compares every merged version by hash
  (`scripts/check-template-immutability.mjs` covers both). **The blank PDFs come from the product
  owner** (Q176): the BA site is unreachable from cloud sessions, and the synthetic fixtures are
  filled copies, not the official blanks.
- **D2. Which version is used.** Generation uses the version valid on the Berlin date of the
  request (`validFrom ≤ today`, `validUntil` null or `≥ today`); none is
  `form_version_unavailable`. A new version gets its folder and the previous one its `validUntil`
  (a reviewed PR, ADR-0009). An unsigned generated form of an expired version shows "Neu erzeugen"
  (derived); a signed scan keeps its version (Q42). Every generated document and every scan
  records `formCode` and `formVersion`.
- **D3. `PdfRenderer`** (`packages/adapters/src/pdf`, ADR-0006): `fillForm({ template, fieldMap,
  values })` fills the AcroForm with pdf-lib in process and flattens it, with a committed subset of
  Noto Sans (OFL) embedded through `@pdf-lib/fontkit` for the appearance streams, so names outside
  WinAnsi (`Ł`, `ğ`, `ș`) print; `renderHtml({ html })` is Gotenberg's Chromium route
  (`PDF_ADAPTER=gotenberg`, `GOTENBERG_URL`, a cluster-internal service, so no third party sees the
  data); the mock renders the same structured document with pdf-lib text and no network. Merging
  PDFs and turning a JPEG/PNG scan into a page are pure pdf-lib helpers of the package, not adapter
  methods. Production wires no mock: what needs HTML (the Anlage, the Teilnehmerliste PDF) answers
  `503 pdf_unavailable` without Gotenberg; generation stores documents, so it also needs the store
  (`503 storage_unavailable` until Q149). Contract tests fill each real blank, read every value back
  from the unflattened fill (special characters included) and check the flattened output's page
  count; a Gotenberg contract test runs against `GOTENBERG_URL` (a CI service container), skipped
  without it.
- **D4. `Exporter`** (`packages/adapters/src/export`): versioned CSV (`;`, UTF-8 with BOM, a
  header row, quoting, formula-injection guard: a cell starting with `=`, `+`, `-` or `@` gets a
  leading `'`), first used by the Teilnehmerliste (D20).
- **D5. Validation before rendering** (`packages/domain/src/forms/`, no I/O, no system time): the
  form input is built from domain data (`tl407Input`, `kug200bInput`) and checked against the field
  map (`validateFormInput`): an impossible date or time, `bis` before `von` in a time pair, and a
  missing `*` field of the TL 407 (except the Agentur's) are **errors** that refuse generation; the
  plausibility checks are **warnings** staff confirm by code (age 15–67 at the effective TG start,
  else at today; entry to Germany before the birth date; a date range with `von > bis`), each
  confirmation audited `warning_confirmed` (participation, code). The formatted output is checked
  again (`TT.MM.JJJJ` real calendar dates), so the month-14 fixture is a hard error. A Kug 200b may
  be generated with blanks (D7).
- **D6. Overflow and the Anlage** (Q41, Q182): profiling sessions chronological; education with
  the highest school qualification first, then vocational and university, most recent first; jobs
  of the last three years before the generation date, most recent first; languages in their order
  (German first, not a row). Rows beyond the form's (4 sessions, 5 education, 7 jobs, 4 further
  languages) go onto the "Anlage zum Profilingbogen", and the form's last row of that table reads
  "weitere siehe Anlage" (its other cells empty). A free text that doesn't fit its field box at the
  minimum font size (measured with the embedded font) is cut at a word boundary with "Fortsetzung
  siehe Anlage" and continues there (Q182). The Anlage is our own HTML template
  `anlage-profilingbogen:v1` (`packages/forms/templates/own/`, versioned like the forms, hash-checked):
  name, birth date, "Anlage zum Profilingbogen (TL 407 08/2025)", page "n von m" and the continued
  tables and texts. It is appended to the generated TL 407 as one document (one print).
- **D7. What is filled** (Q180, Q181).
  - TL 407: `chbxParagraph110` in `ta_only`, `chbxParagraph111` in `ta_tg` (regional-variation.md);
    the Vermerke never; section A's Träger from the organisation configuration (new keys under
    `transfergesellschaft`: name, street, house number, postal code, city; synthetic in the repo),
    names and birth date from the identity, the expected stay in the beE from the effective
    `tgStart`/`tgEnd` (`ta_tg`; in `ta_only` blank, Q181), the sessions; section B from the profile,
    the contact fields and the sensitive tables (read inside the generation, each field audited
    `sensitive_read`); phone, mobile and email only when the BA contact declaration is `yes`; the
    Jobbörse choice; the unemployment period; section C and p. 7. Signature places and dates stay
    blank (handwritten).
  - Kug 200b: 1 the TG's name, 2 the project's customer, 3–8 name and address, 9 Familienstand,
    10 nationality, 11 RV-Nummer, 12 Schwerbehinderung/Gleichstellung; 13–15 (voluntary contact
    data under the BA's consent note), the declarations 16 and 17 and place and date 18–19 stay
    blank: the participant ticks, writes and signs by hand. Missing data stays blank for the
    participant to write; staff see the list of blank `*` fields before printing.
- **D8. Generated forms are documents** (Q179): new types `tl407_form` (catalog version 3, 6-3)
  and `kug200b_form` (version 4, 6-4), unsigned, immutable, of the signed type's access category
  and class, stored encrypted like every file, named `tl407-<date>.pdf` on download, opened only
  through the logged opening. Retention: a new class `form_working_copy` (deleted 30 days after a
  newer generation supersedes it or its signed scan is accepted; executable period `unset` until
  Slice 7). Who generates: the TL 407 the assigned consultant (the profiler, who alone reads
  section C; Q49); the Kug 200b the PL or the assigned consultant (the PL may open the signed
  Kug 200b, Q49), the PL also for 1–100 participations at once (all or nothing, one print file).

### Profiling

- **D9. The tab "Profiling"** (staff app, normal mode): the profiling status and its actions
  (D10); the sessions (D11); section B as the tab "Selbstauskunft" shows it (the viewer's read
  rights; the sensitive answers as "angegeben / fehlt"), with "Im assistierten Modus ergänzen": staff
  write self-service fields only in assisted mode (Q136), and the participant is present during
  profiling; for the assigned consultant (profiler only) the unemployment period, section C and
  p. 7 (D12) and the two declarations to the BA (Q44: the Jobbörse choice of field 50 and the BA
  contact declaration, on the profiling record with the form version and the date of the TL 407's
  signature, set when its scan is accepted; "vorgesehen" before); the TL 407 readiness (errors and
  warnings as codes, the overflow), generation, the generated forms and scans, the review, the
  Agentur submission (D21). The PL sees the sessions, the statuses, the readiness codes and the
  documents' metadata, never section C (Q49); back office has no tab.
- **D10. Profiling track actions** (`POST /participations/{id}/profiling-status`; Q60: the PL and
  the assigned consultant, normal mode): along the edges of the
  [transitions table](../domain/generated/lifecycle-transitions.md) through the status service and
  `apply_status_change`, with track activity as built (also forward and a refusal while
  `active_in_tg` under an approved exception, Q74). `profiling_done` needs `tl407_signed` (an
  accepted TL 407 scan, D14) and its effective date `profilingDoneOn`, by default the later of the
  two signature dates and never before it (Q191; staff dates may be backdated, never in the future).
  Recording the first session doesn't move the track; the tab offers "Profiling begonnen" then.
  `profilingDoneOn` feeds the Transfer-KuG outcome as built (`transfer-kug.ts`, Q82, Q86); this slice
  shows no outcome.
- **D11. Profiling sessions** (Q193): date, from, to (`hh:mm`, from < to, a date not in the
  future, no two sessions overlapping on one day); written whole with the record's revision by the
  assigned consultant; the PL reads them. Each change audited per session (added, changed, removed;
  id and date). `profilingSessions` is evidence-set data (Q88), so the table is
  `participation_record`.
- **D12. Section C, p. 7 and the unemployment period** (Q85, Q192): encrypted like the sensitive
  self-service fields (ADR-0002, field encryption), one table per access category and retention
  class: section C's ratings (`kein` / `vermittlungsrelevant` per line) and their texts, the
  "andere" lines' labels, Gesamteinschätzung and weiteres Vorgehen (highly confidential,
  `profiling_assessment`, `personnel_file`); the health line (rating and text, special category,
  `profiling_assessment`, `health_record`, Q40); the unemployment period beside the residence and
  social answers (highly confidential, `residence_social`, `personnel_file`; Q85 stays open, fail
  safe). Only the assigned consultant reads and writes section C, each field audited
  `sensitive_write` / `sensitive_read`; the unemployment period is written by the assigned
  consultant and read like the group's other fields (also back office). Text limits: a line 300,
  p. 7 2,000 characters each; the form says no diagnoses (data-protection.md, classification).

### Signed scans

- **D13. Scans belong to a generation.** A signed scan (`tl407_signed_scan`, `kug200b_signed_scan`)
  names the generated form it was printed from (`generationDocumentId`, of the same participation
  and form; Q184), so its version is known; PDF, JPEG or PNG under the Slice 4b limits, scanned
  before storing. Upload from the tab "Profiling" or "Arbeitsuche"; the tab "Unterlagen" lists them
  with "Öffnen" for whoever may open them.
- **D14. The review** (Q184, Q185): once, final, normal mode, the assigned consultant or the PL.
  - TL 407: acceptance records the participant's and the profiler's signature dates (≤ today, not
    before the generation date) and the confirmation that both signatures are present; it gives the
    fact `tl407Signed` (`validOn` the later date, `recordedAt` the acceptance) and the declarations'
    date (D9).
  - Kug 200b: acceptance needs the confirmation that **both declarations (16, 17) are ticked and
    the form is signed** (round 14) and records the date written in field 19; in the same
    transaction it records our consent `kug200b_profile_access` (source `paper_form`, text version
    `Kug 200b 09/2021`, language `de`, given on that date, recorded by the reviewer;
    `consent_given`) and the offer's outcome `signed`.
  - A rejection keeps the existing reasons (`unreadable`, `wrong_document`, `incomplete`); a new
    print and scan follow.
  - A scan uploaded to the wrong participation may be deleted by the PL before its review with
    `wrong_person` or `wrong_file` (tombstone, object purged); an accepted scan never (Q183).

### ASU and Kug 200b (`ta_tg` only, Q89)

- **D15. The ASU record** (`asu_registration`, Q186): one per participation.
  - The **route** (`kug_200b`, `online_self`, `in_person`), set by the PL or the assigned consultant;
    the form preselects the placement Agentur's `defaultChannel` (never a blocker, round 14).
    Changeable until a registration is recorded.
  - The **registration**: for `kug_200b` the submission of the accepted Kug 200b in a batch (D20),
    `registeredOn` the submission date; for `online_self` and `in_person` the date the person
    registered, recorded with its **proof**: an accepted `asu_proof` document (a BA confirmation,
    reviewed by the assigned consultant) or the PL's **attestation of the BA-Kundennummer** (the
    number stored encrypted beside the RV-Nummer, write-only for the PL, `sensitive_write`; read by
    the assigned consultant and back office; no file needed, round 14).
  - It gives the fact `asuRegisteredWithProof` (`validOn` `registeredOn`, `recordedAt` the instant
    the proof was recorded: the submission, the acceptance or the attestation). Once recorded the
    registration is final; a wrong one waits for the evidence corrections (not in this slice).
  - The **Agentur confirmation** (`confirmedOn`, optional, route `kug_200b`); none 14 days after the
    submission (`kug200bConfirmationFollowUpDays`) is the item `kug200b_confirmation_missing`.
- **D16. The Kug 200b offer** is separate from the ASU proof (round 14): offered = a generated
  Kug 200b exists; outcome `signed` (accepted scan) or `declined` (recorded by the PL or the assigned
  consultant with the date; `kug200b_offer_declined`). On another route an open offer is the item
  `kug200b_offer_open` ("Arbeitsuche selbst gemeldet, Kug 200b offen"), never a guard; declined, the
  consent record simply stays empty. A revocation of the profile-access consent that reaches the TG
  is recorded by the same roles from the written statement (`consent_ended`, `revoked`, its date;
  Q185).
- **D17. Completeness** (base defaults version 3, regional-variation.md):
  - the rule language gains an optional `when` on `documentPresent`, the same shape as
    `requiredIf`'s (a narrow applicability condition, round 14; the JSON Schema regenerated; old
    layers stay valid);
  - a new field `asuChannel` (`case_internal`, listable);
  - two `asu_registration` rules, `ta_tg`, basis `ba_form`, applying only while `asuChannel` equals
    `kug_200b`: `base-kug200b-rv-nummer` (`requiredIf` `pensionInsuranceNumber`) and
    `base-kug200b-signed-scan` (`documentPresent` `kug200b_signed_scan`, accepted);
  - `base-asu-proof` keeps its shape; the engine's state for `asu_proof` comes from the ASU record
    (accepted once a registration with proof exists, any channel; `uploaded` while an `asu_proof`
    document awaits review), so the attestation and the batch submission satisfy it without a file.
- **D18. The ASU due date** (Q1 `verify`, Q177, Q178): `knowledgeDate` (Kenntnis vom Ende des
  Arbeitsverhältnisses) is stored per participation, an optional import target and an edit of the
  PL (`knowledge_date_set`). `asuDueDate` (the base defaults' parameters) becomes the deadline
  `asu_due` while the project is `ta_tg`, the participation is before `active_in_tg` and not
  terminal and no registration with proof exists; without `knowledgeDate` the date is
  `oldEmploymentEndDate − 3 months` and the row says "ohne Kenntnisdatum" (the earlier date: fail
  safe); without `oldEmploymentEndDate` there is no due date. Informational like every deadline;
  **no automatic reminder** until a PL confirms Q1 (Q152). ASU isn't a participant action.
- **D19. Real guard facts** (`dbGuardFacts`, replacing `failClosedFacts` for the facts it reads):
  `asuRegisteredWithProof` (6-4), `tl407Signed` and `profilingDone` (6-3), the exception evidence
  (6-7). The DSV facts stay fail closed until Slice 7, so no participation enters the TG on real
  facts before it; the seed overlays its synthetic facts as today. Facts carry the database instant
  of their recording (the snapshot rule).

### Agentur submissions

- **D20. Kug 200b batches** (Q45, Q91, Q187, Q188), the PL only (back office never opens a signed
  Kug 200b, Q49):
  - per placement Agentur of a `ta_tg` project; refused without a placement Agentur
    (`placement_agentur_missing`), with the step blocker of `asu_registration`
    (`batchSubmissionChannel` unset, Q91: `agentur_submission_blocked`, also when its template is
    missing) and for a form version the Agentur rejects (D21);
  - candidates: accepted Kug 200b scans of the project's participations with that Agentur, not in a
    live batch and not submitted; a batch takes 1–200 of them, all or nothing, its members fixed;
  - exports (each logged `export_created`, a 60-second link like the opening's): the
    **Teilnehmerliste** as PDF and CSV (header TG, Agentur, channel, date, count; per row last name,
    first name, birth date, form version; Q187), and for `scan_email` and `upload` one PDF of the
    members' scans in list order; for `paper_courier` / `paper_post` the list is the cover sheet;
  - "Übermittelt am" (≤ today, not before the batch's creation) records each member's submission
    (channel = the batch's resolved channel) and, on the route `kug_200b`, its ASU registration;
    "Verwerfen" before that frees the members. A member that turned terminal stays in its batch
    (the PL may discard and rebuild it).
- **D21. TL 407 submission** per participation, the PL (Q54, Q92, Q188, Q189): after an accepted TL
  407 scan, refused without a placement Agentur or with the `agentur_submission` blocker (all four
  settings, Q92). The channel is the resolved `submissionChannel` (recorded, not chosen). With
  `originalRequired` the item `tl407_original_missing` stays until "Original versandt am". A signed
  form whose version has expired is refused (`form_version_outdated`) when the Agentur's
  `rejectsOutdatedFormVersions` is `true` (Q188; the same rule for the Kug 200b in a batch). An
  Agentur's rejection is recorded (`outdated_form_version`, `incomplete`, `other`; Q189) and allows a
  new submission (after a new form for an outdated one); a version rejection is the form owner's cue
  to check the BA page (ADR-0009).
- **D22. Deadlines, items and the escalation** (process-and-lifecycle.md, profiling track):
  - deadline `tl407_submission` while `informed` or `active_in_tg` in `ta_tg` and no TL 407 is
    submitted: the effective TG start minus the placement Agentur's `leadTimeDays` (the TG start
    itself while unresolved);
  - from TG start + `tl407EscalationDaysAfterTgStart` (14) still unsubmitted: `tl407_escalated` for
    the PL and the regional admin's view `GET /escalations` (Q57: project, responsible PLs, count
    per type, days overdue of the oldest; no names), for the regional admins of the project's region
    and the admins; under an approved exception the submission follows the catch-up of profiling,
    so the deadline is the exception's (entry + 1 month) instead of the TG start (Q74, Q189);
  - items on the work list: `kug200b_offer_open`, `kug200b_confirmation_missing`,
    `tl407_original_missing`, `tl407_escalated`, `ba_report_pending` (6-6).
- **D23. BA reporting tasks** (Q111, Q190): a pending task is closed once, final: `reported`
  (the date it was sent, not in the future, not before the task) or `not_required` (a closed reason:
  `agentur_confirmed_not_required`, `no_claim_month_affected`, `created_in_error`), by the PL or back
  office (`ba_report_recorded`, stream `dsv` like the date change). Never deleted. The monthly claim
  and project closure don't exist in the MVP; `pendingBaReports` is the domain's blocker for them
  and the work list item `ba_report_pending` meanwhile. No due date is invented.

### Profiling exceptions

- **D24. Exception requests with evidence** (Q80, Q81, Q194; 6-7): data-protection.md places the
  evidence document here. The PL uploads the evidence (`profiling_exception_evidence`, one type at
  the stricter class, write-only for the PL: it opens only in assisted mode or through
  break-glass), requests the exception with a reason code (and the BA confirmation for
  `ba_confirmed_other`); the fingerprint is `sha256:v1` over a canonical text of participation,
  type and the content's SHA-256, computed in SQL. The regional operations manager approves or
  rejects from a review queue ("Freigaben": project, reason code, dates, "Nachweis vorhanden"; no
  case data), never their own request (four eyes); the PL revokes. The domain and the status
  functions exist (Slice 1); this adds the evidence, the routes and the screens. The product owner
  may move it to Slice 7 with the TG entry guard.

### Cross-cutting

- **D25. Lock order** (ADR-0002: project → template version → participation row). Every new
  function takes the project's advisory lock first: shared through `lock_participation` for one
  participation, exclusive for a batch or a bulk generation. Then always: participation rows (UUID
  order) → document rows (id order) → the profiling rows → `asu_registration` → the batch row →
  `agentur_submission` rows (id order) → consent rows → the sensitive rows. Never a batch before a
  participation.

  | Operation | Project lock | Then |
  |---|---|---|
  | generate one form, write the profiling record or sessions, review a scan, record the ASU route, registration, decline, confirmation or a consent's end, submit one TL 407, record an original or a rejection, close a reporting task | shared (`lock_participation`) | participation → its documents `FOR SHARE` (the generation a scan names) or `FOR UPDATE` (the reviewed one) → profiling rows → `asu_registration` → `agentur_submission` → consent → sensitive rows |
  | bulk Kug 200b generation; create, submit or discard a batch | exclusive | the members' participations in UUID order → their scans `FOR SHARE` → the batch → the submissions (id order) → their `asu_registration` rows |
  | `profiling_done` (`apply_status_change`) | shared (held) | participation (held) → the accepted TL 407 scan `FOR SHARE` |

  Concurrency tests show two batches racing for one scan give one, a batch submission racing a
  terminal transition and a review deadlock-free (D27).
- **D26. Writes go through SECURITY DEFINER functions** (ADR-0002): `transfer_app` selects the new
  tables (never a ciphertext column) and writes none; each function writes its audit events in its
  transaction; `record_audit_event` refuses the new types. Status changes only through the status
  function. Nothing varies per Agentur in code: channels, original, lead time and outdated versions
  are the resolved settings; the Kug 200b rules are base rules (regional-variation.md).
- **D27. Required scenarios**, each an integration test in its PR: a TL 407 scan accepted after the
  TG start's scheduled run counts only for a reconciliation (6-3); the Kug 200b route proven by the
  batch submission and the `online_self` route by the attestation, each passing
  `asu_registered_with_proof` on the TG start without a file (6-4, 6-5); a declined offer is never a
  missing scan (6-4); two batches racing for one scan, and a submission racing a terminal transition
  (6-5); a new form version: the unsigned form "Neu erzeugen", the signed one keeps its version, the
  outdated one refused where the Agentur rejects it (6-5); a name with `Ł` and `ğ` filled and read
  back, the month-14 date a hard error (6-1).
- **D28. Not in this slice:** automatic ASU reminders (Q1, Q152); the DSV PDF and its tracking
  (Slice 7); evidence corrections (`append_evidence_correction`); signed forms in the portal (Q67);
  an ASU upload by the participant; electronic BA interfaces (the PL sends outside the app); KuG
  claims, billing and project closure; the half-yearly Agentur report and other reports (Slice 9);
  PDF batch jobs (bulk generation is synchronous, ≤ 100); AI.

## PRs

One planned PR = one branch, each based on `main` after the PRs it needs merged (none stacked).
6-1 and 6-2 need nothing from each other; 6-3 needs both; 6-4 needs 6-3 (it extends the same
document functions and the catalog after it); 6-5 needs 6-4; 6-6 and 6-7 need nothing from the
others. 6-6 (BA reports) and 6-7 (exception evidence) are separate concerns; 6-1 to 6-5 are split
at the ~1,500-line limit. The last PR to merge archives this plan.

| PR | Scope | Est. lines |
|---|---|---|
| 6-1 | Forms and PDFs (D1–D7): `packages/forms` (registry, manifests, field maps, the blanks, the font, the Anlage template, generator and checks), `PdfRenderer` (pdf-lib, Gotenberg, mock), `Exporter`, the domain's form input, validation, overflow and Anlage layout; contract tests. No database, no UI | ~1,300 |
| 6-2 | Profiling record and track (D9–D12): sessions, declarations, the encrypted section C, health line and unemployment period, their functions and routes, the profiling-status route; the tab "Profiling" without forms | ~1,400 |
| 6-3 | TL 407 (D8, D13, D14 TL 407, D19): `tl407_form`, catalog version 3 for the TL 407 types, readiness and generation with warnings, scans linked to a generation, the review with signature dates, `tl407Signed` and `profilingDone` from the database, `profiling_done`; e2e | ~1,300 |
| 6-4 | ASU and Kug 200b (D14 Kug 200b, D15–D18): `asu_registration`, `knowledgeDate`, `asu_due`; Kug 200b generation (single and bulk) and print file; the Kug 200b review with the consent from paper; the decline and the revocation; `asu_proof` and the attestation; the rule language and base defaults 3; `asuRegisteredWithProof`; the tab "Arbeitsuche"; the work list item `kug200b_offer_open` | ~1,500 |
| 6-5 | Agentur submissions (D20–D22): batches and their exports, the batch submission and the Agentur confirmation, TL 407 submission, originals and rejections, `tl407_submission`, the escalation and `GET /escalations`; the project tab "Agentur"; the work list items and filter | ~1,500 |
| 6-6 | BA reporting tasks (D23): `reported` / `not_required`, the item, the participant overview's section | ~400 |
| 6-7 | Profiling exceptions (D24): the evidence document, the request, decision and revocation routes, the PL's dialog and the review queue | ~1,100 |

## Design

### Domain (`packages/domain`, no I/O, no system time)

- 6-1, `src/forms/`: `FormCode`, `FormVersionRef`; `tl407Input(...)` and `kug200bInput(...)` (pure:
  identity, profile, contact, sensitive values, sessions, assessment, project, organisation, today)
  → `FormInput`; `validateFormInput(input, fieldMap, today)` → `{ errors, warnings }` with codes and
  input keys, never values; `orderRows` (D6); `layoutTl407(input, fieldMap, measure)` →
  `{ fields, anlage }` (`measure` injected: the text width under the embedded font, so the domain
  stays I/O-free); `PlausibilityWarning` (`age_implausible`, `entry_before_birth`,
  `range_reversed`). `packages/forms` loads and checks files only (`@transfer/forms/load`, like
  `@transfer/config/load`).
- 6-2: `ProfilingSession` (Zod; D11), `profilingSessionsProblem`; `SectionCRating`
  (`no_need`, `placement_relevant`), the assessment's shape and limits (D12); `JobboerseChoice`
  (`full`, `anonymous_callme`, `anonymous_no_contact`, `none`); permissions `mayRecordProfiling`,
  `mayReadProfilingAssessment` beside `mayPerformTransition`.
- 6-3: catalog version 3 (`tl407_form`, the TL 407 types' operations, D8, D13); `scanReviewProblem`
  (signature dates); `tl407SignedFact`, `profilingDoneDefault` (Q191); `ParticipantRetentionClass`
  adds `form_working_copy`.
- 6-4: `AsuChannel` reuse, `AsuProofKind` (`kug200b_submission`, `ba_confirmation`,
  `ba_customer_number`), `asuRegistrationProblem`, `asuRegisteredFact`, `kug200bOfferOutcome`; the
  completeness rule `when` on `documentPresent` and `asuProofState`; `asuDueDeadline` (D18);
  catalog version 4 (`kug200b_form`, the Kug 200b, ASU-proof operations); `DeadlineKind` adds
  `asu_due` after `tg_start`.
- 6-5: `batchEligibility`, `tl407SubmissionProblem` (blocker, version, `outdated`),
  `agenturItems(...)` with `AgenturItemKind`; `AgenturFilter` in `WorklistFilter`, a tile
  "Agentur offen" and the group "Agentur" in `funnelFilters`; `DeadlineKind` adds
  `tl407_submission`; `escalationRows(...)` (counts only).
- 6-6: `BaReportOutcome`, `BaReportNotRequiredReason`, `pendingBaReports`.
- 6-7: the evidence fact from the document; `mayRequestException` reuse.

### Data model (data catalog; `project_id` on every participant table, composite FKs to `participation`)

| Table / change | PR | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|---|
| `profiling_session` | 6-2 | id, project, participation, date, from, to, recorded by/at | confidential / `confidential` (`profilingSessions`) | `participation_record` (evidence set, Q88) |
| `participant_profiling` | 6-2 (+6-3) | participation, the Jobbörse choice, the BA contact declaration, `declared_on` and `form_version` (set at the TL 407 acceptance), `revision` | confidential / `confidential` (`jobboerseChoice`, `baContactConsent`) | `personnel_file` |
| `participant_profiling_assessment` | 6-2 | per section C line except health: rating and text ciphertexts and presence; the "andere" labels; Gesamteinschätzung, weiteres Vorgehen; key id, times | highly confidential / `profiling_assessment` | `personnel_file` (Q192) |
| `participant_profiling_health_assessment` | 6-2 | the health line's rating and text ciphertexts and presence | special category / `profiling_assessment` | `health_record` (Q40, Q192) |
| `participant_residence_social_data` | 6-2 | adds the unemployment period's ciphertexts and presence | highly confidential / `residence_social` | `personnel_file` |
| `document` | 6-3, 6-4 | adds `form_code`, `form_version`, `generation_document_id` (a scan's generated form, same participation and form), `signed_on`, `countersigned_on` (TL 407), the review's confirmations; `CHECK`s by type | by type | by type: `form_working_copy` for `tl407_form`, `kug200b_form` (Q179) |
| `participant_identifier_data` | 6-4 | adds the BA-Kundennummer's ciphertext and presence | highly confidential / `identifiers` | `participation_record` (Q88) |
| `participant_details` | 6-4 | adds `knowledge_date` | confidential / `confidential` | `personnel_file` |
| `asu_registration` | 6-4 (+6-5) | participation, channel, `registered_on`, proof kind and document, attested by/at, `kug200b_declined_on/by`, `confirmed_on`, recorded by/at, `version` | internal / `case_internal` (`asuRegistration`, listable as codes and dates) | `participation_record` (minimum evidence facts) |
| `kug200b_batch` | 6-5 | project, Agentur key, channel, status (`open`, `submitted`, `discarded`), created by/at, `submitted_on`, submitted by/at | internal / project data | `project_master` |
| `agentur_submission` | 6-5 | participation, document, form code and version, Agentur key, channel, batch, `submitted_on`, `original_sent_on`, rejection (date, reason), recorded by/at | internal / `case_internal` (`agenturSubmissions`) | `participation_record` (proof of submission, evidence set) |
| `export_link` | 6-4 | a link's token SHA-256, the export (kind, batch or document ids), the session's kind and hash, `expires_at` (60 s); no privilege for `transfer_app` | internal | `access_credential` |
| `ba_reporting_task` | 6-6 | adds `outcome`, `reported_on`, `not_required_reason`, decided by/at | as before | as before |
| `profiling_exception_request` | 6-7 | the evidence becomes the document's id (FK) | as before | as before |

Enum values are added in their PR's generated migration (`audit_event_type`, `document_type`,
`retention_class`, the new enums), compared as text in that migration run (see the lessons below).

### Functions (hand-written, SECURITY DEFINER, audit in the same transaction, the lock order of D25)

- 6-2: `write_profiling_sessions(context, participation, revision, sessions)`,
  `write_profiling_declarations`, `write_profiling_assessment` / `read_profiling_assessment` (the
  key passed per call like the sensitive fields), `write_unemployment_period`; the profiling-status
  route uses the existing `change_participation_status`.
- 6-3: `add_document` takes the generation a scan names; `record_form_generation` (inserts the
  generated form's document, `source` `generated`, `form_generated` with the version and
  whether an Anlage exists, the confirmed warnings' `warning_confirmed`); `review_document` takes the
  signature dates and confirmations for the TL 407 types; the facts' reader `tl407_facts`;
  `delete_document` lets the PL delete a signed scan before its review (`wrong_person`,
  `wrong_file`; Q183).
- 6-4: `set_asu_route`, `record_asu_registration` (`online_self` / `in_person` with a document or the
  attestation), `decline_kug200b_offer`, `end_paper_consent`, `set_knowledge_date`;
  `review_document` for the Kug 200b (the consent and the outcome); `record_form_generation` for 1–100
  participations (exclusive lock); `create_export_link` / `export_link_content`; `write_participant_data`
  and the import learn `knowledgeDate`.
- 6-5: `create_kug200b_batch`, `discard_kug200b_batch`, `submit_kug200b_batch` (the members'
  submissions and their ASU registrations), `record_asu_confirmation`, `submit_tl407`,
  `record_original_sent`, `record_agentur_rejection`.
- 6-6: `record_ba_report`.
- 6-7: `add_document` for the evidence (the PL); the request reads the evidence fact from the
  document under the participation lock.

### API (`/api/v1`, OpenAPI, RFC 9457, capabilities on every item)

| PR | Route | Does |
|---|---|---|
| 6-2 | `GET /participations/{id}/profiling` | status, sessions, declarations, presence of section C for the profiler, capabilities (`private, no-store`) |
| 6-2 | `PUT …/profiling/sessions`; `PUT …/profiling/declarations` | whole, with `revision` (`409 stale_revision`) |
| 6-2 | `GET`/`PUT …/profiling/assessment`; `PUT …/profiling/unemployment` | the profiler's logged read and writes (`no-store`; `422` with codes and locations, never a value) |
| 6-2 | `POST /participations/{id}/profiling-status` | `{ to, effectiveDate?, statusVersion }` → the change; `422` with the transition's code |
| 6-3 | `GET /participations/{id}/forms/tl407/readiness`; `POST /participations/{id}/forms/tl407` | errors, warnings, overflow (no write); generation (`{ confirmWarnings }` → `201 { documentId, formVersion, anlage }`); opening through the documents' opening route |
| 6-3 | `POST /participations/{id}/documents` (signed types: `generationDocumentId`); `POST …/documents/{documentId}/review` (`signedOn`, `countersignedOn`, the confirmations) | scan upload and review |
| 6-4 | `GET /participations/{id}/asu`; `PUT …/asu/route`; `POST …/asu/registration`; `POST …/asu/kug200b-decline`; `POST …/consents/{consentId}/end`; `PUT …/knowledge-date` | the tab "Arbeitsuche" and its actions |
| 6-4 | `POST /participations/{id}/forms/kug200b`; `POST /projects/{id}/forms/kug200b` (`{ participationIds }`, 1–100); `POST /exports/{kind}` → link; `GET /export-content/{token}` | Kug 200b generation, bulk, the print file and the exports' download (`attachment`, `no-store`) |
| 6-5 | `GET /projects/{id}/kug200b-batches`; `POST /projects/{id}/kug200b-batches`; `POST /kug200b-batches/{id}/submission`; `POST /kug200b-batches/{id}/discard` | candidates per Agentur and batches; create; "Übermittelt am"; discard |
| 6-5 | `POST /participations/{id}/asu/confirmation`; `POST /participations/{id}/tl407-submissions`; `POST /agentur-submissions/{id}/original`; `POST /agentur-submissions/{id}/rejection` | the Agentur's confirmation; TL 407 submission, original, rejection |
| 6-5 | `GET /escalations`; `GET /projects/{id}/worklist`, `/dashboard` | the regional admin's counts; the new deadlines, items, filter and counts |
| 6-6 | `POST /ba-reporting-tasks/{id}/outcome` | `{ outcome: "reported", reportedOn } \| { outcome: "not_required", reason }` |
| 6-7 | `POST /participations/{id}/profiling-exception-requests`; `POST /profiling-exception-requests/{id}/decision`; `…/revocation`; `GET /reviews/profiling-exceptions` | request; approve or reject; revoke; the queue |

Order as in ADR-0010: schema → visibility (`404`; `participation_not_found` for a hidden id in a
body) → permission `403` → state `422`. Logs carry ids, codes and size buckets only; never a value,
a file name, a form's content or a token.

### History (`auditProjection` + an `audit_event_projection` migration row each)

- `profiling` stream (PL; assigned consultant): `profiling_session_changed` (`action`, `sessionId`,
  `date`), `profiling_declarations_recorded` (changed keys), `agentur_submission_recorded`
  (`formCode`, `channel`, `submittedOn`, `batchId`), `agentur_submission_original_sent`,
  `agentur_submission_rejected` (reason).
- `case` stream: `form_generated` (`formCode`, `formVersion`, `documentId`, `anlage`),
  `asu_route_set` (`channel`, `previousChannel`), `asu_registration_recorded` (`channel`,
  `registeredOn`, `proofKind`), `asu_confirmation_recorded` (`confirmedOn`),
  `kug200b_offer_declined` (`declinedOn`), `knowledge_date_set` (changed or cleared, never the
  date), the existing `consent_given` / `consent_ended` with `source`.
- `dsv` stream: `ba_report_recorded` (`kind`, `outcome`, `reportedOn`, reason).
- project-level, in no history: `kug200b_batch_created` (Agentur, count), `kug200b_batch_submitted`,
  `kug200b_batch_discarded`. Security, never shown: `export_created` (kind, count), the reads and
  writes of D12, `document_opened`.
- `document_reviewed` adds `formVersion` for the signed types.

### Web UI (`apps/web`, German; every button by its capability)

- 6-2: tab "Profiling": status with "Teilnahme zugestimmt", "Profiling begonnen", "Abgelehnt"
  (with a confirmation), "Erneut zugestimmt"; "Termine des Profilings" (Datum, von, bis; add, change,
  remove; "Speichern"); "Angaben aus der Selbstauskunft" with "Im assistierten Modus ergänzen";
  for the profiler "Arbeitslos seit / bis", "Handlungsbedarf (Abschnitt C)" (per line "kein /
  vermittlungsrelevant" and text, the hint against diagnoses), "Gesamteinschätzung", "Weiteres
  Vorgehen", "Erklärungen gegenüber der BA" (Jobbörse, Kontaktdaten); each sensitive block loaded on
  "Anzeigen", never cached.
- 6-3: "Profilingbogen (TL 407)": readiness ("Fehlt", "Bitte prüfen" with the warning texts and
  "Bestätigen"), "Erzeugen", the generated forms ("Öffnen", "Neu erzeugen" for an expired
  version), "Unterschriebenen Scan hochladen", "Prüfen" (dates, both signatures present, or a
  reason), "Profiling abschließen" with the date (default the signature).
- 6-4: tab "Arbeitsuche": Weg (route) with the Agentur's default, Kenntnisdatum, Fällig am (or
  "ohne Kenntnisdatum"), "Meldung erfassen" (date and proof: BA-Bestätigung hochladen or
  BA-Kundennummer bestätigen, the number masked as typed and never shown back), Kug 200b ("Erzeugen",
  "Öffnen", scan, "Prüfen" with "Erklärungen 16 und 17 angekreuzt und unterschrieben",
  "Abgelehnt"), "Einwilligung Profilzugriff" (since, "Widerruf erfassen"). Work list bulk
  "Kug 200b erzeugen" (count, the blank `*` fields per row as codes, "Druckdatei öffnen").
- 6-5: project tab "Agentur": per placement Agentur the channel or "Einstellungen fehlen", the
  ready scans, "Sammelmeldung bilden", batches with "Teilnehmerliste (PDF/CSV)", "Scans (PDF)",
  "Übermittelt am", "Verwerfen"; on the tab "Profiling" "An Agentur übermittelt am", "Original
  versandt am", "Von der Agentur abgelehnt"; on "Arbeitsuche" "Bestätigung der Agentur am". Work
  list: deadlines `asu_due` "Arbeitsuche fällig", `tl407_submission` "TL 407 einreichen", the column
  "Agentur" (the most urgent item), filter "Agentur", tile "Agentur offen", group "Agentur".
  `/admin/escalations` for regional admins and admins.
- 6-6: overview's "BA-Meldungen": "Gemeldet am" or "Nicht erforderlich" (reason), with a
  confirmation.
- 6-7: "Ausnahme beantragen" (reason, evidence upload, BA confirmation); "Widerrufen"; the queue
  "Freigaben" for the regional operations manager with "Genehmigen" / "Ablehnen".

### Lessons carried from Slice 5b

- plpgsql: `text[] || 'x'` parses `'x'` as an array (write `'x'::text`); enum values added in a
  generated migration are compared as text in the same migration run; a boolean SQL helper never
  returns null (`IS NOT DISTINCT FROM`, `coalesce`); a generated migration may need a `UNIQUE` moved
  before the FK that references it (the scan's `generation_document_id` composite FK).
- A new parameter on an existing function (`add_document`, `review_document`, `delete_document`,
  `write_participant_data`): `DROP FUNCTION` with the old signature, `CREATE`, the grants again.
- `packages/domain` has no `new Date(` or `Date.now(` (the form layout gets `today`); React render
  code no `Date.now()`.
- Each new or changed audit event gets its `auditProjection` row and an `audit_event_projection`
  migration row (the drift test); history details are strings, booleans, string lists or null
  (dates as ISO strings, counts as strings).
- Zod: an enum with `.meta({ id })` that is also used `.nullable()` makes the OpenAPI component
  nullable everywhere (keep a separate nullable schema); a `.default()` in an input schema becomes
  required in the client body (no defaults in inputs: `confirmWarnings` optional).
- `pnpm verify` takes about 15 minutes; DB tests run from the repo root, never in parallel with it
  (they share `transfer_test`); `pnpm generate` after API schema and form-registry changes;
  `pnpm format` before committing.

## User flows

1. **Info event with Kug 200b:** the PL books the event (5b), then from the work list "Kug 200b
   erzeugen" for the 35 invited (`ta_tg`, placement Agentur Beispielstadt-Nord): 31 complete, 4
   with a blank RV-Nummer; opens the print file. At the event the participants tick, sign and date;
   back in the office the consultant uploads each scan to its form and accepts it ("16 und 17
   angekreuzt und unterschrieben"): the consent is recorded.
2. **Batch:** tab "Agentur" → Beispielstadt-Nord (`scan_email`): 33 ready → "Sammelmeldung bilden" →
   "Teilnehmerliste (PDF)" and "Scans (PDF)" → the PL mails them outside the app → "Übermittelt am
   24.11.": 33 ASU registrations (route `kug_200b`). After 14 days without confirmation the work list
   shows "Bestätigung der Agentur fehlt" until "Bestätigung der Agentur am".
3. **Self-registered:** a participant registered online; the PL records "Meldung erfassen" with the
   BA-Kundennummer; the work list shows "Kug 200b offen" until the participant declines it (recorded) or signs.
4. **Profiling:** the profiler records two sessions, completes section B with the participant in
   assisted mode, fills section C, sees "Bitte prüfen: Alter unplausibel" (a synthetic birth date),
   confirms it, generates the TL 407 (an Anlage for 9 jobs), both sign, the scan is accepted with
   both dates, "Profiling abschließen" (`profiling_done` on the signature date).
5. **Submission:** the PL opens the scan (logged) and uploads it at the Agentur, records "An Agentur
   übermittelt am"; the Agentur needs the original: "Original versandt am" two days later. A
   participation 14 days past its TG start without submission appears on the regional admin's
   escalation view as "1 × TL 407 nicht eingereicht, 3 Tage" with the PL's name, no participant.
6. **BA report:** a later entry created a `later_entry` task in Slice 2; back office sends Kug 208
   and records "Gemeldet am".

## Acceptance criteria

**6-1**
- Each field map matches its blank (names, kinds, radio states); the forms manifest and the
  immutability check run in `pnpm lint` and CI; a changed blank fails both.
- Contract tests fill the real TL 407 and Kug 200b with synthetic data and read every value back,
  `Ł`, `ğ`, `ß` included; the flattened output keeps its page count; the Gotenberg test passes in CI.
- Domain (100 % coverage on the new rules): every error and warning code at its boundary (age 15
  and 67, the same date for `von` and `bis`, 29.02. of a leap year, `03.14.1998`); the row order of
  D6; 4/5/7/4 rows fit, one more goes to the Anlage with "weitere siehe Anlage"; a text one word too
  long continues on the Anlage; Vermerke never filled; §110/§111 by project type; the Kug 200b's
  16–19 always blank.
- `Exporter`: the CSV's header, quoting, BOM and formula guard.

**6-2**
- The PL reads sessions and statuses, never section C or the unemployment period (`403` on the
  route); back office no tab (`403`); an unassigned consultant `404` (ADR-0010); assisted
  mode and break-glass grant none of the writes.
- Each section C field written and read is one `sensitive_write` / `sensitive_read`; `transfer_app`
  can't select a ciphertext; no value in a log line or an audit detail.
- The profiling track: each edge by the PL and the assigned consultant, refused by back office;
  `profiling_done` refused on its guard `tl407_signed` until 6-3; track activity after a terminal
  status and while `active_in_tg` without an exception refuses (`track_inactive`).
- Sessions: overlap, from ≥ to and a future date refused; stale revision `409`.

**6-3**
- Readiness lists every missing `*` field as a code for the viewer's known fields; generation is
  refused with an error, needs every warning confirmed (one `warning_confirmed` each) and stores one
  document with code and version; a second generation supersedes the first; the PL can't generate
  (`403`), opens the form with a `document_opened`.
- A scan must name a generation of the same participation and form; the review needs both dates and
  the confirmation; accepted, `tl407Signed` comes from the database and `profiling_done` passes with
  the default date and refuses an earlier one; the snapshot scenario (D27).
- The PL deletes a wrongly uploaded scan before its review; an accepted one is `document_immutable`.
- e2e: the profiler records a session, generates, uploads and accepts the scan, closes profiling.

**6-4**
- Domain: the rules with `when` apply only on the route `kug_200b`; a declined offer is never a
  missing item; `asu_proof` accepted from an attestation, a document or a batch submission;
  `asu_due` with and without a knowledge date, with a month-end clamp, gone once registered with
  proof, never in `ta_only`.
- Kug 200b acceptance without the declarations' confirmation is refused; accepted, one
  `consent_given` (`paper_form`); the revocation ends it `revoked`; generation refused in `ta_only`.
- The attestation's number is never returned, logged or in an audit detail; the PL can't open an
  `asu_proof` file (break-glass only).
- Bulk generation: 100 rows in one transaction, all or nothing, the print file's link once.
- The guard `asu_registered_with_proof` passes on the TG start from the attestation without a file.

**6-5**
- Two batches racing for one scan give one; a batch submission records every member's submission
  and, on the Kug 200b route, the ASU registration; discarding frees the members; a batch is
  refused without the batch channel or the placement Agentur.
- TL 407 submission refused with the Agentur's blocker and for an expired version where the Agentur
  rejects outdated forms, allowed where it doesn't; `originalRequired` leaves the item until the
  original is recorded; a rejection allows a new submission.
- Each export writes `export_created`; its link works 60 s for its session only; the CSV and PDF
  hold exactly the listed columns.
- The escalation view shows counts and the PL's name, never a participant; a regional admin of
  another region sees nothing; for every new count `count = items.filter(filter).length`, distinct
  participations; the work list over 2,000 participations keeps the Slice 5 performance criterion.

**6-6**
- A pending task closes once (`already_recorded` after), by the PL or back office, never a
  consultant; `reported` in the future or before the task is refused; the item disappears.

**6-7**
- The PL uploads evidence but can't open it; a request without evidence is `evidence_missing`, with
  the same fingerprint as a rejected one `evidence_unchanged`; the approver is never the requester;
  the approved exception satisfies `profiling_done_or_approved_exception` from its date.

## Docs updated by the PRs

- 6-1: ba-forms.md (registry as built, D5–D7), ADR-0006 (`PdfRenderer`, `Exporter` as built),
  ADR-0009 (field map, manifest, versions), architecture/overview.md (`packages/forms`),
  `.env.example` (`PDF_ADAPTER`, `GOTENBERG_URL`).
- 6-2: process-and-lifecycle.md (the profiling record and track actions), data-protection.md (the
  profiling tables, section C storage, the history rows), ADR-0002 (the profiling functions).
- 6-3: data-protection.md (generated forms, the scans' operations, catalog version 3,
  `form_working_copy`), process-and-lifecycle.md (`profiling_done` from the TL 407), ADR-0002.
- 6-4: process-and-lifecycle.md (the ASU record, the offer, the due date), regional-variation.md
  (the rule `when`, base defaults 3, the Kug 200b rules), data-protection.md (consent from paper,
  the attestation, `export_link`, catalog version 4), ADR-0002, ADR-0010 (exports).
- 6-5: process-and-lifecycle.md (submissions, the escalation), regional-variation.md (the batch
  blocker no longer a warning only, Q91), data-protection.md (batches, exports, the regional view),
  architecture/overview.md (the tab "Agentur").
- 6-6: process-and-lifecycle.md (BA reporting as built).
- 6-7: process-and-lifecycle.md (exception requests as built), data-protection.md (the evidence's
  operations); the last PR: roadmap.md (Slice 6 done) and this plan to `docs/plans/archive/`.

## For the product owner

1. **The PR split** (seven PRs) and whether exception requests (6-7) stay in Slice 6 or move to
   Slice 7 with the TG entry guard.
2. **The blank BA PDFs** (Q176): please add the official TL 407 08/2025 (FormID 000159) and Kug 200b
   09/2021 to the repo or name where they come from; 6-1 can't merge without them.
3. **Generated forms as stored documents** with a short-lived class and who generates them (Q179).
4. **Pre-fill rules** (Q180) and the TL 407's Träger and Verweildauer in `ta_only` (Q181, open).
5. **The access cells for the new documents** (Q183, Q184), the Kug 200b acceptance and consent from
   paper (Q185), the storage of section C (Q192).
6. **The ASU record** (Q186), the knowledge date (Q177) and showing the ASU due date before Q1 is
   confirmed, without reminders (Q178).
7. **Batches and the Teilnehmerliste** (Q187), outdated versions (Q188), Agentur rejections (Q189),
   BA reporting outcomes (Q190).
